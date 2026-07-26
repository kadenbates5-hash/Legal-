import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog, type AuditAnchorRecord } from "../src/core/audit.js";
import { MultiAnchorTarget, type AuditAnchorTarget } from "../src/core/audit-anchor.js";
import { EmailAnchorTarget, FileAnchorTarget } from "../src/integrations/audit-anchor-targets.js";
import { AuditService } from "../src/review-ui/audit-service.js";
import { AccessDeniedError, type Actor } from "../src/core/types.js";
import type { EmailMessage, EmailResult, EmailSender } from "../src/integrations/email-sender.js";

const attorney: Actor = { id: "a1", role: "attorney" };
const paralegal: Actor = { id: "p1", role: "paralegal" };

let dirs: string[] = [];
async function tempFile(name = "anchors.jsonl"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "docket-anchor-"));
  dirs.push(dir);
  return join(dir, name);
}
afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs = [];
});

function logWith(count: number, from = 0): AuditLog {
  const log = new AuditLog();
  for (let i = from; i < from + count; i++) {
    log.append({ actor: attorney, matterId: "m-1", action: `action_${i}`, detail: `detail ${i}` });
  }
  return log;
}

/** Captures what it was asked to send, and can be made to fail. */
class FakeEmailSender implements EmailSender {
  readonly name = "fake";
  readonly canSend = true;
  readonly fromAddress = "docket@firm.example";
  sent: EmailMessage[] = [];
  failWith: Error | undefined;
  async send(message: EmailMessage): Promise<EmailResult> {
    if (this.failWith) throw this.failWith;
    this.sent.push(message);
    return { messageId: `<anchor-${this.sent.length}@firm.example>` };
  }
}

describe("FileAnchorTarget", () => {
  it("appends one JSON line per anchor and reads them back", async () => {
    const path = await tempFile();
    const target = new FileAnchorTarget(path);
    await target.publish({ sequence: 4, headHash: "a".repeat(64), anchoredAt: "2026-07-26T00:00:00.000Z" });
    await target.publish({ sequence: 9, headHash: "b".repeat(64), anchoredAt: "2026-07-27T00:00:00.000Z" });

    expect((await readFile(path, "utf8")).trim().split("\n")).toHaveLength(2);
    const records = await target.readBack();
    expect(records.map((r) => r.sequence)).toEqual([4, 9]);
    expect(records[1]!.headHash).toBe("b".repeat(64));
  });

  it("returns a receipt tied to the exact line written", async () => {
    const target = new FileAnchorTarget(await tempFile());
    const first = await target.publish({ sequence: 1, headHash: "a".repeat(64), anchoredAt: "2026-07-26T00:00:00.000Z" });
    const same = await target.publish({ sequence: 1, headHash: "a".repeat(64), anchoredAt: "2026-07-26T00:00:00.000Z" });
    const different = await target.publish({ sequence: 2, headHash: "a".repeat(64), anchoredAt: "2026-07-26T00:00:00.000Z" });
    expect(first.receipt).toBe(same.receipt);
    expect(first.receipt).not.toBe(different.receipt);
  });

  it("treats a file that was never written as nothing anchored, not a failure", async () => {
    expect(await new FileAnchorTarget(await tempFile("missing.jsonl")).readBack()).toEqual([]);
  });

  it("skips a corrupt line rather than losing every anchor to it", async () => {
    const path = await tempFile();
    const target = new FileAnchorTarget(path);
    await target.publish({ sequence: 1, headHash: "a".repeat(64), anchoredAt: "2026-07-26T00:00:00.000Z" });
    await writeFile(path, (await readFile(path, "utf8")) + "{ not json\n", "utf8");
    await target.publish({ sequence: 2, headHash: "b".repeat(64), anchoredAt: "2026-07-27T00:00:00.000Z" });
    expect((await target.readBack()).map((r) => r.sequence)).toEqual([1, 2]);
  });
});

describe("EmailAnchorTarget", () => {
  it("mails the head hash to every recipient", async () => {
    const sender = new FakeEmailSender();
    const target = new EmailAnchorTarget({ sender, recipients: ["a@firm.example", "b@firm.example"], firmName: "Reyes LLP" });
    const { receipt } = await target.publish({ sequence: 7, headHash: "c".repeat(64), anchoredAt: "2026-07-26T09:00:00.000Z" });

    expect(sender.sent.map((m) => m.to)).toEqual(["a@firm.example", "b@firm.example"]);
    expect(sender.sent[0]!.subject).toContain("sequence 7");
    expect(sender.sent[0]!.text).toContain("c".repeat(64));
    expect(sender.sent[0]!.text).toContain("Reyes LLP");
    expect(receipt).toContain("@firm.example");
  });

  it("is deliberately write-only — it can send mail but not read a mailbox", () => {
    const target = new EmailAnchorTarget({ sender: new FakeEmailSender(), recipients: ["a@firm.example"] });
    expect(target.readBack).toBeUndefined();
  });

  it("throws when it could not reach anyone", async () => {
    const sender = new FakeEmailSender();
    sender.failWith = new Error("smtp down");
    const target = new EmailAnchorTarget({ sender, recipients: ["a@firm.example"] });
    await expect(target.publish({ sequence: 1, headHash: "d".repeat(64), anchoredAt: "x" })).rejects.toThrow(/could not email/i);
  });

  it("refuses to be constructed with no recipients", () => {
    expect(() => new EmailAnchorTarget({ sender: new FakeEmailSender(), recipients: [] })).toThrow();
  });
});

