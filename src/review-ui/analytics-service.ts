import { AccessDeniedError, type Actor } from "../core/types.js";
import type { MatterStore, MatterStatus } from "../core/matters.js";
import type { InvoiceStore } from "../core/invoicing.js";
import type { BillingHoursStore } from "../core/billing-hours.js";
import type { UtilizationTracker, UtilizationTaskType } from "../core/utilization.js";
import type { AuthService } from "../core/auth.js";

/**
 * Backs the "Analytics" panel — a read-only, firm-wide view over data
 * every other panel already produces (matters, invoices, billing hours,
 * AI-utilization telemetry). Nothing here is a new write path or a new
 * fact about the firm; it's existing records re-aggregated for a
 * different question than any one matter's own panel answers ("who's
 * carrying the most open matters", "how much is overdue and by how
 * much", "is AI drafting time trending up or down").
 *
 * Deliberately **attorney-only**, same reasoning as `AuditService`/
 * `AccountsService`: this is a firm-wide rollup with no per-matter
 * scoping of its own (unlike, say, `InvoicingService.listOutstanding()`,
 * which silently omits matters a paralegal can't reach) — a view that
 * exists specifically to show the whole firm at once has no narrower
 * version that would mean anything, so rather than invent one it's
 * restricted to the role that already sees everything. A paralegal
 * wanting their own caseload already has that on the Cases panel,
 * scoped the normal way.
 *
 * Reads the underlying stores directly rather than going through
 * `MattersService`/`InvoicingService`/etc. — same pattern `AuditService`
 * uses over the raw `AuditLog` — because every one of those services
 * exists to add matter-level `AccessControl` scoping this panel
 * deliberately doesn't want.
 */
function requireAttorney(actor: Actor): void {
  if (actor.role !== "attorney") {
    throw new AccessDeniedError(`analytics is attorney-only (got role '${actor.role}')`);
  }
}

export interface CaseloadByAttorney {
  actorId: string;
  displayName: string;
  openMatters: number;
  closedMatters: number;
}

export interface InvoiceAgingBucket {
  bucket: "current" | "1-30" | "31-60" | "61-90" | "90+";
  count: number;
  totalCents: number;
}

export interface DailyUtilization {
  date: string;
  /** Minutes of AI-agent time started that day, by task type. Only entries with an endedAt contribute — an open-ended entry has no duration yet. */
  minutesByTaskType: Partial<Record<UtilizationTaskType, number>>;
}

export interface DailyBillableHours {
  date: string;
  hours: number;
}

const AGING_BUCKETS: InvoiceAgingBucket["bucket"][] = ["current", "1-30", "31-60", "61-90", "90+"];

function agingBucketFor(daysOverdue: number): InvoiceAgingBucket["bucket"] {
  if (daysOverdue <= 0) return "current";
  if (daysOverdue <= 30) return "1-30";
  if (daysOverdue <= 60) return "31-60";
  if (daysOverdue <= 90) return "61-90";
  return "90+";
}

function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 86_400_000);
}

export class AnalyticsService {
  #matters: MatterStore;
  #invoices: InvoiceStore;
  #billingHours: BillingHoursStore;
  #utilization: UtilizationTracker;
  #auth: AuthService;

  constructor(params: {
    matters: MatterStore;
    invoices: InvoiceStore;
    billingHours: BillingHoursStore;
    utilization: UtilizationTracker;
    auth: AuthService;
  }) {
    this.#matters = params.matters;
    this.#invoices = params.invoices;
    this.#billingHours = params.billingHours;
    this.#utilization = params.utilization;
    this.#auth = params.auth;
  }

