import { AccessDeniedError, type Actor } from "../core/types.js";
import type { AuditLog } from "../core/audit.js";
import type { PayRate, PayrollStore, PayrollSummary, WorkedHoursEntry } from "../core/payroll.js";

/**
 * Backs the "Payroll" panel.
 *
 * Not matter-scoped — payroll has nothing to do with any client matter,
 * and routing it through `AccessControl`'s matter checks would be
 * miscategorising it. The gates that apply instead are about privacy
 * between colleagues:
 *
 * - **Setting a pay rate is attorney-only.** What someone is paid isn't
 *   a self-service field.
 * - **You can see your own hours and your own rate; only an attorney can
 *   see anyone else's, or run a firm-wide summary.** A paralegal being
 *   able to read a colleague's salary would be a straightforward privacy
 *   failure, and this is the one place in the app holding that data.
 * - Recording worked hours follows the same self-vs-attorney split as
 *   the staff schedule: log your own, or an attorney logs anyone's.
 */
function requireHuman(actor: Actor): void {
  if (actor.role === "system") {
    throw new AccessDeniedError("payroll is not available to the system credential");
  }
}

function requireSelfOrAttorney(actor: Actor, actorId: string, what: string): void {
  requireHuman(actor);
  if (actor.id !== actorId && actor.role !== "attorney") {
    throw new AccessDeniedError(`${what} for another person is attorney-only`);
  }
}

export class PayrollService {
  #store: PayrollStore;
  #auditLog: AuditLog;

  constructor(params: { store: PayrollStore; auditLog: AuditLog }) {
    this.#store = params.store;
    this.#auditLog = params.auditLog;
  }

  setRate(
    actor: Actor,
    actorId: string,
    params: { hourlyCents: number; effectiveFrom: string; note?: string },
  ): PayRate {
    requireHuman(actor);
    if (actor.role !== "attorney") {
      throw new AccessDeniedError("setting a pay rate is attorney-only");
    }
    const rate = this.#store.setRate({
      actorId,
      hourlyCents: params.hourlyCents,
      effectiveFrom: params.effectiveFrom,
      setBy: actor.id,
      ...(params.note ? { note: params.note } : {}),
    });
    this.#auditLog.append({
      actor,
      matterId: undefined,
      action: "pay_rate_set",
      detail: `subject=${actorId} hourlyCents=${rate.hourlyCents} effectiveFrom=${rate.effectiveFrom}`,
    });
    return rate;
  }

  listRates(actor: Actor, actorId: string): PayRate[] {
    requireSelfOrAttorney(actor, actorId, "viewing pay rates");
    return this.#store.listRates(actorId);
  }

  recordHours(
    actor: Actor,
    actorId: string,
    params: { date: string; hoursMilli: number; description: string },
  ): WorkedHoursEntry {
    requireSelfOrAttorney(actor, actorId, "recording worked hours");
    return this.#store.recordHours({
      actorId,
      date: params.date,
      hoursMilli: params.hoursMilli,
      description: params.description,
      recordedBy: actor.id,
    });
  }

  listHours(actor: Actor, actorId: string, fromDate?: string, toDate?: string): WorkedHoursEntry[] {
    requireSelfOrAttorney(actor, actorId, "viewing worked hours");
    return this.#store.listHours(actorId, fromDate, toDate);
  }

  deleteHours(actor: Actor, actorId: string, entryId: string): void {
    requireSelfOrAttorney(actor, actorId, "deleting worked hours");
    const owned = this.#store.listHours(actorId).some((e) => e.id === entryId);
    if (!owned) throw new Error(`no worked-hours entry '${entryId}' for '${actorId}'`);
    this.#store.deleteHours(entryId);
  }

  /**
   * Firm-wide gross pay for a period. Attorney-only, because it exposes
   * what everyone earns at once. Audited for the same reason.
   */
  summarize(actor: Actor, fromDate: string, toDate: string): PayrollSummary {
    requireHuman(actor);
    if (actor.role !== "attorney") {
      throw new AccessDeniedError("the firm-wide payroll summary is attorney-only");
    }
    const summary = this.#store.summarize(fromDate, toDate);
    this.#auditLog.append({
      actor,
      matterId: undefined,
      action: "payroll_summary_run",
      detail: `from=${fromDate} to=${toDate} people=${summary.lines.length} totalGrossPayCents=${summary.totalGrossPayCents} incomplete=${summary.incomplete}`,
    });
    return summary;
  }
}
