import { randomBytes } from "node:crypto";
import type { ConflictChecker } from "./conflicts.js";
import { addDaysToCalendarDate, isCalendarDate, todayIn } from "./calendar-date.js";

/**
 * Self-service booking requests: what a prospective client submits from
 * the public booking page (`public/book.html`) before anyone at the firm
 * has spoken to them.
 *
 * A request is deliberately **not** an appointment. Nothing a member of
 * the public submits lands on an attorney's calendar on its own: staff
 * accept a request, choosing the exact time, and only then is an
 * `Appointment` booked through `SchedulingService` — with its normal
 * business-hours and double-booking checks. Same principle as the review
 * gate: a person decides.
 *
 * What it collects is deliberately narrow, because it's pre-retention:
 * who they are and how to reach them, a matter *type* from a fixed list,
 * a preferred day and part of day, and the other party's name — that
 * last one only so the firm-wide conflicts screen can run before anyone
 * meets them. There is no free-text "what happened" box. Inviting a
 * stranger to narrate facts before the firm has run conflicts or taken
 * the matter is exactly what the receptionist is built to stop
 * (`pre_retention_factual_narrative`), and a web form shouldn't undo it.
 */
export type BookingMatterType = "criminal_defense" | "dui" | "traffic" | "juvenile" | "expungement" | "other";
export const BOOKING_MATTER_TYPES: Record<BookingMatterType, string> = {
  criminal_defense: "Criminal charge",
  dui: "DUI / DWI",
  traffic: "Traffic ticket",
  juvenile: "Juvenile matter",
  expungement: "Clearing a record (expungement)",
  other: "Something else",
};
export type BookingTimeOfDay = "morning" | "afternoon" | "any";
export type BookingRequestStatus = "pending" | "accepted" | "declined";

export interface BookingConflictSummary {
  /** True when any hit needs an attorney before the firm proceeds — only an attorney can accept such a request. */
  requiresAttorneyReview: boolean;
  hits: Array<{ matterId: string; matterTitle: string; matchedName: string; severity: string; explanation: string }>;
}

export interface BookingRequest {
  readonly id: string;
  readonly createdAt: string;
  name: string;
  email: string | undefined;
  phone: string | undefined;
  matterType: BookingMatterType;
  otherPartyName: string | undefined;
  preferredDate: string;
  preferredTime: BookingTimeOfDay;
  status: BookingRequestStatus;
  /** Never shown to the requester — a conflict is the firm's to assess, and saying so would itself disclose a client. */
  conflict: BookingConflictSummary;
  decidedBy: string | undefined;
  decidedAt: string | undefined;
  appointmentId: string | undefined;
  declineReason: string | undefined;
}

export class BookingRequestError extends Error {
  constructor(
    message: string,
    readonly kind: "invalid" | "not_found" | "conflict" | "busy",
  ) {
    super(message);
    this.name = "BookingRequestError";
  }
}

