import { describe, expect, it } from "vitest";
import { ResearchService } from "../src/review-ui/research-service.js";
import { ResearchLibrary } from "../src/core/research-library.js";
import { AccessControl } from "../src/core/access-control.js";
import { AuditLog } from "../src/core/audit.js";
import { AccessDeniedError, type Actor } from "../src/core/types.js";
import type { CaseLawSearchClient, CaseSearchResult } from "../src/integrations/courtlistener.js";

const attorney: Actor = { id: "a1", role: "attorney" };
const paralegal: Actor = { id: "p1", role: "paralegal" };
const receptionist: Actor = { id: "r1", role: "receptionist" };

class FakeSearchClient implements CaseLawSearchClient {
  lastQuery: string | undefined;
  async search(query: string): Promise<CaseSearchResult[]> {
    this.lastQuery = query;
    return [{ caseName: "Roe v. Wade", citations: ["410 U.S. 113"], court: undefined, dateFiled: undefined, snippet: undefined, url: "https://x" }];
  }
}

function makeService() {
  const accessControl = new AccessControl(new AuditLog());
  accessControl.assignParalegal("p1", "m1");
  const library = new ResearchLibrary();
  const searchClient = new FakeSearchClient();
  return { accessControl, library, searchClient, research: new ResearchService({ accessControl, library, searchClient }) };
}

describe("ResearchService", () => {
  it("denies receptionists entirely", async () => {
    const { research } = makeService();
    await expect(research.search(receptionist, "abortion")).rejects.toThrow(AccessDeniedError);
    expect(() => research.listMatterReferences(receptionist, "m1")).toThrow(AccessDeniedError);
  });

  it("searches case law without requiring a matter", async () => {
    const { research, searchClient } = makeService();
    const results = await research.search(paralegal, "abortion");
    expect(searchClient.lastQuery).toBe("abortion");
    expect(results).toHaveLength(1);
  });

  it("rejects an empty search query", async () => {
    const { research } = makeService();
    await expect(research.search(paralegal, "  ")).rejects.toThrow(/query is required/);
  });

  it("lets an attorney search too", async () => {
    const { research } = makeService();
    const results = await research.search(attorney, "x");
    expect(results).toHaveLength(1);
  });

  it("saves a reference to the paralegal's assigned matter", () => {
    const { research } = makeService();
    const saved = research.saveReference(paralegal, "m1", { citation: "410 U.S. 113", title: "Roe v. Wade" });
    expect(saved.savedBy).toBe("p1");
    expect(research.listMatterReferences(paralegal, "m1")).toHaveLength(1);
  });

  it("denies saving to a matter the paralegal isn't assigned to", () => {
    const { research } = makeService();
    expect(() => research.saveReference(paralegal, "m2", { citation: "c", title: "t" })).toThrow(AccessDeniedError);
  });

  it("lets an attorney save to any matter", () => {
    const { research } = makeService();
    const saved = research.saveReference(attorney, "m999", { citation: "c", title: "t" });
    expect(saved.matterId).toBe("m999");
  });

  it("rejects a missing citation or title", () => {
    const { research } = makeService();
    expect(() => research.saveReference(paralegal, "m1", { citation: "  ", title: "t" })).toThrow(/citation is required/);
    expect(() => research.saveReference(paralegal, "m1", { citation: "c", title: "  " })).toThrow(/title is required/);
  });

  it("deletes a saved reference", () => {
    const { research } = makeService();
    const saved = research.saveReference(paralegal, "m1", { citation: "c", title: "t" });
    research.deleteReference(paralegal, "m1", saved.id);
    expect(research.listMatterReferences(paralegal, "m1")).toHaveLength(0);
  });

  it("returns a clear error for an unknown reference id on an accessible matter", () => {
    const { research } = makeService();
    expect(() => research.deleteReference(paralegal, "m1", "nope")).toThrow(/no saved reference/);
  });

  it("denies deleting a reference on a matter the paralegal isn't assigned to, even by id", () => {
    const { research } = makeService();
    const saved = research.saveReference(attorney, "m999", { citation: "c", title: "t" });
    expect(() => research.deleteReference(paralegal, "m999", saved.id)).toThrow(AccessDeniedError);
  });
});
