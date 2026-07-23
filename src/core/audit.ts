import type { Actor, MatterRef } from "./types.js";

/**
 * §5: "Audit trail: treated as privilege-sensitive itself — access-restricted
 * and counsel-aware, not an open engineering log."
 *
 * This is an append-only log. There is deliberately no update/delete method.
 */
export interface AuditEntry {
  readonly sequence: number;
  readonly timestamp: string;
  readonly actor: Actor;
  readonly matterId: string | undefined;
  readonly action: string;
  readonly detail: string | undefined;
}

export type AuditReaderRole = "attorney" | "system_admin_no_content";

export class AuditLog {
  #entries: AuditEntry[] = [];

  append(entry: Omit<AuditEntry, "sequence" | "timestamp">): AuditEntry {
    const full: AuditEntry = Object.freeze({
      sequence: this.#entries.length,
      timestamp: new Date().toISOString(),
      ...entry,
    });
    this.#entries.push(full);
    return full;
  }

  /**
   * Reading requires an explicit counsel-aware role. `system_admin_no_content`
   * exists for ops tooling that needs entry counts/timestamps but must not
   * see privilege-sensitive detail/action content.
   */
  read(readerRole: AuditReaderRole, filter?: Partial<MatterRef>): AuditEntry[] {
    const scoped = filter?.matterId
      ? this.#entries.filter((e) => e.matterId === filter.matterId)
      : [...this.#entries];

    if (readerRole === "attorney") return scoped;

    return scoped.map((e) =>
      Object.freeze({
        sequence: e.sequence,
        timestamp: e.timestamp,
        actor: e.actor,
        matterId: e.matterId,
        action: "[redacted]",
        detail: undefined,
      }),
    );
  }

  count(): number {
    return this.#entries.length;
  }

  /**
   * Plain-data snapshot for persistence. Unlike `read()`, this returns
   * unredacted entries regardless of caller — it's meant for a trusted
   * persistence layer restoring the log itself, not for a UI/reporting
   * consumer, so it deliberately has no reader-role parameter.
   */
  toSnapshot(): AuditEntry[] {
    return this.#entries.map((e) => ({ ...e }));
  }

  /** Rehydrates a log from a persisted snapshot, preserving exact sequence/timestamp. */
  static fromSnapshot(entries: readonly AuditEntry[]): AuditLog {
    const log = new AuditLog();
    log.#entries = entries.map((e) => Object.freeze({ ...e }));
    return log;
  }
}
