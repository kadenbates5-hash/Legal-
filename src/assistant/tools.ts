import type { Actor } from "../core/types.js";
import type { DraftingService } from "../review-ui/drafting-service.js";
import type { DocumentsService } from "../review-ui/documents-service.js";
import type { CasesService } from "../review-ui/cases-service.js";
import type { ResearchService } from "../review-ui/research-service.js";
import type { ReviewGateService } from "../review-ui/review-service.js";
import type { SchedulingService, AppointmentType } from "../core/scheduling.js";
import type { DeadlineType } from "../core/deadline.js";
import type { ClaudeToolDefinition } from "../integrations/anthropic.js";

/**
 * The assistant's entire capability surface is this list of tools — every
 * one of them is a thin wrapper around a method the same logged-in actor
 * could already call from the ordinary Docket UI (Drafting, Documents,
 * Cases, Research, Scheduling, read-only Deadlines). Nothing here grants
 * the assistant any privilege the human user doesn't already have:
 * every executor passes the actor straight through, so `AccessControl`'s
 * matter-scoping enforces exactly the same rules it enforces everywhere
 * else in this system.
 *
 * Deliberately, permanently excluded — regardless of the actor's role:
 * work-product status transitions (`approve`/`reject`/`request-revision`/
 * `release`/`clear-flag`), deadline *confirmation*, and all account
 * management. Those are the review-gate's non-negotiable human
 * checkpoints (§1) and the redundant-verification requirement (§3/§7) —
 * an LLM calling a tool is not a substitute for a human's own action,
 * and giving the assistant a tool for either would quietly undo the
 * exact guarantees those subsystems exist to enforce. The assistant can
 * draft, revise, submit for review, research, and schedule; it can never
 * be the second, independent signature on its own work.
 */
export interface AssistantTool {
  definition: ClaudeToolDefinition;
  execute: (actor: Actor, input: Record<string, unknown>) => Promise<unknown>;
}

export interface AssistantToolDependencies {
  drafting: DraftingService;
  documents: DocumentsService;
  cases: CasesService;
  research: ResearchService;
  scheduling: SchedulingService;
  reviewGate: ReviewGateService;
}

function str(input: Record<string, unknown>, key: string): string {
  return String(input[key] ?? "");
}

