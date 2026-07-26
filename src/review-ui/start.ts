import { randomBytes } from "node:crypto";
import { createReviewServer, maxRequestBodyBytesFor } from "./server.js";
import { ReviewGateService } from "./review-service.js";
import { IntakeDemoSessions } from "./intake-demo.js";
import { AccountsService } from "./accounts-service.js";
import { DraftingService } from "./drafting-service.js";
import { DocumentsService } from "./documents-service.js";
import { CasesService } from "./cases-service.js";
import { AuditService } from "./audit-service.js";
import { ResearchService } from "./research-service.js";
import { CourtListenerClient } from "../integrations/courtlistener.js";
import { loadSystemState, saveSystemState } from "../persistence/system-state.js";
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
import { PayrollService } from "./payroll-service.js";
import { TimeClockService } from "./time-clock-service.js";
import { ManualPaymentProcessor } from "../integrations/payment-processor.js";
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
function bootstrapAccount(envPrefix: string, role: UserRole): void {
  const username = process.env[`${envPrefix}_USERNAME`];
  const password = process.env[`${envPrefix}_PASSWORD`];
  if (username && password) {
    state.auth.createUser({ username, password, role });
    console.log(`Seeded ${role} account '${username}' from ${envPrefix}_USERNAME/${envPrefix}_PASSWORD.`);
  }
}

let seeded = false;
if (!state.auth.hasAnyUsers()) {
  bootstrapAccount("ATTORNEY", "attorney");
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

const service = new ReviewGateService(state.workProductStore, state.deadlineTracker);

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

const intake = new IntakeDemoSessions({
  accessControl: new AccessControl(state.auditLog),
  auditLog: state.auditLog,
  module: criminalLawModule,
  utilization: state.utilization,
  ...(firmConfig ? { firmConfig } : {}),
  // Live intake screens against the firm's real matter records, not a
  // hardcoded name list — see core/conflicts.ts.
  conflictChecker,
});

/**
 * `state.accessControl` is the canonical, persisted AccessControl — the
 * one whose paralegal-matter assignments actually matter and must survive
 * a restart (unlike intake's throwaway one above). Shared by the Drafting
 * panel (enforcing matter scoping on every draft/revise/submit) and the
 * Accounts panel (the only place assignments are made/changed).
 */
const accounts = new AccountsService(state.auth, state.accessControl, state.loginThrottle);

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
const invoicing = new InvoicingService({
  store: state.invoices,
  accessControl: state.accessControl,
  auditLog: state.auditLog,
  trust: state.trustLedger,
  billingHours: state.billingHours,
  processor: new ManualPaymentProcessor(),
});

/** Backs the "Payroll" panel — what the firm pays its people, deliberately unconnected to client matters or trust. */
const payroll = new PayrollService({ store: state.payroll, auditLog: state.auditLog });

/**
 * Backs the "Time Clock" panel — the capture side of payroll.
 * `FIRM_TIME_ZONE` decides where a day starts: bucketing punches by UTC
 * would put an evening shift on the wrong day, and therefore in the
 * wrong week and pay period. Defaults to the host's own zone.
 */
const FIRM_TIME_ZONE = process.env["FIRM_TIME_ZONE"] ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
const timeClock = new TimeClockService({
  clock: state.timeClock,
  payroll: state.payroll,
  auditLog: state.auditLog,
  defaultTimeZone: FIRM_TIME_ZONE,
});

/** Backs the attorney-only "Audit Log" panel — see audit-service.ts. */
const audit = new AuditService(state.auditLog);

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
    })
  : undefined;

/** Backs the "Staff" panel: every logged-in human can see who else is on the team. */
const staff = new StaffService(state.auth, state.accessControl);

/** Backs the "Messages" panel: direct/group chat plus firm-wide announcements. */
const messaging = new MessagingService(state.messaging, state.auth);

/** Backs the "Schedule" panel: who's in the office/remote/out, per day. */
const staffSchedule = new StaffScheduleService(state.staffSchedule);

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
const PUBLIC_BASE_URL = process.env["PUBLIC_BASE_URL"];
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
        }),
        audioClips: new AudioClipStore(),
        twilio: { accountSid: TWILIO_ACCOUNT_SID, authToken: TWILIO_AUTH_TOKEN, publicBaseUrl: PUBLIC_BASE_URL.replace(/\/+$/, "") },
      }
    : {};

const server = createReviewServer(service, state.auth, {
  onMutated: () => {
    void saveSystemState(store, state);
  },
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
  payroll,
  timeClock,
  maxRequestBodyBytes,
  loginThrottle: state.loginThrottle,
  auditLog: state.auditLog,
  trustProxy,
  ...(assistant ? { assistant } : {}),
  ...voiceOptions,
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
  console.log(`Time clock day boundary: ${FIRM_TIME_ZONE} (set FIRM_TIME_ZONE to change).`);
});
