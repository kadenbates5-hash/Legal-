import type { AuditAnchorRecord } from "./audit.js";

/**
 * Anchoring the audit chain outside the database.
 *
 * **The gap this closes.** `AuditLog`'s hash chain detects an entry that
 * was altered or removed *in place*. It cannot detect a log that was
 * rebuilt from scratch, because a rebuilt chain is a perfectly valid
 * chain — whoever can edit the state file can recompute every hash. Nor
 * can it detect entries truncated off the end, since a shorter chain is
 * still internally consistent.
 *
 * An anchor closes both. It is one value — the hash of the most recent
 * entry, which because of the chaining commits to every entry before it
 * — written somewhere the person who controls the database does not.
 * Later, the chain is re-derived and compared to what was published. If
 * they disagree, the log was rewritten, however tidy it now looks.
 *
 * **An anchor is only as good as the independence of where it goes.**
 * That is the whole property, and it is not something this file can
 * enforce — it is an operational decision:
 *
 * - Appending to a file on the same disk, writable by the same account,
 *   is close to worthless: the same person edits both.
 * - A file on a separate append-only volume, or one shipped off the box
 *   by a log collector, is meaningfully better.
 * - Emailing the hash to the firm's partners puts it in mailboxes the
 *   database administrator has no access to, and is probably the most
 *   practical option for a small firm.
 * - A third-party append-only store (or a public timestamping service)
 *   is the strongest, and is the natural next target to implement.
 *
 * `AuditAnchorTarget` is deliberately narrow — publish a value, list
 * what was published — so a firm can point it wherever their own threat
 * model requires.
 */
export interface AuditAnchorTarget {
  readonly name: string;
  /**
   * Records a commitment. Returns a receipt if the destination provides
   * one (a message id, a byte offset, a transaction id) — evidence the
   * publication actually happened, not just that this process tried.
   */
  publish(anchor: { sequence: number; headHash: string; anchoredAt: string }): Promise<{ receipt?: string }>;
  /**
   * Reads back what was published, for verification. Optional: some
   * destinations are write-only from here (an outbound email cannot be
   * read back), in which case verification uses the locally recorded
   * copy and the operator compares against the external one by hand.
   */
  readBack?(): Promise<AuditAnchorRecord[]>;
}

/**
 * How often to anchor, and the reasoning: an anchor bounds the window in
 * which a rewrite is undetectable. Anchor once a day and a rewrite of
 * anything older than today's first entry is caught; anchor hourly and
 * that window is an hour. Every anchor after the first costs almost
 * nothing (one hash, one append), so the limit is how much noise the
 * destination tolerates rather than anything technical.
 */
export const SUGGESTED_ANCHOR_INTERVAL_HOURS = 24;

/**
 * Publishing to more than one destination, because the point is
 * independence and a single destination is a single point of collusion.
 * A failure at one target does not stop the others — a partial anchor is
 * far better than none, and the caller is told exactly which succeeded.
 */
export class MultiAnchorTarget implements AuditAnchorTarget {
  readonly name: string;
  #targets: AuditAnchorTarget[];

  constructor(targets: AuditAnchorTarget[]) {
    if (targets.length === 0) throw new Error("MultiAnchorTarget needs at least one target");
    this.#targets = targets;
    this.name = targets.map((t) => t.name).join("+");
  }

  async publish(anchor: { sequence: number; headHash: string; anchoredAt: string }): Promise<{ receipt?: string }> {
    const receipts: string[] = [];
    const failures: string[] = [];
    for (const target of this.#targets) {
      try {
        const { receipt } = await target.publish(anchor);
        receipts.push(`${target.name}=${receipt ?? "ok"}`);
      } catch (err) {
        failures.push(`${target.name}: ${(err as Error).message}`);
      }
    }
    if (receipts.length === 0) {
      throw new Error(`every anchor destination failed — ${failures.join("; ")}`);
    }
    // Failures are carried in the receipt rather than swallowed, so a
    // half-published anchor is visible in the record itself.
    const note = failures.length ? ` (failed: ${failures.join("; ")})` : "";
    return { receipt: `${receipts.join(" ")}${note}` };
  }

  async readBack(): Promise<AuditAnchorRecord[]> {
    for (const target of this.#targets) {
      if (!target.readBack) continue;
      try {
        return await target.readBack();
      } catch {
        // Try the next readable target rather than failing verification
        // outright — one unreachable destination isn't evidence of anything.
      }
    }
    return [];
  }
}
