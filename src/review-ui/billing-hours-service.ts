import { AccessDeniedError, type Actor } from "../core/types.js";
import type { AccessControl } from "../core/access-control.js";
import { BillingHoursStore, type BillingHoursEntry } from "../core/billing-hours.js";

function requireBillingRole(actor: Actor): void {
  if (actor.role !== "paralegal" && actor.role !== "attorney") {
    throw new AccessDeniedError(`billing hours are paralegal/attorney-only (got role '${actor.role}')`);
  }
}

/**
 * The "Billing" panel's backend: lawyers and paralegals log billable
 * hours against a matter. Same shape as `DocumentsService` — every
 * method authorizes the matter via `AccessControl`'s existing
 * `"billing_internal"` category before touching the store, since an
 * entry is exposed over HTTP by matter id/entry id that any
 * authenticated caller could otherwise name arbitrarily. Deliberately
 * distinct from `core/utilization.ts` (internal AI-utilization
 * telemetry) — this is the human timekeeping record.
 */
export class BillingHoursService {
  #accessControl: AccessControl;
  #store: BillingHoursStore;

  constructor(params: { accessControl: AccessControl; store: BillingHoursStore }) {
    this.#accessControl = params.accessControl;
    this.#store = params.store;
  }

  logHours(actor: Actor, matterId: string, params: { date: string; hours: number; description: string }): BillingHoursEntry {
    requireBillingRole(actor);
    this.#accessControl.authorize({ actor, matterId, category: "billing_internal" });
    return this.#store.log({ matterId, actorId: actor.id, date: params.date, hours: params.hours, description: params.description });
  }

  listMatterHours(actor: Actor, matterId: string): BillingHoursEntry[] {
    requireBillingRole(actor);
    this.#accessControl.authorize({ actor, matterId, category: "billing_internal" });
    return this.#store.listByMatter(matterId);
  }

  /** Every entry the calling actor themselves logged, across matters — no matter-scoping needed since it's always their own. */
  listMyHours(actor: Actor): BillingHoursEntry[] {
    requireBillingRole(actor);
    return this.#store.listByActor(actor.id);
  }

  deleteEntry(actor: Actor, matterId: string, id: string): void {
    requireBillingRole(actor);
    this.#accessControl.authorize({ actor, matterId, category: "billing_internal" });
    const entry = this.#store.get(id);
    if (!entry || entry.matterId !== matterId) {
      throw new Error(`no billing entry '${id}' on matter '${matterId}'`);
    }
    this.#store.delete(id);
  }
}
