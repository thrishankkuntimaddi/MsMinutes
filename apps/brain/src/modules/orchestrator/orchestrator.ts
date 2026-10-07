import { randomUUID } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import type { FastifyBaseLogger } from "fastify";
import { z } from "zod";
import { matchLine, type ScriptedLine } from "@ms-minutes/persona";
import { brainMessage, type BrainPayload, type BrainToBodyType } from "@ms-minutes/protocol";
import type { BodyRecord, BodyRegistry } from "../bodies/registry.js";
import type { EventBus } from "../events/event-bus.js";
import type { BodySender } from "../gateway/gateway.js";
import { LLMUnavailableError, type LLM } from "../llm/llm.js";
import type { TurnTrace, TurnTraces } from "../tracing/turn-traces.js";
import { SpeechOut } from "../voice/speech-out.js";
import type { TTS } from "../voice/tts.js";
import type { TurnRecord } from "../memory/memory.js";
import { backstop } from "../skills/builtin/backstop.js";
import type { SkillRegistry } from "../skills/registry.js";
import { actionNote, TagFilter, type Tag } from "./tags.js";
import { SET_EXPRESSION, SetExpressionInput, tools } from "./tools.js";

export type OrchestratorDeps = {
  llm: LLM;
  send: BodySender;
  registry: BodyRegistry;
  traces: TurnTraces;
  systemPrompt: string;
  timezone: string;
  log: FastifyBaseLogger;
  /** When set, the brain speaks: bodies that can play audio get her synthesized voice. */
  tts?: TTS;
  /** Server-side skills (timers, weather…), presented to the model as tools (§12). */
  skills?: SkillRegistry;
  /** Long-term memory: recalled before each turn, written after it. */
  memory?: {
    recall(text: string): Promise<{ note: string; fresh: boolean }>;
    remember(turn: TurnRecord): Promise<void>;
  };
  now?: () => Date;
  /** Lines she says word for word when she hears their command (persona/lines.md). */
  lines?: ScriptedLine[];
};

/** Bodies that declare this capability play the brain's synthesized voice. */
export const SPEAK_AUDIO = "speak.audio";
/** Bodies that declare this capability can move; its schema lists the actions. */
export const ANIMATE = "animate";

/** Upper bound on model calls in one turn (each tool round is one call). */
const MAX_LLM_CALLS_PER_TURN = 4;
const EXPRESSION_TRANSITION_MS = 300;
/** Memory lookup gets this long before she answers without it. */
const RECALL_TIMEOUT_MS = 1500;
/** More than this many moves in one reply is fidgeting, not expression. */
const MAX_ACTIONS_PER_TURN = 2;
/** Spoken when the model declines and no fallback model could answer. */
const REFUSAL_LINE = "Hmm, I'd rather not get into that one.";

type ToolUse = Anthropic.Beta.BetaToolUseBlock;
type ToolResult = Anthropic.Beta.BetaToolResultBlockParam;

class TurnAborted extends Error {}

/**
 * Runs turns: event in → Claude → speech and expression directives out (ADR-0002).
 * There is one conversation for the whole brain, whichever body the user talks through.
 */
