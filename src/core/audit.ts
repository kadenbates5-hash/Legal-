import { createHash } from "node:crypto";
import type { Actor, MatterRef } from "./types.js";

/**
 * §5: "Audit trail: treated as privilege-sensitive itself — access-restricted
 * and counsel-aware, not an open engineering log."
 *
 * This is an append-only log. There is deliberately no update/delete method.
 *
 * **Append-only is proved, not asserted.** Every entry carries a SHA-256
 * hash over its own contents *and the previous entry's hash*, so the log
 * is a chain: altering an entry, deleting one, or splicing one in
 * changes that entry's hash and breaks every link after it.
 * `verifyIntegrity()` walks the chain and reports the first sequence
 * where it breaks.
 *
 * This matters because the log doesn't only live in memory — it is
 * persisted, as JSON, in a file or a Postgres column that a person with
 * the right access could edit directly. Without the chain, "we never
 * delete audit entries" is a promise about code that has nothing to do
 * with the file on disk. With it, a quietly removed entry is detectable
 * after the fact, which is the difference between a log and evidence.
 *
 * What it does **not** do is make tampering impossible. Someone who can
 * rewrite the state file can also recompute every subsequent hash. Real
 * tamper-*proofing* needs the chain anchored somewhere the same person
 * can't reach — an append-only external store, or periodically
 * publishing the head hash. Detecting casual alteration is a large step
 * up from nothing; it is not the same thing as an immutable log, and it
 * shouldn't be described to a firm as if it were.
 */
export interface AuditChange {
  field: string;
  /** Rendered as text, so an audit entry stays plain, diffable data. `undefined` means the field wasn't set before. */
  from: string | undefined;
  to: string | undefined;
}

export interface AuditEntry {
  readonly sequence: number;
  readonly timestamp: string;
  readonly actor: Actor;
  readonly matterId: string | undefined;
  readonly action: string;
  readonly detail: string | undefined;
  /**
   * Field-level before/after for an *edit*. "matter_updated" tells you
   * something happened; this tells you what, which is the whole point of
   * an accountability trail — especially for matter parties, which drive
   * every future conflicts check.
   */
  readonly changes?: readonly AuditChange[];
  /** SHA-256 over this entry's contents plus `prevHash`. Absent on entries written before chaining existed. */
  readonly hash?: string;
  /** The previous entry's hash; empty string for the first entry in the chain. */
  readonly prevHash?: string;
}

export type AuditReaderRole = "attorney" | "system_admin_no_content";

export interface IntegrityReport {
  ok: boolean;
  entriesChecked: number;
  /** Entries written before hash chaining existed — they can't be verified, but their absence isn't a failure. */
  unchainedEntries: number;
  /** Sequence number of the first entry whose hash doesn't match, if any. */
  brokenAtSequence?: number;
  reason?: string;
}

/**
 * The exact bytes hashed for an entry. Field order is fixed here rather
 * than taken from object iteration order, so a snapshot that
 * round-trips through JSON in a different key order still verifies.
 */
function canonicalize(entry: Omit<AuditEntry, "hash">): string {
  return JSON.stringify([
    entry.sequence,
    entry.timestamp,
    entry.actor.id,
    entry.actor.role,
    entry.matterId ?? null,
    entry.action,
    entry.detail ?? null,
    (entry.changes ?? []).map((c) => [c.field, c.from ?? null, c.to ?? null]),
    entry.prevHash ?? "",
  ]);
}

function hashEntry(entry: Omit<AuditEntry, "hash">): string {
  return createHash("sha256").update(canonicalize(entry)).digest("hex");
}

/** Renders a value for an audit change: compact, readable, and bounded. */
export function auditValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value.length > 500 ? `${value.slice(0, 500)}…` : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map((v) => auditValue(v) ?? "").join(", ");
  const json = JSON.stringify(value);
  return json.length > 500 ? `${json.slice(0, 500)}…` : json;
}

/**
 * Builds the `changes` list for an edit by comparing two records over
 * the named fields. Only fields that actually differ are recorded — a
 * save that changed one field shouldn't produce an entry implying the
 * whole record was rewritten.
 */
export function diffFields<T extends Record<string, unknown>>(
  before: T | undefined,
  after: T,
  fields: readonly (keyof T & string)[],
): AuditChange[] {
  const changes: AuditChange[] = [];
  for (const field of fields) {
    const from = auditValue(before?.[field]);
    const to = auditValue(after[field]);
    if (from !== to) changes.push({ field, from, to });
  }
  return changes;
}

