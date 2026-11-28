import { randomBytes } from "node:crypto";
import type { AuditLog } from "../core/audit.js";
import type { AuthService } from "../core/auth.js";
import type { BillingHoursStore } from "../core/billing-hours.js";
import type { MatterStore } from "../core/matters.js";
import type { TrustLedger } from "../core/trust-ledger.js";
import { AccessDeniedError, type Actor } from "../core/types.js";
import { DataImportError, planImport, type ImportKind, type ImportPlan, type PlannedImport } from "../core/data-import.js";

/** 5 MB of CSV is tens of thousands of rows, far past what one import should be. */
export const MAX_IMPORT_CSV_BYTES = 5 * 1024 * 1024;

export interface ImportRequest {
  kind: ImportKind;
  csv: string;
  /** Column overrides, field → header text ("" for "not in this file"). */
  mapping?: Record<string, string>;
  /** Shown in the audit entry only; never used to decide anything. */
  fileName?: string;
}

export interface ImportResult {
  importId: string;
  kind: ImportKind;
  created: number;
  skipped: number;
  leftOut: number;
  matterIds: string[];
  hoursCreated?: number;
}

/**
 * Backs the "Import" panel — see `core/data-import.ts` for what the
 * import will and won't do. This class is the gate around it:
 *
 * - **Attorney-only, preview included.** An import writes matter records
 *   (whose party lists drive every future conflicts check — the same
 *   reason editing one is attorney-only) and credits hours to colleagues
 *   by name. The preview is gated too, because it runs a firm-wide
 *   conflicts screen and reports what it finds.
 * - **Commit only what was previewed.** `commit()` re-plans from the same
 *   file and refuses with `stale` if the plan's fingerprint differs from
 *   the one the attorney saw, and refuses outright if the screen found
 *   conflicts the attorney hasn't acknowledged.
 * - **Audited twice over.** Each created matter gets its own
 *   `matter_imported` entry (so its history starts with where it came
 *   from), each matter receiving time gets one `billing_hours_imported`
 *   entry with a count and total, and the import as a whole gets a
 *   `data_import_committed` summary. A preview writes nothing.
 */
export class ImportService {
  #matters: MatterStore;
  #billingHours: BillingHoursStore;
  #auth: AuthService;
  #auditLog: AuditLog;
  #trust: TrustLedger | undefined;
  #matterIdsInUse: () => Iterable<string>;
  #retentionYears: number;
  #now: () => Date;
  #timeZone: string | undefined;

  constructor(params: {
    matters: MatterStore;
    billingHours: BillingHoursStore;
    auth: AuthService;
    auditLog: AuditLog;
    trust?: TrustLedger;
    /** Matter ids other stores already use, so the preview can say a new record will describe existing work. */
    matterIdsInUse?: () => Iterable<string>;
    retentionYears?: number;
    now?: () => Date;
    /** The firm's zone — see `ImportContext.timeZone`. */
    timeZone?: string;
  }) {
    this.#timeZone = params.timeZone;
    this.#matters = params.matters;
    this.#billingHours = params.billingHours;
    this.#auth = params.auth;
    this.#auditLog = params.auditLog;
    this.#trust = params.trust;
    this.#matterIdsInUse = params.matterIdsInUse ?? (() => []);
    this.#retentionYears = params.retentionYears ?? 0;
    this.#now = params.now ?? (() => new Date());
  }

  preview(actor: Actor, request: ImportRequest): ImportPlan {
    requireAttorney(actor);
    return this.#plan(request).plan;
  }

