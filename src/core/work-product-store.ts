import type { WorkProduct, WorkProductStatus } from "./review-gate.js";

/**
 * Central in-memory registry of `WorkProduct` instances. Deliberately
 * separate from persistence (§8's "not yet built" — persistence is a
 * distinct open item): this just makes drafts discoverable within a
 * running process, e.g. so an attorney review UI can list what's pending.
 * No access control lives here — that's `AccessControl`/the review-gate
 * UI's own gating, not the store's job.
 */
export class WorkProductStore {
  #byId = new Map<string, WorkProduct>();

  register(workProduct: WorkProduct): void {
    this.#byId.set(workProduct.id, workProduct);
  }

  get(id: string): WorkProduct | undefined {
    return this.#byId.get(id);
  }

  listAll(): WorkProduct[] {
    return [...this.#byId.values()];
  }

  listByStatus(status: WorkProductStatus): WorkProduct[] {
    return this.listAll().filter((wp) => wp.status === status);
  }

  listByMatter(matterId: string): WorkProduct[] {
    return this.listAll().filter((wp) => wp.matterId === matterId);
  }
}
