import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { AuditLog } from "../src/core/audit.js";
import { AccessControl } from "../src/core/access-control.js";
import { WorkProductStore } from "../src/core/work-product-store.js";
import { MatterStore } from "../src/core/matters.js";
import { ConflictChecker } from "../src/core/conflicts.js";
import { DocumentStore } from "../src/core/document-store.js";
import { ResearchLibrary } from "../src/core/research-library.js";
import { SchedulingService } from "../src/core/scheduling.js";
import { AuthService } from "../src/core/auth.js";
import { DraftingService } from "../src/review-ui/drafting-service.js";
import { DocumentsService } from "../src/review-ui/documents-service.js";
import { CasesService } from "../src/review-ui/cases-service.js";
import { ResearchService } from "../src/review-ui/research-service.js";
import { ReviewGateService } from "../src/review-ui/review-service.js";
import { MattersService } from "../src/review-ui/matters-service.js";
import { createReviewServer } from "../src/review-ui/server.js";
import { createAssistantTools } from "../src/assistant/tools.js";
import {
  criminalLawModule,
  PADILLA_ADVISORY_FLAG,
  PROTECTIVE_ORDER_NO_DISTRIBUTION_FLAG,
} from "../src/modules/criminal-law/index.js";
import type { Actor } from "../src/core/types.js";

/**
 * §3: plea drafting for a noncitizen client "must hard-trigger an
 * immigration-consequence advisory flag ... not rely on someone
 * remembering to check." The flag only fired when a request said
 * `clientIsNoncitizen: true`, and nothing in Docket ever said it — so no
 * plea memo drafted from the panel or by the Assistant was ever flagged.
 */
const paralegal: Actor = { id: "p1", role: "paralegal" };
const attorney: Actor = { id: "a1", role: "attorney" };

function setup() {
  const auditLog = new AuditLog();
  const accessControl = new AccessControl(auditLog);
  accessControl.assignParalegal("p1", "m1");
  const store = new WorkProductStore();
  const matters = new MatterStore();
  const drafting = new DraftingService({ accessControl, auditLog, module: criminalLawModule, store, matters });
  const plea = (context?: Record<string, unknown>) =>
    drafting.draftFromTemplate(paralegal, "m1", { templateId: "plea_agreement_memo", content: "Plea terms…", ...(context ? { context } : {}) });
  return { auditLog, accessControl, store, matters, drafting, plea };
}

describe("the Padilla flag on a plea memo", () => {
  it("is raised unless the matter record says the client is a U.S. citizen", () => {
    const { matters, plea } = setup();
    expect(plea().flags).toContain(PADILLA_ADVISORY_FLAG); // no record at all
    matters.upsert("m1", { title: "State v. Ruiz", clientCitizenship: "unknown" });
    expect(plea().flags).toContain(PADILLA_ADVISORY_FLAG);
    matters.upsert("m1", { clientCitizenship: "noncitizen" });
    expect(plea().flags).toContain(PADILLA_ADVISORY_FLAG);
    matters.upsert("m1", { clientCitizenship: "us_citizen" });
    expect(plea().flags).not.toContain(PADILLA_ADVISORY_FLAG);
  });

  it("can't be talked away by the request — only added", () => {
    const { matters, plea } = setup();
    expect(plea({ clientCitizenship: "us_citizen" }).flags).toContain(PADILLA_ADVISORY_FLAG);
    expect(plea({ clientIsNoncitizen: false }).flags).toContain(PADILLA_ADVISORY_FLAG);
    matters.upsert("m1", { title: "State v. Ruiz", clientCitizenship: "us_citizen" });
    expect(plea({ clientIsNoncitizen: true }).flags).toContain(PADILLA_ADVISORY_FLAG);
  });

  it("isn't raised on drafting that isn't about a plea", () => {
    const { drafting } = setup();
    const motion = drafting.draftFromTemplate(paralegal, "m1", { templateId: "motion_to_suppress", content: "…" });
    expect(motion.flags).not.toContain(PADILLA_ADVISORY_FLAG);
  });

  it("is raised for a plea memo the Assistant drafts, which can also add the protective-order flag", async () => {
    const { auditLog, accessControl, store, drafting } = setup();
    const documentStore = new DocumentStore();
    const tools = createAssistantTools({
      drafting,
      documents: new DocumentsService({ accessControl, store: documentStore }),
      cases: new CasesService({ accessControl, workProductStore: store, documentStore }),
      research: new ResearchService({ accessControl, library: new ResearchLibrary(), searchClient: { search: async () => [] } }),
      scheduling: new SchedulingService(),
      reviewGate: new ReviewGateService(store),
    });
    void auditLog;
    const draft = tools.find((t) => t.definition.name === "draft_from_template")!;
    const memo = (await draft.execute(paralegal, {
      matterId: "m1",
      templateId: "plea_agreement_memo",
      content: "Plea terms…",
      protectiveOrderMaterial: true,
      clientIsNoncitizen: false,
    })) as { flags: string[] };
    expect(memo.flags).toEqual(expect.arrayContaining([PADILLA_ADVISORY_FLAG, PROTECTIVE_ORDER_NO_DISTRIBUTION_FLAG]));
  });
});

