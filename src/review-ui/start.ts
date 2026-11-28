import { randomBytes } from "node:crypto";
import { createReviewServer, maxRequestBodyBytesFor } from "./server.js";
import { ReviewGateService } from "./review-service.js";
import { IntakeDemoSessions } from "./intake-demo.js";
import { ClaudeAcknowledgementSource } from "../receptionist/acknowledgements.js";
import { AccountsService } from "./accounts-service.js";
import { DraftingService } from "./drafting-service.js";
import { DocumentsService } from "./documents-service.js";
import { CasesService } from "./cases-service.js";
import { AuditService } from "./audit-service.js";
import { SearchService } from "./search-service.js";
import { ResearchService } from "./research-service.js";
import { CourtListenerClient } from "../integrations/courtlistener.js";
import { loadSystemState, saveSystemState, type SystemState } from "../persistence/system-state.js";
import { WorkProduct } from "../core/review-gate.js";
import { checkedRetentionYears } from "../core/matters.js";
import { addDaysToCalendarDate, checkedTimeZone, todayIn } from "../core/calendar-date.js";
import type { Actor } from "../core/types.js";
import { readJsonFile } from "../persistence/json-file-store.js";
import { createPostgresStateStore } from "../persistence/postgres-store.js";
import type { StateStore } from "../persistence/state-store.js";
import { AccessControl } from "../core/access-control.js";
import { criminalLawModule } from "../modules/criminal-law/index.js";
import type { UserRole } from "../core/auth.js";
import type { FirmConfig } from "../config/firm-config.js";
import { VoiceCallSessions } from "../receptionist/voice-call-sessions.js";
import { AudioClipStore } from "../receptionist/audio-clip-store.js";
import { VoiceboxSpeechToText, VoiceboxTextToSpeech } from "../integrations/voicebox.js";
import { AssistantService } from "./assistant-service.js";
import { SpeechService } from "./speech-service.js";
import { AnthropicClient } from "../integrations/anthropic.js";
import { StaffService } from "./staff-service.js";
import { MessagingService } from "./messaging-service.js";
import { StaffScheduleService } from "./staff-schedule-service.js";
import { BillingHoursService } from "./billing-hours-service.js";
import { PdfReportService } from "./pdf-report-service.js";
import { PdfParseTextExtractor } from "../integrations/pdf-text.js";
import { PdfLibCondenser } from "../integrations/pdf-condenser.js";
import { MattersService } from "./matters-service.js";
import { ConflictChecker } from "../core/conflicts.js";
import { TrustService } from "./trust-service.js";
import { ClientFileService } from "./client-file-service.js";
import { InvoicingService } from "./invoicing-service.js";
import { ClientPortalService } from "./client-portal-service.js";
import { ClientMessagingService } from "./client-messaging-service.js";
import { PayrollService } from "./payroll-service.js";
import { AnalyticsService } from "./analytics-service.js";
import { ImportService } from "./import-service.js";
import { CalendarExportService } from "./calendar-export-service.js";
import { MatterTimelineService } from "./matter-timeline-service.js";
import { CalendarConnectionService } from "./calendar-connection-service.js";
import { TimeClockService } from "./time-clock-service.js";
import { ManualPaymentProcessor } from "../integrations/payment-processor.js";
import { StripeCheckoutProvider } from "../integrations/stripe-checkout.js";
import { SimpleWebAuthnProvider } from "../integrations/webauthn-provider.js";
import { UnconfiguredEmailSender, type EmailSender } from "../integrations/email-sender.js";
import { SmtpEmailSender } from "../integrations/smtp-email.js";
import { PdfLibInvoicePdfRenderer } from "../integrations/invoice-pdf.js";
import { MultiAnchorTarget, type AuditAnchorTarget } from "../core/audit-anchor.js";
import { EmailAnchorTarget, FileAnchorTarget } from "../integrations/audit-anchor-targets.js";
import { ESignatureService } from "./esignature-service.js";
import { BookingService } from "./booking-service.js";
import type { ReviewServerOptions } from "./server.js";

/**
 * Standalone entry point for the attorney review-gate UI (`npm run
 * start:review-ui`). Loads persisted state on boot (including accounts/
 * sessions — see `core/auth.ts`) and saves after every mutation (see
 * `server.ts`'s `onMutated` hook), through whichever `StateStore` is
 * configured (see `persistence/state-store.ts`): file-backed by default,
 * or Postgres when `DATABASE_URL` is set (see `persistence/postgres-store.ts`).
 */
const STATE_FILE = process.env["STATE_FILE"] ?? "./data/system-state.json";
const FIRM_CONFIG_FILE = process.env["FIRM_CONFIG_FILE"];
const DATABASE_URL = process.env["DATABASE_URL"];

const firmConfig = FIRM_CONFIG_FILE ? await readJsonFile<FirmConfig | null>(FIRM_CONFIG_FILE, null) : null;
// Checked once, here, so a bad value stops the server with a plain
// message instead of stamping impossible retention dates on every matter
// it closes (see checkedRetentionYears).
const fileRetentionYears = checkedRetentionYears(firmConfig?.fileRetentionYears, "fileRetentionYears in FIRM_CONFIG_FILE");

/**
 * The firm's zone — where its days start. Every check that compares a
 * date with "today" asks it here: a court date the receptionist hears, a
 * deadline coming due, an invoice going overdue, the day a file closed,
 * the dates printed on a bill, where a time-clock day starts. Asked in the
 * host's zone instead, a server in UTC is on tomorrow from 7pm in New York
 * and on yesterday until 11am in Sydney.
 *
 * FIRM_TIME_ZONE if set, else the firm config's business-hours zone, else
 * this machine's. Checked once here, so a zone the runtime doesn't know
 * stops the server with a plain message rather than failing every request
 * that asks what day it is.
 */
