import { AccessDeniedError, type Actor } from "../core/types.js";
import type {
  AnchorVerification,
  AuditAnchorRecord,
  AuditEntry,
  AuditFilter,
  AuditLog,
  IntegrityReport,
} from "../core/audit.js";
import type { AuditAnchorTarget } from "../core/audit-anchor.js";

/**
 * Backs Docket's "Audit Log" panel. `AuditLog.read()` already requires an
 * explicit counsel-aware reader role (`"attorney"` vs.
 * `"system_admin_no_content"`), but that's a parameter any caller could
 * pass — this service is the actual attorney-only gate: every method
 * requires an attorney actor, same as `ReviewGateService`/`AccountsService`,
 * and always reads with role `"attorney"` since the caller is already
 * confirmed to be one.
 */
function requireAttorney(actor: Actor): void {
  if (actor.role !== "attorney") {
    throw new AccessDeniedError(`the audit log is attorney-only (got role '${actor.role}')`);
  }
}

/** The integrity report plus what the external anchors say, which is the part the chain alone can't tell you. */
export interface FullIntegrityReport extends IntegrityReport {
  anchoring:
    | { configured: false }
    | ({ configured: true; target: string; lastAnchor: AuditAnchorRecord | undefined } & AnchorVerification);
}

/** The log entry anchoring itself writes — excluded when deciding whether anything new has happened. */
const ANCHOR_ACTION = "audit_anchored";

export class AuditService {
  #auditLog: AuditLog;
  #anchorTarget: AuditAnchorTarget | undefined;
  /** Locally recorded anchors, persisted with the rest of system state. Compared against the external copy. */
  #anchors: AuditAnchorRecord[];

  constructor(auditLog: AuditLog, options: { anchorTarget?: AuditAnchorTarget; anchors?: AuditAnchorRecord[] } = {}) {
    this.#auditLog = auditLog;
    this.#anchorTarget = options.anchorTarget;
    this.#anchors = options.anchors ?? [];
  }

  /** The locally held anchor records, so the persistence layer can save them. */
  get anchors(): readonly AuditAnchorRecord[] {
    return this.#anchors;
  }

  /**
   * Publishes the current head hash to the configured destination.
   *
   * Anchoring an unchanged log is refused rather than silently repeated:
   * a run of identical anchors adds no evidence and buries the ones that
   * do. Nothing to anchor is a normal outcome, not an error, so it
   * reports rather than throws.
   */
  async anchorNow(actor: Actor): Promise<{ anchored: boolean; reason?: string; anchor?: AuditAnchorRecord }> {
    requireAttorney(actor);
    if (!this.#anchorTarget) return { anchored: false, reason: "no anchor destination is configured" };

    const headHash = this.#auditLog.headHash();
    if (!headHash) return { anchored: false, reason: "there is nothing in the log to anchor yet" };

    const sequence = this.#auditLog.count() - 1;
    const last = this.#anchors.at(-1);
    // Anchoring writes its own audit entry, so the head hash always
    // differs from the last anchor's. "Anything new" therefore means
    // anything that isn't itself an anchor — otherwise a nightly job
    // would anchor forever on a completely idle system, and the
    // destination would fill with anchors of anchors, burying the ones
    // that actually attest to work.
    if (last && this.#auditLog.countSince(last.sequence, [ANCHOR_ACTION]) === 0) {
      return { anchored: false, reason: `already anchored at sequence ${last.sequence} — nothing new has happened since` };
    }

    const anchoredAt = new Date().toISOString();
    // Published *before* it is recorded locally: a local record of an
    // anchor that never left the building would be a false assurance,
    // and is worse than no record at all.
    const { receipt } = await this.#anchorTarget.publish({ sequence, headHash, anchoredAt });
    const anchor: AuditAnchorRecord = {
      sequence,
      headHash,
      anchoredAt,
      destination: this.#anchorTarget.name,
      receipt,
    };
    this.#anchors.push(anchor);

    // Logged like anything else — and note this entry lands *after* the
    // anchored sequence, so it doesn't invalidate what was just published.
    this.#auditLog.append({
      actor,
      matterId: undefined,
      action: ANCHOR_ACTION,
      detail: `sequence=${sequence} headHash=${headHash.slice(0, 16)}… destination=${anchor.destination}`,
    });
    return { anchored: true, anchor };
  }

  list(actor: Actor, filter?: { matterId?: string } & AuditFilter): AuditEntry[] {
    requireAttorney(actor);
    return this.#auditLog.read("attorney", filter);
  }

  /**
   * Checks the hash chain and reports where, if anywhere, it breaks.
   *
   * Exposed to attorneys rather than kept as an internal ops check
   * because the people who need to be able to say "this record is
   * intact" are the ones answerable for it. It is deliberately a
   * *report*, not a repair: there is no code path that rewrites a
   * broken chain to make it verify again, since that is
   * indistinguishable from covering up whatever broke it.
   */
  async verifyIntegrity(actor: Actor): Promise<FullIntegrityReport> {
    requireAttorney(actor);
    // Not itself audited: verification is a read, and logging every
    // check would grow the log it is checking on every page load.
    const chain = this.#auditLog.verifyIntegrity();
    if (!this.#anchorTarget) return { ...chain, anchoring: { configured: false } };

    // Prefer the destination's own copy over the local one. Checking the
    // log against a record kept beside it proves nothing; the external
    // copy is the entire point. Fall back to the local record only when
    // the destination is write-only (email), which is stated as such.
    let anchors = this.#anchors;
    if (this.#anchorTarget.readBack) {
      try {
        const external = await this.#anchorTarget.readBack();
        if (external.length > 0) anchors = external;
      } catch {
        // An unreachable destination isn't evidence of tampering; fall
        // back to the local record rather than reporting a false alarm.
      }
    }

    return {
      ...chain,
      anchoring: {
        configured: true,
        target: this.#anchorTarget.name,
        lastAnchor: anchors.at(-1),
        ...this.#auditLog.verifyAgainstAnchors(anchors),
      },
    };
  }
}
