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
  /**
   * Whether the client can see and download this document through the
   * client portal. Defaults to `false` — an uploaded file starts private
   * the same way a draft starts unreviewed, and someone on staff has to
   * make an affirmative choice to share it, the same as `close()`
   * requiring a note rather than inferring disposition.
   */
  visibleToClient: boolean;
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
      visibleToClient: false,
    };
    this.#byId.set(document.id, document);
    return document;
  }

  get(id: string): CaseDocument | undefined {
    return this.#byId.get(id);
  }

  /** The one write path for client visibility — a deliberate, auditable act by whoever calls it (see `DocumentsService.setClientVisibility`). */
  setClientVisibility(id: string, visible: boolean): CaseDocument {
    const doc = this.#byId.get(id);
    if (!doc) throw new Error(`no document '${id}'`);
    const updated = { ...doc, visibleToClient: visible };
    this.#byId.set(id, updated);
    return updated;
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
      // `visibleToClient` may be absent on a snapshot predating client
      // accounts — defaults to false, same as a freshly uploaded file.
      store.#byId.set(doc.id, { ...doc, visibleToClient: doc.visibleToClient ?? false });
      const num = Number(doc.id.replace(/^doc_/, ""));
      if (Number.isFinite(num) && num > maxId) maxId = num;
    }
    store.#nextId = maxId + 1;
    return store;
  }
}