const FIRM_TIME_ZONE = checkedTimeZone(
  process.env["FIRM_TIME_ZONE"] ??
    firmConfig?.businessHours?.timezone ??
    Intl.DateTimeFormat().resolvedOptions().timeZone ??
    "UTC",
  process.env["FIRM_TIME_ZONE"] ? "FIRM_TIME_ZONE" : "businessHours.timezone in FIRM_CONFIG_FILE",
);
// Business hours are checked in the config's own zone (the greeting's
// after-hours notice, scheduling), so a bad one there is refused too.
if (firmConfig?.businessHours?.timezone !== undefined) {
  checkedTimeZone(firmConfig.businessHours.timezone, "businessHours.timezone in FIRM_CONFIG_FILE");
}
if (process.env["FIRM_TIME_ZONE"] && firmConfig?.businessHours?.timezone && firmConfig.businessHours.timezone !== FIRM_TIME_ZONE) {
  console.warn(
    `FIRM_TIME_ZONE (${FIRM_TIME_ZONE}) differs from the firm config's business-hours zone (${firmConfig.businessHours.timezone}); ` +
      "days are counted in FIRM_TIME_ZONE, business hours in the config's zone.",
  );
}

/**
 * `store` is either the Postgres adapter (when DATABASE_URL is set) or a
 * plain file path string — `loadSystemState`/`saveSystemState` accept
 * either. Computed once here and reused for every save, so a Postgres
 * connection pool isn't recreated per mutation.
 */
const store: string | StateStore = DATABASE_URL ? await createPostgresStateStore({ connectionString: DATABASE_URL }) : STATE_FILE;

const state = await loadSystemState(store, firmConfig ? { firmConfig } : {});

/**
 * First-run bootstrap only: if the persisted state has no accounts yet,
 * seed them from environment variables. Once any user exists, this is a
 * no-op forever — env vars are for getting the very first attorney
 * account into an empty system, not an ongoing credential-management
 * path. Adding/disabling accounts after that goes through Docket's
 * Accounts panel (see AccountsService below), which is attorney-gated
 * like everything else.
 */
/**
 * Populates a handful of sample records across the panels a first-time
 * visitor is most likely to click into — see the `DEMO_SEED` gate below
 * for when this runs. Every id is prefixed `demo-` so it's obviously
 * throwaway data, never mistaken for a real client's matter.
 */
function seedDemoData(state: SystemState, attorneyUsername: string): void {
  const attorney: Actor = { id: attorneyUsername, role: "attorney" };
  // The firm's day, so the deadline lands inside Coming due's two-week
  // window wherever the server is — fourteen days from UTC's date was
  // fifteen from Honolulu's, and the sample deadline never showed.
  const today = todayIn(FIRM_TIME_ZONE);
  const inTenDays = addDaysToCalendarDate(today, 10);
  const inThreeDays = new Date(Date.now() + 3 * 86_400_000);
  inThreeDays.setUTCHours(15, 0, 0, 0);

  state.matters.upsert("demo-criminal-1", {
    title: "State v. Jordan Smith",
    status: "open",
    practiceAreaId: "criminal-law",
    responsibleAttorneyId: attorneyUsername,
    description: "Misdemeanor reckless driving — sample matter, safe to delete.",
    parties: [
      { name: "Jordan Smith", role: "client", note: undefined, email: undefined, phone: undefined },
      { name: "State of Example", role: "adverse", note: undefined, email: undefined, phone: undefined },
    ],
  });
  state.matters.upsert("demo-contract-1", {
    title: "Acme Co. — Contract Dispute",
    status: "open",
    responsibleAttorneyId: attorneyUsername,
    description: "Breach-of-contract dispute — sample matter, safe to delete.",
    parties: [
      { name: "Acme Co.", role: "client", note: undefined, email: undefined, phone: undefined },
      { name: "Rival Industries", role: "adverse", note: undefined, email: undefined, phone: undefined },
    ],
  });

  // Unconfirmed on purpose — a single agent-sourced calculation — so the
  // Deadlines panel's redundant-verification story is visible on first
  // login rather than something to read about.
  state.deadlineTracker.record({
    matterId: "demo-criminal-1",
    type: "arraignment",
    date: inTenDays,
    source: "agent",
  });

  state.scheduling.scheduleConsultation(attorney, {
    matterId: "demo-contract-1",
    attorneyId: attorneyUsername,
    startTime: inThreeDays,
    allowOutsideBusinessHours: true,
  });

  const draft = new WorkProduct(
    { id: "demo-wp-1", matterId: "demo-criminal-1", kind: "motion", content: "DRAFT — Motion to suppress (sample content, safe to delete)." },
    state.auditLog,
  );
  draft.submitForReview(attorney);
  state.workProductStore.register(draft);

  state.billingHours.log({
    matterId: "demo-contract-1",
    actorId: attorneyUsername,
    date: today,
    hours: 1.5,
    description: "Sample entry — initial client consultation.",
  });

  state.trustLedger.record({
    matterId: "demo-contract-1",
    type: "deposit",
    amountCents: 150_000,
    description: "Sample retainer deposit — safe to delete.",
    recordedBy: attorneyUsername,
  });
}

function bootstrapAccount(envPrefix: string, role: UserRole): string | undefined {
  const username = process.env[`${envPrefix}_USERNAME`];
  const password = process.env[`${envPrefix}_PASSWORD`];
  if (username && password) {
    state.auth.createUser({ username, password, role });
    console.log(`Seeded ${role} account '${username}' from ${envPrefix}_USERNAME/${envPrefix}_PASSWORD.`);
    return username;
  }
  return undefined;
}

let seeded = false;
let freshAttorneyUsername: string | undefined;
if (!state.auth.hasAnyUsers()) {
  freshAttorneyUsername = bootstrapAccount("ATTORNEY", "attorney");
  bootstrapAccount("PARALEGAL", "paralegal");
  bootstrapAccount("RECEPTIONIST", "receptionist");
  bootstrapAccount("STAFF", "staff");
  if (!state.auth.hasAnyUsers()) {
    console.warn(
      "No accounts exist and no ATTORNEY_USERNAME/ATTORNEY_PASSWORD env vars were set — nobody can log in. " +
        "Set them (8+ char password) and restart.",
    );
  } else {
    seeded = true;
  }
}

/**
 * `DEMO_SEED=true` — optional, first-boot-only sample data so a fresh
 * deploy isn't a blank slate on first login (see DEPLOY.md: the single
 * biggest friction point in "try this out" is logging into an empty
 * dashboard with nothing to click on). Deliberately gated on the exact
 * same condition as the account bootstrap above (no accounts existed
 * yet this run) rather than "no matters exist" — the latter would
 * re-seed forever on a system where every demo matter was deliberately
 * deleted. A real firm's first deploy simply shouldn't set this.
 */
