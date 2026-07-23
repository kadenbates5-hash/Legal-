import { WorkProduct, type WorkProductSnapshot, type WorkProductStatus } from "./review-gate.js";
import type { AuditLog } from "./audit.js";

/**
 * Central in-memory registry of `WorkProduct` instances — makes drafts
 * discoverable within a running process, e.g. so an attorney review UI can
 * list what's pending. No access control lives here — that's
 * `AccessControl`/the review-gate UI's own gating, not the store's job.
 * `toSnapshot`/`fromSnapshot` are what a persistence layer (see
 * `src/persistence/`) uses to save/restore the whole registry.
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

  toSnapshot(): WorkProductSnapshot[] {
    return this.listAll().map((wp) => wp.toSnapshot());
  }

  static fromSnapshot(snapshots: readonly WorkProductSnapshot[], auditLog: AuditLog): WorkProductStore {
    const store = new WorkProductStore();
    for (const snapshot of snapshots) {
      store.register(WorkProduct.fromSnapshot(snapshot, auditLog));
    }
    return store;
  }
}
