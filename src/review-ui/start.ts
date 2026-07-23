import { createReviewServer } from "./server.js";
import { ReviewGateService } from "./review-service.js";
import { WorkProductStore } from "../core/work-product-store.js";

/**
 * Standalone entry point for the attorney review-gate UI (`npm run
 * start:review-ui`). Boots with an empty in-memory store — there's no
 * persistence yet (§8's "not yet built"), so this is for local
 * development/demo use, not a real deployment target.
 */
const store = new WorkProductStore();
const service = new ReviewGateService(store);
const server = createReviewServer(service);

const port = Number(process.env["PORT"] ?? 3000);
server.listen(port, () => {
  console.log(`Attorney review-gate UI listening on http://localhost:${port}`);
});
