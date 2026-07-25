import { describe, expect, it } from "vitest";
import { MessagingService } from "../src/review-ui/messaging-service.js";
import { MessagingStore } from "../src/core/messaging.js";
import { AuthService } from "../src/core/auth.js";
import { AccessDeniedError, type Actor } from "../src/core/types.js";

const attorney: Actor = { id: "a1", role: "attorney" };
const paralegal: Actor = { id: "p1", role: "paralegal" };
const receptionist: Actor = { id: "r1", role: "receptionist" };
const system: Actor = { id: "system", role: "system" };

function makeService() {
  const auth = new AuthService();
  auth.createUser({ username: "attorney1", password: "correct-horse", role: "attorney", actorId: "a1", displayName: "Ada Attorney" });
  auth.createUser({ username: "paralegal1", password: "correct-horse", role: "paralegal", actorId: "p1", displayName: "Pat Paralegal" });
  auth.createUser({ username: "reception1", password: "correct-horse", role: "receptionist", actorId: "r1", displayName: "Rex Reception" });
  return { auth, messaging: new MessagingService(new MessagingStore(), auth) };
}

describe("MessagingService", () => {
  it("denies the system credential entirely", () => {
    const { messaging } = makeService();
    expect(() => messaging.listConversations(system)).toThrow(AccessDeniedError);
  });

  it("lets two participants exchange direct messages, with resolved display names", () => {
    const { messaging } = makeService();
    const conversation = messaging.startDirectConversation(attorney, "p1");
    messaging.postMessage(attorney, conversation.id, "Can you handle the Smith matter?");
    const messages = messaging.listMessages(paralegal, conversation.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.senderName).toBe("Ada Attorney");
  });

  it("denies a non-participant from reading or posting in a direct conversation", () => {
    const { messaging } = makeService();
    const conversation = messaging.startDirectConversation(attorney, "p1");
    expect(() => messaging.listMessages(receptionist, conversation.id)).toThrow(AccessDeniedError);
    expect(() => messaging.postMessage(receptionist, conversation.id, "hi")).toThrow(AccessDeniedError);
  });

  it("creates a group including the creator, and lets members post", () => {
    const { messaging } = makeService();
    const group = messaging.createGroup(attorney, "Trial Team", ["p1"]);
    expect(group.participants.map((p) => p.actorId).sort()).toEqual(["a1", "p1"]);
    messaging.postMessage(paralegal, group.id, "Discovery is ready");
    expect(messaging.listMessages(attorney, group.id)).toHaveLength(1);
  });

  it("lets the creator add/remove members, but denies a non-creator from removing someone else", () => {
    const { messaging } = makeService();
    const group = messaging.createGroup(attorney, "Trial Team", ["p1"]);
    messaging.addMember(attorney, group.id, "r1");
    expect(messaging.listMessages(receptionist, group.id)).toEqual([]);
    expect(() => messaging.removeMember(paralegal, group.id, "r1")).toThrow(AccessDeniedError);
    const updated = messaging.removeMember(attorney, group.id, "r1");
    expect(updated.participants.map((p) => p.actorId)).not.toContain("r1");
  });

  it("lets a member leave a group themselves", () => {
    const { messaging } = makeService();
    const group = messaging.createGroup(attorney, "Trial Team", ["p1"]);
    const updated = messaging.removeMember(paralegal, group.id, "p1");
    expect(updated.participants.map((p) => p.actorId)).not.toContain("p1");
  });

  it("lets any authenticated human post and read announcements, with no membership list", () => {
    const { messaging } = makeService();
    messaging.postAnnouncement(attorney, "Office closed Friday");
    messaging.postAnnouncement(receptionist, "New coffee machine!");
    const announcements = messaging.listAnnouncements(paralegal);
    expect(announcements.map((m) => m.body)).toEqual(["Office closed Friday", "New coffee machine!"]);
  });

  it("includes the announcements conversation in every actor's conversation list even with no other conversations", () => {
    const { messaging } = makeService();
    const conversations = messaging.listConversations(receptionist);
    expect(conversations.some((c) => c.kind === "announcement")).toBe(true);
  });
});