if (process.env["DEMO_SEED"] === "true" && freshAttorneyUsername) {
  seedDemoData(state, freshAttorneyUsername);
  seeded = true;
  console.log("DEMO_SEED=true: populated sample matters, a deadline, an appointment, and a draft awaiting review.");
}

if (!state.auth.hasSystemApiKey()) {
  const envKey = process.env["CALENDAR_SYSTEM_API_KEY"];
  const key = envKey ?? randomBytes(24).toString("hex");
  state.auth.setSystemApiKey(key);
  seeded = true;
  if (!envKey) {
    console.log(
      `Generated a calendar-integration system API key (no CALENDAR_SYSTEM_API_KEY env var set): ${key}\n` +
        "Save this — it's required to record 'calendar_system'-sourced deadline confirmations via x-system-api-key, and won't be printed again.",
    );
  }
}

if (seeded) {
  await saveSystemState(store, state);
}

const service = new ReviewGateService(state.workProductStore, state.deadlineTracker, { timeZone: FIRM_TIME_ZONE });

/**
 * Backs the dashboard's "Live Intake Demo" panel — see intake-demo.ts.
 * Shares the real audit log (so demo conversations show up in the same
 * audit trail as everything else) but gets its own AccessControl, since
 * paralegal-matter assignment has nothing to do with receptionist intake.
 */
/**
 * One checker shared by live intake and the Matters/Conflicts panels, so
 * a receptionist screening a caller and an attorney running a formal
 * check are looking at exactly the same firm records.
 */
const conflictChecker = new ConflictChecker(state.matters);

/**
 * Natural phrasing for live intake (see receptionist/acknowledgements.ts):
 * Claude may put one short acknowledgement in front of an ordinary intake
 * question, never touching the question or any gate. Opt-in on its own
 * flag rather than riding on ANTHROPIC_API_KEY, because it sends the
 * caller's words to Anthropic — a firm that set up the Assistant panel
 * hasn't thereby agreed to that for intake.
 */
const intakeAcknowledgements =
  process.env["INTAKE_NATURAL_PHRASING"] === "true" && process.env["ANTHROPIC_API_KEY"]
    ? new ClaudeAcknowledgementSource(
        new AnthropicClient({
          apiKey: process.env["ANTHROPIC_API_KEY"],
          ...(process.env["ANTHROPIC_MODEL"] ? { model: process.env["ANTHROPIC_MODEL"] } : {}),
          ...(process.env["ANTHROPIC_BASE_URL"] ? { baseUrl: process.env["ANTHROPIC_BASE_URL"] } : {}),
          maxTokens: 60,
        }),
      )
    : undefined;

const intake = new IntakeDemoSessions({
  accessControl: new AccessControl(state.auditLog),
  auditLog: state.auditLog,
  module: criminalLawModule,
  utilization: state.utilization,
  ...(firmConfig ? { firmConfig } : {}),
  timeZone: FIRM_TIME_ZONE,
  // Live intake screens against the firm's real matter records, not a
  // hardcoded name list — see core/conflicts.ts.
  conflictChecker,
  ...(intakeAcknowledgements ? { acknowledgements: intakeAcknowledgements } : {}),
});

/**
 * `state.accessControl` is the canonical, persisted AccessControl — the
 * one whose paralegal-matter assignments actually matter and must survive
 * a restart (unlike intake's throwaway one above). Shared by the Drafting
 * panel (enforcing matter scoping on every draft/revise/submit) and the
 * Accounts panel (the only place assignments are made/changed).
 */
const accounts = new AccountsService(state.auth, state.accessControl, state.loginThrottle, state.auditLog, (matterId) =>
  Boolean(state.matters.get(matterId)),
);

const drafting = new DraftingService({
  accessControl: state.accessControl,
  auditLog: state.auditLog,
  module: criminalLawModule,
  store: state.workProductStore,
  utilization: state.utilization,
  deadlineTracker: state.deadlineTracker,
});

/**
 * Backs the "Cases" panel: uploaded documents (documents) plus the
 * clickable per-matter view combining them with drafted work product
 * (cases). `MAX_DOCUMENT_UPLOAD_BYTES` overrides `DocumentsService`'s
 * 25 MB default — see that file's doc comment for why this cap exists at
 * all (this project's single-JSON-blob persistence model).
 */
const MAX_DOCUMENT_UPLOAD_BYTES = process.env["MAX_DOCUMENT_UPLOAD_BYTES"];
const documents = new DocumentsService({
  accessControl: state.accessControl,
  store: state.documentStore,
  auditLog: state.auditLog,
  ...(MAX_DOCUMENT_UPLOAD_BYTES ? { maxUploadBytes: Number(MAX_DOCUMENT_UPLOAD_BYTES) } : {}),
});

/**
 * The server-wide request-body ceiling has to clear the largest legitimate
 * request, which is an upload (base64-inflated). Derived from the same cap
 * above so raising `MAX_DOCUMENT_UPLOAD_BYTES` can't leave uploads
 * rejected at the transport layer before `DocumentsService` ever sees them.
 */
const maxRequestBodyBytes = maxRequestBodyBytesFor(documents.getMaxUploadBytes());
const cases = new CasesService({
  accessControl: state.accessControl,
  workProductStore: state.workProductStore,
  documentStore: state.documentStore,
});

/**
 * Backs the Cases panel's "Draft report"/"Condense" actions on an
 * uploaded PDF — see pdf-report-service.ts. Both `pdf-parse` (text
 * extraction) and `pdf-lib` (condensing) are pure-JS, so unlike the
 * Voicebox/Twilio integrations there's no separate vendor process or API
 * key to configure; this is always available whenever `documents`/
 * `drafting` are.
 */
const pdfReports = new PdfReportService({
  documents,
  drafting,
  extractor: new PdfParseTextExtractor(),
  condenser: new PdfLibCondenser(),
});

/**
 * Backs the "Matters" and "Conflicts" panels. The conflicts checker gets
 * the whole matter store on purpose — ABA Model Rule 1.10 imputes one
 * lawyer's conflict to the firm, so a check scoped to the caller's own
 * matters would return a dangerously clean answer. `MattersService` is
 * what limits who may run a check and what comes back.
 */
