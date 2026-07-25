import { describe, expect, it } from "vitest";
import { createAssistantTools } from "../src/assistant/tools.js";
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
import type { CaseLawSearchClient, CaseSearchResult } from "../src/integrations/courtlistener.js";

const attorney: Actor = { id: "a1", role: "attorney" };
const paralegal: Actor = { id: "p1", role: "paralegal" };

class FakeSearchClient implements CaseLawSearchClient {
  async search(query: string): Promise<CaseSearchResult[]> {
    return [{ caseName: `Result for ${query}`, citations: [], court: undefined, dateFiled: undefined, snippet: undefined, url: "https://x" }];
  }
}

function makeTools() {
  const auditLog = new AuditLog();
  const accessControl = new AccessControl(auditLog);
  accessControl.assignParalegal("p1", "m1");
  const workProductStore = new WorkProductStore();
  const documentStore = new DocumentStore();
  const drafting = new DraftingService({ accessControl, auditLog, module: criminalLawModule, store: workProductStore });
  const documents = new DocumentsService({ accessControl, store: documentStore });
  const cases = new CasesService({ accessControl, workProductStore, documentStore });
  const research = new ResearchService({ accessControl, library: new ResearchLibrary(), searchClient: new FakeSearchClient() });
  const scheduling = new SchedulingService();
  const reviewGate = new ReviewGateService(workProductStore);
  const tools = createAssistantTools({ drafting, documents, cases, research, scheduling, reviewGate });
  return { tools, drafting, workProductStore };
}

function findTool(tools: ReturnType<typeof createAssistantTools>, name: string) {
  const tool = tools.find((t) => t.definition.name === name);
  if (!tool) throw new Error(`no tool '${name}'`);
  return tool;
}

describe("createAssistantTools", () => {
  it("never exposes review-gate status transitions, deadline confirmation, or account management", () => {
    const { tools } = makeTools();
    const names = tools.map((t) => t.definition.name);
    for (const forbidden of ["approve", "reject", "request_revision", "release", "clear_flag", "confirm_deadline", "create_account", "disable_account"]) {
      expect(names).not.toContain(forbidden);
    }
  });

  it("draft_from_template creates a draft scoped to the actor's matter access", async () => {
    const { tools } = makeTools();
    const result = (await findTool(tools, "draft_from_template").execute(paralegal, {
      matterId: "m1",
      templateId: "engagement_letter",
      content: "Dear client...",
    })) as { status: string; matterId: string };
    expect(result.status).toBe("draft");
    expect(result.matterId).toBe("m1");
  });

  it("draft_from_template denies a matter the paralegal isn't assigned to", async () => {
    const { tools } = makeTools();
    await expect(
      findTool(tools, "draft_from_template").execute(paralegal, { matterId: "m2", templateId: "engagement_letter", content: "x" }),
    ).rejects.toThrow(AccessDeniedError);
  });

  it("submit_draft_for_review moves a draft into pending_review, not further", async () => {
    const { tools, workProductStore } = makeTools();
    const created = (await findTool(tools, "draft_from_template").execute(paralegal, {
      matterId: "m1",
      templateId: "engagement_letter",
      content: "x",
    })) as { id: string };
    const result = (await findTool(tools, "submit_draft_for_review").execute(paralegal, { matterId: "m1", workProductId: created.id })) as {
      status: string;
    };
    expect(result.status).toBe("pending_review");
    // Confirms there is no tool that could push it further than pending_review.
    expect(workProductStore.get(created.id)?.status).toBe("pending_review");
  });

  it("search_case_law and save_research_reference work end to end", async () => {
    const { tools } = makeTools();
    const results = (await findTool(tools, "search_case_law").execute(attorney, { query: "Miranda" })) as { caseName: string }[];
    expect(results[0]?.caseName).toBe("Result for Miranda");

    const saved = await findTool(tools, "save_research_reference").execute(paralegal, {
      matterId: "m1",
      citation: "410 U.S. 113",
      title: "Roe v. Wade",
    });
    expect(saved).toMatchObject({ citation: "410 U.S. 113", title: "Roe v. Wade" });
  });

  it("get_deadline_status is attorney-only, matching ReviewGateService directly", async () => {
    const { tools } = makeTools();
    await expect(findTool(tools, "get_deadline_status").execute(paralegal, { matterId: "m1", type: "speedy_trial" })).rejects.toThrow(
      AccessDeniedError,
    );
    const status = await findTool(tools, "get_deadline_status").execute(attorney, { matterId: "m1", type: "speedy_trial" });
    expect(status).toMatchObject({ state: "unconfirmed" });
  });

  it("book_appointment and list_appointments round-trip", async () => {
    const { tools } = makeTools();
    const booked = (await findTool(tools, "book_appointment").execute(paralegal, {
      matterId: "m1",
      startTime: "2026-08-03T15:00:00Z",
      attorneyId: "a1",
    })) as { id: string };
    expect(booked.id).toBeTruthy();

    const list = (await findTool(tools, "list_appointments").execute(paralegal, { matterId: "m1" })) as unknown[];
    expect(list).toHaveLength(1);
  });

  it("list_cases and get_case reflect the same access scoping as the Cases panel", async () => {
    const { tools } = makeTools();
    await findTool(tools, "draft_from_template").execute(paralegal, { matterId: "m1", templateId: "engagement_letter", content: "x" });
    const cases = (await findTool(tools, "list_cases").execute(paralegal, {})) as { matterId: string }[];
    expect(cases.map((c) => c.matterId)).toEqual(["m1"]);

    await expect(findTool(tools, "get_case").execute(paralegal, { matterId: "m2" })).rejects.toThrow(AccessDeniedError);
  });
});
