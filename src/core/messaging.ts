/**
 * Internal staff messaging: direct (1:1), group, and firm-wide
 * announcements. Deliberately separate from `WorkProductStore`/
 * `DocumentStore` — a message is scratch team communication, never a
 * client deliverable, so it never touches the review-gate.
 *
 * A `Conversation` is one of three kinds:
 * - `"direct"` — exactly two participants (`actorId`s), created lazily the
 *   first time one is messaged.
 * - `"group"` — a named conversation with an explicit member list; the
 *   creator can add/remove other members, any member can leave.
 * - `"announcement"` — a single well-known conversation
 *   (`ANNOUNCEMENTS_CONVERSATION_ID`) with no membership list at all: every
 *   authenticated human can read it, and (per the feature request, which
 *   named no restriction) every authenticated human can post to it too —
 *   there's no separate "who can announce" role in this system. It always
 *   exists, created on first access rather than requiring a setup step.
 *
 * Access control (who may read/post which conversation) is enforced one
 * layer up in `review-ui/messaging-service.ts`, matching this project's
 * split between a plain in-memory store (core) and an HTTP-facing service
 * that adds the actual gate — the same shape as `research-library.ts`/
 * `research-service.ts`.
 */
export type ConversationKind = "direct" | "group" | "announcement";

export const ANNOUNCEMENTS_CONVERSATION_ID = "announcements";

export interface Conversation {
  id: string;
  kind: ConversationKind;
  /** Only set for "group" conversations. */
  name: string | undefined;
  /** Empty/irrelevant for "announcement" — see module doc comment. */
  participantIds: string[];
  /** Only set for "group" conversations — the member who can add/remove others. */
  createdBy: string | undefined;
  createdAt: string;
}

export interface Message {
  id: string;
  conversationId: string;
  senderId: string;
  body: string;
  sentAt: string;
}

export interface MessagingSnapshot {
  conversations: Conversation[];
  messages: Message[];
}

function directConversationKey(a: string, b: string): string {
  return [a, b].sort().join("::");
}

export class MessagingStore {
  #conversationsById = new Map<string, Conversation>();
  #directByKey = new Map<string, string>();
  #messagesByConversation = new Map<string, Message[]>();
  #nextConversationId = 1;
  #nextMessageId = 1;

