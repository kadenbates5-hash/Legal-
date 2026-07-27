import { AccessDeniedError, type Actor } from "../core/types.js";
import { StaffScheduleStore, type StaffScheduleEntry, type StaffScheduleStatus } from "../core/staff-schedule.js";

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

  constructor(store: StaffScheduleStore) {
    this.#store = store;
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
    if (actorId !== actor.id && actor.role !== "attorney") {
      throw new AccessDeniedError("only an attorney can set another staff member's schedule entry");
    }
    return this.#store.setEntry(actorId, date, status, note);
  }

  removeEntry(actor: Actor, actorId: string, date: string): void {
    requireHuman(actor);
    if (actorId !== actor.id && actor.role !== "attorney") {
      throw new AccessDeniedError("only an attorney can remove another staff member's schedule entry");
    }
    this.#store.removeEntry(actorId, date);
  }
}