const matters = new MattersService({
  store: state.matters,
  checker: conflictChecker,
  accessControl: state.accessControl,
  auditLog: state.auditLog,
  // Closing a matter refuses while client funds remain in trust; the
  // other two are consulted for warnings only.
  trust: state.trustLedger,
  invoices: state.invoices,
  workProducts: state.workProductStore,
  ...(fileRetentionYears > 0 ? { retentionYears: fileRetentionYears } : {}),
  timeZone: FIRM_TIME_ZONE,
});

/**
 * Backs the "Trust" panel. The hard invariants (no overdrawn client
 * sub-ledger, integer cents, immutable history) live in
 * `core/trust-ledger.ts` so no route or future integration can bypass
 * them; this service adds matter scoping and the attorney gate on money
 * leaving the account.
 */
const trust = new TrustService({
  ledger: state.trustLedger,
  accessControl: state.accessControl,
  auditLog: state.auditLog,
});

/**
 * Backs the Cases panel's "Export client file" action. The client file
 * belongs to the client, so producing it is a first-class, audited
 * operation rather than a manual trawl through six stores.
 */
const clientFile = new ClientFileService({
  accessControl: state.accessControl,
  auditLog: state.auditLog,
  matters: state.matters,
  workProducts: state.workProductStore,
  documents: state.documentStore,
  research: state.researchLibrary,
  billing: state.billingHours,
  trust: state.trustLedger,
});

/**
 * Backs the "Invoices" panel. The payment processor is a vendor-agnostic
 * seam (see integrations/payment-processor.ts); the default records
 * payments without contacting anyone, which is what makes invoicing
 * fully usable before a processor is chosen. Whichever is wired in
 * later, the thing to verify is that its fees are routed to the
 * operating account and never netted out of trust deposits.
 */
/**
 * Mail. Configured only when `SMTP_HOST` and `SMTP_FROM` are both set;
 * otherwise the Invoices panel offers preview-and-send-yourself rather
 * than an Email button that would fail — the same "absent config means
 * the surface doesn't exist" pattern as every other optional piece.
 *
 * An invoice names the matter in its subject line and itemises the work
 * in its body, so whoever carries it is subject to §5's vendor
 * due-diligence questions in full. Pointing this at the firm's own mail
 * server is usually the least surprising answer.
 */
const SMTP_HOST = process.env["SMTP_HOST"];
const SMTP_FROM = process.env["SMTP_FROM"];
const emailSender: EmailSender =
  SMTP_HOST && SMTP_FROM
    ? new SmtpEmailSender({
        host: SMTP_HOST,
        from: SMTP_FROM,
        ...(process.env["SMTP_PORT"] ? { port: Number(process.env["SMTP_PORT"]) } : {}),
        ...(process.env["SMTP_USER"] ? { user: process.env["SMTP_USER"] } : {}),
        ...(process.env["SMTP_PASSWORD"] ? { password: process.env["SMTP_PASSWORD"] } : {}),
        ...(firmConfig?.firmName ? { fromName: firmConfig.firmName } : {}),
        // Only for a relay on loopback or a trusted private network —
        // see `smtp-email.ts` for why this is off unless asked for.
        ...(process.env["SMTP_ALLOW_INSECURE"] === "true" ? { allowInsecurePlaintext: true } : {}),
      })
    : new UnconfiguredEmailSender();

/**
 * Shared by the Twilio telephony integration, self-service password
 * reset links, the per-attorney Google Calendar OAuth callback, and
 * (here) Stripe Checkout's success/cancel redirects — one externally
 * reachable base URL for every feature that needs the browser or a
 * third party to call back into this server.
 */
const PUBLIC_BASE_URL = process.env["PUBLIC_BASE_URL"];

/**
 * Online invoice payment via a real Stripe Checkout session — see
 * CLAUDE.md's "Online invoice payment (Stripe Checkout)". Wired up only
 * when `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET`/`PUBLIC_BASE_URL` are
 * all set, same "absent config means the surface doesn't exist" pattern
 * as every other optional integration — without it the client portal
 * simply shows no "Pay now" button, same degrade-not-gate reasoning as
 * `ManualPaymentProcessor` reporting `canCharge: false`.
 */
const STRIPE_SECRET_KEY = process.env["STRIPE_SECRET_KEY"];
const STRIPE_WEBHOOK_SECRET = process.env["STRIPE_WEBHOOK_SECRET"];
const checkoutOptions: Pick<ConstructorParameters<typeof InvoicingService>[0], "checkout" | "publicBaseUrl"> =
  STRIPE_SECRET_KEY && STRIPE_WEBHOOK_SECRET && PUBLIC_BASE_URL
    ? { checkout: new StripeCheckoutProvider({ secretKey: STRIPE_SECRET_KEY }), publicBaseUrl: PUBLIC_BASE_URL }
    : {};
const stripeWebhookOptions: Pick<ReviewServerOptions, "stripeWebhook"> =
  STRIPE_SECRET_KEY && STRIPE_WEBHOOK_SECRET && PUBLIC_BASE_URL
    ? { stripeWebhook: { webhookSecret: STRIPE_WEBHOOK_SECRET } }
    : {};

/**
 * Passkeys (WebAuthn) — see CLAUDE.md's "Passkeys (WebAuthn)". Unlike
 * every other optional integration here, this one needs no vendor
 * secret at all — WebAuthn is a browser platform standard, not a
 * third-party service — so it's wired up unconditionally rather than
 * gated on an env var. What it *does* need is the deployment's real
 * identity (the relying-party ID and origin), since a WebAuthn
 * credential is cryptographically bound to the exact origin it was
 * registered against. `PUBLIC_BASE_URL`'s hostname is that identity in
 * production; absent it, a plain localhost origin lets registration/
 * login still work for local dev against `npm run start:review-ui`
 * without any extra configuration.
 */