describe("MultiAnchorTarget", () => {
  it("publishes to every destination — independence is the point", async () => {
    const path = await tempFile();
    const sender = new FakeEmailSender();
    const multi = new MultiAnchorTarget([
      new FileAnchorTarget(path),
      new EmailAnchorTarget({ sender, recipients: ["a@firm.example"] }),
    ]);
    await multi.publish({ sequence: 3, headHash: "e".repeat(64), anchoredAt: "2026-07-26T00:00:00.000Z" });
    expect((await readFile(path, "utf8")).trim().split("\n")).toHaveLength(1);
    expect(sender.sent).toHaveLength(1);
    expect(multi.name).toBe("file+email");
  });

  it("still anchors when one destination fails, and says which", async () => {
    const path = await tempFile();
    const sender = new FakeEmailSender();
    sender.failWith = new Error("smtp down");
    const multi = new MultiAnchorTarget([
      new FileAnchorTarget(path),
      new EmailAnchorTarget({ sender, recipients: ["a@firm.example"] }),
    ]);
    const { receipt } = await multi.publish({ sequence: 3, headHash: "e".repeat(64), anchoredAt: "2026-07-26T00:00:00.000Z" });
    expect(receipt).toContain("file=");
    expect(receipt).toContain("failed:");
  });

  it("throws only when every destination fails", async () => {
    const sender = new FakeEmailSender();
    sender.failWith = new Error("smtp down");
    const multi = new MultiAnchorTarget([new EmailAnchorTarget({ sender, recipients: ["a@firm.example"] })]);
    await expect(multi.publish({ sequence: 1, headHash: "f".repeat(64), anchoredAt: "x" })).rejects.toThrow(/every anchor destination failed/i);
  });
});

describe("AuditLog.verifyAgainstAnchors", () => {
  it("passes when the chain still produces the published hash", () => {
    const log = logWith(5);
    const anchor: AuditAnchorRecord = {
      sequence: 4,
      headHash: log.headHash()!,
      anchoredAt: "x",
      destination: "file",
      receipt: undefined,
    };
    expect(log.verifyAgainstAnchors([anchor])).toMatchObject({ ok: true, anchorsChecked: 1 });
  });

  it("catches a log rebuilt from scratch — which the internal chain cannot", () => {
    const original = logWith(5);
    const anchor: AuditAnchorRecord = {
      sequence: 4,
      headHash: original.headHash()!,
      anchoredAt: "x",
      destination: "file",
      receipt: undefined,
    };

    // Someone rebuilds the log without one entry. Every hash is
    // recomputed, so it is internally perfect...
    const rebuilt = new AuditLog();
    for (const e of original.toSnapshot()) {
      if (e.action === "action_2") continue;
      rebuilt.append({ actor: e.actor, matterId: e.matterId, action: e.action, detail: e.detail });
    }
    expect(rebuilt.verifyIntegrity().ok).toBe(true);

    // ...but it no longer matches what was published.
    const result = rebuilt.verifyAgainstAnchors([anchor]);
    expect(result.ok).toBe(false);
    expect(result.mismatches[0]).toMatchObject({ sequence: 4, kind: "missing" });
  });

  it("catches history rewritten at an anchored sequence", () => {
    const original = logWith(5);
    const anchor: AuditAnchorRecord = {
      sequence: 2,
      headHash: original.hashAt(2)!,
      anchoredAt: "x",
      destination: "file",
      receipt: undefined,
    };
    const rebuilt = new AuditLog();
    for (const e of original.toSnapshot()) {
      rebuilt.append({
        actor: e.actor,
        matterId: e.matterId,
        action: e.sequence === 2 ? "something_else_entirely" : e.action,
        detail: e.detail,
      });
    }
    expect(rebuilt.verifyIntegrity().ok).toBe(true);
    expect(rebuilt.verifyAgainstAnchors([anchor])).toMatchObject({
      ok: false,
      mismatches: [{ sequence: 2, kind: "mismatch" }],
    });
  });

  it("catches entries truncated off the end", () => {
    const log = logWith(10);
    const anchor: AuditAnchorRecord = {
      sequence: 9,
      headHash: log.headHash()!,
      anchoredAt: "x",
      destination: "file",
      receipt: undefined,
    };
    const truncated = AuditLog.fromSnapshot(log.toSnapshot().slice(0, 5));
    // A shorter chain is still a valid chain — this is exactly the blind spot.
    expect(truncated.verifyIntegrity().ok).toBe(true);
    expect(truncated.verifyAgainstAnchors([anchor]).mismatches[0]).toMatchObject({ kind: "missing" });
  });

  it("passes trivially with no anchors, since nothing has been claimed", () => {
    expect(logWith(3).verifyAgainstAnchors([])).toMatchObject({ ok: true, anchorsChecked: 0 });
  });
});

