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
log into it.

## Attorney review-gate UI — "Docket"

`src/review-ui/` — the attorney-facing app over `review-gate.ts`
(§8 build order step 5), plus `src/core/work-product-store.ts`, the
in-memory registry that makes drafted `WorkProduct`s discoverable (a
`ParalegalDraftingSession` given a `store` registers into it automatically).
Branded **Docket**: one app shell (sidebar nav, no full-page reloads
between sections) over five panels — Review Queue, Deadlines, Scheduling,
Live Intake Demo, and Accounts (attorney-only, hidden from the nav for
every other role).

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
- `server.ts` — a small dependency-free JSON API (Node's built-in `http`,
  no framework) over the service, plus static-file serving for the
  dashboard. Actor identity comes from an `httpOnly` session cookie set by
  `POST /api/login` and validated against `AuthService` on every request
  (see "Real authentication" above) — or from an `x-system-api-key` header
  for the calendar integration's machine credential. `GET /` redirects to
  `/login.html` when there's no valid session; `POST /api/logout` clears
  it. `/api/intake/*` and `/api/accounts*` are 404 if no
  `IntakeDemoSessions`/`AccountsService` was passed to
  `createReviewServer`, respectively. `npm run build` copies `public/`
  into `dist/` since `tsc` only compiles `.ts` files.
- `public/login.html` — Docket-branded sign-in: username/password + a
  "remember me" checkbox, posting to `/api/login`.
- `public/index.html` — the Docket app shell: a dark sidebar (brand +
  panel nav), a top bar showing who's signed in, and one panel each for
  the Review Queue (list/detail/approve/reject/request-revision/
  clear-flag/release), Deadlines (status check/independent confirmation/
  conflict list), Scheduling (book/list/reschedule/cancel/complete/
  reminders), Live Intake Demo (a chat window driving `intake-demo.ts` —
  "Start new demo conversation" then type caller turns), and Accounts
  (add a login, disable/re-enable one — nav item stays `hidden` unless
  `GET /api/me` reports role `attorney`, though the real gate is
  server-side in `AccountsService`, not this client-side hide). Any `401`
  from the API redirects the browser back to `/login.html`.
- `start.ts`'s boot-time bootstrap: if no accounts exist yet in the
  persisted state, it creates them from `ATTORNEY_USERNAME`/
  `ATTORNEY_PASSWORD` (and optionally `PARALEGAL_USERNAME`/
  `RECEPTIONIST_USERNAME`/`STAFF_USERNAME` with matching `_PASSWORD`
  vars) — this is only for getting the very first attorney account into
  an empty system; it's a no-op forever once any account exists. Anything
  after that goes through the Accounts panel. `start.ts` also sets the
  calendar-integration system key from `CALENDAR_SYSTEM_API_KEY`, or
  generates and logs a random one on first boot if that's unset, and
  constructs the `IntakeDemoSessions`/`AccountsService` wired into the
  server (the former sharing the real audit log with its own dedicated
  `AccessControl` instance and the criminal-law pilot module).

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
  work-product store, deadline tracker, scheduling service, and auth into
  one document via `loadSystemState`/`saveSystemState`, which accept
  either a `StateStore` or (for convenience/backward compatibility) a
  plain file-path string.
- Every stateful core object (`AuditLog`, `UtilizationTracker`,
  `WorkProduct`, `WorkProductStore`, `DeadlineTracker`,
  `SchedulingService`, `AuthService`) has `toSnapshot()`/`fromSnapshot()`
  round-tripping its exact state to plain data — including `WorkProduct`
  states like `approved`/`released` that the normal constructor and
  transition methods can't reach directly. A rehydrated `WorkProduct` is a
  fully functional, rule-enforcing object afterward (content still locks,
  unresolved flags still block approval), not just replayed JSON; a
  rehydrated `SchedulingService` still enforces double-booking checks.
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
```

## §7 open items — status

1. **Deadline/calendar redundancy** — resolved in code, see above
   (`core/deadline.ts`). The "any string can call itself
   `calendar_system`" gap is now closed technically — see "Real
   authentication" above — but there's still no real calendar *vendor*
   behind that credential (no Google/Outlook/etc. integration exists to
   issue it automatically), and it still needs sign-off from someone who
   actually calculates these deadlines in practice before trusting it with
   real dates.
2. **Full criminal-law templates/intake questions** — resolved in code,
   see `criminal-law/index.ts`. Still needs review by a practicing
   criminal defense attorney before real use — this is a reasonable seed
   set, not a jurisdiction-vetted one.
3. **Testing/red-teaming plan** — resolved as an initial pass, see
   `docs/red-teaming-plan.md` and `test/red-team-scenarios.test.ts`. The
   plan explicitly calls for human adversarial testing before real-client
   launch; the automated suite is a regression floor, not a substitute.

## Not yet built

All six numbered steps of §8's build order are implemented (chat, then
voice, for the receptionist). Persistence, TLS-aware cookies, and account
management are resolved (see "Persistence" and "Real authentication"
above). Still open:

- A real STT/TTS vendor integration behind `SpeechToText`/`TextToSpeech` —
  `voice-agent.ts` only has the interfaces and a test double so far, per
  §5's vendor due-diligence checklist (not yet completed for any vendor)
- A real calendar *vendor* integration issuing/rotating the system API key
  automatically (`core/auth.ts`'s `verifySystemApiKey` is the enforcement
  point now — see "Real authentication" above — but no Google/Outlook/etc.
  integration exists yet to be the thing presenting that key)
- The rest of account management: password reset, MFA, and self-service
  invites (adding/disabling users after the one-time boot-time seed *is*
  built — see `AccountsService` above)
- A normalized relational schema for the Postgres adapter, if this ever
  needs to scale past what one JSON blob per deployment comfortably
  handles (see "Persistence" above) — a bigger redesign, deliberately not
  done preemptively
- Human/domain-expert sign-off on all three §7 items before real-client
  use — see the "§7 open items — status" section above