  #ensureAnnouncementsConversation(): Conversation {
    let announcements = this.#conversationsById.get(ANNOUNCEMENTS_CONVERSATION_ID);
    if (!announcements) {
      announcements = {
        id: ANNOUNCEMENTS_CONVERSATION_ID,
        kind: "announcement",
        name: "Announcements",
        participantIds: [],
        createdBy: undefined,
        createdAt: new Date().toISOString(),
      };
      this.#conversationsById.set(announcements.id, announcements);
    }
    return announcements;
  }

  getOrCreateDirectConversation(actorIdA: string, actorIdB: string): Conversation {
    if (actorIdA === actorIdB) {
      throw new Error("a direct conversation requires two distinct participants");
    }
    const key = directConversationKey(actorIdA, actorIdB);
    const existingId = this.#directByKey.get(key);
    if (existingId) {
      return this.#conversationsById.get(existingId)!;
    }
    const conversation: Conversation = {
      id: `conv_${this.#nextConversationId++}`,
      kind: "direct",
      name: undefined,
      participantIds: [actorIdA, actorIdB],
      createdBy: undefined,
      createdAt: new Date().toISOString(),
    };
    this.#conversationsById.set(conversation.id, conversation);
    this.#directByKey.set(key, conversation.id);
    return conversation;
  }

  createGroup(name: string, createdBy: string, memberIds: string[]): Conversation {
    const trimmedName = name.trim();
    if (!trimmedName) throw new Error("a group conversation needs a name");
    const participantIds = [...new Set([createdBy, ...memberIds])];
    const conversation: Conversation = {
      id: `conv_${this.#nextConversationId++}`,
      kind: "group",
      name: trimmedName,
      participantIds,
      createdBy,
      createdAt: new Date().toISOString(),
    };
    this.#conversationsById.set(conversation.id, conversation);
    return conversation;
  }

  getConversation(conversationId: string): Conversation | undefined {
    if (conversationId === ANNOUNCEMENTS_CONVERSATION_ID) return this.#ensureAnnouncementsConversation();
    return this.#conversationsById.get(conversationId);
  }

  /** Every conversation a given actor can see: their direct/group conversations, plus the always-visible announcements channel. */
  listConversationsFor(actorId: string): Conversation[] {
    const owned = [...this.#conversationsById.values()].filter(
      (c) => c.kind !== "announcement" && c.participantIds.includes(actorId),
    );
    return [this.#ensureAnnouncementsConversation(), ...owned];
  }

  addMember(conversationId: string, actorId: string): Conversation {
    const conversation = this.#requireGroup(conversationId);
    if (!conversation.participantIds.includes(actorId)) {
      conversation.participantIds.push(actorId);
    }
    return conversation;
  }

  removeMember(conversationId: string, actorId: string): Conversation {
    const conversation = this.#requireGroup(conversationId);
    conversation.participantIds = conversation.participantIds.filter((id) => id !== actorId);
    return conversation;
  }

  #requireGroup(conversationId: string): Conversation {
    const conversation = this.#conversationsById.get(conversationId);
    if (!conversation || conversation.kind !== "group") {
      throw new Error(`no group conversation '${conversationId}'`);
    }
    return conversation;
  }

  postMessage(conversationId: string, senderId: string, body: string): Message {
    const trimmed = body.trim();
    if (!trimmed) throw new Error("message body must not be empty");
    const conversation = this.getConversation(conversationId);
    if (!conversation) throw new Error(`no conversation '${conversationId}'`);
    const message: Message = {
      id: `msg_${this.#nextMessageId++}`,
      conversationId: conversation.id,
      senderId,
      body: trimmed,
      sentAt: new Date().toISOString(),
    };
    const existing = this.#messagesByConversation.get(conversation.id) ?? [];
    existing.push(message);
    this.#messagesByConversation.set(conversation.id, existing);
    return message;
  }

  listMessages(conversationId: string): Message[] {
    return [...(this.#messagesByConversation.get(conversationId) ?? [])];
  }

  toSnapshot(): MessagingSnapshot {
    return {
      conversations: [...this.#conversationsById.values()].map((c) => ({ ...c, participantIds: [...c.participantIds] })),
      messages: [...this.#messagesByConversation.values()].flat().map((m) => ({ ...m })),
    };
  }

  static fromSnapshot(snapshot: MessagingSnapshot): MessagingStore {
    const store = new MessagingStore();
    let maxConversationId = 0;
    let maxMessageId = 0;
    for (const conversation of snapshot.conversations) {
      store.#conversationsById.set(conversation.id, { ...conversation, participantIds: [...conversation.participantIds] });
      if (conversation.kind === "direct" && conversation.participantIds.length === 2) {
        const [a, b] = conversation.participantIds as [string, string];
        store.#directByKey.set(directConversationKey(a, b), conversation.id);
      }
      const num = Number(conversation.id.replace(/^conv_/, ""));
      if (Number.isFinite(num) && num > maxConversationId) maxConversationId = num;
    }
    for (const message of snapshot.messages) {
      const existing = store.#messagesByConversation.get(message.conversationId) ?? [];
      existing.push({ ...message });
      store.#messagesByConversation.set(message.conversationId, existing);
      const num = Number(message.id.replace(/^msg_/, ""));
      if (Number.isFinite(num) && num > maxMessageId) maxMessageId = num;
    }
    store.#nextConversationId = maxConversationId + 1;
    store.#nextMessageId = maxMessageId + 1;
    return store;
  }
}
