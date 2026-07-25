import { describe, expect, it } from "vitest";
import { DocumentStore } from "../src/core/document-store.js";

describe("DocumentStore", () => {
  it("uploads a document and computes its size from base64 content", () => {
    const store = new DocumentStore();
    const doc = store.upload({
      matterId: "m1",
      fileName: "contract.pdf",
      contentType: "application/pdf",
      content: Buffer.from("hello world").toString("base64"),
      uploadedBy: "p1",
    });
    expect(doc.id).toBe("doc_1");
    expect(doc.size).toBe(Buffer.byteLength("hello world"));
    expect(store.get(doc.id)).toEqual(doc);
  });

  it("lists documents by matter", () => {
    const store = new DocumentStore();
    store.upload({ matterId: "m1", fileName: "a.pdf", contentType: "application/pdf", content: "YQ==", uploadedBy: "p1" });
    store.upload({ matterId: "m2", fileName: "b.pdf", contentType: "application/pdf", content: "Yg==", uploadedBy: "p1" });
    expect(store.listByMatter("m1")).toHaveLength(1);
    expect(store.listByMatter("m1")[0]?.fileName).toBe("a.pdf");
  });

  it("deletes a document", () => {
    const store = new DocumentStore();
    const doc = store.upload({ matterId: "m1", fileName: "a.pdf", contentType: "application/pdf", content: "YQ==", uploadedBy: "p1" });
    store.delete(doc.id);
    expect(store.get(doc.id)).toBeUndefined();
  });

  it("round-trips through toSnapshot/fromSnapshot, preserving ids and continuing id allocation", () => {
    const store = new DocumentStore();
    store.upload({ matterId: "m1", fileName: "a.pdf", contentType: "application/pdf", content: "YQ==", uploadedBy: "p1" });
    store.upload({ matterId: "m1", fileName: "b.pdf", contentType: "application/pdf", content: "Yg==", uploadedBy: "p1" });

    const restored = DocumentStore.fromSnapshot(store.toSnapshot());
    expect(restored.listAll()).toHaveLength(2);
    expect(restored.get("doc_1")?.fileName).toBe("a.pdf");

    const next = restored.upload({ matterId: "m1", fileName: "c.pdf", contentType: "application/pdf", content: "Yw==", uploadedBy: "p1" });
    expect(next.id).toBe("doc_3");
  });
});
