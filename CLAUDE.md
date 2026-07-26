# Docket — AI Receptionist & Paralegal System

**Docket** is the product name for the attorney-facing app in
`src/review-ui/` (dashboard, login, live intake demo) — see "Attorney
review-gate UI" below. The rest of this doc still refers to the overall
system/spec by its generic name; "Docket" specifically means that app.

Project brief: `docs/spec.md` (seed spec — pilot practice area is criminal law,
design goal is a scalable core usable by any practice area/firm).

## Architecture

Three layers, per the spec:

1. **Core** (`src/core/`) — same for every firm, practice-area-agnostic.
   Routing, escalation, confidentiality/access-control, audit logging,
   human-in-the-loop review gates, utilization tracking.
2. **Practice-area module** (`src/modules/<area>/`, interface in
   `src/config/practice-area.ts`) — swappable. `src/modules/criminal-law/`
   is the pilot module.
3. **Firm-level config** (`src/config/firm-config.ts`) — attorney
   assignments, hours, tone/branding, sign-off rules. Consumed by
   `ReceptionistChatSession` (see below): `isWithinBusinessHours()` drives
   an after-hours greeting notice, `branding.greeting` drives the opener,
   and `jurisdictionRecordingConsent` drives the consent-disclosure
   wording — all cosmetic, never gating. A missing `firmConfig` falls back
   to generic wording, so this layer stays optional everywhere it's used.

## Non-negotiable design rule

Nothing produced by either agent reaches a client, a filing, or an invoice
without passing through a human attorney checkpoint. This is enforced as an
actual code path, not a prompt instruction:

- `src/core/review-gate.ts` — `WorkProduct` is a state machine
  (`draft → pending_review → approved → released`, or `revision_requested`/
  `rejected`). `release()` throws unless status is `approved`, and
  `approve()`/`release()` throw unless the calling actor's role is
  `"attorney"`. Unresolved flags (e.g. the Padilla immigration-consequence
  advisory) block approval until an attorney explicitly clears them.
  `content` is private and can only change via `reviseDraft()`, which
  itself throws once status leaves `draft`/`revision_requested` — so an
  attorney's approval can never be silently invalidated by a post-approval
  content edit.
- `src/core/access-control.ts` — `AccessControl.authorize()` throws
  `AccessDeniedError` unless the request is within the actor's scope:
  receptionist gets `intake`/`scheduling` fields only; paralegal is scoped
  to its one assigned matter, with `high_sensitivity` requiring a separate
  explicit grant.
- `src/core/escalation.ts` — `evaluate()` is a pure function with no config
  knob to weaken an emergency trigger (in-custody, imminent police
  questioning, court appearance within 48h, active protective-order issue).

## Core modules

| File | Responsibility |
|---|---|
| `core/types.ts` | Shared vocabulary (`Actor`, `CallerType`, error types) |
| `core/escalation.ts` | Hard-coded, no-exceptions trigger evaluation (§2) |
| `core/router.ts` | Intake sequencing: interpreter-first, consent disclosure, conflict check before substantive info, emergency preemption |
| `core/access-control.ts` | Technically enforced scoping (§5) |
| `core/review-gate.ts` | Human-in-the-loop work-product state machine (§1, §3) |
| `core/audit.ts` | Append-only, privilege-sensitive audit trail, counsel-restricted read, hash-chained and field-level diffs (§5) |
| `core/confidentiality.ts` | Third-party disclosure default ("I can't share case details, but I can pass along a message") |
| `core/utilization.ts` | Internal AI utilization telemetry, explicitly walled off from client billing (§4) |
| `core/deadline.ts` | Redundant deadline confirmation — never single-sourced to the agent (§3, §7 item #1) |
| `core/work-product-store.ts` | In-memory registry making drafted `WorkProduct`s discoverable |
| `core/scheduling.ts` | Consultation booking/rescheduling/reminders (§2) |

## Receptionist agent (chat channel)

`src/receptionist/` — the conversational layer over core. It owns no
escalation/access-control logic itself, only:

- `chat-agent.ts` — `ReceptionistChatSession`, a per-conversation state
  machine that calls `Router.route()` every turn and renders the returned
  directive as a scripted reply. Sequences caller-type ID → consent
  disclosure → conflict check → practice-area intake questions, with
  emergency/legal-advice/opt-out triggers able to end the conversation at
  any point (including mid-intake, if an answer reveals e.g. custody).
- `signal-extraction.ts` — conservative regex-based extraction of
  escalation signals from free text (over-escalating is the safe failure
  mode, under-escalating is not).
- `scripts.ts` — the actual hard-coded reply text per directive, plus
  `greetingFor()`/`recordingConsentScriptFor()` which layer optional
  `FirmConfig` branding/jurisdiction wording on top of the generic
  fallback text — cosmetic only, never a gate.
- `voice-agent.ts` — `VoiceReceptionistSession`, the voice channel (§8
  build order step 6). Wraps the exact same `ReceptionistChatSession`
  behind vendor-agnostic `SpeechToText`/`TextToSpeech` interfaces — no
  escalation/routing logic of its own, only the audio boundary and the
  handling voice specifically needs that text doesn't: a mis-heard or
  low-confidence transcription asks the caller to repeat themselves
  instead of acting on a guess, without advancing any state. Vendor
  selection deliberately stays out of this file — §5's due-diligence
  checklist (zero-retention, no training on firm data, storage
  jurisdiction, subpoena risk, encryption) has to clear for whichever
  STT/TTS vendor is chosen before this touches a real call.

## Paralegal drafting agent

`src/paralegal/drafting.ts` — `ParalegalDraftingSession`, the practice-
area-agnostic drafting engine (§3, §8 build order step 4). It owns no
legal-content knowledge itself, only the hard-coded behaviors §3 requires
of every practice area:

- every draft is access-controlled via `AccessControl` before creation
  (`case_file` for template drafts/research, `billing_internal` for
  billing narratives)
- every draft is a `WorkProduct`, so nothing it produces can leave the
  system without the review-gate's attorney checkpoint
- `draftResearchSummary()` unconditionally adds
  `RESEARCH_REQUIRES_VERIFICATION_FLAG` — not module-configurable
- any draft passed a `deadlineDate` unconditionally adds
  `DEADLINE_REQUIRES_REDUNDANT_VERIFICATION_FLAG` and records the
  calculation with `core/deadline.ts`'s `DeadlineTracker` — see below
- practice-area-specific hard triggers (Padilla, protective-order) are
  applied via `PracticeAreaModule.deriveWorkProductFlags()`

`src/core/document-store.ts` — `DocumentStore`, a registry of uploaded
case documents (a contract, exhibit, or scanned form a paralegal names and
stores against a matter) — separate from `WorkProductStore`'s
agent-drafted text. Content is stored as a base64 string directly on the
record, matching this project's single-JSON-blob persistence model, so
`toSnapshot()`/`fromSnapshot()` round-trip a document like every other
stateful core object. No access control lives here, same split as
`WorkProductStore`.

`src/review-ui/documents-service.ts` — `DocumentsService`, the paralegal/
attorney-facing surface backing the Cases panel's upload/download. Same
shape as `DraftingService`: every method (`listMatterDocuments`, `upload`,
`getWithContent`, `delete`) authorizes the matter via `AccessControl`
before touching the store, since a document is exposed over HTTP by
matter id/document id that any authenticated caller could otherwise name
arbitrarily.

`src/review-ui/cases-service.ts` — `CasesService`, a read-only
aggregation backing the "Cases" panel: a clickable list of matters (there
is no separate `Matter` entity anywhere in this system — a matter is just
the `matterId` string that `WorkProductStore`, `DocumentStore`, and
`AccessControl`'s paralegal assignments all key on) with `listCases()`,
each expanding via `getCase()` into everything on file for it — drafted
work product plus uploaded documents, side by side. It derives the
visible matter-id set from the union of `WorkProductStore`/`DocumentStore`
entries and `AccessControl.listAssignments()`, then filters to what the
calling actor can see (all of them for an attorney; only their own
assigned matter for a paralegal, via the same `authorize()` check
`DraftingService`/`DocumentsService` use). It adds no new write paths of
its own.

`src/review-ui/drafting-service.ts` — `DraftingService`, the HTTP-facing
wrapper backing Docket's "Drafting" panel (where a paralegal actually
writes up contracts, motions, discovery requests, research summaries, and
billing narratives, then submits them). `ParalegalDraftingSession`'s
`reviseDraft`/`submitForReview` take a `WorkProduct` object reference
directly — safe in-process, but exposed over HTTP by id instead, any
authenticated caller could name an arbitrary work-product id, so this
service adds its own `AccessControl` check (matching the draft's matterId
against the caller's assignment) before ever calling into the drafting
session. A `ParalegalDraftingSession` is cached per (actor, matter) pair
and reused across requests, since `submitForReview`'s utilization-entry
bookkeeping only finishes correctly if the same session instance saw the
`start` from creation.

## Scheduling

`src/core/scheduling.ts` — `SchedulingService`, §2's "Schedule/reschedule
consultations, send reminders." Practice-area-agnostic, same pattern as
the rest of core:

- Books a `consultation`/`follow_up` `Appointment`, auto-assigning an
  attorney from `FirmConfig.attorneys` by matching `practiceAreaIds` (or
  accepts an explicit `attorneyId`) — falls back to the firm's first
  attorney if no practice-area match exists, throws if the firm has none.
- Rejects a booking or reschedule outside `isWithinBusinessHours()` unless
  `allowOutsideBusinessHours` is explicitly passed (e.g. an emergency
  follow-up) — reuses `firm-config.ts`'s business-hours check rather than
  duplicating the logic.
- Prevents double-booking: refuses to schedule/reschedule an attorney into
  a time slot that overlaps one of their existing (non-cancelled)
  appointments.
- Computes reminder due-times (default: 24h and 1h before) as plain data —
  `getDueReminders()` returns what's due right now for a host process to
  poll and actually send (email/SMS is a vendor integration, deliberately
  out of scope, same reasoning as `voice-agent.ts` staying vendor-agnostic
  for STT/TTS).
- Optionally enforces `AccessControl`'s existing `"scheduling"` category
  when constructed with one — receptionist role is already scoped to
  `intake`/`scheduling` fields (§5), so this reuses that gate rather than
  inventing a new one.
- `toSnapshot()`/`fromSnapshot()` follow the same persistence pattern as
  every other stateful core object — wired into `system-state.ts` and the
  dashboard's "Scheduling" panel.

## Deadline redundancy (§7 open item #1 — resolved)

`src/core/deadline.ts` — `DeadlineTracker`. §3: "Deadline calculations are
never single-sourced... agent-calculated dates require redundant human/
calendar-system verification." A deadline (`speedy_trial`, `arraignment`,
`bail_hearing`, `discovery_response`, `other`) only reaches `"confirmed"`
once *two independent sources* (`agent`, `human`, `calendar_system`) agree
on the same date — a single source, however many times recorded, stays
`"unconfirmed"`. If independent sources disagree, that's `"conflict"`:
surfaced immediately via `listConflicts()`, never silently resolved by
picking one.

This isn't just advisory — `ReviewGateService.clearFlag()` refuses to
clear `DEADLINE_REQUIRES_REDUNDANT_VERIFICATION_FLAG` unless
`DeadlineTracker.isConfirmed()` is actually true for the matter/type in
question (requiring a `deadlineType` parameter on that call specifically).
`confirmDeadline()` is how the independent human/calendar-system side gets
recorded — it rejects `source: "agent"` outright, since that path exists
to be the second, non-agent source, and it enforces *who* may record
*which* source (see "Real authentication" below): a `"human"`
confirmation requires an attorney session, a `"calendar_system"`
confirmation requires the calendar integration's own credential — an
attorney cannot self-report as the calendar system. The dashboard's
"Deadlines" panel exposes both the status check and the confirm action.

## Google Calendar integration (§7 item #1's remaining piece — resolved)

`src/integrations/` — the real vendor behind the `calendar_system`
credential, chosen as Google (the firm's email/calendar platform).
Read-only and deliberately narrow: it can only *confirm* deadlines that
independently appear on a shared calendar, never write to or alter
`DeadlineTracker` any other way.

- `calendar-events-source.ts` — `CalendarEventsSource`, the vendor-
  agnostic interface (one method: `listDeadlineEvents()`). A firm on
  Outlook/Exchange would implement this interface instead of
  `google-calendar.ts`; nothing else in this layer is Google-specific.
- `google-calendar.ts` — `GoogleCalendarEventsSource`, the real Google
  Calendar v3 API client. Service-account auth only (the firm shares one
  calendar with the service account's email — no Google Workspace
  domain-wide delegation, no per-attorney OAuth), hand-rolled as a JWT
  bearer flow via `node:crypto` + `fetch` rather than pulling in
  `googleapis`/`google-auth-library`, matching this project's
  dependency-light style (`server.ts` is dependency-free; `pg` was the
  one justified exception). Only events explicitly tagged
  `extendedProperties.private.matterId`/`.deadlineType` (Google
  Calendar's structured per-event data, not free-text titles/
  descriptions) are treated as deadline confirmations — guessing wrong
  here would mean confirming the wrong deadline. `parseDeadlineEvent()`
  is exported specifically so the parsing rules are unit-testable
  without a live Google Calendar.
- `calendar-deadline-sync.ts` — `CalendarDeadlineSync`, the practice-
  area/vendor-agnostic engine: reads events from whatever
  `CalendarEventsSource` is configured and confirms each one against
  Docket's own HTTP API using the `x-system-api-key` credential — the
  same way any other API client would, never a shortcut straight into
  `DeadlineTracker`. A per-event failure (wrong key, network error, a
  date disagreement producing a `conflict`) is recorded per-event rather
  than aborting the whole run.
- `sync-calendar-deadlines.ts` — the standalone entry point (`npm run
  sync:calendar`), deliberately outside the main Docket server process —
  same reasoning as scheduling reminders staying "for a host process to
  poll and actually send." Meant to run on its own schedule (e.g. a cron
  job) against `GOOGLE_SERVICE_ACCOUNT_EMAIL`/
  `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`/`GOOGLE_CALENDAR_ID` and
  `DOCKET_BASE_URL`/`DOCKET_SYSTEM_API_KEY`.

What this doesn't do: automate *rotating* the system API key (Google
service-account keys are rotated by regenerating a new key file and
updating `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`/`CALENDAR_SYSTEM_API_KEY`
by hand), and it doesn't complete §5's vendor due-diligence checklist
(zero-retention, no training on firm data, storage jurisdiction, subpoena
risk, encryption) for Google Calendar specifically — that's the firm's
decision to make about the vendor, separate from this technical
integration. It also doesn't sync the other direction: `Appointment`s
from `core/scheduling.ts` aren't pushed to Google Calendar as events —
that would be a separate, additive piece if wanted later.