export class Orchestrator {
  readonly #deps: OrchestratorDeps;
  /** Append-only, so prompt caching and preserved thinking stay valid. Failed turns are cut off the tail. */
  readonly #history: Anthropic.Beta.BetaMessageParam[] = [];
  #queue: Promise<void> = Promise.resolve();
  /** The turn running right now, so a barge-in can cut it short. */
  #current: {
    bodyId: string;
    voice: SpeechOut | null;
    abort: AbortController;
    /** What she has said so far this turn, tags removed. */
    spoken: string;
  } | null = null;

  /** Her face plus every skill. Fixed for the brain's life so the prompt cache holds. */
  readonly tools: Anthropic.Beta.BetaTool[];

  constructor(deps: OrchestratorDeps) {
    this.#deps = deps;
    this.tools = [...tools, ...(deps.skills?.tools() ?? [])];
  }

  attach(bus: EventBus): void {
    bus.on("body.message", ({ bodyId, message }) => {
      if (message.type === "event.utterance.text") void this.enqueue(bodyId, message.payload.text);
      if (message.type === "event.interrupt") this.interrupt(bodyId);
    });
  }

  /** Continues a conversation that was in progress before a restart. */
  preload(turns: { userText: string; replyText: string }[]): void {
    for (const t of turns) {
      this.#history.push({ role: "user", content: [{ type: "text", text: t.userText }] });
      if (t.replyText) {
        this.#history.push({ role: "assistant", content: [{ type: "text", text: t.replyText }] });
      }
    }
  }

  /** Barge-in: the user started talking over her. Stop thinking and stop speaking. */
  interrupt(bodyId: string): void {
    if (this.#current?.bodyId !== bodyId) return;
    this.#deps.log.info({ bodyId }, "barge-in: stopping her");
    this.#current.voice?.cancel();
    this.#current.abort.abort();
  }

  /** What she said lately to this body (tags removed), to recognise her own voice as echo. */
  recentSpeech(bodyId: string): string {
    const now = this.#current?.bodyId === bodyId ? this.#current.spoken : "";
    const past = this.#history
      .filter((m) => m.role === "assistant")
      .slice(-2)
      .flatMap((m) =>
        typeof m.content === "string"
          ? [m.content]
          : m.content.flatMap((b) => (b.type === "text" ? [b.text] : [])),
      )
      .join(" ")
      .replace(/\[[^\]]*\]/g, " ");
    return `${past} ${now}`;
  }

  /** Turns run one at a time: one brain, one voice. */
  /**
   * Something happened that she should tell the person about (a timer went off, a
   * reminder came due): a turn with no utterance, only the event (§3.2, §12.2).
   */
  enqueueEvent(bodyId: string, event: string): Promise<void> {
    return this.enqueue(bodyId, `<event>${event}</event>`, { proactive: true });
  }

  enqueue(
    bodyId: string,
    text: string,
    meta: { sttMs?: number; proactive?: boolean } = {},
  ): Promise<void> {
    const turn = this.#queue.then(() => this.#runTurn(bodyId, text, meta));
    this.#queue = turn;
    return turn;
  }

  async #runTurn(
    bodyId: string,
    text: string,
    meta: { sttMs?: number; proactive?: boolean },
  ): Promise<void> {
    const { systemPrompt, traces, log } = this.#deps;
    const turnId = randomUUID();
    // A scripted line stands in for the model this turn: same voice, face and history.
    const line = meta.proactive ? undefined : matchLine(this.#deps.lines ?? [], text);
    const llm = line ? scripted(line.say) : this.#deps.llm;
    if (line) log.info({ command: line.when[0] }, "scripted line");
    const started = performance.now();
    const elapsed = () => Math.round(performance.now() - started);
    const say = <T extends BrainToBodyType>(type: T, payload: BrainPayload<T>) =>
      this.#deps.send(brainMessage(type, bodyId, payload));

    const trace: TurnTrace = {
      turnId,
      bodyId,
      startedAt: new Date().toISOString(),
      firstTextMs: null,
      totalMs: 0,
      llmCalls: 0,
      expressions: [],
      actions: [],
      stopReason: null,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      skills: [],
      ...(meta.sttMs === undefined ? {} : { sttMs: meta.sttMs }),
      ...(meta.proactive ? { proactive: true } : {}),
    };

    const body = this.#deps.registry.get(bodyId);
    const tags = new TagFilter(animateActions(body));
    const voice =
      this.#deps.tts && body?.capabilities.some((c) => c.name === SPEAK_AUDIO)
        ? new SpeechOut(this.#deps.tts, turnId, say, log)
        : null;
    const current = { bodyId, voice, abort: new AbortController(), spoken: "" };
    this.#current = current;
    /** Raw model text of the call in flight, kept if she's interrupted mid-sentence. */
    let partial = "";

    const turnStart = this.#history.length;
    let speaking = false;
    let firstDeltaOfCall = true;
    /** Spoken text after tags are taken out; goes to captions and to her voice. */
    const speak = (text: string) => {
      if (!speaking) {
        text = text.trimStart();
        if (!text) return;
        speaking = true;
        trace.firstTextMs = elapsed();
        say("state.set", { mode: "speaking" });
      } else if (firstDeltaOfCall) {
        // Text from the next model call continues the same spoken reply.
        text = ` ${text.trimStart()}`;
      }
      if (!text) return;
      firstDeltaOfCall = false;
      say("speech.text.delta", { turnId, text });
      voice?.push(text);
      current.spoken += text;
    };
    say("state.set", { mode: "thinking" });
    const { note: memoryNote, fresh } = meta.proactive
      ? { note: "", fresh: false }
      : await this.#recall(text);
    if (fresh && this.#history.length) {
      // A new conversation after a long gap: start the working context over. What
      // mattered lives on in her memories and last conversation's summary.
      this.#history.length = 0;
      log.info({ bodyId }, "new conversation");
    }
    this.#history.push({
      role: "user",
      content: [
        { type: "text", text: [this.#contextNote(bodyId), memoryNote].filter(Boolean).join("\n") },
        { type: "text", text },
      ],
    });

    try {
      for (let call = 1; ; call++) {
        if (call > MAX_LLM_CALLS_PER_TURN)
          throw new TurnAborted("too many tool rounds in one turn");
        trace.llmCalls = call;

        firstDeltaOfCall = true;
        partial = "";
        /** What this call said once tags are out, and the tags: her reply as history keeps it. */
        let callText = "";
        const callTags: Tag[] = [];
        const message = await llm.stream(
          {
            system: systemPrompt,
            tools: this.tools,
            messages: this.#history,
            signal: current.abort.signal,
          },
          (delta) => {
            if (current.abort.signal.aborted) return;
            partial += delta;
            const found = tags.push(delta);
            for (const tag of found.tags) this.#applyTag(tag, bodyId, trace);
            callTags.push(...found.tags);
            callText += found.text;
            speak(found.text);
          },
        );
        const rest = tags.flush();
        callText += rest;
        speak(rest);

        trace.stopReason = message.stop_reason;
        trace.usage.input += message.usage.input_tokens;
        trace.usage.output += message.usage.output_tokens;
        trace.usage.cacheRead += message.usage.cache_read_input_tokens ?? 0;
        trace.usage.cacheWrite += message.usage.cache_creation_input_tokens ?? 0;

        if (message.stop_reason === "refusal") {
          throw new TurnAborted(`refused (${message.stop_details?.category ?? "uncategorised"})`);
        }

        const toolUses = message.content.filter((b): b is ToolUse => b.type === "tool_use");
        // Tool input cut off by max_tokens can still look valid; never run it.
        if (toolUses.length > 0 && message.stop_reason !== "tool_use") {
          throw new TurnAborted(`tool call ended with stop_reason ${message.stop_reason}`);
        }

        // Keep her reply as she should have written it, not as the model did: a small model
        // copies its own slips ("[right now I am [sad 0.7]") from history into every turn.
        this.#history.push({
          role: "assistant",
          content: asWritten(message.content, callTags, callText),
        });
        if (toolUses.length === 0) break;

        const results = await Promise.all(
          toolUses.map((tool) => this.#runTool(tool, bodyId, trace)),
        );
        this.#history.push({ role: "user", content: results });
      }
      if (!meta.proactive && !line) await this.#backstop(text, current.spoken, bodyId, trace);
    } catch (error) {
      if (current.abort.signal.aborted) {
        // Interrupted: keep what was said, cut off, so she knows where she stopped.
        // (Consecutive user turns are fine; the API merges them.)
        trace.interrupted = true;
        const said = partial.trimEnd();
        if (said) {
          this.#history.push({ role: "assistant", content: [{ type: "text", text: `${said}—` }] });
        }
        log.info({ turnId, bodyId }, "turn interrupted");
        return;
      }
      // Drop the failed turn so the next one starts from a valid, cache-friendly history.
      this.#history.length = turnStart;
      trace.error = describe(error);
      log.warn({ err: error, turnId, bodyId }, "turn failed");

      const refused = error instanceof TurnAborted && trace.stopReason === "refusal";
      // Don't keep talking over an error; a refusal still gets its spoken line.
      if (!refused) voice?.cancel();
      if (refused) {
        const spokeAlready = speaking;
        if (!speaking) {
          speaking = true;
          say("state.set", { mode: "speaking" });
        }
        say("speech.text.delta", {
          turnId,
          text: spokeAlready ? ` ${REFUSAL_LINE}` : REFUSAL_LINE,
        });
        voice?.push(` ${REFUSAL_LINE}`);
      } else if (
        error instanceof Anthropic.APIError ||
        error instanceof LLMUnavailableError ||
        isCredentialError(error)
      ) {
        say("error", { code: "llm_unavailable", message: trace.error, fatal: false });
      } else {
        say("error", {
          code: "internal",
          message: "something went wrong in this turn",
          fatal: false,
        });
      }
    } finally {
      // Her voice may still be catching up with the text; the turn ends when she does.
      await voice?.finish();
      if (voice?.cancelled || current.abort.signal.aborted) trace.interrupted = true;
      if (voice?.firstAudioAt) trace.firstAudioMs = Math.round(voice.firstAudioAt - started);
      if (this.#current === current) this.#current = null;
      if (speaking) say("speech.end", { turnId });
      say("state.set", { mode: "idle" });
      trace.totalMs = elapsed();
      traces.add(trace);
      log.info({ trace }, "turn completed");
      const reply = current.spoken.trim();
      if (this.#deps.memory && !meta.proactive && (reply || trace.interrupted)) {
        void this.#deps.memory.remember({ bodyId, userText: text, replyText: reply, trace });
      }
    }
  }

  async #runTool(tool: ToolUse, bodyId: string, trace: TurnTrace): Promise<ToolResult> {
    const result = (content: string, isError = false): ToolResult => ({
      type: "tool_result",
      tool_use_id: tool.id,
      content,
      ...(isError ? { is_error: true } : {}),
    });

    const skills = this.#deps.skills;
    if (tool.name !== SET_EXPRESSION && skills?.has(tool.name)) {
      const outcome = await skills.run(tool.name, tool.input, {
        bodyId,
        now: (this.#deps.now ?? (() => new Date()))(),
        timezone: this.#deps.timezone,
        log: this.#deps.log,
      });
      trace.skills.push(`${tool.name}:${outcome.ok ? "ok" : "error"}`);
      return outcome.ok ? result(JSON.stringify(outcome.result)) : result(outcome.error, true);
    }
    if (tool.name !== SET_EXPRESSION) {
      return result(`Unknown tool "${tool.name}".`, true);
    }
    const parsed = SetExpressionInput.safeParse(tool.input);
    if (!parsed.success) return result(z.prettifyError(parsed.error), true);

    const body = this.#deps.registry.get(bodyId);
    if (!body?.capabilities.some((c) => c.name === "express")) {
      return result("This body has no face, so the expression wasn't shown.");
    }

    const { affect, intensity } = parsed.data;
    this.#deps.send(
      brainMessage("expression.set", bodyId, {
        affect,
        intensity,
        transitionMs: EXPRESSION_TRANSITION_MS,
      }),
    );
    trace.expressions.push(`${affect}:${intensity}`);
    return result("shown");
  }

  /** She said she set it but no tool ran: make it true (see skills/builtin/backstop.ts). */
  async #backstop(userText: string, said: string, bodyId: string, trace: TurnTrace): Promise<void> {
    const skills = this.#deps.skills;
    if (!skills || !/\b(timer|remind)/i.test(said)) return;
    const intent = backstop(userText);
    if (
      !intent ||
      trace.skills.some((s) => s.startsWith(intent.tool)) ||
      !skills.has(intent.tool)
    ) {
      return;
    }
    const outcome = await skills.run(intent.tool, intent.input, {
      bodyId,
      now: (this.#deps.now ?? (() => new Date()))(),
      timezone: this.#deps.timezone,
      log: this.#deps.log,
    });
    trace.skills.push(`${intent.tool}:backstop:${outcome.ok ? "ok" : "error"}`);
    this.#deps.log.info(
      { intent, ok: outcome.ok },
      "she said it but didn't call the tool; did it for her",
    );
  }

  async #recall(text: string): Promise<{ note: string; fresh: boolean }> {
    const none = { note: "", fresh: false };
    const memory = this.#deps.memory;
    if (!memory) return none;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        memory.recall(text),
        new Promise<typeof none>((resolve) => {
          timer = setTimeout(() => resolve(none), RECALL_TIMEOUT_MS);
        }),
      ]);
    } catch (err) {
      this.#deps.log.warn({ err }, "memory recall failed");
      return none;
    } finally {
      clearTimeout(timer);
    }
  }

  /** A mood or action tag from her reply text. */
  #applyTag(tag: Tag, bodyId: string, trace: TurnTrace): void {
    const body = this.#deps.registry.get(bodyId);
    if (tag.kind === "mood") {
      if (!body?.capabilities.some((c) => c.name === "express")) return;
      this.#deps.send(
        brainMessage("expression.set", bodyId, {
          affect: tag.affect,
          intensity: tag.intensity,
          transitionMs: EXPRESSION_TRANSITION_MS,
        }),
      );
      trace.expressions.push(`${tag.affect}:${tag.intensity}`);
      return;
    }
    if (tag.kind !== "action" || trace.actions.length >= MAX_ACTIONS_PER_TURN) return;
    this.#deps.send(
      brainMessage("capability.call", bodyId, {
        callId: randomUUID(),
        name: ANIMATE,
        args: { action: tag.action },
      }),
    );
    trace.actions.push(tag.action);
  }

  /** Per-turn facts she can't know otherwise. Lives in the user turn so the system prompt stays cacheable. */
  #contextNote(bodyId: string): string {
    const now = (this.#deps.now ?? (() => new Date()))();
    const time = new Intl.DateTimeFormat("en-GB", {
      timeZone: this.#deps.timezone,
      dateStyle: "full",
      timeStyle: "short",
    }).format(now);
    const body = this.#deps.registry.get(bodyId);
    const via = body ? `${body.id} (${body.type})` : bodyId;
    return `<context>Local time: ${time} (${this.#deps.timezone}). Talking through: ${via}.${actionNote(animateActions(body))}</context>`;
  }
}

