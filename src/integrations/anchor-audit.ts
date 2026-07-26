/**
 * Standalone audit-anchor publisher (`npm run anchor:audit`).
 *
 * Deliberately outside the main Docket process, and meant to run on its
 * own schedule (cron, a systemd timer, a CI job) — the same reasoning as
 * `sync-calendar-deadlines.ts`. Two reasons it matters more here:
 *
 * 1. **Anchoring should not depend on someone remembering to click a
 *    button.** An anchor bounds the window in which a rewrite goes
 *    undetected; a firm that anchors when it thinks of it has an
 *    unbounded window.
 * 2. **It can run somewhere else.** Run from a machine the database
 *    administrator doesn't control, reading the state through the same
 *    persistence layer, and the schedule itself becomes independent of
 *    the system being watched.
 *
 * It anchors and exits. It never edits the log — the only write is
 * appending the anchor record, and (like anchoring from the UI) it
 * refuses to re-anchor an unchanged log so a nightly run doesn't fill
 * the destination with identical lines.
 */
import { loadSystemState, saveSystemState } from "../persistence/system-state.js";
import { createPostgresStateStore } from "../persistence/postgres-store.js";
import type { StateStore } from "../persistence/state-store.js";
import { AuditService } from "../review-ui/audit-service.js";
import { MultiAnchorTarget, type AuditAnchorTarget } from "../core/audit-anchor.js";
import { EmailAnchorTarget, FileAnchorTarget } from "./audit-anchor-targets.js";
import { SmtpEmailSender } from "./smtp-email.js";
import type { Actor } from "../core/types.js";

const STATE_FILE = process.env["STATE_FILE"] ?? "./data/system-state.json";
const DATABASE_URL = process.env["DATABASE_URL"];

/**
 * Anchoring is attorney-gated in `AuditService`, and this runner has no
 * logged-in session. It presents an explicit, clearly-named attorney
 * actor rather than inventing a way around the gate — the audit entry it
 * writes says exactly which automated process did it.
 */
const ANCHOR_RUNNER: Actor = { id: "audit-anchor-job", role: "attorney" };

function buildTarget(): AuditAnchorTarget | undefined {
  const targets: AuditAnchorTarget[] = [];

  const file = process.env["AUDIT_ANCHOR_FILE"];
  if (file) targets.push(new FileAnchorTarget(file));

  const recipients = (process.env["AUDIT_ANCHOR_EMAILS"] ?? "")
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean);
  const smtpHost = process.env["SMTP_HOST"];
  const smtpFrom = process.env["SMTP_FROM"];
  if (recipients.length > 0 && smtpHost && smtpFrom) {
    targets.push(
      new EmailAnchorTarget({
        sender: new SmtpEmailSender({
          host: smtpHost,
          from: smtpFrom,
          ...(process.env["SMTP_PORT"] ? { port: Number(process.env["SMTP_PORT"]) } : {}),
          ...(process.env["SMTP_USER"] ? { user: process.env["SMTP_USER"] } : {}),
          ...(process.env["SMTP_PASSWORD"] ? { password: process.env["SMTP_PASSWORD"] } : {}),
          ...(process.env["SMTP_ALLOW_INSECURE"] === "true" ? { allowInsecurePlaintext: true } : {}),
        }),
        recipients,
        ...(process.env["FIRM_NAME"] ? { firmName: process.env["FIRM_NAME"] } : {}),
      }),
    );
  } else if (recipients.length > 0) {
    console.warn("AUDIT_ANCHOR_EMAILS is set but SMTP_HOST/SMTP_FROM are not — skipping the email destination.");
  }

  if (targets.length === 0) return undefined;
  return targets.length === 1 ? targets[0]! : new MultiAnchorTarget(targets);
}

async function main(): Promise<void> {
  const target = buildTarget();
  if (!target) {
    console.error(
      "No anchor destination configured. Set AUDIT_ANCHOR_FILE (a path this process can append to but not rewrite) " +
        "and/or AUDIT_ANCHOR_EMAILS with SMTP_HOST/SMTP_FROM.",
    );
    process.exitCode = 1;
    return;
  }

  const store: string | StateStore = DATABASE_URL
    ? await createPostgresStateStore({ connectionString: DATABASE_URL })
    : STATE_FILE;
  const state = await loadSystemState(store);
  const audit = new AuditService(state.auditLog, { anchorTarget: target, anchors: state.auditAnchors });

  // Report the chain's own state first: anchoring a log that is already
  // broken would publish a hash that endorses the damage.
  const before = await audit.verifyIntegrity(ANCHOR_RUNNER);
  if (!before.ok) {
    console.error(
      `REFUSING TO ANCHOR: the audit chain is already broken at entry #${before.brokenAtSequence} — ${before.reason}\n` +
        "Anchoring now would publish a hash that vouches for an already-damaged log. Investigate first.",
    );
    process.exitCode = 2;
    return;
  }
  if (before.anchoring.configured && !before.anchoring.ok) {
    console.error(
      `REFUSING TO ANCHOR: the log disagrees with ${before.anchoring.mismatches.length} previously published anchor(s).\n` +
        before.anchoring.mismatches
          .map((m) => `  sequence ${m.sequence}: ${m.kind} (published ${m.expectedHash.slice(0, 16)}…, now ${m.actualHash?.slice(0, 16) ?? "absent"})`)
          .join("\n"),
    );
    process.exitCode = 2;
    return;
  }

  const result = await audit.anchorNow(ANCHOR_RUNNER);
  if (!result.anchored) {
    console.log(`Nothing anchored: ${result.reason}`);
    return;
  }

  await saveSystemState(store, { ...state, auditAnchors: [...audit.anchors] });
  console.log(
    `Anchored sequence ${result.anchor!.sequence} (${result.anchor!.headHash.slice(0, 16)}…) to ${result.anchor!.destination}` +
      (result.anchor!.receipt ? ` — receipt ${result.anchor!.receipt}` : ""),
  );
}

await main();