const WEBAUTHN_RP_ID = process.env["WEBAUTHN_RP_ID"] ?? (PUBLIC_BASE_URL ? new URL(PUBLIC_BASE_URL).hostname : "localhost");
const WEBAUTHN_ORIGIN = process.env["WEBAUTHN_ORIGIN"] ?? PUBLIC_BASE_URL ?? `http://localhost:${process.env["PORT"] ?? 3000}`;
state.auth.setWebAuthnProvider(
  new SimpleWebAuthnProvider({ rpName: firmConfig?.firmName ?? "Docket", rpID: WEBAUTHN_RP_ID, origin: WEBAUTHN_ORIGIN }),
);

const invoicing = new InvoicingService({
  store: state.invoices,
  accessControl: state.accessControl,
  auditLog: state.auditLog,
  trust: state.trustLedger,
  billingHours: state.billingHours,
  processor: new ManualPaymentProcessor(),
  email: emailSender,
  ...checkoutOptions,
  // Always on: PDF rendering needs no configuration and no vendor, and
  // the PDF is the form most clients mean by "the invoice".
  pdf: new PdfLibInvoicePdfRenderer(),
  // The matter record supplies the caption and the client's address; the
  // auth service turns a timekeeper's actorId into a name on the bill.
  matters: state.matters,
  auth: state.auth,
  // Letterhead comes from FIRM_CONFIG_FILE, with the env vars as a
  // fallback for a deployment that has no config file at all. The
  // billing address falls back to the SMTP sender, since a client
  // replying to the bill would reach that mailbox anyway.
  firm: {
    name: firmConfig?.firmName ?? "This Firm",
    timeZone: FIRM_TIME_ZONE,
    ...(firmConfig?.letterhead?.addressLines?.length
      ? { addressLines: firmConfig.letterhead.addressLines }
      : {}),
    ...(firmConfig?.letterhead?.phone ? { phone: firmConfig.letterhead.phone } : {}),
    ...(firmConfig?.letterhead?.billingEmail ?? SMTP_FROM
      ? { email: firmConfig?.letterhead?.billingEmail ?? SMTP_FROM! }
      : {}),
    ...(firmConfig?.letterhead?.paymentInstructions ?? process.env["FIRM_PAYMENT_INSTRUCTIONS"]
      ? {
          paymentInstructions:
            firmConfig?.letterhead?.paymentInstructions ?? process.env["FIRM_PAYMENT_INSTRUCTIONS"]!,
        }
      : {}),
  },
});

/**
 * Backs the client-facing "My Matters" surface — see
 * client-portal-service.ts's doc comment for the access-control
 * reasoning. `trust`/`invoicing` are optional there by design (a client
 * portal without invoicing configured just shows no billing section)
 * but both are always available in this deployment, so they're passed
 * through. `maxUploadBytes` reuses the exact same cap as the staff-facing
 * `DocumentsService` above, since both write into the same document
 * store under the same persistence ceiling. `paymentInstructions` reuses
 * the same letterhead field the invoice itself prints, since there is no
 * online payment path — see
 * that service's doc comment for why.
 */
const clientPortal = new ClientPortalService({
  accessControl: state.accessControl,
  matters: state.matters,
  documents: state.documentStore,
  trust: state.trustLedger,
  invoicing,
  auditLog: state.auditLog,
  maxUploadBytes: documents.getMaxUploadBytes(),
  ...(firmConfig?.letterhead?.paymentInstructions ?? process.env["FIRM_PAYMENT_INSTRUCTIONS"]
    ? { paymentInstructions: firmConfig?.letterhead?.paymentInstructions ?? process.env["FIRM_PAYMENT_INSTRUCTIONS"]! }
    : {}),
});

/**
 * Backs the per-matter message thread between a client and staff — a
 * card in both the client's "My Matters" panel and staff's Cases panel,
 * reading and writing the same thread. See client-messaging-service.ts
 * for the two-category access split.
 */
const clientMessaging = new ClientMessagingService({
  store: state.clientMessages,
  accessControl: state.accessControl,
  auditLog: state.auditLog,
});

/**
 * Backs the global search box. Given every store directly rather than
 * the panel services, because it needs to read across all of them at
 * once — and does its own `AccessControl` filtering, silently omitting
 * matters the caller can't reach (see `search-service.ts`).
 */
const search = new SearchService({
  accessControl: state.accessControl,
  auditLog: state.auditLog,
  matters: state.matters,
  workProducts: state.workProductStore,
  documents: state.documentStore,
  research: state.researchLibrary,
  billingHours: state.billingHours,
});

/** Backs the "Payroll" panel — what the firm pays its people, deliberately unconnected to client matters or trust. */
const payroll = new PayrollService({ store: state.payroll, auditLog: state.auditLog });

/**
 * Backs the "Analytics" panel — a read-only, firm-wide rollup over data
 * every other panel already produces. Attorney-only, same reasoning as
 * AuditService/AccountsService — see analytics-service.ts.
 */
const analytics = new AnalyticsService({
  matters: state.matters,
  invoices: state.invoices,
  billingHours: state.billingHours,
  utilization: state.utilization,
  auth: state.auth,
  timeZone: FIRM_TIME_ZONE,
});

/**
 * "Download calendar (.ics)" on the Deadlines and Scheduling panels.
 * Always on — no vendor, no key; it only re-reads what the caller's own
 * panels already show. See calendar-export-service.ts.
 */
const calendarExport = new CalendarExportService({
  reviewGate: service,
  scheduling: state.scheduling,
  auditLog: state.auditLog,
  nameFor: (actorId) => state.auth.listUsers().find((u) => u.actorId === actorId)?.displayName,
  ...(firmConfig?.firmName ? { firmName: firmConfig.firmName } : {}),
  timeZone: FIRM_TIME_ZONE,
});

/**
 * The Cases panel's per-matter timeline. Always on: it only re-reads
 * stores other panels already guard, through those panels' own checks.
 */
const matterTimeline = new MatterTimelineService({
  accessControl: state.accessControl,
  workProducts: state.workProductStore,
  documents: state.documentStore,
  matters: state.matters,
  deadlines: state.deadlineTracker,
  scheduling: state.scheduling,
  invoices: state.invoices,
  trust: state.trustLedger,
  clientMessages: state.clientMessages,
  signatures: state.esignatures,
  nameFor: (actorId) => state.auth.listUsers().find((u) => u.actorId === actorId)?.displayName,
});