  commit(actor: Actor, request: ImportRequest & { fingerprint: string; acknowledgeConflicts?: boolean }): ImportResult {
    requireAttorney(actor);
    const planned = this.#plan(request);
    const { plan } = planned;
    if (plan.missingRequired.length > 0) {
      throw new DataImportError(`choose a column for: ${plan.missingRequired.join(", ")}`, "invalid");
    }
    if (!request.fingerprint || request.fingerprint !== plan.fingerprint) {
      throw new DataImportError(
        "the records or the file changed since you previewed this import, so it wasn't run. Preview it again and check the result.",
        "stale",
      );
    }
    if (plan.needsConflictAcknowledgement && request.acknowledgeConflicts !== true) {
      throw new DataImportError("the conflicts screen found possible conflicts — read them and tick the acknowledgement before importing", "invalid");
    }
    if (plan.counts.create === 0) {
      throw new DataImportError("nothing in this file would be imported", "invalid");
    }

    const importId = `imp_${randomBytes(6).toString("hex")}`;
    const fileLabel = request.fileName ? ` file=${request.fileName.replace(/[\r\n]/g, " ").slice(0, 120)}` : "";
    const source = plan.sourceGuess ? ` source=${plan.sourceGuess}` : "";

    if (request.kind === "matters") {
      this.#applyMatters(actor, planned, importId, source);
    } else {
      this.#applyTime(actor, planned, importId);
    }

    const matterIds = [...new Set(plan.rows.filter((r) => r.action === "create" && r.matterId).map((r) => r.matterId!))];
    const conflictRows = plan.rows.filter((r) => r.action === "create" && r.conflicts?.length).length;
    this.#auditLog.append({
      actor,
      matterId: undefined,
      action: "data_import_committed",
      detail:
        `import=${importId} kind=${request.kind}${source}${fileLabel} created=${plan.counts.create} skipped=${plan.counts.skip} left_out=${plan.counts.error}` +
        (request.kind === "matters" ? ` conflict_rows=${conflictRows} conflicts_acknowledged=${plan.needsConflictAcknowledgement}` : ` hours=${plan.hoursToCreate ?? 0}`),
    });

    return {
      importId,
      kind: request.kind,
      created: plan.counts.create,
      skipped: plan.counts.skip,
      leftOut: plan.counts.error,
      matterIds,
      ...(plan.hoursToCreate !== undefined ? { hoursCreated: plan.hoursToCreate } : {}),
    };
  }

  #applyMatters(actor: Actor, planned: PlannedImport, importId: string, source: string): void {
    // Validated in full before anything is written, so the only way this
    // loop fails is a bug — and upsert of a validated record doesn't throw.
    for (const payload of planned.matters) {
      const record = this.#matters.upsert(payload.matterId, payload.input, {
        ...(payload.openedAt ? { openedAt: payload.openedAt } : {}),
        ...(payload.closedAt ? { closedAt: payload.closedAt } : {}),
      });
      const parties = record.parties.map((p) => `${p.role}:${p.name}`).join("; ");
      this.#auditLog.append({
        actor,
        matterId: record.matterId,
        action: "matter_imported",
        detail: `import=${importId}${source} title=${record.title} status=${record.status}${parties ? ` parties=${parties}` : ""}`,
      });
    }
  }

  #applyTime(actor: Actor, planned: PlannedImport, importId: string): void {
    const perMatter = new Map<string, { count: number; hours: number }>();
    for (const entry of planned.timeEntries) {
      this.#billingHours.log(entry);
      const tally = perMatter.get(entry.matterId) ?? { count: 0, hours: 0 };
      tally.count++;
      tally.hours += entry.hours;
      perMatter.set(entry.matterId, tally);
    }
    for (const [matterId, tally] of perMatter) {
      this.#auditLog.append({
        actor,
        matterId,
        action: "billing_hours_imported",
        detail: `import=${importId} entries=${tally.count} hours=${Math.round(tally.hours * 100) / 100}`,
      });
    }
  }

  #plan(request: ImportRequest): PlannedImport {
    if (typeof request.csv !== "string" || request.csv.trim() === "") {
      throw new DataImportError("choose a CSV file to import", "invalid");
    }
    if (Buffer.byteLength(request.csv, "utf8") > MAX_IMPORT_CSV_BYTES) {
      throw new DataImportError("this file is larger than 5 MB; split it and import the parts one at a time", "invalid");
    }
    const mapping: Record<string, string> = {};
    for (const [field, header] of Object.entries(request.mapping ?? {})) {
      if (typeof header === "string") mapping[field] = header;
    }
    return planImport(
      request.kind,
      request.csv,
      {
        matters: this.#matters,
        people: this.#auth.listUsers().map((u) => ({
          actorId: u.actorId,
          username: u.username,
          displayName: u.displayName,
          role: u.role,
          disabled: u.disabled,
        })),
        billingEntries: this.#billingHours.listAll(),
        ...(this.#trust ? { trustBalanceCents: (id: string) => this.#trust!.balanceForMatter(id) } : {}),
        matterIdsInUse: new Set(this.#matterIdsInUse()),
        retentionYears: this.#retentionYears,
        now: this.#now(),
        ...(this.#timeZone ? { timeZone: this.#timeZone } : {}),
      },
      { mapping },
    );
  }
}

function requireAttorney(actor: Actor): void {
  if (actor.role !== "attorney") {
    throw new AccessDeniedError(`importing records is attorney-only (got role '${actor.role}')`);
  }
}
