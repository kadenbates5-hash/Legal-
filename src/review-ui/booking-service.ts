import type { AuditLog } from "../core/audit.js";
import { todayIn } from "../core/calendar-date.js";
import type { ConflictChecker } from "../core/conflicts.js";
import type { SchedulingService } from "../core/scheduling.js";
import type { FirmConfig } from "../config/firm-config.js";
import { AccessDeniedError, type Actor } from "../core/types.js";
import {
  BOOKING_MATTER_TYPES,
  BOOKING_MAX_DAYS_AHEAD,
  BookingRequestError,
  SubmissionLimiter,
  type BookingRequest,
  type BookingRequestStore,
  type BookingSubmission,
} from "../core/booking-requests.js";

/** Who the public form is recorded as in the audit log — a pre-credential party, never "system". */
const PUBLIC_FORM_ACTOR: Actor = { id: "public-booking-form", role: "anonymous" };
const STAFF_ROLES = new Set(["attorney", "paralegal", "receptionist"]);

/**
 * The self-service booking page's two trust boundaries in one class, the
 * same split as `ESignatureService`:
 *
 * - **Public** (`publicConfig`/`submitPublic`): no session, no actor.
 *   Whatever arrives is validated, rate-limited per IP, screened for
 *   conflicts, and stored as a *request* — and the response says nothing
 *   about what the screen found, since "we can't take you" would itself
 *   disclose that the firm represents someone.
 * - **Staff** (`list`/`accept`/`decline`): the people who already book
 *   consultations. Accepting books a real appointment through
 *   `SchedulingService` (business hours, double-booking) *before* the
 *   request is marked accepted, so a refused booking leaves the request
 *   pending rather than claiming a time nobody holds. A request the
 *   conflicts screen flagged can only be accepted by an attorney.
 */
export class BookingService {
  #store: BookingRequestStore;
  #scheduling: SchedulingService;
  #auditLog: AuditLog;
  #conflictChecker: ConflictChecker | undefined;
  #limiter: SubmissionLimiter;
  #firmConfig: FirmConfig | undefined;
  #now: () => Date;
  #timeZone: string | undefined;

  constructor(params: {
    store: BookingRequestStore;
    scheduling: SchedulingService;
    auditLog: AuditLog;
    conflictChecker?: ConflictChecker;
    limiter?: SubmissionLimiter;
    firmConfig?: FirmConfig;
    now?: () => Date;
    /** The firm's zone — which day "today" is for the form's window. Defaults to the firm config's business-hours zone. */
    timeZone?: string;
  }) {
    this.#store = params.store;
    this.#scheduling = params.scheduling;
    this.#auditLog = params.auditLog;
    this.#conflictChecker = params.conflictChecker;
    this.#limiter = params.limiter ?? new SubmissionLimiter();
    this.#firmConfig = params.firmConfig;
    this.#now = params.now ?? (() => new Date());
    this.#timeZone = params.timeZone ?? params.firmConfig?.businessHours?.timezone;
  }

  /** What the public page needs to draw itself. Nothing about attorneys, calendars or matters. */
  publicConfig(): {
    firmName: string | undefined;
    phone: string | undefined;
    matterTypes: Array<{ id: string; label: string }>;
    maxDaysAhead: number;
    officeDays: number[] | undefined;
    /** The firm's today, so the page's date picker starts where the server's check does. */
    today: string;
  } {
    return {
      today: todayIn(this.#timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone, this.#now()),
      firmName: this.#firmConfig?.firmName,
      phone: this.#firmConfig?.letterhead?.phone,
      matterTypes: Object.entries(BOOKING_MATTER_TYPES).map(([id, label]) => ({ id, label })),
      maxDaysAhead: BOOKING_MAX_DAYS_AHEAD,
      officeDays: this.#firmConfig?.businessHours.days,
    };
  }

  /**
   * Takes a public submission. `honeypot` is a field real people never see
   * or fill; a filled one is answered exactly like a success, so a bot
   * learns nothing, and stored nowhere.
   */
  submitPublic(input: BookingSubmission, context: { ip: string; honeypot?: string }): { received: true } {
    if (context.honeypot && context.honeypot.trim()) return { received: true };
    if (!this.#limiter.allow(context.ip)) {
      throw new BookingRequestError("Too many requests from this connection. Please try again later, or call the office.", "busy");
    }
    const request = this.#store.submit(input, { ...(this.#conflictChecker ? { conflictChecker: this.#conflictChecker } : {}), now: this.#now(), ...(this.#timeZone ? { timeZone: this.#timeZone } : {}) });
    this.#auditLog.append({
      actor: PUBLIC_FORM_ACTOR,
      matterId: undefined,
      action: "booking_request_received",
      detail: `request=${request.id} type=${request.matterType} preferred=${request.preferredDate}/${request.preferredTime} conflict_review=${request.conflict.requiresAttorneyReview}`,
    });
    return { received: true };
  }

  list(actor: Actor): BookingRequest[] {
    this.#requireStaff(actor);
    return this.#store.list();
  }

  accept(actor: Actor, id: string, params: { startTime: Date; durationMinutes?: number; attorneyId?: string }): BookingRequest {
    this.#requireStaff(actor);
    const request = this.#store.get(id);
    if (request.status !== "pending") {
      throw new BookingRequestError(`booking request '${id}' was already ${request.status}`, "conflict");
    }
    if (request.conflict.requiresAttorneyReview && actor.role !== "attorney") {
      throw new AccessDeniedError("the conflicts screen flagged this request, so only an attorney can accept it");
    }
    if (Number.isNaN(params.startTime.getTime())) throw new BookingRequestError("choose a start time", "invalid");

    const appointment = this.#scheduling.scheduleConsultation(actor, {
      matterId: `prospective-${request.id}`,
      startTime: params.startTime,
      type: "consultation",
      ...(params.durationMinutes ? { durationMinutes: params.durationMinutes } : {}),
      ...(params.attorneyId ? { attorneyId: params.attorneyId } : {}),
    });
    const accepted = this.#store.markAccepted(id, actor.id, appointment.id, this.#now());
    this.#auditLog.append({
      actor,
      matterId: appointment.matterId,
      action: "booking_request_accepted",
      detail: `request=${id} appointment=${appointment.id} start=${appointment.startTime} attorney=${appointment.attorneyId}`,
    });
    return accepted;
  }

  decline(actor: Actor, id: string, reason?: string): BookingRequest {
    this.#requireStaff(actor);
    const declined = this.#store.markDeclined(id, actor.id, reason, this.#now());
    this.#auditLog.append({
      actor,
      matterId: undefined,
      action: "booking_request_declined",
      detail: `request=${id}${declined.declineReason ? ` reason=${declined.declineReason}` : ""}`,
    });
    return declined;
  }

  #requireStaff(actor: Actor): void {
    if (!STAFF_ROLES.has(actor.role)) {
      throw new AccessDeniedError("booking requests are for firm staff");
    }
  }
}
