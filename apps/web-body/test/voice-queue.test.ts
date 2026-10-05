import { describe, expect, it } from "vitest";
import type { Speaker } from "../src/speaker.js";
import { VoiceQueue } from "../src/voice-queue.js";

/** Records what would be spoken; each sentence "finishes" on the next tick. */
function fakeSpeaker() {
  const spoken: string[] = [];
  let stops = 0;
  const speaker = {
    speak: async (text: string) => {
      spoken.push(text);
      await Promise.resolve();
    },
    stop: () => void stops++,
  } as unknown as Speaker;
  return { speaker, spoken, stops: () => stops };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("VoiceQueue", () => {
  it("speaks each sentence as soon as it is complete", async () => {
    const { speaker, spoken } = fakeSpeaker();
    const queue = new VoiceQueue(speaker);
    queue.push("Morning! It's half");
    await settle();
    expect(spoken).toEqual(["Morning!"]);
    queue.push(" past nine. Coffee");
    await settle();
    expect(spoken).toEqual(["Morning!", "It's half past nine."]);
    queue.flush();
    await settle();
    expect(spoken).toEqual(["Morning!", "It's half past nine.", "Coffee"]);
  });

  it("waits for the space after a full stop, so numbers aren't split", async () => {
    const { speaker, spoken } = fakeSpeaker();
    const queue = new VoiceQueue(speaker);
    queue.push("It's 3.");
    queue.push("5 degrees out.");
    queue.flush();
    await settle();
    expect(spoken).toEqual(["It's 3.5 degrees out."]);
  });

  it("drops markdown and empty text", async () => {
    const { speaker, spoken } = fakeSpeaker();
    const queue = new VoiceQueue(speaker);
    queue.push("**Well**, hello.   ");
    queue.flush();
    queue.say(" ... ");
    await settle();
    expect(spoken).toEqual(["Well, hello."]);
  });

  it("cancel stops speech and forgets the rest of the reply", async () => {
    const { speaker, spoken, stops } = fakeSpeaker();
    const busy: boolean[] = [];
    const queue = new VoiceQueue(speaker, { onBusy: (b) => busy.push(b) });
    queue.push("One. Two. Three.");
    queue.cancel();
    queue.flush();
    await settle();
    expect(spoken).toEqual(["One."]);
    expect(stops()).toBe(1);
    expect(busy).toEqual([true, false]);
    expect(queue.busy).toBe(false);
  });
});