/**
 * Backs the "Import" panel: bringing matters and time entries over from
 * Clio, MyCase, PracticePanther or a spreadsheet, as CSV. Always on — it
 * needs no vendor and no key, and it's attorney-only with a mandatory
 * preview. See core/data-import.ts.
 */
const dataImport = new ImportService({
  matters: state.matters,
  billingHours: state.billingHours,
  auth: state.auth,
  auditLog: state.auditLog,
  trust: state.trustLedger,
  matterIdsInUse: () => [
    ...state.workProductStore.listAll().map((wp) => wp.matterId),
    ...state.documentStore.listAll().map((d) => d.matterId),
    ...state.billingHours.listAll().map((e) => e.matterId),
    ...state.trustLedger.matterIds(),
  ],
  ...(fileRetentionYears > 0 ? { retentionYears: fileRetentionYears } : {}),
  timeZone: FIRM_TIME_ZONE,
});

/**
 * Backs the "Time Clock" panel — the capture side of payroll.
 * `FIRM_TIME_ZONE` (above) decides where a day starts: bucketing punches
 * by UTC would put an evening shift on the wrong day, and therefore in the
 * wrong week and pay period.
 */
const timeClock = new TimeClockService({
  clock: state.timeClock,
  payroll: state.payroll,
  auditLog: state.auditLog,
  defaultTimeZone: FIRM_TIME_ZONE,
});

/** Backs the attorney-only "Audit Log" panel — see audit-service.ts. */
/**
 * Where audit anchors go. The hash chain detects an entry altered in
 * place; only an anchor published somewhere the database administrator
 * can't reach detects a log rebuilt wholesale, or truncated. Both
 * destinations are optional and independent — see `core/audit-anchor.ts`
 * for why the choice of destination *is* the security property.
 *
 * `AUDIT_ANCHOR_FILE` should point somewhere this process can append to
 * but not rewrite (an append-only mount, or a path a log shipper drains
 * off the machine). A path on the same disk under the same account is
 * close to worthless and is not the default for that reason.
 *
 * `AUDIT_ANCHOR_EMAILS` mails the head hash to the firm's partners,
 * which for a small firm is usually the most genuinely independent
 * option available: it lands in mailboxes hosted elsewhere.
 */
const anchorTargets: AuditAnchorTarget[] = [];
if (process.env["AUDIT_ANCHOR_FILE"]) {
  anchorTargets.push(new FileAnchorTarget(process.env["AUDIT_ANCHOR_FILE"]));
}
const anchorEmails = (process.env["AUDIT_ANCHOR_EMAILS"] ?? "")
  .split(",")
  .map((a) => a.trim())
  .filter(Boolean);
if (anchorEmails.length > 0 && emailSender.canSend) {
  anchorTargets.push(
    new EmailAnchorTarget({
      sender: emailSender,
      recipients: anchorEmails,
      ...(firmConfig?.firmName ? { firmName: firmConfig.firmName } : {}),
    }),
  );
}

const audit = new AuditService(state.auditLog, {
  ...(anchorTargets.length
    ? { anchorTarget: anchorTargets.length === 1 ? anchorTargets[0]! : new MultiAnchorTarget(anchorTargets) }
    : {}),
  anchors: state.auditAnchors,
});

/**
 * Backs the "Research" panel: general case-law search against
 * CourtListener (see integrations/courtlistener.ts) plus a matter-scoped
 * library of references someone explicitly saved (persisted via
 * state.researchLibrary). COURTLISTENER_API_TOKEN is optional — search
 * works unauthenticated, just at a lower rate limit.
 */
const COURTLISTENER_API_TOKEN = process.env["COURTLISTENER_API_TOKEN"];
const COURTLISTENER_BASE_URL = process.env["COURTLISTENER_BASE_URL"];
const research = new ResearchService({
  accessControl: state.accessControl,
  library: state.researchLibrary,
  searchClient: new CourtListenerClient({
    ...(COURTLISTENER_BASE_URL ? { baseUrl: COURTLISTENER_BASE_URL } : {}),
    ...(COURTLISTENER_API_TOKEN ? { apiToken: COURTLISTENER_API_TOKEN } : {}),
  }),
});

/**
 * Backs the "Assistant" panel — an internal AI copilot for attorneys/
 * paralegals (not receptionist-accessible; that's the separate,
 * hard-coded receptionist chat agent). Its tools are thin wrappers
 * around the exact same services the ordinary UI panels use, so it can
 * never act outside the logged-in actor's own AccessControl scope — see
 * assistant/tools.ts for the deliberate, permanent exclusions (no
 * approve/release/reject, no deadline confirmation, no account
 * management). Only wired up when ANTHROPIC_API_KEY is set — `/api/
 * assistant/*` 404s otherwise, same pattern as every other optional
 * integration here.
 */
const ANTHROPIC_API_KEY = process.env["ANTHROPIC_API_KEY"];
const ANTHROPIC_MODEL = process.env["ANTHROPIC_MODEL"];
const ANTHROPIC_BASE_URL = process.env["ANTHROPIC_BASE_URL"];
const assistant = ANTHROPIC_API_KEY
  ? new AssistantService({
      client: new AnthropicClient({
        apiKey: ANTHROPIC_API_KEY,
        ...(ANTHROPIC_MODEL ? { model: ANTHROPIC_MODEL } : {}),
        ...(ANTHROPIC_BASE_URL ? { baseUrl: ANTHROPIC_BASE_URL } : {}),
      }),
      auditLog: state.auditLog,
      toolDeps: { drafting, documents, cases, research, scheduling: state.scheduling, reviewGate: service },
      // Business hours are judged in the firm config's zone, so "10am" should mean the same.
      timeZone: FIRM_TIME_ZONE,
    })
  : undefined;

/** Backs the "Staff" panel: every logged-in human can see who else is on the team. */
const staff = new StaffService(state.auth, state.accessControl);

/** Backs the "Messages" panel: direct/group chat plus firm-wide announcements. */
const messaging = new MessagingService(state.messaging, state.auth);

/** Backs the "Schedule" panel: who's in the office/remote/out, per day. */
const staffSchedule = new StaffScheduleService(state.staffSchedule, {
  // Exact match: entries are keyed by the id as given, so "P1" for "p1"
  // would be an entry nobody's view ever finds.
  isStaffMember: (actorId) => state.auth.listUsers().some((u) => u.actorId === actorId && u.role !== "client"),
  auditLog: state.auditLog,
});

