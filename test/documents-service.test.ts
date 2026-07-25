import { describe, expect, it } from "vitest";
import { DocumentsService } from "../src/review-ui/documents-service.js";
import { DocumentStore } from "../src/core/document-store.js";
import { AccessControl } from "../src/core/access-control.js";
import { AuditLog } from "../src/core/audit.js";
import { AccessDeniedError, type Actor } from "../src/core/types.js";

const attorney: Actor = { id: "a1", role: "attorney" };
const paralegal: Actor = { id: "p1", role: "paralegal" };
const receptionist: Actor = { id: "r1", role: "receptionist" };

function makeService() {
  const accessControl = new AccessControl(new AuditLog());
  accessControl.assignParalegal("p1", "m1");
  const store = new DocumentStore();
  return { accessControl, store, documents: new DocumentsService({ accessControl, store }) };
}

describe("DocumentsService", () => {
  it("denies receptionists entirely", () => {
    const { documents } = makeService();
    expect(() => documents.listMatterDocuments(receptionist, "m1")).toThrow(AccessDeniedError);
  });

  it("uploads a document on the paralegal's assigned matter", () => {
    const { documents } = makeService();
    const doc = documents.upload(paralegal, "m1", { fileName: "contract.pdf", contentType: "application/pdf", content: "aGVsbG8=" });
    expect(doc.fileName).toBe("contract.pdf");
    expect(doc.uploadedBy).toBe("p1");
  });

  it("denies uploading on a matter the paralegal isn't assigned to", () => {
    const { documents } = makeService();
    expect(() =>
      documents.upload(paralegal, "m2", { fileName: "contract.pdf", contentType: "application/pdf", content: "aGVsbG8=" }),
    ).toThrow(AccessDeniedError);
  });

  it("lets an attorney upload on any matter", () => {
    const { documents } = makeService();
    const doc = documents.upload(attorney, "m999", { fileName: "x.pdf", contentType: "application/pdf", content: "aGVsbG8=" });
    expect(doc.matterId).toBe("m999");
  });

  it("rejects an empty file name", () => {
    const { documents } = makeService();
    expect(() => documents.upload(paralegal, "m1", { fileName: "  ", contentType: "application/pdf", content: "aGVsbG8=" })).toThrow(
      /fileName is required/,
    );
  });

  it("lists documents scoped to the matter", () => {
    const { documents } = makeService();
    documents.upload(paralegal, "m1", { fileName: "a.pdf", contentType: "application/pdf", content: "YQ==" });
    expect(documents.listMatterDocuments(paralegal, "m1")).toHaveLength(1);
  });

  it("gets a document with its content, denied cross-matter even by id", () => {
    const { documents } = makeService();
    const created = documents.upload(attorney, "m999", { fileName: "x.pdf", contentType: "application/pdf", content: "aGVsbG8=" });
    const fetched = documents.getWithContent(attorney, "m999", created.id);
    expect(fetched.content).toBe("aGVsbG8=");
    expect(() => documents.getWithContent(paralegal, "m999", created.id)).toThrow(AccessDeniedError);
  });

  it("returns 'no document' error for an unknown id on an accessible matter", () => {
    const { documents } = makeService();
    expect(() => documents.getWithContent(paralegal, "m1", "nope")).toThrow(/no document/);
  });

  it("deletes a document", () => {
    const { documents, store } = makeService();
    const created = documents.upload(paralegal, "m1", { fileName: "a.pdf", contentType: "application/pdf", content: "YQ==" });
    documents.delete(paralegal, "m1", created.id);
    expect(store.get(created.id)).toBeUndefined();
  });
});
