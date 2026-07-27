import { describe, expect, it } from "vitest";
import { AccessDeniedError, type Actor } from "../src/core/types.js";
import { AccessControl } from "../src/core/access-control.js";
import { AuditLog } from "../src/core/audit.js";
import { ClientMessageStore } from "../src/core/client-messages.js";
import { ClientMessagingService } from "../src/review-ui/client-messaging-service.js";

const attorney: Actor = { id: "a1", role: "attorney" };
const paralegal: Actor = { id: "p1", role: "paralegal" };
const client: Actor = { id: "c1", role: "client" };
const otherClient: Actor = { id: "c2", role: "client" };
const receptionist: Actor = { id: "r1", role: "receptionist" };

function makeService() {
  const auditLog = new AuditLog();
  const accessControl = new AccessControl(auditLog);
  accessControl.assignParalegal("p1", "m1");
  accessControl.grantClientAccess("c1", "m1");
  const store = new ClientMessageStore();
  return { auditLog, accessControl, store, service: new ClientMessagingService({ store, accessControl, auditLog }) };
}

describe("ClientMessagingService", () => {
  it("lets a granted client and the assigned staff exchange messages on the same thread", () => {
    const { service } = makeService();
    service.post(client, "m1", "When is my next court date?");
    service.post(paralegal, "m1", "It's the 14th at 9am.");
    const thread = service.list(attorney, "m1");
    expect(thread.map((m) => [m.authorRole, m.body])).toEqual([
      ["client", "When is my next court date?"],
      ["paralegal", "It's the 14th at 9am."],
    ]);
  });

  it("denies a client with no grant on this matter", () => {
    const { service } = makeService();
    expect(() => service.list(otherClient, "m1")).toThrow(AccessDeniedError);
    expect(() => service.post(otherClient, "m1", "hi")).toThrow(AccessDeniedError);
  });

  it("denies a paralegal not assigned to this matter", () => {
    const { service } = makeService();
    expect(() => service.list(paralegal, "m2")).toThrow(AccessDeniedError);
  });

  it("denies receptionist and every other role outright", () => {
    const { service } = makeService();
    expect(() => service.list(receptionist, "m1")).toThrow(AccessDeniedError);
    expect(() => service.post({ id: "sys", role: "system" }, "m1", "hi")).toThrow(AccessDeniedError);
  });

  it("lets an attorney reach any matter regardless of assignment", () => {
    const { service } = makeService();
    service.post(client, "m1", "hello");
    expect(service.list(attorney, "m1")).toHaveLength(1);
  });

  it("rejects an empty message", () => {
    const { service } = makeService();
    expect(() => service.post(client, "m1", "   ")).toThrow(/must not be empty/);
  });

  it("audits every post, attributing it to the real actor", () => {
    const { service, auditLog } = makeService();
    service.post(client, "m1", "hi");
    const entry = auditLog.read("attorney", { matterId: "m1" }).find((e) => e.action === "client_message_posted");
    expect(entry?.actor).toEqual(client);
  });

  it("orders messages chronologically regardless of insertion order into the store", () => {
    const { service, store } = makeService();
    store.post({ matterId: "m1", authorId: "a1", authorRole: "attorney", body: "first" });
    store.post({ matterId: "m1", authorId: "c1", authorRole: "client", body: "second" });
    expect(service.list(attorney, "m1").map((m) => m.body)).toEqual(["first", "second"]);
  });
});

describe("ClientMessageStore snapshot round-trip", () => {
  it("preserves messages and continues numbering after restore", () => {
    const store = new ClientMessageStore();
    store.post({ matterId: "m1", authorId: "c1", authorRole: "client", body: "hi" });
    const restored = ClientMessageStore.fromSnapshot(store.toSnapshot());
    expect(restored.listForMatter("m1")).toHaveLength(1);
    const next = restored.post({ matterId: "m1", authorId: "a1", authorRole: "attorney", body: "reply" });
    expect(next.id).toBe("cmsg_2");
  });
});
