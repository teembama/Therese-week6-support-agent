// Per-process admission for agent turns (D59) and the shutdown drain (D60). Each admitted agent
// turn runs a Claude CLI and an MCP server, so the number running at once is capped. Slots are
// counted per conversation turn ("callId#turnIndex"): a speculative replacement or a re-run of the
// same turn reuses the slot its predecessor holds (the predecessor is being aborted), so partial
// transcripts from one caller never lock out another caller.

export type Refusal = "busy" | "shutting_down";

export interface Slot {
  /** Idempotent. */
  release(): void;
}

export class Admission {
  private readonly holders = new Map<string, number>();
  private draining = false;

  constructor(private readonly cap: number) {}

  /** A slot for this turn, or why none is given. */
  tryAcquire(turnKey: string): Slot | Refusal {
    if (this.draining) return "shutting_down";
    const held = this.holders.get(turnKey);
    if (held === undefined && this.holders.size >= this.cap) return "busy";
    this.holders.set(turnKey, (held ?? 0) + 1);
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        const n = (this.holders.get(turnKey) ?? 1) - 1;
        if (n <= 0) this.holders.delete(turnKey);
        else this.holders.set(turnKey, n);
      },
    };
  }

  /** Distinct conversation turns currently holding a slot. */
  get running(): number {
    return this.holders.size;
  }

  get limit(): number {
    return this.cap;
  }

  /** Stop admitting (SIGTERM). Irreversible. */
  drain(): void {
    this.draining = true;
  }

  get isDraining(): boolean {
    return this.draining;
  }
}