  /**
   * Every account that is ever `responsibleAttorneyId` on a matter —
   * not just accounts with role `"attorney"`, since nothing enforces
   * that only an attorney account can be named responsible (a sole
   * practice might run otherwise) — plus an explicit "unassigned"
   * bucket, because an unowned matter is itself something worth seeing
   * on this panel rather than silently dropping from the count.
   */
  caseloadByAttorney(actor: Actor): CaseloadByAttorney[] {
    requireAttorney(actor);
    const displayNameByActorId = new Map(this.#auth.listUsers().map((u) => [u.actorId, u.displayName]));
    const byActorId = new Map<string, CaseloadByAttorney>();
    const bucketFor = (actorId: string): CaseloadByAttorney => {
      let existing = byActorId.get(actorId);
      if (!existing) {
        existing = { actorId, displayName: displayNameByActorId.get(actorId) ?? actorId, openMatters: 0, closedMatters: 0 };
        byActorId.set(actorId, existing);
      }
      return existing;
    };
    for (const matter of this.#matters.listAll()) {
      const entry = bucketFor(matter.responsibleAttorneyId ?? "(unassigned)");
      if (matter.status === "closed") entry.closedMatters++;
      else entry.openMatters++;
    }
    return [...byActorId.values()].sort((a, b) => b.openMatters - a.openMatters);
  }

  /** Firm-wide matter counts by status — the Analytics panel's headline tiles. */
  matterStatusCounts(actor: Actor): Record<MatterStatus, number> {
    requireAttorney(actor);
    const counts: Record<MatterStatus, number> = { prospective: 0, open: 0, closed: 0 };
    for (const matter of this.#matters.listAll()) counts[matter.status]++;
    return counts;
  }

  /**
   * Every unpaid, non-void, sent invoice bucketed by how overdue it is.
   * Same balance/overdue math as `InvoicingService.listOutstanding()`
   * (duplicated rather than imported from it, since that method's job
   * is per-matter-scoped delivery, not a firm-wide rollup) — the two
   * should never silently disagree about what "overdue" means.
   */
  invoiceAging(actor: Actor, asOf: Date = new Date()): InvoiceAgingBucket[] {
    requireAttorney(actor);
    const today = asOf.toISOString().slice(0, 10);
    const totalsByBucket = new Map<InvoiceAgingBucket["bucket"], { count: number; totalCents: number }>();
    for (const bucket of AGING_BUCKETS) totalsByBucket.set(bucket, { count: 0, totalCents: 0 });

    for (const invoice of this.#invoices.listAll()) {
      if (invoice.status !== "sent" && invoice.status !== "partially_paid") continue;
      const { balanceCents } = this.#invoices.totals(invoice.id);
      if (balanceCents <= 0) continue;
      const daysOverdue = invoice.dueDate && invoice.dueDate < today ? daysBetween(invoice.dueDate, today) : 0;
      const bucket = totalsByBucket.get(agingBucketFor(daysOverdue))!;
      bucket.count++;
      bucket.totalCents += balanceCents;
    }

    return AGING_BUCKETS.map((bucket) => ({ bucket, ...totalsByBucket.get(bucket)! }));
  }

  /**
   * Finished AI-agent time, by day and task type, over the trailing
   * `withinDays` (default 30). Bucketed by when the work *started*
   * (`startedAt`), same convention `TimeClock` uses for an overnight
   * shift — an entry belongs to the day it began. An entry still open
   * (`endedAt` undefined) contributes nothing yet, same as an open
   * time-clock shift never counting toward a total.
   */
  utilizationTrend(actor: Actor, options: { withinDays?: number; now?: Date } = {}): DailyUtilization[] {
    requireAttorney(actor);
    const withinDays = options.withinDays ?? 30;
    const now = options.now ?? new Date();
    const cutoff = new Date(now.getTime() - withinDays * 86_400_000);

    const byDate = new Map<string, DailyUtilization>();
    for (const entry of this.#utilization.all()) {
      if (!entry.endedAt) continue;
      const started = new Date(entry.startedAt);
      if (started < cutoff || started > now) continue;
      const date = entry.startedAt.slice(0, 10);
      let day = byDate.get(date);
      if (!day) {
        day = { date, minutesByTaskType: {} };
        byDate.set(date, day);
      }
      const minutes = (Date.parse(entry.endedAt) - Date.parse(entry.startedAt)) / 60_000;
      day.minutesByTaskType[entry.taskType] = (day.minutesByTaskType[entry.taskType] ?? 0) + minutes;
    }
    return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  }

  /** Billable hours logged per day, firm-wide, over the trailing `withinDays` (default 30). */
  billableHoursTrend(actor: Actor, options: { withinDays?: number; now?: Date } = {}): DailyBillableHours[] {
    requireAttorney(actor);
    const withinDays = options.withinDays ?? 30;
    const now = options.now ?? new Date();
    const cutoffDate = new Date(now.getTime() - withinDays * 86_400_000).toISOString().slice(0, 10);
    const today = now.toISOString().slice(0, 10);

    const byDate = new Map<string, number>();
    for (const entry of this.#billingHours.listAll()) {
      if (entry.date < cutoffDate || entry.date > today) continue;
      byDate.set(entry.date, (byDate.get(entry.date) ?? 0) + entry.hours);
    }
    return [...byDate.entries()]
      .map(([date, hours]) => ({ date, hours }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }
}