describe("the matter record's citizenship field", () => {
  it("keeps only a value it knows, and survives a restart", () => {
    const matters = new MatterStore();
    expect(() => matters.upsert("m1", { clientCitizenship: "citizen" as never })).toThrow(/us_citizen, noncitizen or unknown/);
    matters.upsert("m1", { title: "State v. Ruiz", clientCitizenship: "us_citizen" });
    matters.upsert("m1", { title: "State v. Ruiz (renamed)" });
    expect(MatterStore.fromSnapshot(JSON.parse(JSON.stringify(matters.toSnapshot()))).get("m1")?.clientCitizenship).toBe("us_citizen");
  });
});

describe("over HTTP", () => {
  let server: Server;
  let baseUrl: string;
  let attorneyCookie: string;
  let paralegalCookie: string;
  let auditLog: AuditLog;

  beforeEach(async () => {
    const auth = new AuthService();
    auth.createUser({ username: "attorney1", password: "correct-horse", role: "attorney", actorId: "a1" });
    auth.createUser({ username: "paralegal1", password: "correct-horse", role: "paralegal", actorId: "p1" });
    const built = setup();
    auditLog = built.auditLog;
    const matters = new MattersService({ store: built.matters, checker: new ConflictChecker(built.matters), accessControl: built.accessControl, auditLog });
    server = createReviewServer(new ReviewGateService(built.store), auth, { matters, drafting: built.drafting, auditLog });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    attorneyCookie = await login("attorney1");
    paralegalCookie = await login("paralegal1");
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function login(username: string): Promise<string> {
    const res = await fetch(`${baseUrl}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password: "correct-horse" }),
    });
    return res.headers.get("set-cookie")!.split(";")[0]!;
  }

  const send = (method: string, path: string, cookie: string, body: unknown) =>
    fetch(`${baseUrl}${path}`, { method, headers: { "Content-Type": "application/json", cookie }, body: JSON.stringify(body) });

  it("records citizenship on the matter (attorney-only, audited) and drafts from it", async () => {
    expect((await send("PUT", "/api/matters/m1", attorneyCookie, { title: "State v. Ruiz", clientCitizenship: "maybe" })).status).toBe(400);
    expect((await send("PUT", "/api/matters/m1", paralegalCookie, { title: "State v. Ruiz", clientCitizenship: "us_citizen" })).status).toBe(403);

    // Before anything is recorded — and whatever the request claims — the memo is flagged.
    const before = await send("POST", "/api/drafting/matters/m1/draft-template", paralegalCookie, {
      templateId: "plea_agreement_memo",
      content: "Plea terms…",
      context: { clientCitizenship: "us_citizen", clientIsNoncitizen: false },
    });
    expect((await before.json()).flags).toContain(PADILLA_ADVISORY_FLAG);

    expect((await send("PUT", "/api/matters/m1", attorneyCookie, { title: "State v. Ruiz", clientCitizenship: "us_citizen" })).status).toBe(200);
    const audit = auditLog.read("attorney").filter((e) => e.action.startsWith("matter_record_"));
    expect(audit.at(-1)!.changes?.some((c) => c.field === "clientCitizenship")).toBe(true);

    const after = await send("POST", "/api/drafting/matters/m1/draft-template", paralegalCookie, {
      templateId: "plea_agreement_memo",
      content: "Plea terms…",
    });
    expect((await after.json()).flags).not.toContain(PADILLA_ADVISORY_FLAG);
  });
});