describe("AuditService — anchoring", () => {
  async function setup(target?: AuditAnchorTarget) {
    const log = logWith(3);
    const anchors: AuditAnchorRecord[] = [];
    const service = new AuditService(log, { ...(target ? { anchorTarget: target } : {}), anchors });
    return { log, anchors, service };
  }

  it("publishes the head hash and records it locally", async () => {
    const path = await tempFile();
    const { log, service } = await setup(new FileAnchorTarget(path));
    const headBefore = log.headHash();

    const result = await service.anchorNow(attorney);
    expect(result.anchored).toBe(true);
    expect(result.anchor!.headHash).toBe(headBefore);
    expect((await new FileAnchorTarget(path).readBack())[0]!.headHash).toBe(headBefore);
  });

  it("logs the anchoring itself, after the sequence it anchored", async () => {
    const { log, service } = await setup(new FileAnchorTarget(await tempFile()));
    const result = await service.anchorNow(attorney);
    const entry = log.read("attorney").at(-1)!;
    expect(entry.action).toBe("audit_anchored");
    // The new entry must come after what was anchored, or it would
    // immediately invalidate the hash just published.
    expect(entry.sequence).toBeGreaterThan(result.anchor!.sequence);
    expect((await service.verifyIntegrity(attorney)).anchoring).toMatchObject({ ok: true });
  });

  it("refuses to re-anchor when nothing but anchoring has happened", async () => {
    const { log, service } = await setup(new FileAnchorTarget(await tempFile()));
    expect((await service.anchorNow(attorney)).anchored).toBe(true);

    // Anchoring writes its own entry, so a naive head-hash comparison
    // would say "something changed" forever. It must not.
    const second = await service.anchorNow(attorney);
    expect(second.anchored).toBe(false);
    expect(second.reason).toMatch(/nothing new/i);

    // Real activity makes it anchorable again.
    log.append({ actor: attorney, matterId: "m-1", action: "invoice_sent", detail: undefined });
    expect((await service.anchorNow(attorney)).anchored).toBe(true);
  });

  it("does not grow the destination on an idle system", async () => {
    const path = await tempFile();
    const { service } = await setup(new FileAnchorTarget(path));
    // A nightly job on a firm that did nothing for a week.
    for (let i = 0; i < 7; i++) await service.anchorNow(attorney);
    expect(await new FileAnchorTarget(path).readBack()).toHaveLength(1);
  });

  it("reports rather than throws when nothing is configured or there is nothing to anchor", async () => {
    const { service } = await setup();
    expect(await service.anchorNow(attorney)).toMatchObject({ anchored: false, reason: /no anchor destination/i });

    const empty = new AuditService(new AuditLog(), { anchorTarget: new FileAnchorTarget(await tempFile()) });
    expect(await empty.anchorNow(attorney)).toMatchObject({ anchored: false, reason: /nothing in the log/i });
  });

  it("does not record an anchor locally when publishing failed", async () => {
    const failing: AuditAnchorTarget = {
      name: "broken",
      publish: async () => {
        throw new Error("destination unreachable");
      },
    };
    const { service, anchors } = await setup(failing);
    await expect(service.anchorNow(attorney)).rejects.toThrow(/unreachable/);
    // A local record of an anchor that never left would be a false assurance.
    expect(anchors).toHaveLength(0);
  });

  it("keeps anchoring attorney-only", async () => {
    const { service } = await setup(new FileAnchorTarget(await tempFile()));
    await expect(service.anchorNow(paralegal)).rejects.toThrow(AccessDeniedError);
  });

  it("reports that no anchoring is configured rather than implying safety", async () => {
    const { service } = await setup();
    expect((await service.verifyIntegrity(attorney)).anchoring).toEqual({ configured: false });
  });

  it("prefers the destination's own copy over the local record", async () => {
    const path = await tempFile();
    const { service } = await setup(new FileAnchorTarget(path));
    await service.anchorNow(attorney);

    // The external file says the log looked different at that sequence.
    const tampered = (await readFile(path, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.stringify({ ...JSON.parse(line), headHash: "0".repeat(64) }))
      .join("\n");
    await writeFile(path, `${tampered}\n`, "utf8");

    const report = await service.verifyIntegrity(attorney);
    expect(report.ok).toBe(true); // the chain itself is fine
    expect(report.anchoring).toMatchObject({ configured: true, ok: false });
  });

  it("falls back to the local record when the destination can't be read, without crying tamper", async () => {
    const unreadable: AuditAnchorTarget = {
      name: "flaky",
      publish: async () => ({ receipt: "ok" }),
      readBack: async () => {
        throw new Error("network");
      },
    };
    const { service } = await setup(unreadable);
    await service.anchorNow(attorney);
    const report = await service.verifyIntegrity(attorney);
    expect(report.anchoring).toMatchObject({ configured: true, ok: true, anchorsChecked: 1 });
  });
});