export interface BookingSubmission {
  name: string;
  email?: string;
  phone?: string;
  matterType: string;
  otherPartyName?: string;
  preferredDate: string;
  preferredTime: string;
}

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]{1,64}@[^\s@<>()[\]\\,;:"]{1,255}\.[a-z]{2,}$/i;
const PHONE_RE = /^\+?[0-9 ().-]{7,20}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Letters (any script), spaces and the punctuation real names use. Rules out markup and links in a field staff will read. */
const NAME_RE = /^[\p{L}\p{M}][\p{L}\p{M} .,'’&-]*$/u;

/** How far ahead someone can ask for a day. Further out is a phone call, not a web form. */
export const BOOKING_MAX_DAYS_AHEAD = 60;
/** Beyond this many undecided requests the form stops accepting more, rather than letting a flood bury real ones. */
export const BOOKING_MAX_PENDING = 200;

/** The form shows this message to the person filling it in, so it says which box. */
function clean(value: string | undefined, max: number, label: string): string | undefined {
  const trimmed = (value ?? "").replace(/\s+/g, " ").trim();
  if (!trimmed) return undefined;
  if (trimmed.length > max) throw new BookingRequestError(`${label} can be at most ${max} characters.`, "invalid");
  return trimmed;
}

/** Validates and normalizes a public submission. Throws `BookingRequestError` ("invalid") with a reason the form can show. */
export function validateBookingSubmission(
  input: BookingSubmission,
  now: Date = new Date(),
  /**
   * The firm's zone. "Today" is the firm's day: on a server in UTC, a New
   * York visitor choosing today after 7pm was told to "choose a day within
   * the next 60 days", because the server was already on tomorrow.
   * Absent, this machine's day, as before.
   */
  timeZone?: string,
): Omit<BookingRequest, "id" | "createdAt" | "status" | "conflict" | "decidedBy" | "decidedAt" | "appointmentId" | "declineReason"> {
  const name = clean(input.name, 100, "Your name");
  if (!name || !NAME_RE.test(name)) throw new BookingRequestError("Please enter your name.", "invalid");

  const email = clean(input.email, 254, "The email address");
  if (email && !EMAIL_RE.test(email)) throw new BookingRequestError("That email address doesn't look right.", "invalid");
  const phone = clean(input.phone, 20, "The phone number");
  if (phone && !PHONE_RE.test(phone)) throw new BookingRequestError("That phone number doesn't look right.", "invalid");
  if (!email && !phone) throw new BookingRequestError("Please leave an email address or a phone number so we can confirm.", "invalid");

  if (!(input.matterType in BOOKING_MATTER_TYPES)) throw new BookingRequestError("Please choose what this is about.", "invalid");

  const otherPartyName = clean(input.otherPartyName, 120, "The other party's name");
  if (otherPartyName && !NAME_RE.test(otherPartyName)) {
    throw new BookingRequestError("Please enter only a name for the other party.", "invalid");
  }

  // A pattern alone let "2026-02-30" through, as a day that sorts inside the window.
  if (!DATE_RE.test(input.preferredDate) || !isCalendarDate(input.preferredDate)) {
    throw new BookingRequestError("Please choose a day.", "invalid");
  }
  const today = todayIn(timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone, now);
  const latest = addDaysToCalendarDate(today, BOOKING_MAX_DAYS_AHEAD);
  if (input.preferredDate < today || input.preferredDate > latest) {
    throw new BookingRequestError(`Please choose a day within the next ${BOOKING_MAX_DAYS_AHEAD} days.`, "invalid");
  }
  if (!["morning", "afternoon", "any"].includes(input.preferredTime)) {
    throw new BookingRequestError("Please choose a time of day.", "invalid");
  }

  return {
    name,
    email,
    phone,
    matterType: input.matterType as BookingMatterType,
    otherPartyName,
    preferredDate: input.preferredDate,
    preferredTime: input.preferredTime as BookingTimeOfDay,
  };
}

export class BookingRequestStore {
  #requests = new Map<string, BookingRequest>();

  /**
   * Records a validated submission, screening the requester and the other
   * party against every matter in the firm. The requester is screened as
   * the would-be client and the other party as adverse — the reading that
   * surfaces a Rule 1.7 conflict in either direction.
   */
  submit(input: BookingSubmission, options: { conflictChecker?: ConflictChecker; now?: Date; timeZone?: string } = {}): BookingRequest {
    const now = options.now ?? new Date();
    const valid = validateBookingSubmission(input, now, options.timeZone);
    if (this.list().filter((r) => r.status === "pending").length >= BOOKING_MAX_PENDING) {
      throw new BookingRequestError("We can't take more requests online right now. Please call the office.", "busy");
    }

    const names = [valid.name, ...(valid.otherPartyName ? [valid.otherPartyName] : [])];
    const result = options.conflictChecker?.check({
      names,
      roleByName: { [valid.name]: "client", ...(valid.otherPartyName ? { [valid.otherPartyName]: "adverse" as const } : {}) },
    });

    const request: BookingRequest = {
      id: `book_${randomBytes(6).toString("hex")}`,
      createdAt: now.toISOString(),
      ...valid,
      status: "pending",
      conflict: {
        requiresAttorneyReview: result?.requiresAttorneyReview ?? false,
        hits: (result?.hits ?? []).map((h) => ({
          matterId: h.matterId,
          matterTitle: h.matterTitle,
          matchedName: h.matchedName,
          severity: h.severity,
          explanation: h.explanation,
        })),
      },
      decidedBy: undefined,
      decidedAt: undefined,
      appointmentId: undefined,
      declineReason: undefined,
    };
    this.#requests.set(request.id, request);
    return request;
  }

  get(id: string): BookingRequest {
    const request = this.#requests.get(id);
    if (!request) throw new BookingRequestError(`no booking request '${id}'`, "not_found");
    return request;
  }

  /** Pending first (oldest first, so nobody waits longest), then decided ones, newest first. */
  list(): BookingRequest[] {
    const all = [...this.#requests.values()];
    const pending = all.filter((r) => r.status === "pending").sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const decided = all.filter((r) => r.status !== "pending").sort((a, b) => (b.decidedAt ?? "").localeCompare(a.decidedAt ?? ""));
    return [...pending, ...decided];
  }

  markAccepted(id: string, decidedBy: string, appointmentId: string, at: Date = new Date()): BookingRequest {
    const request = this.#requirePending(id);
    request.status = "accepted";
    request.decidedBy = decidedBy;
    request.decidedAt = at.toISOString();
    request.appointmentId = appointmentId;
    return request;
  }

  markDeclined(id: string, decidedBy: string, reason: string | undefined, at: Date = new Date()): BookingRequest {
    const request = this.#requirePending(id);
    request.status = "declined";
    request.decidedBy = decidedBy;
    request.decidedAt = at.toISOString();
    request.declineReason = reason?.trim() || undefined;
    return request;
  }

  #requirePending(id: string): BookingRequest {
    const request = this.get(id);
    if (request.status !== "pending") {
      throw new BookingRequestError(`booking request '${id}' was already ${request.status}`, "conflict");
    }
    return request;
  }

  toSnapshot(): BookingRequest[] {
    return [...this.#requests.values()].map((r) => ({ ...r, conflict: { ...r.conflict, hits: [...r.conflict.hits] } }));
  }

  static fromSnapshot(snapshot: BookingRequest[] | undefined): BookingRequestStore {
    const store = new BookingRequestStore();
    for (const r of snapshot ?? []) store.#requests.set(r.id, { ...r, conflict: { ...r.conflict, hits: [...r.conflict.hits] } });
    return store;
  }
}

/**
 * A sliding-window count per key (the client IP), for the one public form
 * that writes data. Separate from `LoginThrottle`, which counts *failures*
 * and locks out; here every submission counts, and the answer is simply
 * "not now".
 */
export class SubmissionLimiter {
  #hits = new Map<string, number[]>();
  #max: number;
  #windowMs: number;
  #now: () => number;

  constructor(options: { max?: number; windowMs?: number; now?: () => number } = {}) {
    this.#max = options.max ?? 5;
    this.#windowMs = options.windowMs ?? 60 * 60 * 1000;
    this.#now = options.now ?? (() => Date.now());
  }

  /** Records an attempt and says whether it may proceed. */
  allow(key: string): boolean {
    const now = this.#now();
    const recent = (this.#hits.get(key) ?? []).filter((t) => now - t < this.#windowMs);
    if (recent.length >= this.#max) {
      this.#hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.#hits.set(key, recent);
    if (this.#hits.size > 10_000) this.#sweep(now);
    return true;
  }

  #sweep(now: number): void {
    for (const [key, times] of this.#hits) {
      if (!times.some((t) => now - t < this.#windowMs)) this.#hits.delete(key);
    }
  }
}
