import type { FastifyBaseLogger } from "fastify";
import type { RiskTier } from "@ms-minutes/protocol";

export type Decision = { allow: true } | { allow: false; reason: string };

export type PolicyOptions = {
  /** Tier-2 skills explicitly granted (ARCHITECTURE §13.2), by dotted name. */
  granted?: Iterable<string>;
  /** Skills switched off entirely, whatever their tier. */
  denied?: Iterable<string>;
  log: FastifyBaseLogger;
};

/**
 * The policy gate every skill call passes (ADR-0006, §13.2):
 * tier 0 runs automatically; tier 1 automatically unless denied; tier 2 only when explicitly
 * granted, and always logged; tier 3 needs the person's confirmation, which no body can
 * give yet, so it is refused.
 */
export class PolicyGate {
  readonly #granted: Set<string>;
  readonly #denied: Set<string>;
  readonly #log: FastifyBaseLogger;

  constructor(options: PolicyOptions) {
    this.#granted = new Set(options.granted ?? []);
    this.#denied = new Set(options.denied ?? []);
    this.#log = options.log;
  }

  decide(name: string, tier: RiskTier, bodyId: string): Decision {
    const decision = this.#decide(name, tier);
    if (tier >= 2 || !decision.allow) {
      this.#log.info({ skill: name, tier, bodyId, ...decision }, "policy decision");
    }
    return decision;
  }

  #decide(name: string, tier: RiskTier): Decision {
    if (this.#denied.has(name)) return { allow: false, reason: `${name} is switched off.` };
    if (tier <= 1) return { allow: true };
    if (tier === 2) {
      return this.#granted.has(name)
        ? { allow: true }
        : { allow: false, reason: `${name} needs the person's permission first (not granted).` };
    }
    return {
      allow: false,
      reason: `${name} needs the person's confirmation, which isn't supported yet.`,
    };
  }
}
