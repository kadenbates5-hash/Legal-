import { AccessDeniedError, type Actor } from "../core/types.js";
import type { AccessControl } from "../core/access-control.js";
import type { CaseDocument } from "../core/document-store.js";
import { DocumentStore } from "../core/document-store.js";

/**
 * The paralegal/attorney-facing surface backing Docket's "Cases" panel —
 * where a paralegal uploads and names the actual files for a matter
 * (contracts, exhibits, scanned forms), as distinct from `DraftingService`'s
 * agent-drafted text. Same shape as `DraftingService`: every method is
 * access-controlled against the matter before touching the store, since a
 * document is scoped to exactly one matter and this is exposed over HTTP by
 * matter id/document id, which any authenticated caller could otherwise
 * name arbitrarily.
 *
 * `maxUploadBytes` guards this project's single-JSON-blob persistence
 * model (see `CLAUDE.md`'s "Persistence" section): every document's
 * base64 content lives inline in the same document that's rewritten
 * whole on every mutation (`onMutated` in `server.ts`), so an unbounded
 * upload doesn't just cost disk — it makes *every other* request slower
 * as the whole state blob grows. Defaults to 25 MB per file, comfortably
 * inside Postgres's 1 GB per-`JSONB`-value limit and Node's in-memory
 * string limits even with many documents, while still ruling out the
 * pathological "someone uploads a 2 GB video" case. Configurable via
 * `MAX_DOCUMENT_UPLOAD_BYTES` (see `start.ts`) since a firm on Postgres
 * with real headroom may reasonably want it higher.
 */
const DEFAULT_MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export interface DocumentSummary {
  id: string;
  matterId: string;
  fileName: string;
  contentType: string;
  size: number;
  uploadedBy: string;
  uploadedAt: string;
}

export interface DocumentWithContent extends DocumentSummary {
  content: string;
}

function requireCaseFileRole(actor: Actor): void {
  if (actor.role !== "paralegal" && actor.role !== "attorney") {
    throw new AccessDeniedError(`case documents are paralegal/attorney-only (got role '${actor.role}')`);
  }
}

function summarize(doc: CaseDocument): DocumentSummary {
  return {
    id: doc.id,
    matterId: doc.matterId,
    fileName: doc.fileName,
    contentType: doc.contentType,
    size: doc.size,
    uploadedBy: doc.uploadedBy,
    uploadedAt: doc.uploadedAt,
  };
}

export class DocumentsService {
  #accessControl: AccessControl;
  #store: DocumentStore;
  #maxUploadBytes: number;

  constructor(params: { accessControl: AccessControl; store: DocumentStore; maxUploadBytes?: number }) {
    this.#accessControl = params.accessControl;
    this.#store = params.store;
    this.#maxUploadBytes = params.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES;
  }

  /** Exposed so the UI can tell a paralegal/attorney the limit before they try uploading something over it. */
  getMaxUploadBytes(): number {
    return this.#maxUploadBytes;
  }

  listMatterDocuments(actor: Actor, matterId: string): DocumentSummary[] {
    requireCaseFileRole(actor);
    this.#accessControl.authorize({ actor, matterId, category: "case_file" });
    return this.#store.listByMatter(matterId).map(summarize);
  }

  upload(actor: Actor, matterId: string, params: { fileName: string; contentType: string; content: string }): DocumentSummary {
    requireCaseFileRole(actor);
    this.#accessControl.authorize({ actor, matterId, category: "case_file" });
    if (!params.fileName.trim()) throw new Error("fileName is required");
    const size = Buffer.byteLength(params.content, "base64");
    if (size > this.#maxUploadBytes) {
      throw new Error(`file is ${size} bytes, over the ${this.#maxUploadBytes}-byte upload limit for this server`);
    }
    const doc = this.#store.upload({
      matterId,
      fileName: params.fileName,
      contentType: params.contentType || "application/octet-stream",
      content: params.content,
      uploadedBy: actor.id,
    });
    return summarize(doc);
  }

  /** Includes the base64 content, for download — everything else deals in `DocumentSummary` only. */
  getWithContent(actor: Actor, matterId: string, id: string): DocumentWithContent {
    requireCaseFileRole(actor);
    this.#accessControl.authorize({ actor, matterId, category: "case_file" });
    const doc = this.#requireMatterDocument(matterId, id);
    return { ...summarize(doc), content: doc.content };
  }

  delete(actor: Actor, matterId: string, id: string): void {
    requireCaseFileRole(actor);
    this.#accessControl.authorize({ actor, matterId, category: "case_file" });
    this.#requireMatterDocument(matterId, id);
    this.#store.delete(id);
  }

  #requireMatterDocument(matterId: string, id: string): CaseDocument {
    const doc = this.#store.get(id);
    if (!doc || doc.matterId !== matterId) {
      throw new Error(`no document '${id}' on matter '${matterId}'`);
    }
    return doc;
  }
}
