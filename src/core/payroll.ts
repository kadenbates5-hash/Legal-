/**
 * Staff payroll — what the firm pays its people.
 *
 * Deliberately separate from three things it's easy to confuse it with:
 *
 * - `billing-hours.ts` records **billable** time charged to a client.
 *   Payroll records **worked** time owed to an employee. Someone works
 *   forty hours and bills thirty-two; conflating the two produces both a
 *   wrong invoice and a wrong paycheck.
 * - `invoicing.ts` is money coming *in* from clients.
 * - `trust-ledger.ts` is client money the firm merely holds. Payroll must
 *   never touch it — paying staff from client funds is exactly the
 *   violation that ledger's no-overdraw rule exists to prevent, and
 *   there is no code path between the two.
 *
 * Rates are **historical**: a raise applies from its effective date
 * onward and never silently restates what someone was already paid, so
 * recomputing an old period gives the same answer it gave at the time.
 *
 * What this is emphatically **not**: a payroll *filing* system. It does
 * not compute tax withholding, employer contributions, overtime
 * eligibility, or benefits, and it does not remit anything to a tax
 * authority. It answers "how many hours, at what rate, so what is gross
 * pay" — the input a bookkeeper or payroll provider needs, not a
 * replacement for one.
 */
export class PayrollError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayrollError";
  }
}

export interface PayRate {
  readonly id: string;
  readonly actorId: string;
  readonly hourlyCents: number;
  /** ISO date this rate takes effect. The rate in force for a shift is the latest one on or before its date. */
  readonly effectiveFrom: string;
  readonly setBy: string;
  readonly setAt: string;
  readonly note: string | undefined;
}

export interface WorkedHoursEntry {
  readonly id: string;
  readonly actorId: string;
  /** ISO date the work was performed — this is what selects the applicable rate. */
  readonly date: string;
  /** Thousandths of an hour, so 7.5h is exact and no float is ever multiplied by money. */
  readonly hoursMilli: number;
  readonly description: string;
  readonly recordedBy: string;
  readonly recordedAt: string;
}

export interface PayrollLine {
  actorId: string;
  hoursMilli: number;
  /** Empty when every shift in the period had a rate; otherwise the dates that had none. */
  datesMissingRate: string[];
  grossPayCents: number;
}

export interface PayrollSummary {
  fromDate: string;
  toDate: string;
  lines: PayrollLine[];
  totalGrossPayCents: number;
  /** True when at least one worked shift had no rate in force — the total is understated until that's fixed. */
  incomplete: boolean;
}

export interface PayrollSnapshot {
  rates: PayRate[];
  workedHours: WorkedHoursEntry[];
  nextId: number;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function assertIsoDate(value: string, what: string): void {
  if (!ISO_DATE.test(value)) throw new PayrollError(`${what} must be an ISO date (YYYY-MM-DD)`);
}

export class PayrollStore {
  #rates: PayRate[] = [];
  #workedHours: WorkedHoursEntry[] = [];
  #nextId = 1;

  setRate(params: { actorId: string; hourlyCents: number; effectiveFrom: string; setBy: string; note?: string }): PayRate {
    if (!params.actorId.trim()) throw new PayrollError("actorId is required");
    if (!Number.isInteger(params.hourlyCents)) throw new PayrollError("hourly rate must be an integer number of cents");
    if (params.hourlyCents <= 0) throw new PayrollError("hourly rate must be positive");
    assertIsoDate(params.effectiveFrom, "effectiveFrom");

    const rate: PayRate = Object.freeze({
      id: `rate_${this.#nextId++}`,
      actorId: params.actorId.trim(),
      hourlyCents: params.hourlyCents,
      effectiveFrom: params.effectiveFrom,
      setBy: params.setBy,
      setAt: new Date().toISOString(),
      note: params.note?.trim() || undefined,
    });
    this.#rates.push(rate);
    return rate;
  }

