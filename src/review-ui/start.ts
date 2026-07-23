import { createReviewServer } from "./server.js";
import { ReviewGateService } from "./review-service.js";
import { loadSystemState, saveSystemState } from "../persistence/system-state.js";

/**
 * Standalone entry point for the attorney review-gate UI (`npm run
 * start:review-ui`). Loads persisted state on boot and saves after every
 * mutation (see `server.ts`'s `onMutated` hook) — file-backed via
 * `src/persistence/`, not the in-memory-only store earlier steps used.
 * Still single-process/single-file (§8's "not yet built" still flags a
 * real database as a prerequisite before real clients).
 */
const STATE_FILE = process.env["STATE_FILE"] ?? "./data/system-state.json";

const state = await loadSystemState(STATE_FILE);
const service = new ReviewGateService(state.workProductStore, state.deadlineTracker);
const server = createReviewServer(service, () => {
  void saveSystemState(STATE_FILE, state);
});

const port = Number(process.env["PORT"] ?? 3000);
server.listen(port, () => {
  console.log(`Attorney review-gate UI listening on http://localhost:${port}`);
  console.log(`State persisted to ${STATE_FILE}`);
});
