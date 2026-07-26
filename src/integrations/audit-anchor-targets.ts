import { appendFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { AuditAnchorTarget } from "../core/audit-anchor.js";
import type { AuditAnchorRecord } from "../core/audit.js";
import type { EmailSender } from "./email-sender.js";

/**
 * Concrete places to publish an audit anchor. See `core/audit-anchor.ts`
 * for what an anchor is and why the *destination* is the whole security
 * property — these are the mechanisms, not the guarantee.
 */

/**
 * Appends one line per anchor to a file, JSON Lines format.
 *
 * **This is only worth anything if the file is out of reach of whoever
 * can edit the database.** On the same disk, under the same account, it
 * is theatre: the same person edits both and nothing is detected. It
 * becomes real when the path is
 *
 * - on a volume mounted append-only or write-once, or
 * - tailed off the machine by a log shipper the app can't reach, or
 * - on storage the application user can append to but not rewrite
 *   (e.g. a directory with the append-only attribute set).
 *
 * Append-only *format* is chosen for the same reason: a rewrite that
 * shortens the file is visible as missing sequences, and JSON Lines can
 * be appended to without reading or rewriting what's already there.
 */
export class FileAnchorTarget implements AuditAnchorTarget {
  readonly name = "file";
  #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  get path(): string {
    return this.#path;
  }

  async publish(anchor: { sequence: number; headHash: string; anchoredAt: string }): Promise<{ receipt?: string }> {
    const line = JSON.stringify({
      sequence: anchor.sequence,
      headHash: anchor.headHash,
      anchoredAt: anchor.anchoredAt,
    });
    await appendFile(this.#path, `${line}\n`, "utf8");
    // The receipt is a hash of the exact line written, so a later
    // comparison can tell "this anchor" from "an anchor at this sequence".
    return { receipt: createHash("sha256").update(line).digest("hex").slice(0, 16) };
  }

  async readBack(): Promise<AuditAnchorRecord[]> {
    let raw: string;
    try {
      raw = await readFile(this.#path, "utf8");
    } catch (err) {
      // A file that was never written to isn't a verification failure —
      // it means nothing has been anchored yet.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const records: AuditAnchorRecord[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as { sequence: number; headHash: string; anchoredAt: string };
        if (typeof parsed.sequence !== "number" || typeof parsed.headHash !== "string") continue;
        records.push({ ...parsed, destination: this.name, receipt: undefined });
      } catch {
        // A corrupt line is skipped rather than aborting the read: the
        // anchors that *are* readable still prove what they prove, and
        // silently losing all of them to one bad line would be worse.
      }
    }
    return records;
  }
}

/**
 * Emails the anchor to one or more addresses.
 *
 * For a small firm this is often the most genuinely independent
 * destination available: the partners' mailboxes are hosted elsewhere,
 * and whoever administers the application database has no ability to
 * reach into them and alter a message that arrived last month.
 *
 * Deliberately **write-only** — there is no `readBack()`. This app can
 * send mail; it cannot read a mailbox, and pretending to verify against
 * something it can't actually see would be worse than being explicit.
 * Verification therefore uses the locally recorded copy, and a genuine
 * investigation compares that against the emails by hand. That is the
 * honest division of labour: the machine keeps the record, a human
 * confirms it matches the copy the machine couldn't have altered.
 */
export class EmailAnchorTarget implements AuditAnchorTarget {
  readonly name = "email";
  #sender: EmailSender;
  #recipients: string[];
  #firmName: string;

  constructor(params: { sender: EmailSender; recipients: string[]; firmName?: string }) {
    if (params.recipients.length === 0) throw new Error("EmailAnchorTarget needs at least one recipient");
    this.#sender = params.sender;
    this.#recipients = params.recipients;
    this.#firmName = params.firmName ?? "Docket";
  }

  async publish(anchor: { sequence: number; headHash: string; anchoredAt: string }): Promise<{ receipt?: string }> {
    const body = [
      `${this.#firmName} — audit log anchor`,
      "",
      `Entries recorded: ${anchor.sequence + 1}`,
      `Sequence:         ${anchor.sequence}`,
      `Head hash:        ${anchor.headHash}`,
      `Anchored at:      ${anchor.anchoredAt}`,
      "",
      "Keep this message. It is a fingerprint of the firm's activity log as it",
      "stood at the time above. Because each entry's hash covers the one before",
      "it, this single value commits to every entry up to that point.",
      "",
      "If the log is ever questioned, comparing it against this hash will show",
      "whether the record was altered after this message was sent. That check is",
      "only meaningful because this copy lives in your mailbox rather than in the",
      "system's own database.",
    ].join("\n");

    const messageIds: string[] = [];
    const failures: string[] = [];
    for (const to of this.#recipients) {
      try {
        const { messageId } = await this.#sender.send({
          to,
          subject: `Audit anchor — sequence ${anchor.sequence} — ${anchor.anchoredAt.slice(0, 10)}`,
          text: body,
        });
        if (messageId) messageIds.push(messageId);
      } catch (err) {
        failures.push(`${to}: ${(err as Error).message}`);
      }
    }
    if (messageIds.length === 0 && failures.length === this.#recipients.length) {
      throw new Error(`could not email the anchor to anyone — ${failures.join("; ")}`);
    }
    return { receipt: messageIds.join(",") || "sent" };
  }
}
