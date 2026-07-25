import { describe, expect, it } from "vitest";
import { AssistantService } from "../src/review-ui/assistant-service.js";
import { DraftingService } from "../src/review-ui/drafting-service.js";
import { DocumentsService } from "../src/review-ui/documents-service.js";
import { CasesService } from "../src/review-ui/cases-service.js";
import { ResearchService } from "../src/review-ui/research-service.js";
import { ReviewGateService } from "../src/review-ui/review-service.js";
import { SchedulingService } from "../src/core/scheduling.js";
import { WorkProductStore } from "../src/core/work-product-store.js";
import { DocumentStore } from "../src/core/document-store.js";
import { ResearchLibrary } from "../src/core/research-library.js";
import { AccessControl } from "../src/core/access-control.js";
import { AuditLog } from "../src/core/audit.js";
import { AccessDeniedError, type Actor } from "../src/core/types.js";
import { criminalLawModule } from "../src/modules/criminal-law/index.js";
import type { ClaudeClient, ClaudeResponse } from "../src/integrations/anthropic.js";
import type { CaseLawSearchClient, CaseSearchResult } from "../src/integrations/courtlistener.js";

const attorney: Actor = { id: "a1", role: "attorney" };
const paralegal: Actor = { id: "p1", role: "paralegal" };
const receptionist: Actor = { id: "r1", role: "receptionist" };

class FakeSearchClient implements CaseLawSearchClient {
  async search(): Promise<CaseSearchResult[]> {
    return [];
  }
}

class FakeClaudeClient implements ClaudeClient {
  async createMessage(): Promise<ClaudeResponse> {
    return { id: "msg_1", role: "assistant", content: [{ type: "text", text: "a reply" }], stop_reason: "end_turn" };
  }
}

function makeService() {
  const auditLog = new AuditLog();
  const accessControl = new AccessControl(auditLog);
  const workProductStore = new WorkProductStore();
  const documentStore = new DocumentStore();
  const toolDeps = {
    drafting: new DraftingService({ accessControl, auditLog, module: criminalLawModule, store: workProductStore }),
    documents: new DocumentsService({ accessControl, store: documentStore }),
    cases: new CasesService({ accessControl, workProductStore, documentStore }),
    research: new ResearchService({ accessControl, library: new ResearchLibrary(), searchClient: new FakeSearchClient() }),
    scheduling: new SchedulingService(),
    reviewGate: new ReviewGateService(workProductStore),
  };
  return new AssistantService({ client: new FakeClaudeClient(), auditLog, toolDeps });
}

describe("AssistantService", () => {
  it("denies receptionists entirely", () => {
    const service = makeService();
    expect(() => service.start(receptionist)).toThrow(AccessDeniedError);
  });

  it("lets a paralegal start a session and send a message", async () => {
    const service = makeService();
    const { sessionId } = service.start(paralegal);
    const result = await service.sendMessage(paralegal, sessionId, "hello");
    expect(result.reply).toBe("a reply");
  });

  it("lets an attorney start a session too", () => {
    const service = makeService();
    const { sessionId } = service.start(attorney);
    expect(sessionId).toBeTruthy();
  });

  it("rejects messages to an unknown session", async () => {
    const service = makeService();
    await expect(service.sendMessage(paralegal, "nope", "hi")).rejects.toThrow(/no assistant session/);
  });

  it("does not let one actor send messages into another actor's session", async () => {
    const service = makeService();
    const { sessionId } = service.start(paralegal);
    await expect(service.sendMessage(attorney, sessionId, "hi")).rejects.toThrow(/no assistant session/);
  });

  it("end() removes a session, and only for the actor who owns it", async () => {
    const service = makeService();
    const { sessionId } = service.start(paralegal);
    service.end(attorney, sessionId); // no-op, wrong owner
    await expect(service.sendMessage(paralegal, sessionId, "still here?")).resolves.toBeDefined();

    service.end(paralegal, sessionId);
    await expect(service.sendMessage(paralegal, sessionId, "gone now")).rejects.toThrow(/no assistant session/);
  });
});
