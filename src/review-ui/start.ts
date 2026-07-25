import { randomBytes } from "node:crypto";
import { createReviewServer } from "./server.js";
import { ReviewGateService } from "./review-service.js";
import { IntakeDemoSessions } from "./intake-demo.js";
import { AccountsService } from "./accounts-service.js";
import { loadSystemState, saveSystemState } from "../persistence/system-state.js";
import { readJsonFile } from "../persistence/json-file-store.js";
import { createPostgresStateStore } from "../persistence/postgres-store.js";
import type { StateStore } from "../persistence/state-store.js";
import { AccessControl } from "../core/access-control.js";
import { criminalLawModule } from "../modules/criminal-law/index.js";
import type { UserRole } from "../core/auth.js";
import type { FirmConfig } from "../config/firm-config.js";

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
const intake = new IntakeDemoSessions({
  accessControl: new AccessControl(state.auditLog),
  auditLog: state.auditLog,
  module: criminalLawModule,
  utilization: state.utilization,
  ...(firmConfig ? { firmConfig } : {}),
});

const accounts = new AccountsService(state.auth);

/**
 * TLS is terminated upstream by a reverse proxy/load balancer, not by this
 * Node process — set TRUST_PROXY=true only when actually deployed behind
 * one that sets X-Forwarded-Proto itself (never on a directly-exposed
 * process, where that header could be forged by anyone). See server.ts's
 * module doc comment for what this actually gates: the session cookie's
 * Secure flag.
 */
const trustProxy = process.env["TRUST_PROXY"] === "true";

const server = createReviewServer(
  service,
  state.auth,
  () => {
    void saveSystemState(store, state);
  },
  state.scheduling,
  intake,
  accounts,
  trustProxy,
);

const port = Number(process.env["PORT"] ?? 3000);
server.listen(port, () => {
  console.log(`Docket listening on http://localhost:${port}`);
  console.log(DATABASE_URL ? "State persisted to Postgres (DATABASE_URL)" : `State persisted to ${STATE_FILE}`);
  if (firmConfig) console.log(`Firm config loaded from ${FIRM_CONFIG_FILE}`);
  if (trustProxy) console.log("TRUST_PROXY is on — trusting X-Forwarded-Proto from the upstream proxy.");
});
