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

function requireHuman(actor: Actor): void {
  if (actor.role === "system") {
    throw new AccessDeniedError("messaging is not available to the system credential");
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

  #displayNameFor(actorId: string): string {
    const user = this.#auth.listUsers().find((u) => u.actorId === actorId);
    return user?.displayName ?? actorId;
  }

  #toConversationView(conversation: Conversation): ConversationView {
    return {
      id: conversation.id,
      kind: conversation.kind,
      name: conversation.name,
      participants: conversation.participantIds.map((actorId) => ({ actorId, displayName: this.#displayNameFor(actorId) })),
      createdBy: conversation.createdBy,
      createdAt: conversation.createdAt,
    };
  }

  #toMessageView(message: Message): MessageView {
    return {
      id: message.id,
      conversationId: message.conversationId,
      senderId: message.senderId,
      senderName: this.#displayNameFor(message.senderId),
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
    return this.#store.listConversationsFor(actor.id).map((c) => this.#toConversationView(c));
  }

  startDirectConversation(actor: Actor, otherActorId: string): ConversationView {
    requireHuman(actor);
    return this.#toConversationView(this.#store.getOrCreateDirectConversation(actor.id, otherActorId));
  }

  createGroup(actor: Actor, name: string, memberActorIds: string[]): ConversationView {
    requireHuman(actor);
    return this.#toConversationView(this.#store.createGroup(name, actor.id, memberActorIds));
  }

  addMember(actor: Actor, conversationId: string, memberActorId: string): ConversationView {
    requireHuman(actor);
    const conversation = this.#requireGroupMembership(actor, conversationId);
    return this.#toConversationView(this.#store.addMember(conversation.id, memberActorId));
  }

  /** Leaving removes yourself; removing someone else requires being the group's creator. */
  removeMember(actor: Actor, conversationId: string, memberActorId: string): ConversationView {
    requireHuman(actor);
    const conversation = this.#requireGroupMembership(actor, conversationId);
    if (memberActorId !== actor.id && conversation.createdBy !== actor.id) {
      throw new AccessDeniedError("only the group's creator can remove another member");
    }
    return this.#toConversationView(this.#store.removeMember(conversation.id, memberActorId));
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
    return this.#store.listMessages(conversation.id).map((m) => this.#toMessageView(m));
  }

  postMessage(actor: Actor, conversationId: string, body: string): MessageView {
    requireHuman(actor);
    const conversation = this.#store.getConversation(conversationId);
    if (!conversation) throw new Error(`no conversation '${conversationId}'`);
    this.#requireMembership(actor, conversation);
    return this.#toMessageView(this.#store.postMessage(conversation.id, actor.id, body));
  }

  listAnnouncements(actor: Actor): MessageView[] {
    return this.listMessages(actor, ANNOUNCEMENTS_CONVERSATION_ID);
  }

  postAnnouncement(actor: Actor, body: string): MessageView {
    return this.postMessage(actor, ANNOUNCEMENTS_CONVERSATION_ID, body);
  }
}