export class AuditLog {
  #entries: AuditEntry[] = [];

  append(entry: Omit<AuditEntry, "sequence" | "timestamp" | "hash" | "prevHash">): AuditEntry {
    const prevHash = this.#entries.at(-1)?.hash ?? "";
    const unhashed: Omit<AuditEntry, "hash"> = {
      sequence: this.#entries.length,
      timestamp: new Date().toISOString(),
      ...entry,
      ...(entry.changes?.length ? { changes: entry.changes.map((c) => Object.freeze({ ...c })) } : {}),
      prevHash,
    };
    const full: AuditEntry = Object.freeze({ ...unhashed, hash: hashEntry(unhashed) });
    this.#entries.push(full);
    return full;
  }

  /**
   * Reading requires an explicit counsel-aware role. `system_admin_no_content`
   * exists for ops tooling that needs entry counts/timestamps but must not
   * see privilege-sensitive detail/action content.
   */
  read(readerRole: AuditReaderRole, filter?: Partial<MatterRef> & AuditFilter): AuditEntry[] {
    let scoped = [...this.#entries];
    if (filter?.matterId) scoped = scoped.filter((e) => e.matterId === filter.matterId);
    if (filter?.actorId) scoped = scoped.filter((e) => e.actor.id === filter.actorId);
    if (filter?.action) {
      const needle = filter.action.toLowerCase();
      scoped = scoped.filter((e) => e.action.toLowerCase().includes(needle));
    }
    // Date bounds are compared against the ISO timestamp's date prefix, so
    // "2026-07-26" means that whole calendar day in UTC.
    if (filter?.from) scoped = scoped.filter((e) => e.timestamp.slice(0, 10) >= filter.from!);
    if (filter?.to) scoped = scoped.filter((e) => e.timestamp.slice(0, 10) <= filter.to!);

    if (readerRole === "attorney") return scoped;

    // The redacted view must drop `changes` too: before/after values are
    // exactly the privileged content this role is walled off from.
    return scoped.map((e) =>
      Object.freeze({
        sequence: e.sequence,
        timestamp: e.timestamp,
        actor: e.actor,
        matterId: e.matterId,
        action: "[redacted]",
        detail: undefined,
        ...(e.hash ? { hash: e.hash } : {}),
        ...(e.prevHash !== undefined ? { prevHash: e.prevHash } : {}),
      }),
    );
  }

  /**
   * Walks the hash chain. Returns the first sequence at which it breaks,
   * which is where an entry was altered or one before it was removed.
   */
  verifyIntegrity(): IntegrityReport {
    let unchained = 0;
    let expectedPrev = "";

    for (const [index, entry] of this.#entries.entries()) {
      if (!entry.hash) {
        // Written before chaining existed. Not a failure, but the chain
        // restarts after it — an unhashed entry can't vouch for its
        // successor, and pretending otherwise would report a false break.
        unchained += 1;
        expectedPrev = "";
        continue;
      }
      if (entry.sequence !== index) {
        return {
          ok: false,
          entriesChecked: this.#entries.length,
          unchainedEntries: unchained,
          brokenAtSequence: entry.sequence,
          reason: `entry at position ${index} claims sequence ${entry.sequence} — an entry was removed or reordered`,
        };
      }
      if ((entry.prevHash ?? "") !== expectedPrev) {
        return {
          ok: false,
          entriesChecked: this.#entries.length,
          unchainedEntries: unchained,
          brokenAtSequence: entry.sequence,
          reason: `entry ${entry.sequence} does not follow the entry before it — one was removed or inserted`,
        };
      }
      const { hash, ...rest } = entry;
      if (hashEntry(rest) !== hash) {
        return {
          ok: false,
          entriesChecked: this.#entries.length,
          unchainedEntries: unchained,
          brokenAtSequence: entry.sequence,
          reason: `entry ${entry.sequence} has been altered since it was written`,
        };
      }
      expectedPrev = hash;
    }

    return { ok: true, entriesChecked: this.#entries.length, unchainedEntries: unchained };
  }

  count(): number {
    return this.#entries.length;
  }

  /**
   * The hash of the most recent entry — the single value that commits to
   * the entire log. Publishing this somewhere out of reach is what turns
   * tamper-*detection* into tamper-*evidence*: see `audit-anchor.ts`.
   */
  headHash(): string | undefined {
    return this.#entries.at(-1)?.hash;
  }

  /**
   * Entries after `sequence` whose action isn't in `ignoring`.
   *
   * Exists for one specific problem: anchoring writes its own audit
   * entry, which changes the head hash, so "has anything happened since
   * the last anchor?" can never be answered by comparing head hashes —
   * the answer would always be yes, and a nightly job would anchor
   * forever on a completely idle system.
   */
  countSince(sequence: number, ignoring: readonly string[] = []): number {
    return this.#entries.filter((e) => e.sequence > sequence && !ignoring.includes(e.action)).length;
  }

  /** The hash recorded at a given sequence, for checking an anchor against the current chain. */
  hashAt(sequence: number): string | undefined {
    return this.#entries.find((e) => e.sequence === sequence)?.hash;
  }

  /**
   * Checks the chain against previously published anchors.
   *
   * This is the check the internal chain alone cannot make. Someone who
   * rewrites the state file can recompute every hash, so
   * `verifyIntegrity()` will happily pass on a log that was rebuilt from
   * scratch. An anchor is a copy of the head hash written somewhere that
   * person doesn't control; if the chain no longer produces that hash at
   * that sequence, the log has been rewritten regardless of how
   * internally consistent it now looks.
   *
   * Two distinct failures, reported separately because they mean
   * different things:
   * - **mismatch** — the entry at that sequence exists but hashes
   *   differently. History was rewritten.
   * - **missing** — the log is now shorter than an anchor it already
   *   published. Entries were truncated off the end, which the internal
   *   chain cannot see at all, since a truncated chain is still a valid
   *   chain.
   */
  verifyAgainstAnchors(anchors: readonly AuditAnchorRecord[]): AnchorVerification {
    const mismatches: AnchorMismatch[] = [];
    for (const anchor of anchors) {
      const actual = this.hashAt(anchor.sequence);
      if (actual === undefined) {
        mismatches.push({
          sequence: anchor.sequence,
          expectedHash: anchor.headHash,
          actualHash: undefined,
          kind: "missing",
        });
      } else if (actual !== anchor.headHash) {
        mismatches.push({
          sequence: anchor.sequence,
          expectedHash: anchor.headHash,
          actualHash: actual,
          kind: "mismatch",
        });
      }
    }
    return { ok: mismatches.length === 0, anchorsChecked: anchors.length, mismatches };
  }

  /**
   * Plain-data snapshot for persistence. Unlike `read()`, this returns
   * unredacted entries regardless of caller — it's meant for a trusted
   * persistence layer restoring the log itself, not for a UI/reporting
   * consumer, so it deliberately has no reader-role parameter.
   */
  toSnapshot(): AuditEntry[] {
    return this.#entries.map((e) => ({ ...e, ...(e.changes ? { changes: e.changes.map((c) => ({ ...c })) } : {}) }));
  }

  /** Rehydrates a log from a persisted snapshot, preserving exact sequence/timestamp/hash. */
  static fromSnapshot(entries: readonly AuditEntry[]): AuditLog {
    const log = new AuditLog();
    log.#entries = entries.map((e) =>
      Object.freeze({ ...e, ...(e.changes ? { changes: e.changes.map((c) => Object.freeze({ ...c })) } : {}) }),
    );
    return log;
  }
}

/**
 * A published commitment to the log's state at a point in time. The
 * `headHash` is the hash of entry `sequence`; because each hash covers
 * every entry before it, that one value commits to the whole log up to
 * that point.
 */
export interface AuditAnchorRecord {
  sequence: number;
  headHash: string;
  anchoredAt: string;
  /** Where it went — the name of the target that accepted it. */
  destination: string;
  /** Whatever the target gives back as proof it stored the value (a message id, an offset, a receipt). */
  receipt: string | undefined;
}

export interface AnchorMismatch {
  sequence: number;
  expectedHash: string;
  actualHash: string | undefined;
  /** `missing` means the log is now shorter than an anchor it already published. */
  kind: "mismatch" | "missing";
}

export interface AnchorVerification {
  ok: boolean;
  anchorsChecked: number;
  mismatches: AnchorMismatch[];
}

export interface AuditFilter {
  actorId?: string;
  /** Case-insensitive substring of the action name. */
  action?: string;
  /** Inclusive ISO date bounds (UTC), e.g. "2026-07-01". */
  from?: string;
  to?: string;
}