/** Backs the "Billing" panel: billable hours logged by lawyers/paralegals against a matter. */
const billingHours = new BillingHoursService({ accessControl: state.accessControl, store: state.billingHours });

/**
 * TLS is terminated upstream by a reverse proxy/load balancer, not by this
 * Node process — set TRUST_PROXY=true only when actually deployed behind
 * one that sets X-Forwarded-Proto itself (never on a directly-exposed
 * process, where that header could be forged by anyone). See server.ts's
 * module doc comment for what this actually gates: the session cookie's
 * Secure flag.
 */
const trustProxy = process.env["TRUST_PROXY"] === "true";

/**
 * Firm-wide MFA policy — which roles must have a second factor enrolled
 * before their session can reach anything beyond `/api/me`, `/api/mfa/*`,
 * `/api/logout`, and `/api/change-password` (see server.ts's
 * `needsMfaSetup`). Absent (the default) leaves MFA fully opt-in, same
 * as before this existed. A comma-separated role list rather than a
 * single boolean, since a firm might reasonably require it for attorneys
 * before rolling it out to everyone else.
 */
const MFA_REQUIRED_ROLES = process.env["MFA_REQUIRED_ROLES"];
const mfaRequiredRoles = MFA_REQUIRED_ROLES
  ? new Set(
      MFA_REQUIRED_ROLES.split(",")
        .map((r) => r.trim())
        .filter((r): r is UserRole => (["attorney", "paralegal", "receptionist", "staff", "client"] as const).includes(r as UserRole)),
    )
  : undefined;

/**
 * The real-call telephony surface (see `server.ts`'s `handleVoiceRequest`
 * and CLAUDE.md's "Voicebox voice integration"/"Twilio telephony
 * integration"): a Twilio phone number's webhooks drive
 * `VoiceCallSessions`, which uses Voicebox for both STT and TTS. Only
 * wired up when all three Twilio env vars are present — `/api/voice/*`
 * 404s otherwise, same "absent config means the surface doesn't exist"
 * pattern as every other optional panel here.
 */
const TWILIO_ACCOUNT_SID = process.env["TWILIO_ACCOUNT_SID"];
const TWILIO_AUTH_TOKEN = process.env["TWILIO_AUTH_TOKEN"];
const VOICEBOX_BASE_URL = process.env["VOICEBOX_BASE_URL"];
const VOICEBOX_PROFILE_ID = process.env["VOICEBOX_PROFILE_ID"];
const voiceOptions: Pick<ReviewServerOptions, "voiceCalls" | "audioClips" | "twilio"> =
  TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && PUBLIC_BASE_URL
    ? {
        voiceCalls: new VoiceCallSessions({
          accessControl: new AccessControl(state.auditLog),
          auditLog: state.auditLog,
          module: criminalLawModule,
          stt: new VoiceboxSpeechToText(VOICEBOX_BASE_URL ? { baseUrl: VOICEBOX_BASE_URL } : {}),
          tts: new VoiceboxTextToSpeech({
            ...(VOICEBOX_BASE_URL ? { baseUrl: VOICEBOX_BASE_URL } : {}),
            ...(VOICEBOX_PROFILE_ID ? { profileId: VOICEBOX_PROFILE_ID } : {}),
          }),
          utilization: state.utilization,
          ...(firmConfig ? { firmConfig } : {}),
          timeZone: FIRM_TIME_ZONE,
        }),
        audioClips: new AudioClipStore(),
        twilio: { accountSid: TWILIO_ACCOUNT_SID, authToken: TWILIO_AUTH_TOKEN, publicBaseUrl: PUBLIC_BASE_URL.replace(/\/+$/, "") },
      }
    : {};

/**
 * The dashboard's "Listen" buttons (a draft's content, a chat message, a
 * Live Intake Demo script reply) — deliberately independent of the
 * Twilio gate above. A firm may well want Voicebox read-aloud in the
 * dashboard without having set up real-call telephony at all (or vice
 * versa), so this reuses the same `VOICEBOX_BASE_URL`/`VOICEBOX_PROFILE_ID`
 * vars but behind its own explicit opt-in rather than inheriting
 * Twilio's — constructing a `VoiceboxTextToSpeech` unconditionally
 * whenever Twilio happened to be configured would make this feature's
 * availability an accident of an unrelated integration.
 */
const speechOptions: Pick<ReviewServerOptions, "speech"> =
  process.env["SPEECH_TOOLS"] === "true"
    ? {
        speech: new SpeechService(
          new VoiceboxTextToSpeech({
            ...(VOICEBOX_BASE_URL ? { baseUrl: VOICEBOX_BASE_URL } : {}),
            ...(VOICEBOX_PROFILE_ID ? { profileId: VOICEBOX_PROFILE_ID } : {}),
          }),
        ),
      }
    : {};

/**
 * Self-service "forgot password" needs the same externally-reachable
 * base URL Twilio's webhook config already names (`PUBLIC_BASE_URL`) —
 * reused here rather than a second env var meaning the same thing —
 * plus a real mail transport. Without both, `/api/forgot-password`
 * still exists and responds, just by telling the requester self-service
 * reset isn't set up (see `handleForgotPassword` in server.ts) rather
 * than issuing a token nobody can retrieve.
 */
const passwordResetOptions: Pick<ReviewServerOptions, "passwordReset"> =
  PUBLIC_BASE_URL && emailSender.canSend
    ? {
        passwordReset: {
          email: emailSender,
          baseUrl: PUBLIC_BASE_URL.replace(/\/+$/, ""),
          ...(firmConfig?.firmName ? { firmName: firmConfig.firmName } : {}),
        },
      }
    : {};

/**
 * E-signature (see "Online invoice payment" and "Self-service password
 * reset" above for the same shape — a staff-initiated action that ends
 * in a public, token-bearing link someone outside the firm opens).
 * Needs `PUBLIC_BASE_URL` to build a link that actually resolves
 * anywhere; unlike password reset, a real `EmailSender` is optional
 * rather than required — `ESignatureService.send()` always returns each
 * signer's raw signing URL in its response, so staff can still deliver
 * it by hand (copy/paste, their own mail client) when no SMTP transport
 * is configured, the same "degrade, don't block the whole feature"
 * reasoning as `InvoicingService`'s preview-and-send-yourself fallback.
 */
