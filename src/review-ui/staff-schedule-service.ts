import { AccessDeniedError, type Actor } from "../core/types.js";
import { StaffScheduleStore, type StaffScheduleEntry, type StaffScheduleStatus } from "../core/staff-schedule.js";
import type { AuditLog } from "../core/audit.js";

/** A note is "in court until 2", not a memo. Longer was stored whole and shown to everyone on the date view. */
export const MAX_SCHEDULE_NOTE_LENGTH = 200;

export interface StaffScheduleServiceOptions {
  /**
   * Whether an actor id is someone on staff. Without it any string was
   * accepted, so an attorney's typo put a person who doesn't exist on
   * the day's "who's in" list, and a client's actor id put a client on
   * it. `start.ts` answers from `AuthService`.
   */
  isStaffMember?: (actorId: string) => boolean;
  auditLog?: AuditLog;
}

/**
 * "Every logged-in human" here means every *staff* role — this predates
 * the client portal, and a client seeing who's in the office on a given
 * day (or worse, being able to set an entry) was never the intent. So
 * `"client"` is denied by name, the same way `"system"` already is,
 * rather than left to fall through a role list this file doesn't own.
 */
function requireHuman(actor: Actor): void {
  if (actor.role === "system" || actor.role === "client") {
    throw new AccessDeniedError("the staff schedule is not available to this role");
  }
}

/**
 * Backs the "Schedule" panel's staff-availability view. Read access is
 * open to every logged-in human — the whole point is everyone can see
 * who's in the office when. Write access is narrower: anyone can set
 * their own day, but only an attorney can set someone else's — matching
 * this project's pattern of self-service where nothing's at stake, and an
 * attorney gate where one person overriding another's record needs
 * accountability.
 */
export class StaffScheduleService {
  #store: StaffScheduleStore;
  #isStaffMember: ((actorId: string) => boolean) | undefined;
  #auditLog: AuditLog | undefined;

  constructor(store: StaffScheduleStore, options: StaffScheduleServiceOptions = {}) {
    this.#store = store;
    this.#isStaffMember = options.isStaffMember;
    this.#auditLog = options.auditLog;
  }

  listForActor(actor: Actor, actorId: string): StaffScheduleEntry[] {
    requireHuman(actor);
    return this.#store.listForActor(actorId);
  }

  listForDate(actor: Actor, date: string): StaffScheduleEntry[] {
    requireHuman(actor);
    return this.#store.listForDate(date);
  }

  setEntry(actor: Actor, actorId: string, date: string, status: StaffScheduleStatus, note?: string): StaffScheduleEntry {
    requireHuman(actor);
    const forColleague = actorId !== actor.id;
    if (forColleague && actor.role !== "attorney") {
      throw new AccessDeniedError("only an attorney can set another staff member's schedule entry");
    }
    if (forColleague && this.#isStaffMember && !this.#isStaffMember(actorId)) {
      throw new Error(`no user on staff with id '${actorId}'`);
    }
    const trimmed = note?.trim() || undefined;
    if (trimmed && trimmed.length > MAX_SCHEDULE_NOTE_LENGTH) {
      throw new Error(`a schedule note can be at most ${MAX_SCHEDULE_NOTE_LENGTH} characters`);
    }
    const entry = this.#store.setEntry(actorId, date, status, trimmed);
    // Self-service changes aren't audited — nothing's at stake in saying
    // where you'll be. One person rewriting another's day is the case the
    // attorney gate exists for, and a gate that leaves no record is only
    // half of one.
    if (forColleague) {
      this.#auditLog?.append({
        actor,
        matterId: undefined,
        action: "staff_schedule_set_for_colleague",
        detail: `actor=${actorId} date=${entry.date} status=${entry.status}`,
      });
    }
    return entry;
  }

  removeEntry(actor: Actor, actorId: string, date: string): void {
    requireHuman(actor);
    const forColleague = actorId !== actor.id;
    if (forColleague && actor.role !== "attorney") {
      throw new AccessDeniedError("only an attorney can remove another staff member's schedule entry");
    }
    const removed = this.#store.removeEntry(actorId, date);
    if (removed && forColleague) {
      this.#auditLog?.append({
        actor,
        matterId: undefined,
        action: "staff_schedule_removed_for_colleague",
        detail: `actor=${actorId} date=${date}`,
      });
    }
  }
}
