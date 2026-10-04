import type { Capability } from "@ms-minutes/protocol";

export type BodyRecord = {
  id: string;
  type: string;
  firmware: string;
  capabilities: Capability[];
  sessionId: string;
  connectedAt: Date;
  lastSeenAt: Date;
};

/** In-memory view of the bodies currently connected to the brain. */
export class BodyRegistry {
  readonly #bodies = new Map<string, BodyRecord>();

  add(body: BodyRecord): void {
    this.#bodies.set(body.id, body);
  }

  remove(id: string): void {
    this.#bodies.delete(id);
  }

  get(id: string): BodyRecord | undefined {
    return this.#bodies.get(id);
  }

  list(): BodyRecord[] {
    return [...this.#bodies.values()];
  }

  touch(id: string, at = new Date()): void {
    const body = this.#bodies.get(id);
    if (body) body.lastSeenAt = at;
  }
}