## Voicebox voice integration (§8 build order step 6's remaining piece — resolved)

`src/integrations/voicebox.ts` — `VoiceboxSpeechToText`/
`VoiceboxTextToSpeech`, the real vendor behind `voice-agent.ts`'s
vendor-agnostic `SpeechToText`/`TextToSpeech` interfaces, chosen as
Voicebox (https://voicebox.sh). `voice-agent.ts` itself needed **no
changes** — that's the payoff of keeping those interfaces vendor-
agnostic from the start.

Voicebox is architecturally different from a cloud STT/TTS vendor worth
being explicit about: it's a local, open-source voice studio (Whisper for
transcription, cloned voices for synthesis) that runs its own REST API on
the *same machine* by default (`http://127.0.0.1:17493`), not a hosted
service reached with a per-request API key.

- §5's due-diligence checklist (zero-retention, no training on firm data,
  storage jurisdiction, subpoena risk) is close to moot in the strongest
  possible sense here — audio never leaves the machine running Voicebox,
  so there's no third-party retention/training/jurisdiction surface to
  review — but that's *because* there's no managed vendor with an SLA
  behind it, not a substitute for one.
- Whatever process handles real calls and the Voicebox process must be
  co-located or reachable over a trusted private network; `baseUrl` is
  configurable specifically so this isn't hardcoded to localhost, but
  exposing Voicebox beyond localhost is a network-security decision this
  class doesn't make for you.
- `VoiceboxSpeechToText.transcribe()`/`VoiceboxTextToSpeech.synthesize()`
  narrow the interfaces' opaque `unknown` audio type to a concrete shape
  this adapter expects (`{ data: Buffer, mimeType: string }` in,
  `Buffer` out) — whatever eventually captures/plays real call audio has
  to agree on that shape, since the interface itself stays intentionally
  opaque.
- The `/generate` (TTS) request shape is confirmed against Voicebox's
  public docs; the `/transcribe` (STT) endpoint is written best-effort —
  this sandbox's network policy blocked fetching `docs.voicebox.sh`
  directly while building this, so confirm the exact path/payload against
  a running instance's own interactive docs (`<baseUrl>/docs`) before
  pointing this at a real call.
- Voicebox is a young, single-machine, single-process tool, not something
  with the concurrency/uptime guarantees a live phone line needs — that
  tradeoff is inherent to the vendor choice, not something this adapter
  can paper over.

## Telephony integration — Twilio (§8 build order step 6, fully resolved)

A real phone call now reaches `VoiceReceptionistSession` end to end,
closing the last piece of the voice channel. Twilio was chosen as the
carrier (the industry-standard telephony API); nothing about the design
is Twilio-specific beyond `src/integrations/twilio-voice.ts` itself.

- `src/receptionist/audio-clip-store.ts` — `AudioClipStore`, a short-TTL
  (default 10 min) in-memory map from a random clip id to synthesized
  audio bytes. Exists because Twilio's `<Play>` verb takes a fetchable
  URL, not inline audio in the webhook response — this is what that URL
  resolves to. Deliberately not persisted, same "throwaway call state"
  reasoning as `intake-demo.ts`.
