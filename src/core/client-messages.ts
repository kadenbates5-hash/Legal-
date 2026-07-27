/**
 * A message thread between a firm and a client, one per matter.
 *
 * Deliberately not part of `core/messaging.ts` — that store is staff-only
 * (a client is denied it by name, see `messaging-service.ts`) and models
 * direct/group/announcement conversations that make no sense for a
 * client relationship. This is simpler on purpose: exactly one thread
 * per matter, open to whichever client accounts are granted that matter
 * (see `AccessControl`'s `client_portal` category) and whichever staff
 * can reach the matter's `case_file` — access is enforced one layer up
 * in `review-ui/client-messaging-service.ts`, the same split as every
 * other store in this project.
 *
 * A co-client (two client accounts both granted the same matter) shares
 * one thread rather than getting a private line to the firm each — the
 * same reasoning `core/matters.ts` uses for parties: this is a
 * conversation about the matter, not about the individual account.
 */
export interface ClientMessage {
  id: string;
  matterId: string;
  /** The actorId of whoever posted — a client's or a staff member's. */
  authorId: string;
  /** Recorded so the thread can show "you"/"the firm" without a lookup, and so a role change later doesn't rewrite history. */
  authorRole: "attorney" | "paralegal" | "client";
  body: string;
  sentAt: string;
}

export class ClientMessageStore {
  #byId = new Map<string, ClientMessage>();
  #nextId = 1;

  post(params: { matterId: string; authorId: string; authorRole: ClientMessage["authorRole"]; body: string }): ClientMessage {
    const body = params.body.trim();
    if (!body) throw new Error("message body must not be empty");
    const message: ClientMessage = {
      id: `cmsg_${this.#nextId++}`,
      matterId: params.matterId,
      authorId: params.authorId,
      authorRole: params.authorRole,
      body,
      sentAt: new Date().toISOString(),
    };
    this.#byId.set(message.id, message);
    return message;
  }

  /** Oldest first — a thread reads top-to-bottom like any chat. */
  listForMatter(matterId: string): ClientMessage[] {
    return [...this.#byId.values()]
      .filter((m) => m.matterId === matterId)
      .sort((a, b) => a.sentAt.localeCompare(b.sentAt) || a.id.localeCompare(b.id));
  }

  toSnapshot(): ClientMessage[] {
    return [...this.#byId.values()].map((m) => ({ ...m }));
  }

  static fromSnapshot(snapshot: readonly ClientMessage[]): ClientMessageStore {
    const store = new ClientMessageStore();
    let maxId = 0;
    for (const message of snapshot) {
      store.#byId.set(message.id, { ...message });
      const num = Number(message.id.replace(/^cmsg_/, ""));
      if (Number.isFinite(num) && num > maxId) maxId = num;
    }
    store.#nextId = maxId + 1;
    return store;
  }
}