export function createAssistantTools(deps: AssistantToolDependencies): AssistantTool[] {
  return [
    {
      definition: {
        name: "list_cases",
        description: "List every matter the current user can see, with counts of drafted work product and uploaded documents.",
        input_schema: { type: "object", properties: {} },
      },
      execute: async (actor) => deps.cases.listCases(actor),
    },
    {
      definition: {
        name: "get_case",
        description: "Get full detail for one matter: its drafted work product and uploaded documents.",
        input_schema: { type: "object", properties: { matterId: { type: "string" } }, required: ["matterId"] },
      },
      execute: async (actor, input) => deps.cases.getCase(actor, str(input, "matterId")),
    },
    {
      definition: {
        name: "list_case_documents",
        description: "List uploaded documents (contracts, exhibits, scanned forms) for a matter. Does not include drafted work product.",
        input_schema: { type: "object", properties: { matterId: { type: "string" } }, required: ["matterId"] },
      },
      execute: async (actor, input) => deps.documents.listMatterDocuments(actor, str(input, "matterId")),
    },
    {
      definition: {
        name: "search_case_law",
        description: "Search real case law via CourtListener. Not scoped to any matter. Results are not verified citations.",
        input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      },
      execute: async (actor, input) => deps.research.search(actor, str(input, "query")),
    },
    {
      definition: {
        name: "list_matter_research",
        description: "List case-law/statute references already saved to a matter's quick-access library.",
        input_schema: { type: "object", properties: { matterId: { type: "string" } }, required: ["matterId"] },
      },
      execute: async (actor, input) => deps.research.listMatterReferences(actor, str(input, "matterId")),
    },
    {
      definition: {
        name: "save_research_reference",
        description: "Save a citation to a matter's quick-access research library.",
        input_schema: {
          type: "object",
          properties: {
            matterId: { type: "string" },
            citation: { type: "string" },
            title: { type: "string" },
            url: { type: "string" },
            note: { type: "string" },
          },
          required: ["matterId", "citation", "title"],
        },
      },
      execute: async (actor, input) =>
        deps.research.saveReference(actor, str(input, "matterId"), {
          citation: str(input, "citation"),
          title: str(input, "title"),
          ...(typeof input["url"] === "string" && input["url"] ? { url: input["url"] } : {}),
          ...(typeof input["note"] === "string" && input["note"] ? { note: input["note"] } : {}),
        }),
    },
    {
      definition: {
        name: "list_matter_drafts",
        description: "List drafted work product (letters, motions, discovery requests, research summaries, billing narratives) on a matter.",
        input_schema: { type: "object", properties: { matterId: { type: "string" } }, required: ["matterId"] },
      },
      execute: async (actor, input) => deps.drafting.listMatterWorkProduct(actor, str(input, "matterId")),
    },
    {
      definition: {
        name: "get_draft",
        description: "Get the full content and status of one drafted work product.",
        input_schema: {
          type: "object",
          properties: { matterId: { type: "string" }, workProductId: { type: "string" } },
          required: ["matterId", "workProductId"],
        },
      },
      execute: async (actor, input) => deps.drafting.get(actor, str(input, "matterId"), str(input, "workProductId")),
    },
    {
      definition: {
        name: "list_draft_templates",
        description: "List the practice area's available document templates (for draft_from_template's templateId).",
        input_schema: { type: "object", properties: {} },
      },
      execute: async (actor) => deps.drafting.listTemplates(actor),
    },
    {
      definition: {
        name: "draft_from_template",
        description:
          "Create a new draft on a matter from a template (e.g. an engagement letter or motion). If it references a calculated deadline, pass deadlineDate/deadlineType so it's flagged for redundant human verification.",
        input_schema: {
          type: "object",
          properties: {
            matterId: { type: "string" },
            templateId: { type: "string" },
            content: { type: "string" },
            deadlineDate: { type: "string", description: "YYYY-MM-DD, optional" },
            deadlineType: { type: "string", enum: ["speedy_trial", "arraignment", "bail_hearing", "discovery_response", "other"] },
          },
          required: ["matterId", "templateId", "content"],
        },
      },
      execute: async (actor, input) =>
        deps.drafting.draftFromTemplate(actor, str(input, "matterId"), {
          templateId: str(input, "templateId"),
          content: str(input, "content"),
          ...(typeof input["deadlineDate"] === "string" && input["deadlineDate"] ? { deadlineDate: input["deadlineDate"] } : {}),
          ...(typeof input["deadlineType"] === "string" && input["deadlineType"]
            ? { deadlineType: input["deadlineType"] as DeadlineType }
            : {}),
        }),
    },
    {
      definition: {
        name: "draft_research_summary",
        description: "Create a research-summary draft on a matter. Always carries a flag requiring attorney verification before release.",
        input_schema: {
          type: "object",
          properties: {
            matterId: { type: "string" },
            content: { type: "string" },
            citations: { type: "array", items: { type: "string" } },
          },
          required: ["matterId", "content"],
        },
      },
      execute: async (actor, input) =>
        deps.drafting.draftResearchSummary(actor, str(input, "matterId"), {
          content: str(input, "content"),
          citations: Array.isArray(input["citations"]) ? (input["citations"] as string[]) : [],
        }),
    },
    {
      definition: {
        name: "draft_billing_narrative",
        description: "Create a billing-narrative draft on a matter (internal utilization text, walled off from client billing until approved).",
        input_schema: {
          type: "object",
          properties: { matterId: { type: "string" }, content: { type: "string" } },
          required: ["matterId", "content"],
        },
      },
      execute: async (actor, input) => deps.drafting.draftBillingNarrative(actor, str(input, "matterId"), { content: str(input, "content") }),
    },
    {
      definition: {
        name: "revise_draft",
        description: "Replace the content of an existing draft (only works while it's in draft or revision_requested status).",
        input_schema: {
          type: "object",
          properties: { matterId: { type: "string" }, workProductId: { type: "string" }, content: { type: "string" } },
          required: ["matterId", "workProductId", "content"],
        },
      },
      execute: async (actor, input) =>
        deps.drafting.reviseDraft(actor, str(input, "matterId"), str(input, "workProductId"), str(input, "content")),
    },
    {
      definition: {
        name: "submit_draft_for_review",
        description: "Submit a draft into the attorney's Review Queue. This does not approve or release it — only an attorney can do that.",
        input_schema: {
          type: "object",
          properties: { matterId: { type: "string" }, workProductId: { type: "string" } },
          required: ["matterId", "workProductId"],
        },
      },
      execute: async (actor, input) => deps.drafting.submitForReview(actor, str(input, "matterId"), str(input, "workProductId")),
    },
    {
      definition: {
        name: "get_deadline_status",
        description: "Read-only: check whether a deadline is confirmed, unconfirmed, or in conflict. Attorney-only.",
        input_schema: {
          type: "object",
          properties: {
            matterId: { type: "string" },
            type: { type: "string", enum: ["speedy_trial", "arraignment", "bail_hearing", "discovery_response", "other"] },
          },
          required: ["matterId", "type"],
        },
      },
      execute: async (actor, input) => deps.reviewGate.getDeadlineStatus(actor, str(input, "matterId"), input["type"] as DeadlineType),
    },
    {
      definition: {
        name: "list_deadline_conflicts",
        description: "Read-only: list every deadline where independent sources disagree. Attorney-only.",
        input_schema: { type: "object", properties: {} },
      },
      execute: async (actor) => deps.reviewGate.listDeadlineConflicts(actor),
    },
    {
      definition: {
        name: "list_appointments",
        description: "List consultations/follow-ups, optionally filtered to one matter.",
        input_schema: { type: "object", properties: { matterId: { type: "string" } } },
      },
      execute: async (_actor, input) => {
        const matterId = typeof input["matterId"] === "string" ? input["matterId"] : undefined;
        return matterId ? deps.scheduling.listByMatter(matterId) : deps.scheduling.listAll();
      },
    },
    {
      definition: {
        name: "book_appointment",
        description: "Book a consultation or follow-up for a matter. Rejected outside business hours unless explicitly overridden.",
        input_schema: {
          type: "object",
          properties: {
            matterId: { type: "string" },
            startTime: { type: "string", description: "ISO 8601 datetime" },
            type: { type: "string", enum: ["consultation", "follow_up"] },
            practiceAreaId: { type: "string" },
            attorneyId: { type: "string" },
            allowOutsideBusinessHours: { type: "boolean" },
          },
          required: ["matterId", "startTime"],
        },
      },
      execute: async (actor, input) =>
        deps.scheduling.scheduleConsultation(actor, {
          matterId: str(input, "matterId"),
          startTime: new Date(str(input, "startTime")),
          ...(typeof input["type"] === "string" ? { type: input["type"] as AppointmentType } : {}),
          ...(typeof input["practiceAreaId"] === "string" ? { practiceAreaId: input["practiceAreaId"] } : {}),
          ...(typeof input["attorneyId"] === "string" ? { attorneyId: input["attorneyId"] } : {}),
          allowOutsideBusinessHours: input["allowOutsideBusinessHours"] === true,
        }),
    },
    {
      definition: {
        name: "reschedule_appointment",
        description: "Move an existing appointment to a new time.",
        input_schema: {
          type: "object",
          properties: { id: { type: "string" }, newStartTime: { type: "string", description: "ISO 8601 datetime" } },
          required: ["id", "newStartTime"],
        },
      },
      execute: async (actor, input) =>
        deps.scheduling.reschedule(actor, str(input, "id"), { newStartTime: new Date(str(input, "newStartTime")) }),
    },
    {
      definition: {
        name: "cancel_appointment",
        description: "Cancel an existing appointment.",
        input_schema: {
          type: "object",
          properties: { id: { type: "string" }, reason: { type: "string" } },
          required: ["id"],
        },
      },
      execute: async (actor, input) =>
        deps.scheduling.cancel(actor, str(input, "id"), typeof input["reason"] === "string" ? input["reason"] : undefined),
    },
  ];
}
