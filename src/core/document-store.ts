/**
 * Central in-memory registry of uploaded case documents — the place a
 * paralegal or attorney stores a named file (a contract, exhibit, scanned
 * form, etc.) against a matter, separate from `WorkProductStore`'s drafted
 * text (motions/letters/research the agent itself writes). No access
 * control lives here — that's `AccessControl`/the review-ui service's job,
 * same split as `WorkProductStore`.
 *
 * Content is stored as a base64 string directly in the record (matching
 * this project's single-JSON-blob persistence model — see
 * `src/persistence/`) rather than on a separate filesystem/object-store
 * path, so `toSnapshot()`/`fromSnapshot()` round-trip a document exactly
 * like every other stateful core object.
 */
export interface CaseDocument {
  id: string;
  matterId: string;
  fileName: string;
  contentType: string;
  /** Base64-encoded file bytes. */
  content: string;
  size: number;
  uploadedBy: string;
  uploadedAt: string;
}

export class DocumentStore {
  #byId = new Map<string, CaseDocument>();
  #nextId = 1;

  upload(params: { matterId: string; fileName: string; contentType: string; content: string; uploadedBy: string }): CaseDocument {
    const document: CaseDocument = {
      id: `doc_${this.#nextId++}`,
      matterId: params.matterId,
      fileName: params.fileName,
      contentType: params.contentType,
      content: params.content,
      size: Buffer.byteLength(params.content, "base64"),
      uploadedBy: params.uploadedBy,
      uploadedAt: new Date().toISOString(),
    };
    this.#byId.set(document.id, document);
    return document;
  }

  get(id: string): CaseDocument | undefined {
    return this.#byId.get(id);
  }

  listAll(): CaseDocument[] {
    return [...this.#byId.values()];
  }

  listByMatter(matterId: string): CaseDocument[] {
    return this.listAll().filter((doc) => doc.matterId === matterId);
  }

  delete(id: string): void {
    this.#byId.delete(id);
  }

  toSnapshot(): CaseDocument[] {
    return this.listAll().map((doc) => ({ ...doc }));
  }

  static fromSnapshot(snapshot: readonly CaseDocument[]): DocumentStore {
    const store = new DocumentStore();
    let maxId = 0;
    for (const doc of snapshot) {
      store.#byId.set(doc.id, { ...doc });
      const num = Number(doc.id.replace(/^doc_/, ""));
      if (Number.isFinite(num) && num > maxId) maxId = num;
    }
    store.#nextId = maxId + 1;
    return store;
  }
}
