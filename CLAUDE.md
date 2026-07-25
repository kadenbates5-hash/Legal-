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
| `core/audit.ts` | Append-only, privilege-sensitive audit trail, counsel-restricted read (§5) |
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
there's no password reset and no MFA. Adding/disabling accounts after the
one-time boot-time seed *is* built now — see `AccountsService` below — but
it's attorney-gated, in-app account management, not a self-service flow
(no email verification, no invite links). It replaces the *trust* gap
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

## Attorney review-gate UI — "Docket"

`src/review-ui/` — the attorney-facing app over `review-gate.ts`
(§8 build order step 5), plus `src/core/work-product-store.ts`, the
in-memory registry that makes drafted `WorkProduct`s discoverable (a
`ParalegalDraftingSession` given a `store` registers into it automatically).
Branded **Docket**: one app shell (sidebar nav, no full-page reloads
between sections) over ten panels — Review Queue, Deadlines, Scheduling,
Live Intake Demo, Drafting, Cases, Research, Assistant, Accounts, and
Audit Log (the last six hidden from the nav for roles that can't use
them). Review Queue and
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
  `/api/documents/*`, `/api/cases*`, `/api/audit*`, `/api/research/*`, and
  `/api/assistant/*` are 404 if no `IntakeDemoSessions`/`AccountsService`/
  `DraftingService`/`DocumentsService`/`CasesService`/`AuditService`/
  `ResearchService`/`AssistantService` was passed to `createReviewServer`,
  respectively. `npm run build` copies `public/` into `dist/` since `tsc`
  only compiles `.ts` files.
- `public/login.html` — Docket-branded sign-in: username/password + a
  "remember me" checkbox, posting to `/api/login`.
- `public/index.html` — the Docket app shell: a dark sidebar (brand +
  panel nav), a top bar showing who's signed in, and one panel each for
  the Review Queue (list/detail/approve/reject/request-revision/
  clear-flag/release), Deadlines (status check/independent confirmation/
  conflict list), Scheduling (book/list/reschedule/cancel/complete/
  reminders), Live Intake Demo (a chat window driving `intake-demo.ts` —
  "Start new demo conversation" then type caller turns), Drafting (pick a
  matter, draft from a template/research summary/billing narrative, then
  revise/submit — nav item hidden unless `GET /api/me` reports role
  `attorney` or `paralegal`), Cases (a clickable list of every matter,
  expanding into that matter's uploaded documents — upload a file and
  download it back out as a data URI — alongside its drafted work product;
  same role gate as Drafting), Research (search case law, "Save to
  matter" on any result, and a per-matter quick-access list with a
  Remove action — same role gate as Drafting), Assistant (a chat window
  driving `assistant-service.ts` — "Start new conversation" then ask it
  to search/draft/schedule; same role gate as Drafting), Accounts (add a
  login, disable/re-enable one, and for paralegal accounts specifically,
  assign/unassign a matter — nav item hidden unless role is `attorney`),
  and Audit Log (every access grant/denial and work-product transition,
  append-only, optionally filtered by matter id — nav item hidden unless
  role is `attorney`). All six hides are client-side convenience only;
  the real gate is server-side in
  `AccountsService`/`DraftingService`/`DocumentsService`/`CasesService`/
  `ResearchService`/`AssistantService`/`AuditService`. Any `401` from the API redirects the
  browser back to `/login.html`.
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
  scheduling service, auth, and access control into one document via
  `loadSystemState`/`saveSystemState`, which accept either a `StateStore`
  or (for convenience/backward compatibility) a plain file-path string.
- Every stateful core object (`AuditLog`, `UtilizationTracker`,
  `WorkProduct`, `WorkProductStore`, `DocumentStore`, `ResearchLibrary`,
  `DeadlineTracker`, `SchedulingService`, `AuthService`, `AccessControl`) has
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
# FIRM_CONFIG_FILE=./data/firm-config.json npm run start:review-ui        # enable scheduling business-hours/attorney-assignment/branding
# CALENDAR_SYSTEM_API_KEY=... npm run start:review-ui                     # pin the calendar-integration key instead of auto-generating one
GOOGLE_SERVICE_ACCOUNT_EMAIL=... GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY=... GOOGLE_CALENDAR_ID=... DOCKET_BASE_URL=http://localhost:3000 DOCKET_SYSTEM_API_KEY=... npm run sync:calendar  # one-shot Google Calendar deadline sync (run on a schedule, e.g. cron)
# TWILIO_ACCOUNT_SID=... TWILIO_AUTH_TOKEN=... PUBLIC_BASE_URL=https://docket.example.com npm run start:review-ui  # enable the telephony integration; also point a Twilio number's voice webhook at $PUBLIC_BASE_URL/api/voice/twilio/incoming in the Twilio console
# VOICEBOX_BASE_URL=http://127.0.0.1:17493 VOICEBOX_PROFILE_ID=...                    # optional — defaults to Voicebox's own local port/default voice
# COURTLISTENER_API_TOKEN=...                                             # optional — search works unauthenticated at a lower rate limit
# ANTHROPIC_API_KEY=sk-ant-...  ANTHROPIC_MODEL=claude-sonnet-5  npm run start:review-ui  # enable the Assistant panel; ANTHROPIC_MODEL/ANTHROPIC_BASE_URL are optional overrides
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
- The rest of account management: password reset, MFA, and self-service
  invites (adding/disabling users after the one-time boot-time seed *is*
  built — see `AccountsService` above)
- A normalized relational schema for the Postgres adapter, if this ever
  needs to scale past what one JSON blob per deployment comfortably
  handles (see "Persistence" above) — a bigger redesign, deliberately not
  done preemptively