/** Actions a body says it can perform, from its `animate` capability schema. */
function animateActions(body: BodyRecord | undefined): string[] {
  const capability = body?.capabilities.find((c) => c.name === ANIMATE);
  const action = (capability?.schema?.properties as Record<string, { enum?: unknown }> | undefined)
    ?.action;
  return Array.isArray(action?.enum) ? action.enum.filter((a) => typeof a === "string") : [];
}

function isCredentialError(error: unknown): boolean {
  return error instanceof Anthropic.AnthropicError && /api[_ ]?key|auth/i.test(error.message);
}

function describe(error: unknown): string {
  if (error instanceof Anthropic.AuthenticationError) {
    return "Claude rejected the credentials. Check ANTHROPIC_API_KEY.";
  }
  if (error instanceof Anthropic.RateLimitError)
    return "Claude is rate limiting requests; try again shortly.";
  if (error instanceof Anthropic.APIConnectionError)
    return "Couldn't reach Claude. Check the network.";
  if (error instanceof Anthropic.APIError) return `Claude request failed (${error.status}).`;
  if (isCredentialError(error))
    return "No Claude credentials found. Set ANTHROPIC_API_KEY in .env.";
  return error instanceof Error ? error.message : String(error);
}

/**
 * The text of a model message, normalised: well-formed tags first, then exactly what she said.
 * Tool-use blocks are kept as they are. If nothing is left, the original is kept.
 */
export function asWritten(
  content: Anthropic.Beta.BetaMessage["content"],
  tags: readonly Tag[],
  spoken: string,
): Anthropic.Beta.BetaMessageParam["content"] {
  if (!content.some((b) => b.type === "text")) return content;
  const lead = tags
    .flatMap((t) =>
      t.kind === "mood"
        ? [`[${t.affect} ${t.intensity.toFixed(1)}]`]
        : t.kind === "action"
          ? [`[${t.action}]`]
          : [],
    )
    .join(" ");
  const text = [lead, spoken.trim()].filter(Boolean).join(" ");
  if (!text) return content;
  return [{ type: "text", text }, ...content.filter((b) => b.type !== "text")];
}

/** An LLM that "writes" a fixed line, in small pieces so her voice starts right away. */
function scripted(say: string): LLM {
  return {
    async stream(_request, onText) {
      for (const piece of say.match(/\S+\s*/g) ?? []) onText(piece);
      return {
        id: `scripted_${randomUUID()}`,
        type: "message",
        role: "assistant",
        model: "scripted",
        content: [{ type: "text", text: say, citations: null }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      } as unknown as Anthropic.Beta.BetaMessage;
    },
  };
}
