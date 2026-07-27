import { AccessDeniedError, type Actor } from "../core/types.js";
import type { AccessControl } from "../core/access-control.js";
import type { AuditLog } from "../core/audit.js";
import { ClientMessageStore, type ClientMessage } from "../core/client-messages.js";

/**
 * Backs the message thread between a firm and a client on one matter —
 * a card in the client's "My Matters" panel and a card in staff's Cases
 * panel, reading and writing the same thread.
 *
 * The one surface in this system two different actor kinds both read
 * *and write*, so it's gated through two different `AccessControl`
 * categories depending on who's asking, rather than one shared check:
 * a client goes through `client_portal` (exactly the matters it's been
 * granted); staff goes through `case_file` (an attorney unconditionally,
 * a paralegal only its one assigned matter) — the same gate the
 * Drafting/Cases panels already use, so a paralegal can't reach a
 * client conversation on a matter it isn't assigned to. Receptionist and
 * every other role are denied outright before either check runs, the
 * same explicit-allow-list pattern `DocumentsService`/`DraftingService`
 * use rather than trusting `AccessControl`'s default-deny alone.
 *
 * There is deliberately no delete/edit here, same as the audit log and
 * the internal staff `MessagingStore` — a client-facing conversation
 * about a matter is exactly the kind of record a firm needs to be able
 * to produce intact later.
 */
export class ClientMessagingService {
  #store: ClientMessageStore;
  #accessControl: AccessControl;
  #auditLog: AuditLog;

  constructor(params: { store: ClientMessageStore; accessControl: AccessControl; auditLog: AuditLog }) {
    this.#store = params.store;
    this.#accessControl = params.accessControl;
    this.#auditLog = params.auditLog;
  }

  list(actor: Actor, matterId: string): ClientMessage[] {
    this.#authorize(actor, matterId);
    return this.#store.listForMatter(matterId);
  }

  post(actor: Actor, matterId: string, body: string): ClientMessage {
    this.#authorize(actor, matterId);
    // #authorize has already narrowed actor.role to one of these three —
    // it throws AccessDeniedError for anything else before this line.
    const authorRole = actor.role as ClientMessage["authorRole"];
    const message = this.#store.post({ matterId, authorId: actor.id, authorRole, body });
    // A client-facing exchange about a matter is exactly the sort of
    // thing an attorney reviewing an incident (or a bar complaint) needs
    // a record of — logged like every other matter-scoped write in this
    // project, though the body itself isn't duplicated into the detail
    // the way a diff would be: the message store is already the record.
    this.#auditLog.append({ actor, matterId, action: "client_message_posted", detail: `message=${message.id}` });
    return message;
  }

  #authorize(actor: Actor, matterId: string): void {
    if (actor.role === "client") {
      this.#accessControl.authorize({ actor, matterId, category: "client_portal" });
      return;
    }
    if (actor.role === "attorney" || actor.role === "paralegal") {
      this.#accessControl.authorize({ actor, matterId, category: "case_file" });
      return;
    }
    throw new AccessDeniedError(`client messaging is client/paralegal/attorney-only (got role '${actor.role}')`);
  }
}
