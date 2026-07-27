import { AccessDeniedError, type Actor } from "../core/types.js";
import { ANNOUNCEMENTS_CONVERSATION_ID, MessagingStore, type Conversation, type Message } from "../core/messaging.js";
import type { AuthService } from "../core/auth.js";

/** A `Message`/`Conversation` enriched with sender/participant display names — what the UI actually wants, since it never sees a raw `actorId`. */
export interface MessageView {
  id: string;
  conversationId: string;
  senderId: string;
  senderName: string;
  body: string;
  sentAt: string;
}

export interface ConversationView {
  id: string;
  kind: Conversation["kind"];
  name: string | undefined;
  participants: { actorId: string; displayName: string }[];
  createdBy: string | undefined;
  createdAt: string;
}

/**
 * "Every logged-in human" here means every *staff* role — written before
 * the client portal existed. A client posting to the firm-wide
 * announcements conversation, or DMing an attorney directly, was never
 * the intent, so `"client"` is denied by name here too, same as
 * `"system"`.
 */
function requireHuman(actor: Actor): void {
  if (actor.role === "system" || actor.role === "client") {
    throw new AccessDeniedError("messaging is not available to this role");
  }
}

/**
 * The "Messages" panel's backend. `MessagingStore` (core) knows nothing
 * about who's allowed to see what; this service is the actual gate —
 * same split as every other `*-service.ts` here — plus display-name
 * enrichment via `AuthService`, since a raw `actorId` means nothing in
 * the UI.
 */
export class MessagingService {
  #store: MessagingStore;
  #auth: AuthService;

  constructor(store: MessagingStore, auth: AuthService) {
    this.#store = store;
    this.#auth = auth;
  }

  /**
   * One actorId -> displayName map per request, not per message.
   * `AuthService.listUsers()` deep-copies every account on every call, so
   * resolving a name inline per message made rendering a conversation
   * O(messages x accounts) in object allocations — enough to matter on
   * the Messages panel, which re-fetches a whole thread on every send.
   */
  #displayNames(): Map<string, string> {
    return new Map(this.#auth.listUsers().map((u) => [u.actorId, u.displayName]));
  }

  #toConversationView(conversation: Conversation, names: Map<string, string>): ConversationView {
    return {
      id: conversation.id,
      kind: conversation.kind,
      name: conversation.name,
      participants: conversation.participantIds.map((actorId) => ({
        actorId,
        displayName: names.get(actorId) ?? actorId,
      })),
      createdBy: conversation.createdBy,
      createdAt: conversation.createdAt,
    };
  }

  #toMessageView(message: Message, names: Map<string, string>): MessageView {
    return {
      id: message.id,
      conversationId: message.conversationId,
      senderId: message.senderId,
      senderName: names.get(message.senderId) ?? message.senderId,
      body: message.body,
      sentAt: message.sentAt,
    };
  }

  #requireMembership(actor: Actor, conversation: Conversation): void {
    if (conversation.kind === "announcement") return;
    if (!conversation.participantIds.includes(actor.id)) {
      throw new AccessDeniedError(`actor '${actor.id}' is not a participant in conversation '${conversation.id}'`);
    }
  }

  listConversations(actor: Actor): ConversationView[] {
    requireHuman(actor);
    const names = this.#displayNames();
    return this.#store.listConversationsFor(actor.id).map((c) => this.#toConversationView(c, names));
  }

  startDirectConversation(actor: Actor, otherActorId: string): ConversationView {
    requireHuman(actor);
    return this.#toConversationView(this.#store.getOrCreateDirectConversation(actor.id, otherActorId), this.#displayNames());
  }

  createGroup(actor: Actor, name: string, memberActorIds: string[]): ConversationView {
    requireHuman(actor);
    return this.#toConversationView(this.#store.createGroup(name, actor.id, memberActorIds), this.#displayNames());
  }

  addMember(actor: Actor, conversationId: string, memberActorId: string): ConversationView {
    requireHuman(actor);
    const conversation = this.#requireGroupMembership(actor, conversationId);
    return this.#toConversationView(this.#store.addMember(conversation.id, memberActorId), this.#displayNames());
  }

  /** Leaving removes yourself; removing someone else requires being the group's creator. */
  removeMember(actor: Actor, conversationId: string, memberActorId: string): ConversationView {
    requireHuman(actor);
    const conversation = this.#requireGroupMembership(actor, conversationId);
    if (memberActorId !== actor.id && conversation.createdBy !== actor.id) {
      throw new AccessDeniedError("only the group's creator can remove another member");
    }
    return this.#toConversationView(this.#store.removeMember(conversation.id, memberActorId), this.#displayNames());
  }

  #requireGroupMembership(actor: Actor, conversationId: string): Conversation {
    const conversation = this.#store.getConversation(conversationId);
    if (!conversation || conversation.kind !== "group") {
      throw new Error(`no group conversation '${conversationId}'`);
    }
    this.#requireMembership(actor, conversation);
    return conversation;
  }

  listMessages(actor: Actor, conversationId: string): MessageView[] {
    requireHuman(actor);
    const conversation = this.#store.getConversation(conversationId);
    if (!conversation) throw new Error(`no conversation '${conversationId}'`);
    this.#requireMembership(actor, conversation);
    const names = this.#displayNames();
    return this.#store.listMessages(conversation.id).map((m) => this.#toMessageView(m, names));
  }

  postMessage(actor: Actor, conversationId: string, body: string): MessageView {
    requireHuman(actor);
    const conversation = this.#store.getConversation(conversationId);
    if (!conversation) throw new Error(`no conversation '${conversationId}'`);
    this.#requireMembership(actor, conversation);
    return this.#toMessageView(this.#store.postMessage(conversation.id, actor.id, body), this.#displayNames());
  }

  listAnnouncements(actor: Actor): MessageView[] {
    return this.listMessages(actor, ANNOUNCEMENTS_CONVERSATION_ID);
  }

  postAnnouncement(actor: Actor, body: string): MessageView {
    return this.postMessage(actor, ANNOUNCEMENTS_CONVERSATION_ID, body);
  }
}
