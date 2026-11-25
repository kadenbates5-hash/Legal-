import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { parseZonedInstant, utcOffsetLabel } from "../src/core/instant.js";
import { createReviewServer } from "../src/review-ui/server.js";
import { ReviewGateService } from "../src/review-ui/review-service.js";
import { WorkProductStore } from "../src/core/work-product-store.js";
import { SchedulingService } from "../src/core/scheduling.js";
import { AuthService } from "../src/core/auth.js";
import { AuditLog } from "../src/core/audit.js";
import { AccessControl } from "../src/core/access-control.js";
import { AssistantSession, firmClockContext } from "../src/assistant/assistant-session.js";
import { createAssistantTools } from "../src/assistant/tools.js";
import { DraftingService } from "../src/review-ui/drafting-service.js";
import { DocumentsService } from "../src/review-ui/documents-service.js";
import { CasesService } from "../src/review-ui/cases-service.js";
import { ResearchService } from "../src/review-ui/research-service.js";
import { DocumentStore } from "../src/core/document-store.js";
import { ResearchLibrary } from "../src/core/research-library.js";
import { criminalLawModule } from "../src/modules/criminal-law/index.js";
import type { ClaudeClient, ClaudeMessage, ClaudeResponse } from "../src/integrations/anthropic.js";
import type { Actor } from "../src/core/types.js";

/**
 * A time with no zone was read in the server's zone: "2026-11-26T10:00"
 * booked 10am UTC, 5am in New York. The assistant had no clock at all, so
 * "tomorrow at 10" was a guess at both the day and the hour.
 */
describe("parseZonedInstant", () => {
  it("takes a date and time with Z or an offset, and nothing else", () => {
    expect(parseZonedInstant("2026-11-26T10:00:00-05:00")?.toISOString()).toBe("2026-11-26T15:00:00.000Z");
    expect(parseZonedInstant("2026-11-26T15:00Z")?.toISOString()).toBe("2026-11-26T15:00:00.000Z");
    expect(parseZonedInstant(" 2026-11-26T15:00:00.000Z ")?.toISOString()).toBe("2026-11-26T15:00:00.000Z");
    for (const value of ["2026-11-26T10:00", "2026-11-26 10:00", "Nov 26 2026 10:00 AM", "2026-11-26", "", 1764169200000, null]) {
      expect(parseZonedInstant(value), String(value)).toBeUndefined();
    }
  });

  it("names a zone's offset", () => {
    expect(utcOffsetLabel("America/New_York", new Date("2026-11-25T12:00:00Z"))).toBe("-05:00");
    expect(utcOffsetLabel("America/New_York", new Date("2026-07-25T12:00:00Z"))).toBe("-04:00");
    expect(utcOffsetLabel("UTC", new Date())).toBe("+00:00");
    expect(utcOffsetLabel("Not/AZone", new Date())).toBeUndefined();
  });
});

describe("appointment routes", () => {
  let server: Server;
  let baseUrl: string;
  let cookie: string;

  beforeEach(async () => {
    const auth = new AuthService();
    auth.createUser({ username: "reception1", password: "correct-horse", role: "receptionist", actorId: "r1" });
    const scheduling = new SchedulingService({
      firmConfig: {
        firmName: "Test Firm",
        attorneys: [{ id: "a1", name: "Alice", practiceAreaIds: ["criminal-law"] }],
        businessHours: { timezone: "UTC", open: "00:00", close: "23:59", days: [0, 1, 2, 3, 4, 5, 6] },
        branding: { tone: "warm", greeting: "Hi." },
        jurisdictionRecordingConsent: "one-party-consent",
      },
    });
    server = createReviewServer(new ReviewGateService(new WorkProductStore()), auth, { scheduling });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const login = await fetch(`${baseUrl}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "reception1", password: "correct-horse" }),
    });
    cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const post = (path: string, body: unknown) =>
    fetch(`${baseUrl}${path}`, { method: "POST", headers: { "Content-Type": "application/json", cookie }, body: JSON.stringify(body) });

  it("refuses a booking time without its zone, and books a zoned one at the instant it names", async () => {
    const zoneless = await post("/api/appointments", { matterId: "m1", startTime: "2026-12-01T10:00" });
    expect(zoneless.status).toBe(400);
    expect((await zoneless.json()).error).toMatch(/with its zone/);

    const booked = await post("/api/appointments", { matterId: "m1", startTime: "2026-12-01T10:00:00-05:00" });
    expect(booked.status).toBe(200);
    const appointment = await booked.json();
    expect(appointment.startTime).toBe("2026-12-01T15:00:00.000Z");

    const moved = await post(`/api/appointments/${appointment.id}/reschedule`, { newStartTime: "2026-12-02 10:00" });
    expect(moved.status).toBe(400);
  });
});

describe("the assistant", () => {
  const paralegal: Actor = { id: "p1", role: "paralegal" };

  class ScriptedClient implements ClaudeClient {
    systems: string[] = [];
    constructor(private readonly responses: ClaudeResponse[]) {}
    async createMessage(params: { system: string; messages: ClaudeMessage[] }): Promise<ClaudeResponse> {
      this.systems.push(params.system);
      const next = this.responses.shift();
      if (!next) throw new Error("out of responses");
      return next;
    }
  }

  function tools() {
    const auditLog = new AuditLog();
    const accessControl = new AccessControl(auditLog);
    accessControl.assignParalegal("p1", "m1");
    const workProductStore = new WorkProductStore();
    const documentStore = new DocumentStore();
    const scheduling = new SchedulingService();
    const toolList = createAssistantTools({
      drafting: new DraftingService({ accessControl, auditLog, module: criminalLawModule, store: workProductStore }),
      documents: new DocumentsService({ accessControl, store: documentStore }),
      cases: new CasesService({ accessControl, workProductStore, documentStore }),
      research: new ResearchService({ accessControl, library: new ResearchLibrary(), searchClient: { search: async () => [] } }),
      scheduling,
      reviewGate: new ReviewGateService(workProductStore),
    });
    return { toolList, scheduling, auditLog };
  }

  it("is told the firm's date, time and offset on every request", async () => {
    const client = new ScriptedClient([{ id: "m", role: "assistant", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" }]);
    const session = new AssistantSession({
      client,
      tools: [],
      actor: paralegal,
      auditLog: new AuditLog(),
      context: () => firmClockContext("America/New_York", new Date("2026-11-25T15:30:00Z")),
    });
    await session.sendMessage("book tomorrow at 10");
    expect(client.systems[0]).toContain("Wednesday, November 25, 2026");
    expect(client.systems[0]).toContain("America/New_York (UTC-05:00)");
    expect(client.systems[0]).toContain("2026-11-26T10:00:00-05:00");
  });

  it("gets a zoneless time back as an error it can correct, and books a zoned one where it was meant", async () => {
    const { toolList, scheduling } = tools();
    const book = toolList.find((t) => t.definition.name === "book_appointment")!;
    await expect(book.execute(paralegal, { matterId: "m1", attorneyId: "a1", startTime: "2026-12-01T10:00" })).rejects.toThrow(
      /with its zone/,
    );
    expect(scheduling.listAll(paralegal)).toHaveLength(0);

    const booked = (await book.execute(paralegal, {
      matterId: "m1",
      attorneyId: "a1",
      startTime: "2026-12-01T10:00:00-05:00",
    })) as { startTime: string };
    expect(booked.startTime).toBe("2026-12-01T15:00:00.000Z");
  });
});