const esignatureOptions: Pick<ReviewServerOptions, "esignature"> = PUBLIC_BASE_URL
  ? {
      esignature: new ESignatureService({
        store: state.esignatures,
        accessControl: state.accessControl,
        auditLog: state.auditLog,
        documents: state.documentStore,
        workProducts: state.workProductStore,
        baseUrl: PUBLIC_BASE_URL.replace(/\/+$/, ""),
        ...(emailSender.canSend ? { email: emailSender } : {}),
        ...(firmConfig?.firmName ? { firmName: firmConfig.firmName } : {}),
      }),
    }
  : {};

/**
 * The public self-service booking page (`/book.html`). Opt-in on its own
 * flag: it's the first form in this app that anyone on the internet can
 * submit, so a firm turns it on deliberately rather than getting it as a
 * side effect of some other setting. Requests land in the Scheduling
 * panel for staff to accept or decline; nothing books itself.
 */
const bookingOptions: Pick<ReviewServerOptions, "booking"> =
  process.env["PUBLIC_BOOKING"] === "true"
    ? {
        booking: new BookingService({
          store: state.bookingRequests,
          scheduling: state.scheduling,
          auditLog: state.auditLog,
          conflictChecker,
          ...(firmConfig ? { firmConfig } : {}),
          timeZone: FIRM_TIME_ZONE,
        }),
      }
    : {};

/**
 * Self-service "connect your own Google Calendar" (see "Google
 * Calendar integration" in CLAUDE.md) — the per-attorney alternative
 * to the one firm-wide shared service-account calendar. Needs a real
 * Google OAuth client (console.cloud.google.com → OAuth client ID,
 * type "Web application", authorized redirect URI
 * `${PUBLIC_BASE_URL}/api/calendar-connection/callback`) — a one-time
 * setup step this code can't do for you, the same way the Twilio
 * console step for the voice channel isn't code either.
 */
const GOOGLE_OAUTH_CLIENT_ID = process.env["GOOGLE_OAUTH_CLIENT_ID"];
const GOOGLE_OAUTH_CLIENT_SECRET = process.env["GOOGLE_OAUTH_CLIENT_SECRET"];
const calendarConnectionOptions: Pick<ReviewServerOptions, "calendarConnection"> =
  GOOGLE_OAUTH_CLIENT_ID && GOOGLE_OAUTH_CLIENT_SECRET && PUBLIC_BASE_URL
    ? {
        calendarConnection: new CalendarConnectionService({
          store: state.calendarConnections,
          clientId: GOOGLE_OAUTH_CLIENT_ID,
          clientSecret: GOOGLE_OAUTH_CLIENT_SECRET,
          redirectUri: `${PUBLIC_BASE_URL.replace(/\/+$/, "")}/api/calendar-connection/callback`,
          auditLog: state.auditLog,
          auth: state.auth,
        }),
      }
    : {};

/**
 * Persisting after a mutation, serialized and non-fatal.
 *
 * Two things this must not do, both of which it previously did:
 *
 * - **Run concurrently with itself.** Every mutating request fires a
 *   save; two overlapping writes race each other through the
 *   temp-file-and-rename dance. Chaining them means the last write still
 *   wins (which is correct — it holds the newest state) without two
 *   writers ever being in flight at once.
 * - **Crash the process on failure.** A rejected save used to be a
 *   floating promise, so a transient disk or database error took the
 *   whole server down and every logged-in user with it. A failed save is
 *   serious and is logged as such, but the right response is to keep
 *   serving and let the next mutation retry, not to die.
 */
let pendingSave: Promise<void> = Promise.resolve();
function persist(): void {
  pendingSave = pendingSave
    .then(() => saveSystemState(store, state))
    .catch((err: unknown) => {
      console.error(
        `[docket] FAILED TO PERSIST STATE — the change is live in memory but not saved, and will be lost on restart: ${
          (err as Error).message
        }`,
      );
    });
}

const server = createReviewServer(service, state.auth, {
  onMutated: persist,
  scheduling: state.scheduling,
  intake,
  accounts,
  drafting,
  documents,
  cases,
  audit,
  research,
  staff,
  messaging,
  staffSchedule,
  billingHours,
  pdfReports,
  matters,
  trust,
  clientFile,
  invoicing,
  clientPortal,
  clientMessaging,
  search,
  payroll,
  timeClock,
  analytics,
  dataImport,
  calendarExport,
  matterTimeline,
  maxRequestBodyBytes,
  loginThrottle: state.loginThrottle,
  auditLog: state.auditLog,
  trustProxy,
  ...(firmConfig?.firmName ? { firmName: firmConfig.firmName } : {}),
  ...(mfaRequiredRoles?.size ? { mfaRequiredRoles } : {}),
  ...(assistant ? { assistant } : {}),
  ...voiceOptions,
  ...speechOptions,
  ...passwordResetOptions,
  ...esignatureOptions,
  ...bookingOptions,
  ...calendarConnectionOptions,
  ...stripeWebhookOptions,
});

const port = Number(process.env["PORT"] ?? 3000);
server.listen(port, () => {
  console.log(`Docket listening on http://localhost:${port}`);
  console.log(DATABASE_URL ? "State persisted to Postgres (DATABASE_URL)" : `State persisted to ${STATE_FILE}`);
  if (firmConfig) console.log(`Firm config loaded from ${FIRM_CONFIG_FILE}`);
  if (trustProxy) console.log("TRUST_PROXY is on — trusting X-Forwarded-Proto from the upstream proxy.");
  if (voiceOptions.twilio) {
    console.log(`Telephony integration active — point a Twilio phone number's voice webhook at ${PUBLIC_BASE_URL}/api/voice/twilio/incoming`);
  }
  if (assistant) console.log("Assistant panel active (ANTHROPIC_API_KEY set).");
  console.log(`The firm's days are counted in ${FIRM_TIME_ZONE} (set FIRM_TIME_ZONE to change).`);
  if (bookingOptions.booking) console.log(`Public booking page live at /book.html (PUBLIC_BOOKING=true).`);
});
