import { describe, expect, it } from "vitest";
import { ANNOUNCEMENTS_CONVERSATION_ID, MessagingStore } from "../src/core/messaging.js";

describe("MessagingStore", () => {
  it("creates a direct conversation lazily and reuses it for the same pair regardless of order", () => {
    const store = new MessagingStore();
    const a = store.getOrCreateDirectConversation("a1", "p1");
    const b = store.getOrCreateDirectConversation("p1", "a1");
    expect(a.id).toBe(b.id);
    expect(a.participantIds.sort()).toEqual(["a1", "p1"]);
  });

  it("rejects a direct conversation with only one participant", () => {
    const store = new MessagingStore();
    expect(() => store.getOrCreateDirectConversation("a1", "a1")).toThrow();
  });

  it("creates a group conversation including the creator automatically", () => {
    const store = new MessagingStore();
    const group = store.createGroup("Trial Team", "a1", ["p1", "p2"]);
    expect(group.kind).toBe("group");
    expect(group.participantIds.sort()).toEqual(["a1", "p1", "p2"]);
    expect(group.createdBy).toBe("a1");
  });

  it("rejects a group with an empty name", () => {
    const store = new MessagingStore();
    expect(() => store.createGroup("   ", "a1", [])).toThrow();
  });

  it("adds and removes group members", () => {
    const store = new MessagingStore();
    const group = store.createGroup("Trial Team", "a1", ["p1"]);
    store.addMember(group.id, "p2");
    expect(store.getConversation(group.id)!.participantIds).toContain("p2");
    store.removeMember(group.id, "p1");
    expect(store.getConversation(group.id)!.participantIds).not.toContain("p1");
  });

  it("always has a well-known announcements conversation available without setup", () => {
    const store = new MessagingStore();
    const conversation = store.getConversation(ANNOUNCEMENTS_CONVERSATION_ID);
    expect(conversation).toBeDefined();
    expect(conversation!.kind).toBe("announcement");
  });

  it("posts and lists messages in send order", () => {
    const store = new MessagingStore();
    const conversation = store.getOrCreateDirectConversation("a1", "p1");
    store.postMessage(conversation.id, "a1", "hi");
    store.postMessage(conversation.id, "p1", "hello back");
    const messages = store.listMessages(conversation.id);
    expect(messages.map((m) => m.body)).toEqual(["hi", "hello back"]);
  });

  it("rejects an empty message body", () => {
    const store = new MessagingStore();
    const conversation = store.getOrCreateDirectConversation("a1", "p1");
    expect(() => store.postMessage(conversation.id, "a1", "   ")).toThrow();
  });

  it("round-trips through toSnapshot/fromSnapshot, preserving direct-conversation lookup and message order", () => {
    const store = new MessagingStore();
    const direct = store.getOrCreateDirectConversation("a1", "p1");
    store.postMessage(direct.id, "a1", "first");
    store.postMessage(direct.id, "p1", "second");
    const group = store.createGroup("Trial Team", "a1", ["p1"]);
    store.postMessage(group.id, "a1", "group msg");
    store.postMessage(ANNOUNCEMENTS_CONVERSATION_ID, "a1", "firm-wide notice");

    const restored = MessagingStore.fromSnapshot(store.toSnapshot());
    expect(restored.getOrCreateDirectConversation("p1", "a1").id).toBe(direct.id);
    expect(restored.listMessages(direct.id).map((m) => m.body)).toEqual(["first", "second"]);
    expect(restored.listMessages(group.id).map((m) => m.body)).toEqual(["group msg"]);
    expect(restored.listMessages(ANNOUNCEMENTS_CONVERSATION_ID).map((m) => m.body)).toEqual(["firm-wide notice"]);

    const nextGroup = restored.createGroup("New Group", "a1", []);
    expect(nextGroup.id).not.toBe(group.id);
  });
});