- `src/receptionist/voice-call-sessions.ts` — `VoiceCallSessions`, the
  real-call analogue of `review-ui/intake-demo.ts`'s `IntakeDemoSessions`:
  one `VoiceReceptionistSession` per live call, keyed by the carrier's
  call id (Twilio's `CallSid`). Vendor-agnostic — it knows nothing about
  Twilio, only that some caller identifies a call by a string.
- `src/integrations/twilio-voice.ts` — the only Twilio-specific code:
  `verifyTwilioSignature()` (HMAC-SHA1 over the exact webhook URL plus
  sorted POST params, per Twilio's own algorithm, timing-safe comparison,
  fails closed on a missing/wrong signature), `twimlPlayThenRecord()`/
  `twimlPlayThenHangup()` (the TwiML XML Twilio expects back), and
  `downloadTwilioRecording()` (Basic-auth GET of a completed recording as
  WAV bytes).
- `server.ts`'s `handleVoiceRequest()` wires it together as
  `/api/voice/twilio/incoming` (answers a new call: greet via Voicebox
  TTS, `<Play>` it, `<Record>` the caller's reply) and
  `/api/voice/twilio/:callSid/recording` (download the recording,
  transcribe via Voicebox STT, drive one `VoiceReceptionistSession` turn,
  `<Play>` the reply, loop or `<Hangup>` if the conversation is done), plus
  `/api/voice/audio/:clipId` (GET, serves a stored clip). These routes are
  handled **before** the normal cookie/`x-system-api-key` actor
  resolution — a Twilio webhook isn't a Docket user session, so
  `verifyTwilioSignature()` is the entire auth story for the two
  `/api/voice/twilio/*` routes. `/api/voice/audio/:clipId` is
  intentionally public (Twilio's own media-fetching requests aren't
  signed either) but only ever serves a short-lived, 128-bit random clip
  id. Any failure partway through either webhook (Voicebox unreachable, a
  bad recording download, an unexpected exception) falls back to Twilio's
  *own* built-in `<Say>`+`<Hangup>` — the one deliberate exception to
  "never use the carrier's TTS," reserved for not stranding a caller
  silently when the real pipeline breaks.
- `review-ui/start.ts` wires `VoiceCallSessions`/`AudioClipStore`/the
  Twilio config into the server only when `TWILIO_ACCOUNT_SID`/
  `TWILIO_AUTH_TOKEN`/`PUBLIC_BASE_URL` are all set — `/api/voice/*` 404s
  otherwise, same "absent config means the surface doesn't exist" pattern
  as every other optional panel. `VOICEBOX_BASE_URL`/`VOICEBOX_PROFILE_ID`
  are optional and fall through to `voicebox.ts`'s own defaults.

To actually go live: point a Twilio phone number's "A call comes in"
voice webhook (in the Twilio console) at
`<PUBLIC_BASE_URL>/api/voice/twilio/incoming` — that's a Twilio-side
console configuration step, not something this codebase can do for you.

`createReviewServer`'s signature changed as part of this: it now takes a
single `ReviewServerOptions` object (`{ scheduling?, intake?, accounts?,
drafting?, documents?, cases?, audit?, research?, voiceCalls?,
audioClips?, twilio?, onMutated?, trustProxy? }`) instead of a long
positional-parameter list. That list had grown past a dozen optional
pieces and a purely positional signature that long had already caused
real bugs more than once — inserting a new parameter silently shifted
every later positional argument in existing call sites, with no type
error since they're all optional. A missing or misspelled option key is
a much safer failure mode than a silent off-by-one.

## Legal research — CourtListener (resolved)

`src/core/research-library.ts` / `src/integrations/courtlistener.ts` /
`src/review-ui/research-service.ts` — the "Research" panel: a paralegal
or attorney can search real case law and keep a quick-access list of
citations saved against a matter. Two deliberately separate pieces, per
the two different things "look up a law" and "relevant cases" turned out
to mean:

- **Search** (`integrations/courtlistener.ts` — `CourtListenerClient`) —
  general case-law search against CourtListener (courtlistener.com, the
  Free Law Project's public API), not scoped to any matter. Chosen
  because it's a genuine external case-law database with a free API,
  unlike Westlaw/Lexis-style products this project can't provision
  credentials for. Case law is public record, so there's no §5-style
  confidentiality/subpoena due-diligence question the way there is for
  STT/TTS or calendar vendors — the only caveat is accuracy, which the
  Research panel says outright: a search result is not a verified
  citation. `parseSearchResult()` is exported for testing the
  response-parsing rules in isolation, same pattern as
  `google-calendar.ts`'s `parseDeadlineEvent()` — this sandbox's network
  policy blocked reaching `courtlistener.com` directly while building
  this (same constraint as `docs.voicebox.sh`), so the exact response
  field names are written from documented/training knowledge and are
  best-effort, not verified against a live call.
- **Quick access** (`core/research-library.ts` — `ResearchLibrary`) — a
  registry of references someone explicitly saved against a matter.
  Deliberately manual only (no auto-suggested "relevant cases" from
  search text): saving is always a human action, consistent with this
  project not inferring which case matters to which matter on its own.
  A saved reference is a bookmark, not agent-generated text, so it never
  touches the review-gate — it's a research aid, not something delivered
  to a client. Persisted like every other stateful core object.
- `research-service.ts` — `ResearchService`, same shape as
  `DocumentsService`: `search()` is role-gated (paralegal/attorney) but
  not matter-scoped (nothing to authorize per-matter for a public case-law
  search); `listMatterReferences()`/`saveReference()`/`deleteReference()`
  additionally authorize via `AccessControl` before touching the library,
  since a reference is exposed over HTTP by matter id/reference id that
  any authenticated caller could otherwise name arbitrarily.
- `server.ts` wires it as `GET /api/research/search?q=...` and
  `GET|POST /api/research/matters/:matterId` /
  `DELETE /api/research/matters/:matterId/:id`; `COURTLISTENER_API_TOKEN`
  is optional (search works unauthenticated, just at a lower rate limit)
  and `COURTLISTENER_BASE_URL` exists purely for pointing at something
  other than the real CourtListener (used to verify this against a fake
  local server, since the real one isn't reachable from this sandbox).

## AI Assistant — Claude (resolved)

`src/integrations/anthropic.ts` / `src/assistant/` / `src/review-ui/
assistant-service.ts` — Docket's internal "Assistant" panel: a
tool-calling AI assistant for attorneys/paralegals, powered by the real
Claude API. Distinct from the client-facing receptionist agent
(`receptionist/chat-agent.ts`) — this one is staff-only and never talks
to a caller.

The central design constraint, straight from this project's non-negotiable
rule (§1): **the assistant is never more privileged than the human it's
acting for, and it can never be the human checkpoint itself.**

- `integrations/anthropic.ts` — `AnthropicClient`, a real, high-confidence
  Messages API client (hand-rolled via `fetch`, no SDK dependency, same
  reasoning as every other integration here). `DEFAULT_MODEL` is
  `claude-sonnet-5`, per this project's own guidance to default new AI
  applications to the latest, most capable Claude model — override with
  `ANTHROPIC_MODEL`. `ClaudeClient` is the vendor-agnostic interface
  `AssistantSession` actually depends on (same pattern as
  `SpeechToText`/`CaseLawSearchClient`), so tests use a scripted fake
  instead of a real network call.
- `assistant/tools.ts` — `createAssistantTools()`, the assistant's entire
  capability surface. Every tool is a thin wrapper calling straight into
  the same `DraftingService`/`DocumentsService`/`CasesService`/
  `ResearchService`/`SchedulingService`/`ReviewGateService` (read-only
  methods) the ordinary Docket panels already use — the executor passes
  the actor straight through, so `AccessControl`'s matter-scoping applies
  exactly as it does everywhere else. **Deliberately and permanently
  absent, regardless of the actor's role:** `approve`/`reject`/
  `request-revision`/`release`/`clear-flag` (the review-gate's human
  checkpoint), deadline *confirmation* (the redundant-verification
  requirement an LLM tool-call would defeat by design), and all account
  management. The assistant can draft, revise, submit for review,
  research, and schedule — it can never be the second, independent
  signature on its own work.
- `assistant/assistant-session.ts` — `AssistantSession`, the tool-calling
  loop: send the conversation + tool definitions to Claude, execute any
  `tool_use` blocks against the real services, feed `tool_result`s back,
  repeat until Claude returns plain text (bounded by
  `MAX_TOOL_ITERATIONS` — a real circuit breaker against a runaway loop
  against a metered API). Every successfully executed tool call is
  logged to the real `AuditLog` as `assistant_tool_call`, on top of
  whatever access-grant/denial entries the underlying service call
  already produces — so an attorney can review exactly what the
  assistant did, and for whom, in the same Audit Log panel as everything
  else. `DEFAULT_SYSTEM_PROMPT` states the hard limits above explicitly
  rather than relying on the tool list alone to communicate them.
- `review-ui/assistant-service.ts` — `AssistantService`, backing the
  panel: role-gated to paralegal/attorney (not receptionist-accessible —
  that's the separate agent's job). Sessions are in-memory and ephemeral
  (never persisted to `system-state.ts` — a conversation is a scratch
  workspace, not a case record) and bound to the actor that created them,
  checked on every message, so one authenticated user can't guess
  another's session id and read or continue their conversation — worth
  the extra check specifically here since a conversation can touch
  multiple matters' content over its lifetime, unlike a single-purpose
  demo session.
- `server.ts` wires it as `POST /api/assistant/start` /
  `POST /api/assistant/:id/message` / `POST /api/assistant/:id/end`; only
  configured when `ANTHROPIC_API_KEY` is set, `/api/assistant/*` 404s
  otherwise. `ANTHROPIC_MODEL`/`ANTHROPIC_BASE_URL` are optional
  overrides (the latter used to verify this against a fake local
  Claude-compatible server during development).

What this doesn't do: give the assistant any tool a logged-in user
couldn't already reach themselves, let it act without the same
`AccessControl` checks the rest of the app enforces, or let it touch the
review-gate/deadline-confirmation/account-management surfaces under any
circumstance. It also doesn't persist conversation history across a
server restart — that's a deliberate scope line (ephemeral scratch
workspace), not an oversight, matching `intake-demo.ts`'s reasoning.

## Staff directory, messaging, staff schedule, and billing hours (resolved)

Four small, related additions, all internal-only (never client-facing, so
none of them touch the review-gate): who's on the team, how they talk to
each other, when they're in the office, and how they log billable time.

- `core/auth.ts` — `User` gained a `displayName` field (a person's full
  name, defaulting to `username` if never set) via `createUser({..,
  displayName })`. Initials (for avatars in Staff/Messages) are always
  derived from it at read time, never stored — see `initialsFor()` below.
- `review-ui/staff-service.ts` — `StaffService`, backing the "Staff"
  panel: a read-only directory of every account (username, display name,
  initials, role, disabled status, and a paralegal's current matter
  assignment) via `AuthService.listUsers()`/`AccessControl
  .getParalegalAssignment()`. Open to every logged-in human (messaging
  and scheduling both need "who else exists in the system" to address);
  denies only the `"system"` machine credential, which is never created
  via `createUser` and so can never appear here anyway.
  `initialsFor(displayName)` is exported standalone since it's a pure
  presentation-layer function: a single-word name takes its first two
  characters, a multi-word name takes the first letter of the first and
  last words, both uppercased.
- `core/messaging.ts` / `review-ui/messaging-service.ts` — internal
  staff chat, backing the "Messages" panel. `MessagingStore` (core) knows
  three `Conversation` kinds: `"direct"` (exactly two participants,
  created lazily the first time one actor messages another and reused
  after that), `"group"` (named, explicit member list, creator can
  add/remove others, any member can leave), and `"announcement"` — a
  single well-known conversation (`ANNOUNCEMENTS_CONVERSATION_ID`) that
  always exists with no membership list at all: every authenticated
  human can both read *and post* to it. That's a deliberate design
  choice, not an oversight — the feature request named no restriction on
  who can announce, so this system has no separate "who can announce"
  role, unlike the review-gate's attorney-only checkpoint. `Messaging
  Service` is the actual access gate (direct/group conversations require
  participancy; announcements don't) plus display-name enrichment via
  `AuthService`, since a raw `actorId` means nothing in the UI.
- `core/staff-schedule.ts` / `review-ui/staff-schedule-service.ts` —
  who's in the office/remote/out, one entry per (actor, date), backing
  the "Schedule" panel. Deliberately separate from `core/scheduling.ts`'s
  `SchedulingService`, which books client consultations — this tracks
  the staff's own whereabouts, not client-facing appointments. Read
  access is open to every logged-in human (the point is everyone can see
  who's in when); write access is narrower — anyone can set their own
  day, but only an attorney can set someone else's, the same
  self-service-vs-attorney-gated split as password change vs. password
  reset.
- `core/billing-hours.ts` / `review-ui/billing-hours-service.ts` —
  billable-hours entries a lawyer or paralegal logs against a matter,
  backing the "Billing" panel. Deliberately distinct from
  `core/utilization.ts`'s `UtilizationTracker`, which is internal
  AI-utilization telemetry explicitly walled off from client billing —
  this is the actual human timekeeping record that would feed a client
  invoice (generating the invoice itself is out of scope, same reasoning
  as scheduling reminders/calendar sync staying "for a host process to
  poll and actually send/run"). Same shape as `DocumentsService`: every
  method authorizes the matter via `AccessControl`'s existing
  `"billing_internal"` category before touching the store, since an
  entry is exposed over HTTP by matter id/entry id that any
  authenticated caller could otherwise name arbitrarily.
- `server.ts` wires these as `GET /api/staff`; `GET|POST /api/messages/
  conversations`, `POST /api/messages/conversations/direct`,
  `POST /api/messages/conversations/group`, `GET|POST /api/messages/
  conversations/:id/messages`, `POST|DELETE /api/messages/conversations/
  :id/members[/:actorId]`, and `GET|POST /api/messages/announcements`;
  `GET|POST /api/staff-schedule/actor/:actorId`, `DELETE /api/
  staff-schedule/actor/:actorId/:date`, and `GET /api/staff-schedule/
  date/:date`; and `GET /api/billing-hours/mine` plus `GET|POST /api/
  billing-hours/matters/:matterId` / `DELETE /api/billing-hours/matters/
  :matterId/:id` — each 404s if the corresponding service wasn't passed
  to `createReviewServer`, same "absent config means the surface doesn't
  exist" pattern as every other optional panel.
- All four stores persist through the same `toSnapshot()`/
  `fromSnapshot()` pattern as everything else — see "Persistence" below.

What this doesn't do: give an announcement poster any special role check
(intentional, per above), push staff-schedule entries anywhere external
(e.g. no calendar sync, unlike deadline confirmation), or generate an
actual client invoice from logged billing hours — it's the timekeeping
record, not the billing pipeline.

## PDF intake, document-report drafting, and PDF condensing (resolved)

A place to insert PDF files, have them read, and get a draft report out
the other side — plus a way to shrink a PDF's size. Both are built on
top of already-uploaded documents (`core/document-store.ts`), not a
separate upload surface.

- `integrations/pdf-text.ts` — `PdfTextExtractor`/`PdfParseTextExtractor`,
  a vendor-agnostic interface (same pattern as `CaseLawSearchClient`/
  `ClaudeClient`) over `pdf-parse`. `pdf-parse` and `pdf-lib` (below) are
  deliberate, justified exceptions to this project's dependency-light
  style — same reasoning as `pg` being the one earlier exception:
  reimplementing PDF text extraction or object-stream rewriting from
  scratch isn't a reasonable ask. `pdf-parse` only reads a PDF's real
  text layer — it does **not** OCR scanned/image-only pages, so those
  come back with little or no text.
- `paralegal/drafting.ts` — `ParalegalDraftingSession.draftDocumentReport()`
  wraps extracted text into a `document_report`-kind `WorkProduct`,
  unconditionally carrying `PDF_EXTRACTION_REQUIRES_VERIFICATION_FLAG` —
  same unconditional-flag pattern as `RESEARCH_REQUIRES_VERIFICATION_FLAG`,
  since extracted text can be wrong, incomplete, or (for a scanned page)
  entirely absent. `review-ui/drafting-service.ts` exposes it the same
  way as `draftResearchSummary`/`draftBillingNarrative`.
- `integrations/pdf-condenser.ts` — `PdfCondenser`/`PdfLibCondenser`, over
  `pdf-lib`: reloads a PDF, strips its metadata (title/author/subject/
  keywords/creator/producer), and re-saves with compressed object
  streams. This meaningfully shrinks PDFs with many small objects
  (exported from word processors, form-heavy documents) but does **not**
  recompress or downsample embedded images — a scanned, image-heavy PDF
  will see little to no reduction. Real image recompression needs an
  image codec or an external tool (e.g. Ghostscript), deliberately out
  of scope, the same "not a substitute for a real tool" caveat this
  project already gives Voicebox/CourtListener for their own limits.
- `review-ui/pdf-report-service.ts` — `PdfReportService`, backing the
  Cases panel's "Draft report from this PDF" and "Condense" buttons on
  any uploaded PDF. Deliberately a thin composition over `DocumentsService`
  (already the access-controlled gate on a matter's uploaded files) and
  `DraftingService` (already the access-controlled gate on drafting) —
  it adds no `AccessControl` checks of its own beyond a role check, since
  every store access already goes through one of those two services.
  Condensing never overwrites the original file — it uploads the
  condensed bytes as a *new* document named `<original> (condensed).pdf`,
  same reasoning as `reviseDraft` never mutating an already-submitted
  `WorkProduct` in place.
- `server.ts` wires this as `POST /api/pdf-reports/matters/:matterId/:documentId/draft-report`
  and `POST /api/pdf-reports/matters/:matterId/:documentId/condense`
  (404 if no `PdfReportService` was passed to `createReviewServer`), plus
  `GET /api/documents/limits` (see storage capacity below).

**Storage capacity.** Every uploaded file's base64 content lives inline
in the single JSON document this whole project persists as (see
"Persistence" below) — there's no separate filesystem/object-store path.
That means an unbounded upload doesn't just cost disk: `onMutated`
rewrites the *entire* state blob on every mutation, so a huge file makes
every other request slower too, and both backends have their own hard
ceiling regardless:

- **File-backed (default)**: bounded by available disk plus Node's
  in-memory string/JSON limits — practically, tens of MB total is
  comfortable; hundreds of MB starts costing real latency on every
  request; there's no enforced ceiling from Node itself until you're
  well past what this architecture is meant for.
- **Postgres-backed**: the entire state document is one `JSONB` value
  (see `postgres-store.ts`), and Postgres hard-caps a single `JSONB`
  value at **1 GB** — that's a hard ceiling on the *sum* of every
  document, work product, message, and everything else this project
  persists, not just PDFs.

Given that, `DocumentsService` enforces a **25 MB per-file** upload cap
by default (`DEFAULT_MAX_UPLOAD_BYTES` in `documents-service.ts`) —
generous for a scanned contract or brief, nowhere near either backend's
ceiling even with many files, and it rules out someone uploading
something the architecture was never meant to hold (a video, a database
dump). It's configurable via `MAX_DOCUMENT_UPLOAD_BYTES` in `start.ts`
for a firm on Postgres with real headroom that wants it higher — but
raising it doesn't raise Postgres's 1 GB *total* ceiling, it only changes
how much of that ceiling one file can claim. `GET /api/documents/limits`
surfaces the configured number to the UI so a paralegal/attorney sees it
before trying to upload something over it, rather than discovering the
cap by having an upload rejected.

That per-file cap is not itself a defense against a hostile client,
though: it runs inside `DocumentsService`, *after* `server.ts` has
already buffered the whole request body in memory. The actual bound is
`ReviewServerOptions.maxRequestBodyBytes` — enforced in `readBodyBuffer`
on every route, including the unauthenticated ones (`/api/login`, the
Twilio webhooks), rejecting with `413` both on a declared
`Content-Length` and on the bytes that actually arrive (a chunked
request declares no length). `start.ts` derives it from the configured
upload cap via `maxRequestBodyBytesFor()` — base64 inflates by 4/3, plus
slack for the JSON envelope — so raising `MAX_DOCUMENT_UPLOAD_BYTES`
raises the transport ceiling with it instead of leaving legitimate
uploads rejected.

What none of this does: OCR a scanned PDF (so `draftDocumentReport` on
one will legitimately have little or nothing to summarize — the
unconditional verification flag is exactly the safety net for that), or
recompress embedded images when condensing (see `pdf-condenser.ts`'s doc
comment above) — a scanned, image-heavy PDF condenses poorly by design,
not by bug.

## Matters and conflict-of-interest screening

The one thing a law firm is *ethically obliged* to get right before
taking on work, and the biggest domain gap this project had: conflicts
screening ran as `lowered.includes(name)` against a hardcoded list
passed into the chat session, and there was no firm-wide record of who
any client or adversary actually was.

- `core/matters.ts` — `MatterStore`. Until now a "matter" was just a
  `matterId` string that `WorkProductStore`/`DocumentStore`/
  `BillingHoursStore`/`AccessControl` happened to key on. A `Matter`
  record adds what screening needs: title, status
  (`prospective`/`open`/`closed`), responsible attorney, and **parties**
  with a `client`/`adverse`/`related` role. Deliberately keyed on the
  same `matterId` string rather than a new primary key, so every
  existing store keeps working untouched and a matter can still be
  referenced before its record is filled in. A record here is
  *descriptive* — `AccessControl` remains the only thing deciding who
  can see what.
- `core/conflicts.ts` — `ConflictChecker`. Screens names against every
  matter in the firm, because **ABA Model Rule 1.10 imputes one
  lawyer's conflict to the whole firm** — a check scoped to the
  caller's own matters would return a dangerously clean answer.
  Classifies hits as `direct` (Rule 1.7, adverse to a current client),
  `former_client` (Rule 1.9, adverse to a closed matter — turns on
  whether the matters are substantially related, which is an attorney's
  call, not the software's), `same_side`, or `informational`.
  - **It deliberately over-matches.** A false positive costs a minute of
    reading; a false negative is a rule violation and possibly
    disqualification. `normalizeName()` handles the shapes intake
    actually produces — `"SMITH, John Q."` vs `"john smith"`, honorifics
    and generational/professional suffixes, diacritics, and entity
    suffixes so `"Acme, Inc."` and `"ACME Corporation"` are one
    adversary. `compareNames()` grades a match `exact` / `strong`
    (subset-of-tokens, so a middle name doesn't defeat it) / `possible`
    (same surname and first initial) so a human can triage.
  - Nothing auto-clears. The result is an input to an attorney's
    judgement, the same philosophy as the review gate.
- `review-ui/matters-service.ts` — two *different* access shapes on
  purpose. Matter records are matter-scoped like everything else (a
  paralegal sees only their assigned matter), and **editing one is
  attorney-only**, since those party fields are the input to every
  future check — letting them be edited more widely would let someone
  quietly weaken the firm's screening. Conflict *checking* is
  deliberately not matter-scoped, per Rule 1.10 above; the result is
  limited to what discharging the duty requires (which matter, its
  title/status, the matching party), and **every check is audited**,
  because being able to show that a check was run, by whom, over which
  names, is itself part of the obligation.
- `receptionist/chat-agent.ts` now runs the real firm-wide screen at the
  conflict gate, OR'd with the legacy literal-name list — never instead
  of it. `signal-extraction.ts`'s `extractCandidatePartyNames()` pulls
  capitalized runs out of the caller's answer (falling back to the whole
  answer when nothing is capitalized, so an all-lower-case typist is
  still screened).
  - Candidates are screened as **adverse**, because that's the reading
    that actually stops an intake: screening them as "client" would only
    ever yield same-side/informational hits, which by design don't
    block, so a real Rule 1.7 conflict would sail straight through. The
    accepted cost is that an existing client who names themselves here
    can trip the gate and get handed to an attorney — the safe direction
    to be wrong, and the same tradeoff `signal-extraction.ts` already
    makes for escalation triggers.
- `server.ts` wires `GET /api/matters`, `GET|PUT /api/matters/:matterId`
  and `POST /api/conflicts/check` (404 if no `MattersService` was
  passed). The UI is the "Conflicts" panel: run a check, read the hits
  with their rule citations, and maintain the matter records that make
  screening work.

What this does **not** do: decide whether a conflict is waivable, judge
whether two matters are "substantially related" under Rule 1.9, or know
anything about matters the firm never wrote down — the panel says that
last part out loud on a clean result, rather than implying an all-clear.

## Client trust accounting (IOLTA) and client-file export

Two duties that sit outside the review-gate model but get the same
treatment: enforced in code, not asked of a human.

- `core/trust-ledger.ts` — `TrustLedger`. Client funds held in trust are
  not the firm's money, and mishandling them is among the fastest routes
  to disbarment there is. Three invariants are structural, with no
  configuration knob:
  1. **A matter's balance can never go below zero.** A negative
     sub-ledger means one client's funds paid another client's costs —
     the cardinal violation, and the reason this file exists rather than
     a spreadsheet. Enforced in `#append`, so no route, assistant tool
     call, or future integration can route around it.
  2. **Entries are immutable.** A mistake is corrected with a reversing
     entry (`reverse()`), never an edit or delete — same append-only
     reasoning as `audit.ts`. A ledger you can quietly edit is not
     evidence of anything. Reversals are themselves subject to the
     no-overdraw rule, and can't be double-applied or reversed.
  3. **Money is integer cents.** Floats lose fractions of a cent and a
     trust ledger that doesn't reconcile to the penny is an audit
     finding. The UI converts once, at the input edge.
  `reconcile(bankBalanceCents)` is the ledger side of a three-way
  reconciliation: the sum of every client sub-ledger must equal the
  actual bank balance, and a difference is reported exactly rather than
  rounded away.
- `review-ui/trust-service.ts` — two gates for two risks. Matter scoping
  reuses `AccessControl`'s `billing_internal` category (as billing hours
  does), and **money leaving the account is attorney-only**: recording an
  incoming deposit is bookkeeping a paralegal can do, but a
  disbursement, an earned-fee transfer, a refund, or a reversal all move
  client funds and in practice need an authorized signer.
  Reconciliation is attorney-only too — it deliberately exposes every
  matter's balance at once. Every call is audited; a trust ledger's value
  is evidentiary.
  `server.ts` wires `GET|POST /api/trust/matters/:matterId`,
  `POST /api/trust/matters/:matterId/:entryId/reverse`, and
  `POST /api/trust/reconcile`. An overdraw returns **409**, not 400 — it
  is a conflict with the ledger's current state, not a malformed request.
- `review-ui/client-file-service.ts` — `ClientFileService`. **The client
  file belongs to the client**, and a firm that can only produce it by
  trawling six stores produces it late and incomplete, so
  `GET /api/client-file/:matterId` bundles the matter record, work
  product, documents, research references, billing hours and trust
  ledger into one downloadable file. Attorney-only, because deciding
  what to produce has privilege implications, and audited with a count
  of what left.

What none of this does: bookkeeping, bank integration, or the firm's
actual reconciliation duty (it can tell you the ledger and the bank
disagree; it cannot tell you the bank balance). It doesn't know your
jurisdiction's rules on retainers, interest, or unclaimed funds. And the
export deliberately **does not** decide what a client is legally entitled
to — jurisdictions differ on whether internal work product forms part of
the client file and whether a retaining lien applies, so the bundle
carries a notice telling the attorney to review and withhold rather than
pretending the question is settled.

## Invoicing, payments, and staff payroll

Three money surfaces, deliberately kept apart because conflating them is
how firms get into trouble: **invoices** are money coming in from
clients, the **trust ledger** is client money the firm merely holds, and
**payroll** is money going out to staff. There is no code path from
payroll to trust.

- `core/invoicing.ts` — `InvoiceStore`. Integer cents throughout, same
  reasoning as the trust ledger. The rule that matters most: **line
  items lock the moment an invoice is sent.** An invoice the firm can
  edit after the client has a copy is not a record of anything — the
  same reasoning that locks `WorkProduct.content` at review. Correct a
  sent invoice by voiding and reissuing. Voiding is refused once
  payments exist (that's a refund, not a disappearance), payment is
  refused before sending and after voiding, and **overpayment is
  refused** rather than absorbed into a negative balance, since it's
  money the firm would then owe back.
- `integrations/payment-processor.ts` — vendor-agnostic
  `PaymentProcessor`, same pattern as `SpeechToText`/`ClaudeClient`.
  **The compliance point driving the design:** most general-purpose
  processors net their fee out of the deposit, which against a trust
  account means the balance no longer equals the sum of client
  ledgers — exactly what `TrustLedger.reconcile()` exists to catch, and
  a serious violation. Legal-specific processors (LawPay and similar)
  route fees to the operating account instead. `charge()` is therefore
  only ever used for *operating* receipts; trust funds are applied by
  ledger movement and never round-tripped through a processor.
  `ManualPaymentProcessor` is the default and reports `canCharge:
  false`, so the UI can say "record payment" rather than offering a card
  charge that will fail. Card data must never reach this server — use
  the processor's client-side tokenization and pass only a token, or
  this application falls into PCI-DSS scope.
- `review-ui/invoicing-service.ts` — matter-scoped via `billing_internal`
  like billing hours and trust. **Sending and voiding are attorney-only**
  (a paralegal prepares the draft; committing it is supervisory), as is
  `payFromTrust`. That last method is the important one: applying money
  the firm already holds is the firm transferring client funds to
  itself, permissible only for fees actually earned. It writes an
  `earned_fee_transfer` to the trust ledger *and* records the payment,
  attempting the trust side **first** — if the client lacks the funds,
  `TrustLedger` throws and neither record is written, so the two can
  never disagree about whether money moved. `recordPayment` refuses
  `trust_application` outright, so the ledger can't be bypassed.
- `core/payroll.ts` / `review-ui/payroll-service.ts` — what the firm pays
  its people. Distinct from `billing-hours.ts`, which records **billable**
  time charged to a client: someone works forty hours and bills
  thirty-two, and conflating the two produces both a wrong invoice and a
  wrong paycheck. Rates are **historical** — a shift is priced at the
  rate in force on the day it was worked, so a raise never restates a
  period already paid. A shift with no rate on record contributes hours
  but no money and is reported in `datesMissingRate` with
  `incomplete: true`; silently pricing it at zero would produce a
  confidently wrong paycheck. Access is about privacy between
  colleagues rather than matters: setting a rate is attorney-only, you
  can see your own hours and rate, and only an attorney can see anyone
  else's or run the firm-wide summary.
- `server.ts` wires `/api/invoices/*` and `/api/payroll/*` (each 404s
  without its service). An invoice-state violation is **409**, malformed
  input is 400.

### The itemised invoice, and emailing it

`core/invoice-render.ts` — the document a client actually receives,
rendered as plain text and HTML from the same data. The point of the
file is the **itemisation**: a bill reading "professional services —
$4,250" is the classic source of fee disputes, and in many jurisdictions
an unitemised bill isn't collectable. Every time line therefore carries
five things — the date the work was done, who did it, what it was, how
long it took, and at what rate — split into **services / expenses /
fixed fees**, because a client asking "why is this so much" is looking
for one of the three and merging them hides which. Rendering is pure: no
store, no access control, no transport, so the same output backs the
on-screen preview and the emailed copy and what an attorney approves is
character-for-character what the client gets.

`InvoiceLineItem` gained `workedOn` / `timekeeperId` / `sourceEntryId`
to make that possible. `sourceEntryId` also closes a real hole:
`addTimeFromBillingHours` now **skips hours already billed on a live
invoice** (`InvoiceStore.billedEntryIds()`), so pressing "add logged
time" twice can't double-bill a client. Voiding an invoice releases its
hours back for re-billing, which is what void-and-reissue is for.

`integrations/email-sender.ts` / `integrations/smtp-email.ts` — the
vendor-agnostic `EmailSender` seam and a real SMTP client hand-rolled
over `node:net`/`node:tls`, same dependency-light call as the Google
Calendar JWT flow. Two properties worth naming:

- **It will not send in the clear.** On the STARTTLS path it aborts if
  the server doesn't advertise the upgrade, rather than falling back —
  the credential is the firm's mail password and the payload is a
  privileged client document. `allowInsecurePlaintext`
  (`SMTP_ALLOW_INSECURE=true`) exists only for a loopback relay and is
  off unless asked for.
- **Addresses are validated before they reach the wire**
  (`assertSafeEmailAddress`), because a newline in an address is a new
  SMTP command — an injected `Bcc` would silently copy a client's
  itemised bill to an outsider. Header values are newline-stripped and
  the body is dot-stuffed for the same class of reason.

`integrations/invoice-pdf.ts` — the invoice as a **PDF**, the form a
client files, prints, or forwards to their accountant. Over the
`pdf-lib` this project already uses for condensing, behind the same
vendor-agnostic interface shape as `PdfCondenser`/`PdfTextExtractor`. It
lays the page out directly rather than converting the HTML, because
there is no HTML-to-PDF path here that wouldn't mean shipping a headless
browser; it shares its *data* and its `formatCents`/`formatQuantity`
helpers with `invoice-render.ts`, so the three renderings can't disagree
about a figure. Three things it gets right that a naive layout doesn't:
a description too long for its column **wraps** (and a single
unbreakable token breaks by character) rather than being clipped; a
table running past the page bottom **continues with its header
repeated**, and the pages are numbered "1 of N", because a second page
of unlabelled numbers is what a client disputes; and text is coerced to
WinAnsi (`toWinAnsi`) before it reaches pdf-lib's standard fonts, since
a smart quote pasted from a word processor would otherwise turn
generating a bill into a 500.

`InvoicingService.renderPdf()` backs `GET /api/invoices/matters/
:matterId/:invoiceId/pdf` (the panel's "Download PDF"), served through
`server.ts`'s `sendBinary` — the one non-JSON response in this API,
with the filename quoted and stripped so a matter title can't terminate
the `Content-Disposition` header. Access matches `preview`: a paralegal
preparing the bill can read it, only an attorney can send it. The PDF
renderer needs no configuration and no vendor, so it is always on.

`EmailMessage.attachments` and `smtp-email.ts`'s `multipart/mixed`
nesting carry that PDF with the outgoing mail (base64 wrapped at 76
columns per RFC 2045; an attachment filename is newline- and
quote-stripped for the same reason an address is). If the PDF fails to
render, the send **aborts** rather than quietly mailing a bill without
the document its body refers to.

`InvoicingService.emailInvoice()` is attorney-only (it *is* sending a
bill, the act `send()` is already gated on) and **mails the invoice
before committing the send transition** — so a transport failure leaves
an editable draft rather than an invoice permanently marked as issued
that the client never received, the same ordering reasoning as
`payFromTrust` attempting the trust side first. The outgoing copy is
rendered as issued so the client's copy never reads "draft — not yet
issued". Deliveries are appended to `Invoice.deliveries` (recipient,
time, who sent it, the transport's message id): "we sent it on the 3rd"
is a claim a firm needs to be able to substantiate. The recipient comes
from the matter's **client** party via `billingEmailFor()`, which
deliberately never falls back to another party — mailing a bill to the
opposing side is far worse than not mailing it.

**Accounts receivable.** `InvoicingService.listOutstanding()` backs the
Invoices panel's "Outstanding across all your matters" card and a Home
tile: every issued, unpaid, non-void invoice, most overdue first, then
largest balance — the order someone chasing payment works through them
in. Deliberately **cross-matter**, because "who owes us money" is a
question about the firm and answering it one file at a time is how a
receivable quietly ages past collectability. Access stays per-matter
though: each invoice's matter goes through the same `authorize()` check
as everywhere else and a failing one is *silently omitted* rather than
raising, so a paralegal scoped to one matter sees that matter's
receivables with no hint that others exist. Drafts are excluded — a
draft is not money anyone owes yet. Each row carries the client name and
matter title so a receivable can be chased without opening the matter,
and clicking one jumps straight to that invoice.

**Letterhead** comes from `FirmConfig.letterhead` (`addressLines`,
`phone`, `billingEmail`, `paymentInstructions`) in `FIRM_CONFIG_FILE`,
falling back to `SMTP_FROM`/`FIRM_PAYMENT_INSTRUCTIONS`. Every field is
optional: without any of it the invoice still renders correctly with
just the firm name, the same "absent config degrades, never gates"
principle as the rest of that layer.

**The client's email** lives on the matter's client party and is edited
in the Conflicts panel's matter record as `Name <email@example.com>` —
the same shape as a mail "To:" field. It has to round-trip through that
textarea because saving rebuilds the whole party list, so anything the
editor can't display it would silently delete.

`server.ts` adds `GET /api/invoices/outstanding`,
`GET /api/invoices/email-transport`,
`GET /api/invoices/matters/:matterId/:invoiceId/preview` and
`POST /api/invoices/matters/:matterId/:invoiceId/email`. Configured via
`SMTP_HOST`/`SMTP_FROM` (plus optional `SMTP_PORT`/`SMTP_USER`/
`SMTP_PASSWORD`/`FIRM_PAYMENT_INSTRUCTIONS`); absent, the panel offers
preview-and-send-yourself instead of an Email button that would fail.

The Invoices panel's preview shows the **plain-text** alternative rather
than the HTML one. Both carry the same itemisation; the HTML version
styles itself with inline attributes because that is all mail clients
honour, and this app's CSP blocks inline styles on purpose — not a rule
worth an exception for a preview.

What this doesn't do: sign with DKIM (the firm's provider does that
server-side), pool connections, or retry a failed send. The PDF is
generated fresh on every request rather than stored — it is a view of
the invoice, and a stored copy could fall out of step with the record
it claims to represent.

What none of this does: accounting, tax withholding, overtime rules,
benefits, dunning, or filing anything with a tax authority. Payroll
answers "how many hours, at what rate, so what is gross pay" — the input
a bookkeeper or payroll provider needs, not a replacement for one.

## Time clock

`core/time-clock.ts` / `review-ui/time-clock-service.ts` — clock in,
clock out, and daily / weekly / monthly totals, backing the "Time Clock"
panel. This is the *capture* side of `payroll.ts`: a punch is a fact
about the clock, a payroll entry is a fact about money, and correcting
one must not silently rewrite the other.

Two things real timeclocks routinely get wrong, both handled here:

- **Day boundaries are local, not UTC.** Clocking in at 9pm in New York
  is already "tomorrow" in UTC, so UTC bucketing puts those hours in the
  wrong day — and therefore the wrong week and the wrong pay period.
  Every aggregation takes an IANA timezone and derives the local date
  through `Intl`; the firm's zone comes from `FIRM_TIME_ZONE`.
  `TimeClock.today()` exists so nothing computes "which bucket is
  today's" from a second, different notion of now.
- **People forget to clock out.** Open shifts are never counted in a
  total — a total that changes every time you look at it isn't a total —
  and one running past `STALE_OPEN_SHIFT_HOURS` (16) is reported as
  `likelyForgotten` so it gets corrected rather than paid. Overnight
  shifts are attributed to the day they *started*, the usual payroll
  convention, so one shift never splits across two pay periods.

Access mirrors payroll: **you punch your own clock** (the routes take no
actor id at all) and read your own timesheet; an attorney can read
anyone's, and `whoIsOnTheClock` is attorney-only. **Corrections are
attorney-only even for your own shifts** — a timesheet you can quietly
rewrite isn't a record, the same reasoning that makes the audit log and
trust ledger append-only — and they keep the previous values, who
changed them and why. `postToPayroll` creates the payroll entry *first*
and only then marks the shift posted, so a failure can't mark hours paid
that aren't; once posted the shift locks against correction, so the two
records can't disagree.

`TimeClockError` carries an explicit `kind`
(`invalid`/`not_found`/`conflict`) rather than leaving `server.ts` to
match HTTP status codes against error prose — that approach broke the
first time a message was reworded.

`server.ts` wires `POST /api/time-clock/clock-in|clock-out`,
`GET /api/time-clock/on-the-clock`,
`POST /api/time-clock/shifts/:id/adjust|post-to-payroll`, and
`GET /api/time-clock/actor/:actorId/summary|shifts|totals?kind=day|week|month`
(all accepting `?tz=`); 404 without a `TimeClockService`. The Home panel
shows this week's total and a one-click punch button.

What this doesn't do: overtime rules, breaks, geofencing, or scheduled
shifts to punch against — it records when someone was working and rolls
it up.

## The activity record — who did what, and proof it wasn't edited

`core/audit.ts` is where accountability actually lives. Three properties
matter, and two of them are new:

- **Every entry is hash-chained.** Each carries a SHA-256 over its own
  contents *plus the previous entry's hash*, so the log is a chain:
  altering an entry, deleting one, or splicing one in changes that
  entry's hash and breaks every link after it.
  `AuditLog.verifyIntegrity()` walks the chain and reports the first
  sequence where it breaks; the Audit Log panel's "Verify the chain"
  button exposes it to attorneys, because the people who have to be able
  to say "this record is intact" are the ones answerable for it.
  - This matters because the log doesn't only live in memory — it is
    persisted as JSON in a file or a Postgres column that someone with
    the right access could edit directly. Without the chain,
    "we never delete audit entries" is a promise about *code* that has
    nothing to do with the file on disk.
  - **It detects tampering; it does not prevent it.** Someone who can
    rewrite the state file can recompute every subsequent hash. Real
    tamper-*proofing* needs the chain anchored where that same person
    can't reach — an append-only external store, or publishing the head
    hash somewhere. That is a genuine remaining gap and the panel says
    so in as many words rather than implying an immutable log.
  - Entries written before chaining existed verify as
    `unchainedEntries` rather than as a break — an old snapshot isn't
    evidence of tampering.
  - `verifyIntegrity()` is a *report*, never a repair. There is
    deliberately no code path that rewrites a broken chain to make it
    verify again, since that is indistinguishable from covering up
    whatever broke it.
- **Edits record what changed.** `AuditEntry.changes` carries
  field-level before/after, built by `diffFields()`. "matter_updated"
  tells you something happened; this tells you *what*. It matters most
  on matter parties, because those drive every future conflicts check
  and "who quietly removed the adverse party" is precisely the question
  this log has to answer — `MattersService.upsert()` reads the record
  before writing so it can say. Only fields that actually differ are
  recorded, and an emptied party list reads as *cleared* rather than as
  a blank cell that could equally mean "unchanged".
- **Coverage.** Beyond the access grants/denials, escalations and
  work-product transitions already logged: matter-record creation and
  edits (with diffs), document uploads and deletions (a deletion keeps
  what the file *was*, since nothing else survives it), account
  creation/disable/enable/password-reset, matter assignment and
  unassignment, and every money movement (trust, invoices, payroll,
  time clock). Passwords never appear, and a refused action logs the
  denial rather than a phantom success.

`AuditService.list()` takes a filter object (`matterId`, `actorId`,
`action` substring, `from`/`to` dates) — the Audit Log panel exposes all
five, since a log you can only read start-to-finish isn't one anyone
uses. Redaction for `system_admin_no_content` drops `changes` too:
before/after values are exactly the privileged content that role is
walled off from.

## Transport & session security

Hardening that applies to every route, independent of any one panel.

- **Login throttling** (`core/login-throttle.ts` — `LoginThrottle`).
  `POST /api/login` was unlimited, which is two problems: password
  guessing, and a CPU-exhaustion vector, since every attempt runs
  `scrypt` *by design* and the endpoint needs no credentials to reach.
  Failures are counted against two independent keys — the **username**
  (stops one account being hammered from many addresses) and the
  **client IP** (stops one address spraying across many accounts) —
  and either tripping locks the attempt out. The check runs *before*
  `AuthService.login`, so a locked-out attempt never pays the scrypt
  cost. Defaults: 5 failures per 15 min, 15 min lockout, cleared on a
  successful login. Persisted (see "Persistence") so bouncing the
  process can't clear a lockout.
  - A lockout is deliberately **time-boxed, never an account disable** —
    otherwise anyone able to send failed logins could permanently deny a
    real attorney access to their own matters, the same failure mode
    `AuthService.setDisabled` guards against by refusing to remove the
    last enabled attorney. `AccountsService.clearLoginLockout()`
    (attorney-gated, `POST /api/accounts/:id/clear-login-lockout`) is
    the escape hatch for a colleague who just fatfingered their password.
  - `X-Forwarded-For` is only honoured under the same `TRUST_PROXY` flag
    that gates `X-Forwarded-Proto` — trusting it unconditionally would
    let an attacker defeat per-IP throttling by varying a header.
- **Auth auditing.** Login success/failure/lockout land in the same
  `AuditLog` the Audit Log panel reads. Auth events carry
  `matterId: undefined` (they aren't matter-scoped) and a new
  `"anonymous"` actor role — recording a pre-credential attempt as
  `"system"` would be a lie, since that role is the calendar
  integration's machine credential. `AccessControl` default-denies every
  role it doesn't explicitly model, so an anonymous actor can't reach
  matter data by construction.
- **Security headers** on every response (`SECURITY_HEADERS` in
  `server.ts`): a real CSP (`default-src 'self'`, `script-src 'self'`
  with **no** `unsafe-inline`), `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY` + `frame-ancestors 'none'`, `Referrer-Policy:
  no-referrer`, `Cross-Origin-Opener-Policy: same-origin`.
  Clickjacking is the one worth naming: the Review Queue has one-click
  approve/release buttons that release privileged work product, which is
  exactly what a framed-overlay attack would target.
  - The dashboard's CSS and JS live in real files (`public/app.css`,
    `public/app.js`, `public/login.css`, `public/login.js`) rather than
    inline blocks **specifically so that policy can be strict** — an
    inline-script allowance would make it decoration. For the same
    reason there are no `style="..."` attributes anywhere; the handful
    that existed became utility classes in `app.css`, since `style-src
    'self'` blocks inline style attributes too (including any written
    into `innerHTML`).
- **Request-body ceiling** — see "PDF intake…" above for why the
  per-file upload cap alone wasn't one.
- `serveStatic` compares against `PUBLIC_DIR + path.sep`, not a bare
  `startsWith`: the latter also accepts a sibling directory whose name
  merely begins with it, which `../public-x/secret` would reach.

## Real authentication (§5/§6 — resolved)

`src/core/auth.ts` — `AuthService`. Replaces the earlier
`x-actor-id`/`x-actor-role` header stand-in with real, credentialed
accounts:

- Passwords are hashed with `scrypt` (never stored or compared in plain
  text; comparison is timing-safe via `timingSafeEqual`).
- `login()` issues a session token; there is no code path to a valid actor
  that doesn't go through `login()` at least once — login is always
  required.
- "Remember me" (`login(..., remember: true)`) only extends how long the
  session lasts (30 days vs. the 12-hour default) — it never skips
  authentication.
- A `"system"` actor role (already part of `Actor` in `core/types.ts`) is
  deliberately *not* created via username/password. It's the calendar
  integration's own machine credential — see `setSystemApiKey()`/
  `verifySystemApiKey()` — which closes the "any string can call itself
  `calendar_system`" gap noted below: `ReviewGateService.confirmDeadline()`
  now requires role `"system"` specifically for a `calendar_system`
  source, and role `"attorney"` for a `"human"` source.
- `AuthService` snapshots into `persistence/system-state.ts` like every
  other stateful core object, so accounts, live sessions ("remember me"
  survives a restart), and the system key persist across process
  restarts.

This is still a real-vendor-shaped seed, not a finished identity system:
there's still no MFA. Password reset *is* now built (see below) —
attorney-initiated, not the self-service email-link flow production auth
usually means. Adding/disabling accounts after the one-time boot-time
seed *is* built now — see `AccountsService` below — but it's
attorney-gated, in-app account management, not a self-service flow (no
email verification, no invite links). It replaces the *trust* gap
(headers anyone could set) with a *real* one (credentialed sessions),
which is the prerequisite §5/§6 called for, not the last word on
production auth.

`AccountsService` (`src/review-ui/accounts-service.ts`) wraps `AuthService`
the same way `ReviewGateService` wraps `review-gate.ts`: every method,
including plain reads, requires an attorney actor. It adds accounts
(`list`/`create`), and disables/re-enables them (`disable`/`enable`) — a
disabled account fails login with the exact same generic "invalid username
or password" message a wrong password would (no user-enumeration signal),
and `AuthService.setDisabled()` revokes every one of that user's live
sessions immediately, "remember me" included, not just at next check.
`setDisabled()` also refuses to disable the last remaining *enabled*
attorney account — there's no path to a Docket with zero attorneys able to
log into it. It also owns matter assignment for paralegal accounts
(`assignMatter`/`unassignMatter`, wrapping `AccessControl`'s
`assignParalegal`/`revokeParalegalAssignment`) — a freshly created
paralegal account has no case-file access at all until an attorney
assigns it to a matter here, which is exactly the scoping the Drafting
panel enforces below.

**Password reset/change (resolved).** Two distinct paths, matching two
distinct trust levels:

- `AuthService.resetPassword(userId, newPassword)` — an attorney sets a
  new password for someone who's lost theirs (in person, over the phone,
  whatever secure-enough channel the firm uses — there's still no
  email/token-based self-service reset, consistent with this project's
  existing "no email verification, no invite links" scope line).
  Requires no knowledge of the old password, marks `mustChangePassword`
  on the account, and revokes every live session immediately — the same
  "access changes take effect now" behavior as `setDisabled`. Exposed as
  `AccountsService.resetPassword()` (attorney-gated, like every other
  method there) and `POST /api/accounts/:id/reset-password`.
- `AuthService.changePassword(userId, currentPassword, newPassword)` —
  self-service, any logged-in role. Requires proving the *current*
  password first (unlike a reset), clears `mustChangePassword`, and also
  revokes every live session — including the one making the request — so
  the caller has to log back in with the new password. Wired directly
  into `server.ts` as `POST /api/change-password` with no attorney gate
  and no dependency on `AccountsService`, since it only ever acts on the
  caller's own account; a wrong current password is a `403`, deliberately
  not the `401` a real auth failure would be, so the dashboard's global
  "401 means redirect to login" handling doesn't fire for what's actually
  a simple retry-able mistake.
- `mustChangePassword` is surfaced on `GET /api/me` and in the Accounts
  panel's account list (`password reset pending` badge) — there's no
  forced-change flow yet (the account can keep using Docket normally
  until they act on it), just a flag the login banner and Accounts panel
  nudge on.

## Attorney review-gate UI — "Docket"

`src/review-ui/` — the attorney-facing app over `review-gate.ts`
(§8 build order step 5), plus `src/core/work-product-store.ts`, the
in-memory registry that makes drafted `WorkProduct`s discoverable (a
`ParalegalDraftingSession` given a `store` registers into it automatically).
Branded **Docket**: one app shell (sidebar nav, no full-page reloads
between sections) over twenty panels — Home, Review Queue, Deadlines,
Scheduling, Live Intake Demo, Drafting, Cases, Conflicts, Trust, Invoices,
Time Clock, Payroll, Research, Assistant,
Staff, Messages, Schedule, Billing, Accounts, and Audit Log (Drafting/
Cases/Research/Assistant/Billing and Accounts/Audit Log hidden from the
nav for roles that can't use them; Staff/Messages/Schedule are open to
every logged-in human so they're never hidden). Review Queue and
Deadlines are themselves attorney-only server-side (`ReviewGateService`
gates every method, including reads), so the dashboard only fires their
initial load once `GET /api/me` confirms the role — a non-attorney
session sees an inline "attorney-only" message instead of a background
403 on login.

- `review-service.ts` — `ReviewGateService`. `review-gate.ts` already
  guards the status-transition methods against non-attorney actors, but
  reads/listing are unguarded there since drafting agents need them too.
  This service requires an attorney actor on *every* method, including
  plain reads — a receptionist/paralegal credential shouldn't reach this
  surface at all, not just get blocked on the mutating calls.
- `intake-demo.ts` — `IntakeDemoSessions`, backing the dashboard's "Live
  Intake Demo" panel: an in-memory, ephemeral map of `ReceptionistChatSession`s
  keyed by a random session id, driven by the *actual* logged-in actor
  through the *actual* `Router`/`AccessControl`. It's a real conversation
  through the real code path (same escalation/access-control/scripting as
  a real caller), not a mock — the only thing "demo" about it is that
  sessions live only in memory and are pruned the moment a conversation
  ends, never touching `system-state.ts` or a real matter. A logged-in
  actor whose role wouldn't be allowed to run intake (e.g. `paralegal`)
  gets the same `AccessDeniedError` a misconfigured real session would.
- `accounts-service.ts` — `AccountsService`, backing the "Accounts" panel
  — see "Real authentication" above for what it does and doesn't do.
- `drafting-service.ts` — `DraftingService`, backing the "Drafting" panel
  — see "Paralegal drafting agent" above for what it does and why it adds
  its own `AccessControl` check on top of `ParalegalDraftingSession`.
- `documents-service.ts` / `cases-service.ts` — `DocumentsService` and
  `CasesService`, backing the "Cases" panel — see `document-store.ts`'s
  entry above for what they do.
- `research-service.ts` — `ResearchService`, backing the "Research" panel
  — see "Legal research — CourtListener" above for what it does.
- `assistant-service.ts` — `AssistantService`, backing the "Assistant"
  panel — see "AI Assistant — Claude" above for what it does.
- `staff-service.ts` / `messaging-service.ts` / `staff-schedule-service.ts`
  / `billing-hours-service.ts` — backing the "Staff", "Messages",
  "Schedule", and "Billing" panels respectively — see "Staff directory,
  messaging, staff schedule, and billing hours" above for what each does.
- `audit-service.ts` — `AuditService`, backing the "Audit Log" panel.
  `AuditLog.read()` already takes an explicit counsel-aware reader role
  (`"attorney"` vs. `"system_admin_no_content"`), but that's a parameter
  any caller could pass — this service is the actual gate, requiring an
  attorney actor on its one method (`list`, optionally filtered by
  `matterId`) before ever reading with role `"attorney"`.
- `server.ts` — a small dependency-free JSON API (Node's built-in `http`,
  no framework) over the service, plus static-file serving for the
  dashboard. Actor identity comes from an `httpOnly` session cookie set by
  `POST /api/login` and validated against `AuthService` on every request
  (see "Real authentication" above) — or from an `x-system-api-key` header
  for the calendar integration's machine credential. `GET /` redirects to
  `/login.html` when there's no valid session; `POST /api/logout` clears
  it. `/api/intake/*`, `/api/accounts*`, `/api/drafting/*`,
  `/api/documents/*`, `/api/cases*`, `/api/audit*`, `/api/research/*`,
  `/api/assistant/*`, `/api/staff`, `/api/messages/*`,
  `/api/staff-schedule/*`, `/api/billing-hours/*`, and `/api/pdf-reports/*`
  are 404 if no `IntakeDemoSessions`/`AccountsService`/`DraftingService`/
  `DocumentsService`/`CasesService`/`AuditService`/`ResearchService`/
  `AssistantService`/`StaffService`/`MessagingService`/
  `StaffScheduleService`/`BillingHoursService`/`PdfReportService` was
  passed to `createReviewServer`, respectively. `npm run build` copies
  `public/` into `dist/` since `tsc` only compiles `.ts` files.
- `public/login.html` — Docket-branded sign-in: username/password + a
  "remember me" checkbox, posting to `/api/login`.
- `public/index.html` / `public/app.js` / `public/app.css` — the Docket
  app shell: a dark sidebar (brand + panel nav), a top bar showing who's
  signed in, and one panel each for **Home** (the landing panel: a
  role-aware set of stat tiles, a "Needs your attention" list that
  deep-links into the Review Queue, and a "Today" list showing your own
  schedule entry and the latest announcements — it only requests data
  the current role can read, so nothing 403s in the background, and each
  tile is best-effort so one unavailable surface can't blank the page.
  Before this, the app opened on the attorney-only Review Queue, so a
  paralegal's first impression was the words "attorney-only"), the
  Review Queue (list/detail/approve/reject/request-revision/
  clear-flag/release), Deadlines (status check/independent confirmation/
  conflict list), Scheduling (book/list/reschedule/cancel/complete/
  reminders), Live Intake Demo (a chat window driving `intake-demo.ts` —
  "Start new demo conversation" then type caller turns), Drafting (pick a
  matter, draft from a template/research summary/billing narrative, then
  revise/submit — nav item hidden unless `GET /api/me` reports role
  `attorney` or `paralegal`), Cases (a clickable list of every matter,
  expanding into that matter's uploaded documents — upload a file and
  download it back out as a data URI, plus "Draft report from this PDF"
  and "Condense" actions on any uploaded PDF (see "PDF intake,
  document-report drafting, and PDF condensing" above) — alongside its
  drafted work product; same role gate as Drafting), Research (search
  case law, "Save to
  matter" on any result, and a per-matter quick-access list with a
  Remove action — same role gate as Drafting), Assistant (a chat window
  driving `assistant-service.ts` — "Start new conversation" then ask it
  to search/draft/schedule; same role gate as Drafting), Staff (a
  read-only directory of every account — username, display name,
  initials, role, and a paralegal's matter assignment — open to every
  logged-in human, never hidden), Messages (an Announcements chat window
  every human can post to, a "start DM"/"create group" form, and a
  conversation list with an "Open" button into a chat window — also
  never hidden), Schedule (set your own or, as an attorney, anyone's
  in-office/remote/out entry for a date; view everyone's status for a
  date or one actor's upcoming entries — also never hidden), Billing (log
  hours against a matter with a date/hours/description, view a matter's
  logged hours with a running total, and view your own hours across every
  matter — same role gate as Drafting), Accounts (add a login with a
  username/full name/temporary password/role, disable/re-enable one, and
  for paralegal accounts specifically, assign/unassign a matter — nav
  item hidden unless role is `attorney`), and Audit Log (every access
  grant/denial and work-product transition, append-only, optionally
  filtered by matter id — nav item hidden unless role is `attorney`). The
  Drafting/Cases/Research/Assistant/Billing and Accounts/Audit Log hides
  are client-side convenience only; the real gate is server-side in
  `AccountsService`/`DraftingService`/`DocumentsService`/`CasesService`/
  `ResearchService`/`AssistantService`/`BillingHoursService`/`AuditService`.
  Any `401` from the API redirects the browser back to `/login.html`.
  Every field that names a person is a `<select>` populated from
  `GET /api/staff` (showing display names, defaulting to you, and
  excluding you from "message someone"), and every matter field offers
  autocomplete from `GET /api/cases` via a shared `<datalist>` — matter
  fields stay free-text on purpose, since a matter comes into existence
  the first time someone uses its id, so the list is a convenience and
  never a restriction. Previously all of these were raw ids typed from
  memory, where a typo silently created a different matter.
- `start.ts`'s boot-time bootstrap: if no accounts exist yet in the
  persisted state, it creates them from `ATTORNEY_USERNAME`/
  `ATTORNEY_PASSWORD` (and optionally `PARALEGAL_USERNAME`/
  `RECEPTIONIST_USERNAME`/`STAFF_USERNAME` with matching `_PASSWORD`
  vars) — this is only for getting the very first attorney account into
  an empty system; it's a no-op forever once any account exists. Anything
  after that goes through the Accounts panel (including assigning that
  seeded paralegal to a matter, if one was seeded — the env-var bootstrap
  creates the login but not a matter assignment). `start.ts` also sets the
  calendar-integration system key from `CALENDAR_SYSTEM_API_KEY`, or
  generates and logs a random one on first boot if that's unset, and
  constructs `IntakeDemoSessions`/`AccountsService`/`DraftingService`
  wired into the server. `IntakeDemoSessions` gets its own throwaway
  `AccessControl` (receptionist intake has nothing to do with paralegal
  matter assignment); `AccountsService` and `DraftingService` share
  `state.accessControl` — the canonical, *persisted* instance (see
  "Persistence" below) — since one is where assignments are made and the
  other is where they're enforced.

`/api/appointments*` (see `scheduling.ts` above) is wired into the same
server, gated by `SchedulingService`'s own optional `AccessControl`
integration rather than `ReviewGateService` — scheduling is a
receptionist-role concern, not attorney-only, so it deliberately isn't
behind the attorney-only service. It still requires a logged-in session
(any role) like every other `/api/*` route.

## Persistence

`src/persistence/` — real durability behind a storage-agnostic seam, not
an in-memory-only demo. §8's "not yet built — persistence" is resolved
two ways now: file-backed by default, or a real Postgres database when
`DATABASE_URL` is set.

- `state-store.ts` — the seam: `StateStore` is `{ read(default), write(data) }`
  over a single opaque JSON blob. `system-state.ts` and everything upstream
  of it (core, receptionist, paralegal, review-ui) only ever speaks in
  plain-data snapshots via each domain object's `toSnapshot()`/
  `fromSnapshot()`, so neither storage backend needs to know what a
  `WorkProduct` or a `User` is.
- `json-file-store.ts` — dependency-free, atomic JSON-file read/write
  (temp file + rename, so a crash mid-write can't leave a corrupt state
  file). `fileStateStore(path)` wraps it as a `StateStore`.
- `postgres-store.ts` — `createPostgresStateStore({ connectionString })`,
  the real-database swap. Deliberately not a normalized relational schema:
  it stores the same single JSON snapshot in one `JSONB` column
  (`docket_state`, keyed by an opaque string — one row per deployment in
  practice), via the `pg` driver. `CREATE TABLE IF NOT EXISTS` runs on
  every connect, so there's no separate migration step to run first.
- `system-state.ts` — bundles the audit log, utilization tracker,
  work-product store, document store, research library, deadline tracker,
  scheduling service, auth, access control, messaging store, staff
  schedule store, and billing hours store into one document via
  `loadSystemState`/`saveSystemState`, which accept either a `StateStore`
  or (for convenience/backward compatibility) a plain file-path string.
- Every stateful core object (`AuditLog`, `UtilizationTracker`,
  `WorkProduct`, `WorkProductStore`, `DocumentStore`, `ResearchLibrary`,
  `DeadlineTracker`, `SchedulingService`, `AuthService`, `AccessControl`,
  `MessagingStore`, `StaffScheduleStore`, `BillingHoursStore`) has
  `toSnapshot()`/`fromSnapshot()` round-tripping its exact state to plain
  data — including `WorkProduct` states like `approved`/`released` that
  the normal constructor and transition methods can't reach directly. A
  rehydrated `WorkProduct` is a fully functional, rule-enforcing object
  afterward (content still locks, unresolved flags still block approval),
  not just replayed JSON; a rehydrated `SchedulingService` still enforces
  double-booking checks, and a rehydrated `AccessControl` still enforces
  paralegal-matter scoping — without this, every paralegal-matter
  assignment (see "Real authentication" above) would silently vanish on
  every restart.
- `review-ui/start.ts` wires this in: computes the store once at boot
  (`DATABASE_URL` set → Postgres, else `STATE_FILE`, default
  `./data/system-state.json`), loads state through it (plus an optional
  `FIRM_CONFIG_FILE` for business hours/attorney auto-assignment/
  branding), and `server.ts`'s `onMutated` hook saves through the same
  store instance after every state-changing request — the connection pool
  is created once, not per mutation.

Postgres is still single-instance/single-database, not a sharded or
read-replica setup — the right next step if this needs to scale past one
firm's traffic, but a normalized relational schema (rather than one JSON
blob) would be the more valuable change before that, and is a bigger
redesign deliberately out of scope here.

## Practice-area module contract

A module implements `PracticeAreaModule` (`src/config/practice-area.ts`):
intake questions, document templates, `deriveEscalationSignals()` to
translate module-specific context into core `EscalationSignals`, and
`deriveWorkProductFlags()` to translate drafting context into
`WorkProduct` flags. A module can only *add* escalation signals — core's
trigger set has no suppression path.

`src/modules/criminal-law/index.ts` is the pilot module and also shows the
Padilla-flag and protective-order-flag pattern: `deriveWorkProductFlags()`
returns the flag names, and `review-gate.ts` blocks approval until an
attorney clears them via `workProduct.clearFlag(...)`.

## Commands

```
npm install
npm run typecheck        # tsc --noEmit
npm test                  # vitest run — Postgres-backed persistence tests skip cleanly if TEST_DATABASE_URL / a local Postgres isn't reachable
ATTORNEY_USERNAME=you ATTORNEY_PASSWORD=at-least-8-chars npm run start:review-ui   # first boot: seeds your login
npm run start:review-ui   # subsequent boots — attorney review-gate dashboard at http://localhost:3000
# STATE_FILE=./data/system-state.json PORT=3000 npm run start:review-ui  # override the file-backed default
# DATABASE_URL=postgres://user:pass@host:5432/docket npm run start:review-ui  # use Postgres instead of the file store
# TRUST_PROXY=true npm run start:review-ui                               # only behind a real TLS-terminating reverse proxy — see "Real authentication"
# FIRM_CONFIG_FILE=./data/firm-config.json npm run start:review-ui        # enable scheduling business-hours/attorney-assignment/branding, and the invoice letterhead (firmName + letterhead.addressLines/phone/billingEmail/paymentInstructions)
# CALENDAR_SYSTEM_API_KEY=... npm run start:review-ui                     # pin the calendar-integration key instead of auto-generating one
GOOGLE_SERVICE_ACCOUNT_EMAIL=... GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY=... GOOGLE_CALENDAR_ID=... DOCKET_BASE_URL=http://localhost:3000 DOCKET_SYSTEM_API_KEY=... npm run sync:calendar  # one-shot Google Calendar deadline sync (run on a schedule, e.g. cron)
# TWILIO_ACCOUNT_SID=... TWILIO_AUTH_TOKEN=... PUBLIC_BASE_URL=https://docket.example.com npm run start:review-ui  # enable the telephony integration; also point a Twilio number's voice webhook at $PUBLIC_BASE_URL/api/voice/twilio/incoming in the Twilio console
# VOICEBOX_BASE_URL=http://127.0.0.1:17493 VOICEBOX_PROFILE_ID=...                    # optional — defaults to Voicebox's own local port/default voice
# COURTLISTENER_API_TOKEN=...                                             # optional — search works unauthenticated at a lower rate limit
# ANTHROPIC_API_KEY=sk-ant-...  ANTHROPIC_MODEL=claude-sonnet-5  npm run start:review-ui  # enable the Assistant panel; ANTHROPIC_MODEL/ANTHROPIC_BASE_URL are optional overrides
# FIRM_TIME_ZONE=America/New_York npm run start:review-ui                 # optional — where the Time Clock's day starts; defaults to the host's zone
# SMTP_HOST=smtp.example.com SMTP_FROM=billing@firm.example SMTP_USER=... SMTP_PASSWORD=... npm run start:review-ui  # enable emailing invoices (SMTP_PORT defaults to 587/STARTTLS; SMTP_ALLOW_INSECURE=true only for a loopback relay)
# FIRM_PAYMENT_INSTRUCTIONS="Payable within 30 days."                     # optional — printed under the invoice total
# MAX_DOCUMENT_UPLOAD_BYTES=52428800 npm run start:review-ui               # optional — override the 25 MB default per-file cap on Cases-panel uploads (see "PDF intake..." above for why this cap exists)
```

## §7 open items — status

All three items below have been reviewed and **signed off by the
practicing attorney overseeing this project, as domain expert, on
2026-07-25** — the human/domain-expert sign-off these items called for is
no longer outstanding. This attests to the approach and content being
sound as a starting point for real use, not that no further engineering
work remains (see the specific caveats kept under each item, and
"Not yet built" below).

1. **Deadline/calendar redundancy** — resolved in code, see above
   (`core/deadline.ts`), and **signed off**: the two-independent-source
   redundancy logic and `confirmDeadline()`'s source/role gating are sound
   to trust with real dates. The "any string can call itself
   `calendar_system`" gap is closed technically — see "Real
   authentication" above. The real calendar vendor behind that credential
   is now built too — see "Google Calendar integration" above — though
   key *rotation* stays manual and §5's vendor due-diligence review of
   Google Calendar itself is still the firm's call, not covered by this
   sign-off (see "Not yet built").
2. **Full criminal-law templates/intake questions** — resolved in code,
   see `criminal-law/index.ts`, and **signed off**: acceptable to use as
   the practice-area content, not merely a seed requiring further
   jurisdiction-specific revision before any real use.
3. **Testing/red-teaming plan** — resolved as an initial pass, see
   `docs/red-teaming-plan.md` and `test/red-team-scenarios.test.ts`, and
   **signed off**: the automated suite plus this review are accepted as
   sufficient without a separate additional round of human adversarial
   testing first.

## Not yet built

All six numbered steps of §8's build order are implemented (chat, then
voice, for the receptionist). Persistence, TLS-aware cookies, and account
management are resolved (see "Persistence" and "Real authentication"
above). Still open:

- The Twilio phone-number console configuration itself (pointing a real
  number's voice webhook at `/api/voice/twilio/incoming`) — see
  "Telephony integration — Twilio" above for what's code vs. what's a
  one-time console step; the code side is done
- Voicebox's specific caveats remain (see "Voicebox voice integration"
  above): best-effort `/transcribe` contract, no concurrency/uptime
  guarantees, must run co-located with whatever answers the call
- Automatic system-API-key *rotation* for the Google Calendar integration
  (see "Google Calendar integration" above — today a key is rotated by
  hand, regenerating the service-account key and re-running
  `CALENDAR_SYSTEM_API_KEY`), and §5's vendor due-diligence review of
  Google Calendar itself (zero-retention, storage jurisdiction, subpoena
  risk) — a firm decision, not a technical one
- Syncing the other direction: `Appointment`s aren't pushed to Google
  Calendar as events, only deadline confirmations flow in from it
- The rest of account management: MFA, self-service (email-link) password
  reset, and self-service invites — attorney-initiated password reset,
  self-service password change, and adding/disabling users after the
  one-time boot-time seed are all built (see "Real authentication" above)
- A normalized relational schema for the Postgres adapter, if this ever
  needs to scale past what one JSON blob per deployment comfortably
  handles (see "Persistence" above) — a bigger redesign, deliberately not
  done preemptively