  /** The rate in force on a given date: the latest one effective on or before it. */
  rateOn(actorId: string, date: string): PayRate | undefined {
    return this.#rates
      .filter((r) => r.actorId === actorId && r.effectiveFrom <= date)
      .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))
      .pop();
  }

  listRates(actorId: string): PayRate[] {
    return this.#rates.filter((r) => r.actorId === actorId).map((r) => ({ ...r }));
  }

  recordHours(params: {
    actorId: string;
    date: string;
    hoursMilli: number;
    description: string;
    recordedBy: string;
  }): WorkedHoursEntry {
    if (!params.actorId.trim()) throw new PayrollError("actorId is required");
    assertIsoDate(params.date, "date");
    if (!Number.isInteger(params.hoursMilli) || params.hoursMilli <= 0) {
      throw new PayrollError("hours must be a positive integer number of thousandths of an hour");
    }
    if (!params.description.trim()) throw new PayrollError("worked hours need a description");

    const entry: WorkedHoursEntry = Object.freeze({
      id: `worked_${this.#nextId++}`,
      actorId: params.actorId.trim(),
      date: params.date,
      hoursMilli: params.hoursMilli,
      description: params.description.trim(),
      recordedBy: params.recordedBy,
      recordedAt: new Date().toISOString(),
    });
    this.#workedHours.push(entry);
    return entry;
  }

  listHours(actorId: string, fromDate?: string, toDate?: string): WorkedHoursEntry[] {
    return this.#workedHours
      .filter((e) => e.actorId === actorId)
      .filter((e) => (!fromDate || e.date >= fromDate) && (!toDate || e.date <= toDate))
      .map((e) => ({ ...e }));
  }

  deleteHours(entryId: string): void {
    this.#workedHours = this.#workedHours.filter((e) => e.id !== entryId);
  }

  /**
   * Gross pay for a period, per person.
   *
   * Each shift is priced at the rate in force *on the day it was worked*,
   * not today's rate, so a raise never retroactively restates a period
   * that has already been paid.
   *
   * A shift with no rate on record contributes hours but no money, and
   * the date is reported in `datesMissingRate` with `incomplete: true`.
   * Silently pricing it at zero would produce a confidently wrong
   * paycheck; this makes the gap visible instead.
   */
  summarize(fromDate: string, toDate: string): PayrollSummary {
    assertIsoDate(fromDate, "fromDate");
    assertIsoDate(toDate, "toDate");
    if (fromDate > toDate) throw new PayrollError("fromDate must not be after toDate");

    const inPeriod = this.#workedHours.filter((e) => e.date >= fromDate && e.date <= toDate);
    const byActor = new Map<string, PayrollLine>();

    for (const entry of inPeriod) {
      const line = byActor.get(entry.actorId) ?? {
        actorId: entry.actorId,
        hoursMilli: 0,
        datesMissingRate: [],
        grossPayCents: 0,
      };
      line.hoursMilli += entry.hoursMilli;
      const rate = this.rateOn(entry.actorId, entry.date);
      if (rate) {
        line.grossPayCents += Math.round((entry.hoursMilli * rate.hourlyCents) / 1000);
      } else if (!line.datesMissingRate.includes(entry.date)) {
        line.datesMissingRate.push(entry.date);
      }
      byActor.set(entry.actorId, line);
    }

    const lines = [...byActor.values()].sort((a, b) => a.actorId.localeCompare(b.actorId));
    for (const line of lines) line.datesMissingRate.sort();
    return {
      fromDate,
      toDate,
      lines,
      totalGrossPayCents: lines.reduce((sum, l) => sum + l.grossPayCents, 0),
      incomplete: lines.some((l) => l.datesMissingRate.length > 0),
    };
  }

  toSnapshot(): PayrollSnapshot {
    return {
      rates: this.#rates.map((r) => ({ ...r })),
      workedHours: this.#workedHours.map((e) => ({ ...e })),
      nextId: this.#nextId,
    };
  }

  static fromSnapshot(snapshot: PayrollSnapshot): PayrollStore {
    const store = new PayrollStore();
    store.#rates = (snapshot.rates ?? []).map((r) => Object.freeze({ ...r }));
    store.#workedHours = (snapshot.workedHours ?? []).map((e) => Object.freeze({ ...e }));
    store.#nextId = snapshot.nextId ?? 1;
    return store;
  }
}
