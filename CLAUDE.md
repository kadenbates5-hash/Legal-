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
  **A cleared flag is a sign-off on the text, so a rewrite re-raises it.**
  It used to survive a revision. An attorney could clear the Padilla flag
  on a memo that carried the advisory and ask for changes, and the
  rewrite (advisory gone, by the paralegal or the Assistant) could then
  be approved with nothing left to stop it. `reviseDraft()` now restores
  every flag cleared since the text last changed, when the text actually
  changes, and audits it as `flags_reraised`. The Drafting panel says so
  when it happens. Cleared flags are kept in the snapshot
  (`clearedFlags`). A snapshot written before that recovers them from
  the audit log, failing closed: an unapproved draft whose flag was
  cleared and then rewritten under the old code gets the flag back at
  load. `test/flag-reraise.test.ts` pins it.
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
- `acknowledgements.ts` — **natural phrasing**, the confirmed follow-up
  to the Live Intake training work: Claude may put *one short
  acknowledgement* ("I understand, that sounds really stressful.") in
  front of an ordinary intake question, and nothing else. The design is
  the limit on what it can touch:
  - `ReceptionistChatSession` marks only an intake-question turn after
    the first `acknowledgeable` (`ChatTurnResult`). Greeting,
    caller-type, consent, conflict, every escalation, every handoff and
    the wrap-up never reach this code, and the question after the
    acknowledgement is always the exact script. Routing has already
    happened by the time an acknowledgement is requested, so nothing
    the model says can change a decision.
  - `vetAcknowledgement()` checks every sentence before anyone sees it:
    one sentence, letters/commas/apostrophes/dashes only, at most 16
    words, no question (with or without a `?`), no number or date or
    weekday or timeframe, and a broad block-list covering advice,
    outcomes, reassurance, promises, the law/case/firm, fees, and
    identity claims. Failures are dropped, never repaired. A timeout
    (3.5s), API error or `NONE` also gives the plain script, which is
    what the receptionist said before this existed.
  - The caller's words go to the model as tagged data with `<`/`>`
    stripped, and the prompt says to ignore instructions in them — but
    the validator is the real defence. Verified live: a fake model
    induced to answer "You are not guilty, an attorney will call you"
    had that line dropped and the plain question delivered.
  - Opt-in on its own flag, `INTAKE_NATURAL_PHRASING=true` (plus
    `ANTHROPIC_API_KEY`), not implied by the Assistant panel's key,
    because it sends caller text to Anthropic. Wired only into the Live
    Intake Demo for now (`IntakeDemoSessions.respond()`, a per-
    conversation checkbox, `GET /api/intake/capabilities`); the panel
    shows the added words in italics and the transcript records them,
    so a trainee can always see which words were the script. Putting it
    on a real channel (`voice-agent.ts`, a chat widget) means real
    caller words leave the building, so §5's vendor due-diligence
    applies first.
- `side-questions.ts` — what callers say *between* answers:
  `classifySideQuestion()` (a question back: "are you a robot?", "how
  much do you charge?", "sorry, what?") and `classifyConsentAnswer()`
  (yes / no / unclear to the recording disclosure). Only a message with
  no escalation signal at all reaches either — emergencies, legal
  questions and opt-outs always take the normal path first. A side
  question gets a brief answer from `sideAnswerFor()` (what the
  assistant is, honestly; that fees are for the attorney; the firm's
  configured hours/address; why we ask) and the *same* question again,
  with nothing advanced; two in a row are answered, a third hands off to
  a person, so a call can't circle.

### Stress-testing intake (and what it found)

`test/intake-stress.test.ts` runs the real `ReceptionistChatSession`
over a corpus of how callers actually talk — every emergency phrasing in
seven variants (as written, ALL CAPS, lower case, a filler, a plea,
doubled spaces, a phone's curly apostrophe) at every point in a call,
legal questions at every point, a benign set that must *not* end the
call, and 1,500 seeded-random conversations of gibberish, emoji, other
languages, 3,000-character messages, questions back and repeats. Those
must never throw, never reply with nothing, always finish within a
computed bound, and stay finished. Its first run found the receptionist
was far less safe than its tests said:

- **Most emergencies didn't escalate.** The extractor only knew a few
  first-person phrasings. "My husband is in jail right now", "IM IN
  JAIL", "I'm calling from jail", "the police are at my door right now",
  "my arraignment is in 2 hours", "I took a bunch of pills", "my
  boyfriend is hitting me right now" — all missed, opening the call or
  mid-intake; "IM IN JAIL" in reply to "Are you currently in custody?"
  carried on with intake. A relative calling about someone in custody,
  the most common emergency call, never escalated at all.
  `signal-extraction.ts` now covers third parties, places, booking,
  bail, police at the door, every court word (hearing, arraignment,
  trial, judge…) with timing parsed from words ("in two hours"),
  tonight/tomorrow, weekdays and dates against the session clock, more
  protective-order types, and much more crisis language. Over-escalating
  stays the intended failure mode, with three narrow guards so ordinary
  answers don't: a match negated in the three words just before it ("I'm
  not in jail", "I've never been arrested") doesn't count — a bare "no"
  earlier doesn't negate, so "No, my husband is in jail" still escalates;
  the caller's *own past* arrest ("I was arrested last year") is a
  narrative, not custody, while someone else's arrest, being booked, or
  being held still is; and "booked" only counts as "booked in/into".
  Crisis wording is never negation-guarded.
- **"No." counted as consent to recording**, as did "nope", "I'd rather
  not" and "what do you mean recorded?" — only a few explicit refusal
  phrases stopped it. Consent now takes a yes; a no (bar "no problem"
  and friends) is a refusal; anything else is asked once more, then
  handed to a person *without* recording. One-party-consent firms keep
  notice-only behaviour. The decision is made after routing, so an
  emergency in the same message always wins over a refusal — previously
  a refusal returned before emergencies were even checked.
- **A question back could skip the custody question.** "are you a
  robot?" in reply to "Are you currently in custody?" was stored as the
  answer and intake moved on. Side questions (above) now never advance.
- **Most new clients got the third-party brush-off.** Only the literal
  words "new client" identified one, so "I got a DUI last night and need
  a lawyer" ended in "I can't share case details, but I can pass along a
  message". First-person needs now identify a new client (third party is
  still checked first, so a relative is never mistaken for the client),
  an unidentified caller is asked once who the call is about, and one
  still unidentified gets a message-only ending without the "can't share"
  line.
- **Doubled spaces and curly apostrophes defeated every pattern.**
  `normalizeCallerText()` collapses whitespace and straightens quotes
  once, before any matching.

**A second round** widened the corpus to how people actually type and
talk outside the textbook phrasing — and found 38 more emergencies that
never escalated, at any point in a call:

- *Texting shorthand*: "hes in jail rn", "court 2moro", "court is in
  1hr", "the police wanna talk to me", "kms". `expandShorthand()` now
  rewrites shorthand ("2moro", "rn", "wanna", "kms", "5-0", and
  apostrophe-less contractions like "isnt", so the negation guard still
  sees them) before the escalation patterns run — and *only* there:
  party names for conflicts screening come from the caller's own words,
  where turning "R" into "are" would mangle them.
- *Slang and regional custody*: "he's at county", "behind bars", "got
  nicked… in the cells", "remanded", "the cops picked him up", "taken
  in", "cuffed", "they won't let me leave", ICE/immigration detention.
  "At county" deliberately excludes county court, the clerk and the
  courthouse.
- *Protective-order abbreviations*: TRO, RO, PFA, DVRO, "order of
  protection" — and contact with the protected person ("she has a no
  contact order and I texted her") now counts as the issue, as does an
  order newly taken out against the caller.
- *Crisis in the past tense and nearby weapons*: "my husband just hit
  me", "my ex is outside with a gun", "ending my life", "unalive
  myself". A weapon only counts when it's *here* (outside, at the door,
  coming over) — "I got caught with a gun in my car" is an ordinary call
  to a criminal practice, not a crisis, and is pinned as benign.
- *Code-switching*: Spanish custody ("mi esposo está en la cárcel", "lo
  arrestaron anoche"), police ("la policía está en mi casa"), court
  ("tengo corte mañana") and crisis ("me quiero morir"), with a Spanish
  "no" before the verb read as a denial.
- *Rambling openers*: an emergency buried at the end of a long
  paragraph still escalates (it did; now it's pinned).

Two false alarms were fixed along the way: "lol no he's not locked up"
(the word between the verb and "locked up" can no longer be the
negation itself), and — introduced by this round, caught by the
existing suite — "No, there's no protective order against me", now
read as denying the order. Every new phrasing runs in all seven variants
at all seven points in a call, like the first round.

The "Family member calling on someone's behalf" training scenario's
script changed as a result: its old opening ("my son, he's been
arrested") is now, correctly, a custody emergency, so it no longer
reached the confidentiality default it exists to show.

**A third round** asked what a voice call actually delivers: a
speech-to-text transcript — lower case, no punctuation, fillers and
stutters left in, numbers spelled out, and the same few words misheard
every time. Every emergency phrasing from all three rounds now also runs
as a transcript (as transcribed, without apostrophes, with a filler
mid-phrase, with a false start) at every point in a call. Its first run
found:

- *A filler in the middle of a phrase defeated almost everything.* "i
  want to uh die", "in uh like an hour", "i'm scared he's gonna uh kill
  me" — every multi-word pattern broke on the "uh". `expandShorthand()`
  now drops vocal fillers and collapses stutters ("i i", "my my
  husband") first, still only for escalation matching.
- *Minutes and spoken dates weren't understood at all.* "court in
  thirty minutes", "my court date is in forty five minutes", "the twenty
  sixth", "november twenty-sixth", "the 26th of november" — none
  escalated. `parseHoursUntil()` now reads minutes (any count is "within
  the hour"), spoken numbers past twelve including compounds ("forty
  eight"), and ordinal dates after "the" or a month — a bare "the
  fifth" is this month's if still to come, otherwise next month's
  (December's rolls into January). "My second arrest" stays a count.
- *The words transcription mishears on exactly the calls that matter.*
  "arraignment" → "arrangement", "court" → "cord", "bail" → "bale",
  "arrested" → "a rested", and TRO/PFA/DVRO/FBI said letter by letter.
  Each is repaired only where context makes the legal word likely ("my
  arrangement", "have cord", "cord tomorrow"). "Court" is deliberately
  never recovered from "caught": "I got caught…" opens half the calls to
  a criminal practice.
- *Phrasings no round had tried:* "bail my son out", "incarcerated",
  "an officer is coming by", "he's got a knife and he's here", "a whole
  bottle of pills", "killing myself", "I just want it all to stop".

A benign set of transcribed answers — denials with stutters, court dates
three days or more out, "my second hearing", "bail out of this
contract", a past "he used to hit me" — is pinned not to end the call.

**Weekdays and dates are the firm's.** `parseHoursUntil()` counted "on
Monday" and "the 27th" from the *server's* day. Most hosts run in UTC,
which is already tomorrow from 7pm in New York and still yesterday
until 11am in Sydney. So "court on Monday", said early on a Saturday in
Sydney, came out as 72 hours away and never escalated, and in New York
"my hearing is the 27th", said on the evening of the 27th, read as next
month. It now counts from the firm's calendar day (`calendarDayIn()`,
`timeZone` on `ReceptionistChatSession`, from `FIRM_TIME_ZONE` or the
firm config's business-hours zone). It still errs early as before. A
zone the runtime doesn't recognise falls back to the server's day rather
than failing the call. Verified live on a UTC host with the firm set to
Honolulu: "my court date is the 27th" escalated on the 27th there. See
"The firm's day" below.

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

**The Padilla flag fails closed, from the matter record.** §3 says plea
drafting for a noncitizen client "must hard-trigger an immigration-
consequence advisory flag ... not rely on someone remembering to check",
yet the flag fired only when a request carried `clientIsNoncitizen:
true`. Nothing in Docket ever sent that: the Drafting panel had no such
field and the Assistant's `draft_from_template` took no context. So no
plea memo drafted in Docket was ever flagged. The protective-order flag
was out of reach the same way. Now:

- `Matter.clientCitizenship` (`us_citizen` / `noncitizen` / `unknown`)
  is recorded on the Conflicts panel's matter form. Editing it is
  attorney-only and audited with the rest of the record.
- `DraftingService.draftFromTemplate()` passes the recorded value to the
  module as `clientCitizenship`, overriding anything the request says.
  The criminal-law module flags a plea memo **unless the record says
  U.S. citizen**. Unknown counts as not known to be a citizen. A request
  can add the flag (`clientIsNoncitizen: true`) but never remove it, so
  neither a paralegal's request body nor the Assistant can talk it
  away.
- The Drafting form says up front why a plea memo arrives flagged, and
  has a "Covered by a protective order" checkbox. The Assistant's tool
  gained `protectiveOrderMaterial`. Both can only add a flag.
- `test/padilla-trigger.test.ts` pins each path, over HTTP too. This
  changes the signed-off criminal-law content in one direction only: it
  flags more plea memos than the old rule did (every one where
  citizenship isn't recorded), never fewer.

`src/core/document-store.ts` — `DocumentStore`, a registry of uploaded
case documents (a contract, exhibit, or scanned form a paralegal names and
stores against a matter) — separate from `WorkProductStore`'s
agent-drafted text. Content is stored as a base64 string directly on the
record, matching this project's single-JSON-blob persistence model, so
`toSnapshot()`/`fromSnapshot()` round-trip a document like every other
stateful core object. No access control lives here, same split as
`WorkProductStore`. A document's file name and type come from the
browser and go straight back out in a download's headers, so `upload()`
keeps the name on one line (control characters dropped, at most 255
characters) and stores the type as a bare `type/subtype`, or as
`application/octet-stream` when it isn't one. A type with a line break
in it made the file impossible to download, since Node refuses the
header. The content itself must be base64 (`normalizedBase64()`):
anything else used to be stored as sent and only went wrong at
download, because Node's decoder skips characters it doesn't know and
decodes the rest — so a value that was never base64, or one still
carrying its `data:application/pdf;base64,` prefix (whose letters are
valid base64), came back as a quietly corrupt file. Line breaks and a
data-URL prefix are taken off, since what was meant is clear; anything
else is a 400.

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
  appointments. The length is checked before the overlap test, because
  it decides what overlaps: a duration of -30 minutes overlapped nothing
  (a way around the rule) and one of a billion minutes overlapped every
  booking that attorney could ever have — from one request any
  receptionist could make. An appointment is now 1 to 1,440 minutes and
  its start a real time; either mistake is a 400 (`SchedulingError`
  gained a `kind`), not a 409 or "Invalid time value".
- **A booking time says which moment it means.** The routes read
  `startTime`/`newStartTime` with `new Date(text)`, which takes a time
  without a zone in the *server's* zone: "2026-12-01T10:00" from an API
  caller or the assistant booked 10am UTC, 5am in New York. Every time
  that becomes a record now goes through `core/instant.ts`'s
  `parseZonedInstant()` — a date and time with `Z` or an offset, or a
  400 saying so. The dashboard was never affected (it converts the
  local picker to an instant before sending); the time clock's punch
  corrections use the same check.
- The Scheduling panel's booking form gained an **Attorney** picker. It
  had none, so a firm whose firm config lists no attorneys couldn't book
  a consultation from the panel at all — every attempt ended in "no
  attorney available". The first option keeps auto-assignment from firm
  settings; an attorney booking defaults to themselves.
- Computes reminder due-times (default: 24h and 1h before) as plain data —
  `getDueReminders(actor)` returns what's due right now for a host
  process to poll and actually send. Sending itself is a vendor
  integration (email/SMS) — see "Appointment reminder emails" below for
  the vendor now built, same reasoning as `voice-agent.ts` staying
  vendor-agnostic for STT/TTS applies to `scheduling.ts` itself staying
  vendor-agnostic here. Firm-wide by nature (a reminder-sending job needs
  every due reminder in one pass), so the `"system"` role sees everything
  unscoped, same as `listPendingCalendarSync()`; every other role gets
  the same matter-scoped, silently-omitting filter as `listAll()` — this
  same method also backs the in-app Scheduling panel's "Coming due" card,
  which a receptionist or paralegal reads day to day, so it can't simply
  be system-only the way `listPendingCalendarSync()` is.
  `markReminderSent()` is restricted to the `"system"` role outright
  (mirroring `recordCalendarSync()`) and returns the updated `Appointment`
  directly rather than making the caller re-fetch it — the system
  credential has no `"scheduling"` grant in `AccessControl`, so a
  `get(actor, id)` afterward would deny the very actor that just
  succeeded. Both were unscoped/unauthenticated for a period, closed
  alongside the sending job below.
- Enforces `AccessControl`'s existing `"scheduling"` category when
  constructed with one — receptionist role is already scoped to
  `intake`/`scheduling` fields (§5), so this reuses that gate rather than
  inventing a new one. `system-state.ts` wires the canonical, persisted
  `AccessControl` instance into `SchedulingService.fromSnapshot` by
  default (the same instance `DraftingService`/`AccountsService` share),
  so real paralegal assignments and client grants apply to scheduling the
  same as everywhere else — this was **not** always true: for a period
  `start.ts` never passed an `AccessControl` to scheduling at all, so
  every appointment read and mutation (book/reschedule/cancel/complete/
  list/get) was completely unauthorized for every role, made materially
  worse once the client role existed (any client account could see or
  cancel any other client's or matter's appointments firm-wide). Fixed by
  wiring the default and by giving every read method actor-based
  filtering it never had: `get()`/`listByMatter()` throw
  `AccessDeniedError` for a matter the actor can't reach (a caller asking
  about one specific id/matter gets a clear denial, not a confusing empty
  result); `listAll()`/`listByAttorney()` — cross-matter views by nature —
  silently omit inaccessible matters instead, the same
  don't-confirm-what-exists reasoning `CasesService`/`SearchService`
  already use; `listPendingCalendarSync()` is restricted to the
  `"system"` role outright, since the sync engine's whole point is a
  firm-wide read no per-matter filtering makes sense for. `toSnapshot()`
  still reads the raw, unscoped map directly — persistence is not an
  actor.
- `toSnapshot()`/`fromSnapshot()` follow the same persistence pattern as
  every other stateful core object — wired into `system-state.ts` and the
  dashboard's "Scheduling" panel.

### Self-service public booking (`/book.html`)

`core/booking-requests.ts` / `review-ui/booking-service.ts` /
`public/book.html` — a page a prospective client can use to ask for a
consultation without phoning. Opt-in on its own flag,
`PUBLIC_BOOKING=true`, because it's the first form in this app anyone on
the internet can submit; absent, `/api/public/booking/*` and
`/api/booking-requests*` both 404 and the page says online booking isn't
available.

- **A request, never an appointment.** Nothing a member of the public
  submits reaches a calendar by itself. Staff accept a request from the
  Scheduling panel's "Online booking requests" card, choosing the exact
  time and attorney, and only then is an `Appointment` booked through
  `SchedulingService` — business hours and double-booking enforced
  exactly as for any other booking, and *before* the request is marked
  accepted, so a refused booking leaves it pending rather than claiming a
  time nobody holds. The appointment's matter id is
  `prospective-<requestId>`.
- **No "what happened" box.** It asks who they are, how to reach them
  (email or phone), a matter *type* from a fixed list, a preferred day
  and part of day, and the other party's name — the last only for the
  conflicts screen. Inviting a stranger to narrate facts pre-retention is
  exactly what the receptionist's `pre_retention_factual_narrative`
  trigger stops, and a web form shouldn't undo that. Names are validated
  to look like names, so the other-party field can't carry a narrative,
  a link or markup either. A day must be a real one ("2026-11-31" used
  to pass, sorting inside the 60-day window), and a box that's too long
  is named in the reply ("Your name can be at most 100 characters.") —
  the form's own `maxlength` stops it first; the message is for anything
  posting to the route directly.
- **Conflicts are screened on arrival, and never disclosed.** The
  requester is screened as the would-be client and the other party as
  adverse, against every matter (Rule 1.10, same `ConflictChecker` as
  everywhere else). The requester always gets the same "received"
  answer — saying "we can't take you" would itself reveal that the firm
  represents someone. Staff see the hits with their explanations, and a
  flagged request **can only be accepted by an attorney**.
- **Urgent situations aren't submitted at all.** A "someone is in custody
  / police want to question / court within two days" box replaces the
  form with "call us now" and the firm's letterhead phone (and 911 for
  danger), so an emergency never waits in a queue.
- **Abuse controls**: per-IP `SubmissionLimiter` (5 an hour by default,
  a sliding window rather than `LoginThrottle`'s failure-and-lockout
  model), a cap of `BOOKING_MAX_PENDING` (200) undecided requests after
  which the form says to call, and an off-screen honeypot field whose
  submissions get the identical "received" answer and are stored nowhere.
- Audited: `booking_request_received` (as the `anonymous` actor
  `public-booking-form`), `booking_request_accepted`,
  `booking_request_declined`. Staff routes are receptionist/paralegal/
  attorney; `client` and `system` are refused. Persisted as
  `bookingRequests` in `system-state.ts`.

What this doesn't do: show live free/busy slots (deliberately — a public
page shouldn't expose attorneys' calendars; staff pick the time), email
the requester a confirmation (staff contact them; the appointment's own
reminders take over once booked), or take payment or a retainer.

### Appointment reminder emails and SMS (closing the "send it" gap)

`src/integrations/appointment-reminders.ts` — `AppointmentReminderSender`,
the vendor now behind the gap `scheduling.ts` always left open ("sending
them is a vendor integration... deliberately out of scope"). Now that an
`EmailSender` already exists for invoicing (see "Invoicing, payments, and
staff payroll" below), closing it is the same shape as the calendar sync
engines: a standalone process that reads from and writes back to
Docket's own HTTP API using the `x-system-api-key` credential, never a
shortcut straight into `SchedulingService`.

- **Where the recipient address comes from.** A reminder has an
  `attorneyId`/`matterId`, not a client contact — the client's email
  lives on the matter's client party, the same field
  `InvoicingService`/`billingEmailFor()` already use to mail an invoice.
  `MattersService.clientEmailFor(actor, matterId)` is a new, narrow read
  restricted to the `"system"` role (same gate as
  `recordCalendarSync`/`confirmDeadline`'s calendar-system source) —
  handing a machine credential the one address it needs is a smaller
  grant than the ordinary `get()`'s full `case_file` category (adverse
  parties, status, description). It's never audited on its own, same as
  `InvoicingService`'s internal `#clientEmail` — supporting data for a
  read that's already accounted for, not a new disclosure surface.
- **The enrichment lives in the route, not the sender.**
  `GET /api/appointments/reminders/due` attaches `recipientEmail` to
  each entry only when the caller is the `"system"` role — a
  receptionist/paralegal reading the same in-app "Coming due" card gets
  the plain, unenriched list, since nothing in the UI has ever shown or
  needed a client's email there. This keeps `clientEmailFor` itself
  strict (no "trust the caller already scoped this" shortcut) while
  still giving the one legitimate caller — the sending job — everything
  it needs in a single request.
- `AppointmentReminderSender.run()` fetches the enriched due list, skips
  any entry with no deliverable channel (`result.skipped`, not a
  failure — there's simply nothing to send), sends via whichever of
  `EmailSender`/`SmsSender` applies, and marks each one sent via
  `POST /api/appointments/:id/reminders/:reminderId` on success. A
  per-reminder failure is recorded rather than aborting the run, the
  same pattern as `AppointmentCalendarSync`/`CalendarDeadlineSync`. A
  mail/text failure after all is deliberately not distinguished from a
  mark-sent failure: either way the reminder stays unsent and the next
  run retries it — better to occasionally re-send a reminder than to
  silently drop one. `renderReminderEmail()`/`renderReminderSms()` are
  exported standalone for the same reason
  `buildAppointmentEventBody()`/`parseDeadlineEvent()` are: the wording
  is unit-testable without a live Docket instance or mail/SMS transport.
- **SMS is a second channel alongside email, not a replacement.**
  `integrations/sms-sender.ts` is the vendor-agnostic `SmsSender`
  interface (mirroring `EmailSender`'s shape exactly); `twilio-sms.ts`'s
  `TwilioSmsSender` is the real implementation, reusing the *same*
  `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN` credential the voice channel
  already authenticates with (see "Telephony integration — Twilio"
  below) — a firm with Twilio already set up for voice needs only one
  more var, `TWILIO_SMS_FROM_NUMBER`. `MatterParty` gained a `phone`
  field alongside `email` (same "client party only, never adverse"
  reasoning, exposed as `MattersService.clientPhoneFor()` and the route's
  `recipientPhone` enrichment, both mirroring the email versions
  exactly) — edited in the Conflicts panel's party textarea as
  `Name <email@example.com> [+15551234567]`, the bracket an addition to
  the existing `<email>` shape. A client with only a phone on record
  still gets reminded once an `SmsSender` is configured, same as a
  client with only an email always has; a reminder is marked sent the
  moment *either* channel delivers it, and a phone on file with no
  `SmsSender` configured is a skip, not a failure — it simply isn't a
  channel this deployment can use yet.
- `src/integrations/send-appointment-reminders.ts` is the standalone
  entry point (`npm run send:reminders`), deliberately its own process
  rather than running inside the main server — same reasoning as
  `sync-calendar-deadlines.ts`. Configured via `SMTP_HOST`/`SMTP_FROM`
  (plus the usual optional `SMTP_*` vars), `DOCKET_BASE_URL`/
  `DOCKET_SYSTEM_API_KEY`, and an optional `FIRM_NAME` used in the
  reminder's subject/body, plus optional
  `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN`/`TWILIO_SMS_FROM_NUMBER` to
  also text.

What this doesn't do: let a client reply to change the appointment —
the email/text both say so explicitly and point back to calling the
office — or support any SMS carrier besides Twilio yet, though
`SmsSender` is the seam a second one would implement.

### Proactive deadline-risk alerts (closing the "somebody has to look" gap)

`src/integrations/deadline-alerts.ts` — `DeadlineAlertSender`, the same
"host process polls Docket's own API" shape as
`AppointmentReminderSender`, aimed at the deadline side instead of
appointments. The Deadlines panel's "Coming due" list (see "What's
coming due" below) is only useful to someone who opens it, and per this
project's own stated rationale, "missing a deadline is the most common
malpractice claim there is" — a risk-ranked list nobody is looking at
doesn't reduce that risk.

- `ReviewGateService.listUpcomingDeadlines()` is now reachable by the
  `"system"` machine credential in addition to an attorney — an inline
  `actor.role !== "attorney" && actor.role !== "system"` check at that
  one call site, not a change to the shared `requireAttorney()` helper
  every other method on the class still uses unmodified and must stay
  strictly attorney-only. `/api/deadlines/upcoming` needed no server.ts
  change at all: it already passed `actor` straight through with no
  route-level gate of its own.
- **Routed to each matter's actual responsible attorney**, not one
  firm-wide digest to a single recipient (the original, simpler
  design). This needed `User.email` (`core/auth.ts`) — an optional
  staff email, set via `AccountsService.setEmail()`/`POST
  /api/accounts/:id/set-email` or at account creation, surfaced in the
  Accounts panel next to each account ("Set email"/"Change email").
  `/api/deadlines/upcoming` attaches `responsibleAttorneyEmail` to each
  entry only when the caller is the `"system"` role — the same
  "enrichment lives in the route" pattern as the appointment-reminders
  route's `recipientEmail` — by resolving the matter's
  `responsibleAttorneyId` (`MattersService.responsibleAttorneyIdFor()`,
  gated to `"system"` like `clientEmailFor`) to an address via
  `StaffService.emailForActorId()` (the *opposite* gate of
  `StaffService.list()`: restricted to `"system"` specifically, rather
  than open to every staff human — handing the sending job one address
  is a narrower grant than the whole directory).
- `DeadlineAlertSender.run()` groups the deadlines it fetches by
  `responsibleAttorneyEmail` and sends one digest per attorney — so an
  attorney's digest is their own at-risk matters, not the whole firm's.
  A deadline whose matter has no responsible attorney on record, or
  whose attorney has no email on file, falls back to the optional
  `catchAllEmail` (`DEADLINE_ALERT_RECIPIENT`, now optional — a
  firm-wide distribution list still works there); with neither, that
  deadline is counted in `skipped` rather than silently dropped or
  blocking every other attorney's digest from sending.
- **No "mark sent" state, unlike appointment reminders.** An appointment
  reminder is client-facing and must never double-send; this digest is
  internal and reflects current system state on every run — resending
  the same at-risk deadline on tomorrow's run is the point, not a bug,
  since it's still at risk. `run()` sends nothing at all
  (`{ sent: false, deadlineCount: 0 }`) when nothing is currently within
  the horizon, rather than mailing an empty "all clear" digest daily.
- `renderDeadlineDigest()` is exported standalone for the same reason
  `renderReminderEmail()` is: the wording is unit-testable without a
  live Docket instance or mail transport. It carries the matter id,
  deadline type, date, and confirmation state for every entry, ordered
  exactly as `listUpcomingDeadlines()` already ranks them (urgency, not
  date — see "What's coming due" below) — the digest and the panel can't
  disagree about what matters most since both read the same ranking.
- `src/integrations/send-deadline-alerts.ts` is the standalone entry
  point (`npm run send:deadline-alerts`), deliberately its own process
  rather than running inside the main server — same reasoning as
  `send-appointment-reminders.ts`. Configured via `SMTP_HOST`/`SMTP_FROM`
  (plus the usual optional `SMTP_*` vars), `DOCKET_BASE_URL`/
  `DOCKET_SYSTEM_API_KEY`, `DEADLINE_ALERT_RECIPIENT`, and optional
  `FIRM_NAME`/`DEADLINE_ALERT_WITHIN_DAYS`. Meant to run on a daily
  schedule (e.g. cron), not continuously.

What this doesn't do: suppress a deadline once someone has seen it
(there's no acknowledgment state — the source of truth stays the
Deadlines panel), or replace attorney judgment about which deadlines
matter — it's a nudge to go look, not a substitute for looking.

## Deadline redundancy (§7 open item #1 — resolved)

### What counts as an independent source

The rule is "two independent sources agree". What *independence* means
is the whole feature, and keying it on the source **type** alone
(`agent`/`human`/`calendar_system`) was wrong in a way that quietly
broke it: a second attorney who independently checked a date changed
nothing, because both were `human`. The deadline read "not verified"
forever unless a calendar integration happened to be wired up — a real
check the system refused to count, which teaches people the status is
noise.

`independenceKey()` fixes that without weakening anything:

- the **agent** is one source however many times it calculates,
- the **calendar system** likewise,
- but each **person** is their own source, tracked via
  `DeadlineCalculation.recordedBy`.

So two different attorneys agreeing is redundancy; the same attorney
entering it twice is not; and the agent still cannot confirm its own
arithmetic by running again — the failure the requirement exists to
prevent. Entries written before `recordedBy` existed collapse to a
single identity, so an old snapshot can never become retroactively
"confirmed" by a second check that never happened. All five cases are
pinned by tests.

`ReviewGateService.deadlineVerificationHint()` turns the state into a
sentence, because "unconfirmed" leaves people guessing and the usual
answer — *someone else needs to check this* — isn't something anyone
would infer from the word. It is addressed to the reader: the person who
entered the date is told it needs a colleague; a different attorney is
told that confirming it themselves completes the check.

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

### What's coming due

`DeadlineTracker.listUpcoming()` / `ReviewGateService.listUpcomingDeadlines()`
back the Deadlines panel's "Coming due" card and a Home tile. Missing a
deadline is the most common malpractice claim there is, and a system
that tracked dates without ever surfacing one was only half the feature.

**Ordered by risk, not by date.** A deadline eight days out that two
sources disagree about — or that only one source has ever seen — is a
worse position than a confirmed deadline tomorrow: the confirmed one is
a task, the unverified one is a question nobody has asked yet, and the
window to ask it is what's closing. `deadlineUrgency()` combines time
pressure with a verification penalty, so ranking by date alone can't
bury exactly the rows that need attention. Verified live:

```
 168  m-overdue      2026-07-22   -4d  unconfirmed (OVERDUE)
 111  m-conflict     2026-08-02    7d  conflict
  79  m-confirmed    2026-07-29    3d  confirmed
  70  m-unverified   2026-08-05   10d  unconfirmed
```

Three further behaviours worth naming:

- **A passed deadline keeps appearing.** Filtering by `date >= today`
  would make a missed deadline vanish at exactly the moment it starts
  mattering most; `overdue` is reported instead.
- **A conflict is listed at the *soonest* of its disagreeing dates.** If
  one source says Friday and another says next Tuesday, the firm has
  until Friday to find out which is right.
- **Reading the list writes nothing to the audit log**, so a dashboard
  polling it doesn't grow the log it might later be used to review.

The panel's **"Download CSV"** button exports the same risk-ordered list
currently loaded (matter, type, date, days away, overdue, verification
state) — a weekly-meeting handout, a note for the attorney covering
while someone's out, or a record for an insurer, none of which the
on-screen view alone served. Same client-side, shared-`downloadCsv()`
shape as the Audit Log and Billing panels' exports.

Deadlines only appear once someone records one. The only write path is
`POST /api/deadlines/confirm` (attorney for `human`, the system
credential for `calendar_system`) plus agent calculations that
`ParalegalDraftingSession` records when a draft carries a
`deadlineDate` — there is deliberately no route for recording an
`agent`-sourced date over HTTP, since that source exists to be the one
that needs checking.

**A deadline's date must be a real day.** Coming due, the deadline
digest and the calendar export all find a deadline by comparing its
date with today, and `DeadlineTracker.record()` used to keep whatever it
was sent. So pressing the Deadlines panel's "Confirm" with the date box
empty took an arraignment two days away off all three (the empty date
sorted ahead of the agent's real one), and a draft's deadline written
"next Friday" or "07/29/2026" never appeared at all. A matter id
containing `::` was lost the same way, because the list split its map
key to recover it. `checkDeadlineInput()` now refuses an empty or
unreal date, an unknown type and a blank matter (a 400), and the
drafting session runs it *before* creating the draft, so a refusal
can't leave a draft flagged for a deadline nobody recorded. The panel
also asks for the date before posting. A state file written before
this can still hold an empty date: the list ignores it when choosing a
deadline's date, so the deadline shows on its real date as disputed
(two sources that don't agree) rather than vanishing. `today` and
`withinDays` on `/api/deadlines/upcoming` are checked too — a bad one
used to end in "Invalid time value". `test/deadline-input.test.ts` pins
all of it.

### Calendar file export (.ics)

`core/ics.ts` / `review-ui/calendar-export-service.ts` — a "Download
calendar (.ics)" button on the Deadlines panel's Coming due card and the
Scheduling panel's Appointments card, giving one file any calendar app
imports. No vendor and no key, so it's always on, and it is a separate
thing from the Google Calendar sync below: a person adding dates to their
own calendar, not the firm's integration.

- **No new reads.** Deadlines come through
  `ReviewGateService.listUpcomingDeadlines()` (attorney-only, as on the
  panel) and appointments through `SchedulingService.listAll()`
  (matter-scoped), so a paralegal's file holds their own matter's
  appointments and no deadlines — exactly what their panels show. Both
  buttons fetch the same `GET /api/calendar/export.ics`; the server
  decides the contents from who's asking. Staff roles only.
- **An unverified date never looks verified.** In a phone calendar
  nobody opens Docket to check a status, so the title carries it: a
  date only one source has seen is `UNVERIFIED:`, one the sources
  disagree about is `DISPUTED:` and sits on the soonest proposed date
  with every proposal in its description. Only a confirmed deadline gets
  `STATUS:CONFIRMED`. Deadlines are all-day and don't block time.
- **It leaves the building, so it says little.** Calendar apps sync to
  their vendor's servers. Events carry matter numbers, dates, times and
  the attorney's name — never a matter title (which usually names the
  client), a party or a note. Each export is audited as
  `calendar_exported` with its counts.
- **Re-importing updates rather than duplicates**, mostly: event ids are
  stable hashes, and a cancelled appointment is exported as
  `STATUS:CANCELLED` rather than dropped, so a calendar that already has
  it learns it's off. Some apps import a fresh copy regardless.
- `ics.ts` handles the parts a string join gets wrong: TEXT escaping
  (`,` `;` `\` newline), folding at 75 **octets** without splitting a
  multi-byte character, CRLF throughout, an all-day event's exclusive
  next-day end, and a reminder that isn't a valid duration refusing to
  write a broken file. Deadlines from 30 days ago to a year out;
  appointments from the start of today, completed ones left out.

What this doesn't do: a live subscription feed. A feed URL is a
long-lived credential sitting in a third-party calendar's settings, and
anyone holding it reads the firm's dates; a download is a snapshot the
person chose to take.

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
  domain-wide delegation; per-attorney OAuth as an alternative/addition
  to this shared calendar is now built, see "Per-attorney Google
  Calendar connections" below), hand-rolled as a JWT
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
integration.

### Pushing appointments to the calendar (the other direction — resolved)

The gap named above — `Appointment`s never appearing on the shared
calendar — is now closed, as a genuinely separate, additive piece: it
shares no code path with the inbound deadline sync beyond the JWT bearer
flow in `google-calendar.ts`.

- `core/scheduling.ts`'s `Appointment` gained two fields:
  `calendarEventId` (the vendor's event id, once pushed) and
  `calendarSyncPending` (true on creation and after every reschedule/
  cancel — nothing else in this class ever clears it, since core has no
  idea whether any calendar vendor is even configured). `listPendingCalendarSync()`
  is the sync engine's entire read side; `recordCalendarSync()` is its
  write-back, restricted to the `"system"` role the same way
  `confirmDeadline` requires it for a `calendar_system` source — this is
  a machine recording sync metadata about itself, not a human changing
  what the appointment actually is. An old snapshot with no
  `calendarSyncPending` field defaults to pending, so turning this on
  for the first time catches up on every existing appointment rather
  than silently treating "never recorded" as "already synced."
- `integrations/calendar-event-publisher.ts` — `CalendarEventPublisher`,
  the vendor-agnostic seam for the write direction (deliberately a
  separate interface from `CalendarEventsSource`, which only reads —
  a vendor could reasonably support one without the other).
  `google-calendar.ts`'s `GoogleCalendarEventPublisher` is the only
  implementation, reusing the same service-account JWT flow as the read
  side. `buildAppointmentEventBody()` is exported standalone for the
  same reason `parseDeadlineEvent()` is: the event-shape rules are the
  part actually worth unit-testing without a live Google Calendar.
  Structured data (`extendedProperties.private`: `appointmentId`,
  `matterId`, `attorneyId`, `type`), not the free-text summary, is what
  a future read would key on if one's ever added.
- `integrations/appointment-calendar-sync.ts` — `AppointmentCalendarSync`,
  the vendor-agnostic engine, same shape as `CalendarDeadlineSync` in the
  other direction: it reads `GET /api/appointments?pendingCalendarSync=true`
  and writes back through `POST /api/appointments/:id/calendar-sync`,
  both using the `x-system-api-key` credential like any other API
  client — never a shortcut straight into `SchedulingService`. A
  cancelled appointment with a recorded event gets that event deleted
  and its id cleared; one that was cancelled before ever being synced
  just gets marked done, with nothing to delete. A per-appointment
  failure is recorded rather than aborting the whole run, same as the
  deadline sync.
- `sync-appointments-to-calendar.ts` — the standalone entry point
  (`npm run sync:calendar:push`), deliberately its own process rather
  than running inside the main server, same reasoning as
  `sync-calendar-deadlines.ts`. Configured via the same
  `GOOGLE_SERVICE_ACCOUNT_EMAIL`/`GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`/
  `GOOGLE_CALENDAR_ID` and `DOCKET_BASE_URL`/`DOCKET_SYSTEM_API_KEY` —
  `GOOGLE_CALENDAR_ID` may point at the same calendar the inbound sync
  reads from, or a different one; this project doesn't assume either
  way.

What this doesn't do: read anything back from the events it creates (no
"did someone move this on the calendar" reconciliation — the calendar
event is a one-way projection of Docket's own record, which stays the
source of truth), or push anything for a `"completed"` appointment
beyond keeping its existing event current — there's no notion of
marking an event as historical on the calendar side.

### Per-attorney Google Calendar connections (OAuth — resolved)

The shared service-account calendar above requires every attorney's
appointments to live on one calendar the firm administers. Some firms
instead want each attorney's own Google Calendar to receive their own
appointments — this is that path, built as a genuinely separate,
additive piece alongside the shared-calendar one, not a replacement for
it.

- `integrations/google-oauth.ts` — pure, testable OAuth 2.0
  Authorization Code flow helpers over `fetch`
  (`buildGoogleAuthUrl()`/`exchangeCodeForTokens()`/
  `refreshAccessToken()`/`fetchGoogleAccountEmail()`), the same
  dependency-light call as the service-account JWT flow — no
  `googleapis`/`google-auth-library`. `buildGoogleAuthUrl()` always
  requests `access_type=offline`/`prompt=consent` so a refresh token is
  issued on every connect, never just the first.
- `core/calendar-connections.ts` — `CalendarConnectionStore`, one
  `CalendarConnection` (a refresh token, the connected Google account's
  email, and when) per attorney `actorId`. **This is the first secret
  this project persists inside its own state blob rather than an
  environment variable** — the service-account key, SMTP password, and
  Twilio auth token all live in env vars under the operator's control;
  a refresh token here lives in `system-state.ts`'s snapshot (file or
  Postgres) like every other stateful record. That's a real,
  deliberate trust-boundary difference worth knowing about before
  turning this on, not a design flaw — there's no other place to keep a
  per-attorney secret that both survives a restart and doesn't require
  every attorney to also hold an env-var-editing credential.
- `review-ui/calendar-connection-service.ts` — `CalendarConnectionService`,
  self-service like `/api/mfa/*`/`/api/change-password` (no user id
  param anywhere — it only ever acts on the caller's own connection).
  `beginConnect()` issues a real Google auth URL and stashes a pending,
  short-TTL (10 min), swept, in-memory `{ actorId, expiresAt }` keyed by
  a random `state` value — the same "throwaway call state" pattern as
  `AudioClipStore`/`intake-demo.ts`. That `state` value does double
  duty: it's Google's own CSRF protection, and it's the only way the
  public, cookie-less OAuth callback route learns *which* attorney a
  given `code` belongs to, since Google's redirect carries no Docket
  session. `completeConnect()` redeems a `state` exactly once (replay
  or an unknown/expired one is rejected) and rejects outright if Google
  didn't actually grant a refresh token. `accessTokenFor()` is
  `"system"`-role-only and is the *entire* reason an external process
  never needs the refresh token itself: it performs the refresh
  server-side and hands back only a short-lived access token — see
  below. Every connect/disconnect is audited
  (`calendar_connected`/`calendar_disconnected`), resolving the real
  role from `AuthService` rather than trusting the caller.
- `integrations/per-attorney-calendar-publisher.ts` —
  `PerAttorneyCalendarEventPublisher`, a second `CalendarEventPublisher`
  implementation alongside `GoogleCalendarEventPublisher`, selected by
  the standalone push-sync script (see below) rather than core. For a
  given appointment's `attorneyId` it resolves a fresh access token
  through the system-only token route and writes directly to that
  attorney's own `primary` calendar; for an attorney with no connection
  on file it delegates to an optional `fallback` publisher (typically
  the existing shared `GoogleCalendarEventPublisher`) if one is
  configured, so a firm migrating to per-attorney calendars doesn't
  lose sync for attorneys who haven't connected yet — with no fallback
  configured, an unconnected attorney's push throws (nothing to write
  to) and their delete is a silent no-op (nothing to delete).
  `CalendarEventPublisher.deleteEvent()` gained a required `attorneyId`
  parameter to make this routing possible; the shared-calendar
  implementation simply ignores it.
- **Where the external sync process stays narrow.** `sync-
  appointments-to-calendar.ts` never holds a refresh token, by design —
  it calls `GET /api/calendar-connection/actor/:id/token` with the
  `x-system-api-key` credential, the same pattern every other
  integration in this project already uses for its one piece of
  machine authentication, and gets back a short-lived access token it
  discards after the one push. A new opt-in env var,
  `GOOGLE_CALENDAR_PER_ATTORNEY=true`, switches the script to this mode
  (`GOOGLE_SERVICE_ACCOUNT_*` becomes fallback-only rather than
  required); leaving it unset preserves the exact original
  shared-calendar-only behavior with zero change.
- `server.ts` wires three route groups: `GET /api/calendar-connection`
  (status), `POST /api/calendar-connection/begin`/`/disconnect`
  (self-service, any logged-in role — connecting someone else's
  calendar has no legitimate use), the public, session-less
  `GET /api/calendar-connection/callback` (Google's own redirect
  target — on success or failure it redirects back into the app with a
  `calendarConnected=1`/`calendarError=...` query flag rather than ever
  rendering its own page), and the system-only
  `GET /api/calendar-connection/actor/:id/token`. All 404 if no
  `CalendarConnectionService` was passed to `createReviewServer`.
- The Security panel gained a Google Calendar card (next to the
  existing MFA controls): a connected/not-connected badge, a "Connect
  Google Calendar" button that navigates the whole page to Google's own
  consent screen (not a popup — this is a full OAuth redirect, matching
  how Google's own consent flow expects to run), and a "Disconnect"
  button once connected. Landing back on `/?calendarConnected=1` or
  `/?calendarError=...` shows a toast, switches to the Security panel,
  and strips the query string via `history.replaceState` so reloading
  the page doesn't re-show the toast.
- `start.ts` constructs `CalendarConnectionService` only when
  `GOOGLE_OAUTH_CLIENT_ID`/`GOOGLE_OAUTH_CLIENT_SECRET`/
  `PUBLIC_BASE_URL` are all set — the same "absent config means the
  surface doesn't exist" pattern as every other optional integration —
  deriving the OAuth redirect URI from `PUBLIC_BASE_URL` automatically.
  `persistence/system-state.ts` snapshots `CalendarConnectionStore`
  alongside everything else.

What this doesn't do: let an attorney choose a calendar other than
their account's `primary` one, refresh-token *rotation* beyond what
Google's own token endpoint does transparently on each use, or
reconcile a per-attorney push against the shared calendar if a firm
runs both at once for the same attorney (the fallback only applies to
an attorney with *no* connection — it doesn't merge or dedupe between
the two destinations for one who has both configured, since that's not
a configuration this feature expects anyone to actually run).

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

### Dashboard "Listen" buttons (a second, much lower-stakes consumer)

`src/review-ui/speech-service.ts` — `SpeechService`, a thin wrapper over
the exact same `TextToSpeech` interface above, reused for something far
simpler than a phone call: reading already-on-screen text back to a
staff member. Not a standalone "type anything, get audio" panel — every
caller already has real text (a draft's content, a chat message, a
scripted reply), so there's no freeform input to abuse. Open to every
logged-in staff human (same "every staff role" meaning as
`messaging-service.ts`'s `requireHuman()`) — receptionist included,
deliberately, since previewing a script line in the Live Intake Demo is
primarily their use case, not an attorney's. Caps text at 4000
characters: this is for one draft/message/line at a time, not
synthesizing a whole brief in one request. `POST /api/speech/synthesize`
returns raw `audio/wav` bytes, 404s without a configured `SpeechService`.

`start.ts` wires it behind its own opt-in, `SPEECH_TOOLS=true` —
deliberately independent of the Twilio voice-channel gate, since a firm
may want dashboard read-aloud without real-call telephony configured at
all (or the reverse). Reuses the same `VOICEBOX_BASE_URL`/
`VOICEBOX_PROFILE_ID` vars either way.

The dashboard's shared `speak()`/`playSynthesizedSpeech()`/
`listenButton()` (`app.js`) back three "Listen" buttons: the Drafting
panel's draft detail view, every message/announcement bubble, and the
Live Intake Demo's agent-reply bubbles specifically — not the demo
caller's own typed lines, since this is a preview of the *script*, not a
transcript reader.

**Two engines, tried in order.** `GET /api/speech/status` says whether
the server has a `SpeechService`; if so, speech is synthesized there
(Voicebox) and played from a `blob:` URL. Otherwise the browser's own
`speechSynthesis` speaks it, so read-aloud works with no voice server at
all. The browser engine **only uses voices the device reports as
`localService`**: some browsers offer network voices (Chrome's "Google …"
voices synthesize on Google's servers), and drafts and messages are
privileged, so read-aloud must never quietly ship them to a third party.
No local voice means no browser engine, and no Listen button — a button
that can't make a sound is worse than none. Each button is also gated by
the same role check the backend enforces.

**Three bugs fixed alongside this, all found by actually trying to hear
it** (each was invisible to the unit suite):

- *Listen had never played anything in a real browser.* The CSP had no
  `media-src`, so media fell back to `default-src 'self'`, which a
  `blob:` URL doesn't satisfy; Voicebox synthesized the audio and the
  browser refused to play it. `media-src 'self' blob:` fixes it without
  touching `script-src` (pinned by `login-security-server.test.ts`).
- *Listen buttons appeared on servers without `SPEECH_TOOLS`*, where
  every click 404ed — fixed by the status check above.
- *`hidden` didn't hide.* `.btn`'s `all: unset` (and `login.css`'s
  `label { display: block }`) reset `display`, which beats the browser's
  own `[hidden]` rule. The Time Clock showed "Clock in" and "Clock out"
  at once, the calendar card "Connect" and "Disconnect", the sign-in
  page the two-factor code field to everyone, and Live Intake the
  natural-phrasing checkbox on servers that can't offer it. Each
  stylesheet now opens with `[hidden] { display: none !important; }`.

**Live Intake read-aloud.** A "Read replies aloud" toggle speaks each
receptionist reply as it arrives, queued so replies never talk over
each other. "Play a sample call out loud" picks the selected scenario
(the routine call if none is chosen) and plays the whole call: it waits
for the receptionist to finish, speaks the caller's scripted line in a
second voice, sends it through the real session, and repeats. "Stop"
silences it mid-call without ending the conversation, and starting a new
conversation always cancels the old one's audio. A status line says
which engine will speak, or why none can. Verified live against a fake
Voicebox (every line synthesized and played, in turn order), a fake
device voice list that included a default network voice (never used),
and a voiceless headless browser (controls disabled, no dead buttons).

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
  Its fields are a bookmark's size — citation and title at most 1,000
  characters (room for every parallel citation "Save to matter" joins),
  a note at most 5,000 — and a link must be an http(s) address. The
  panel already refused to render any other link, but the client file
  export hands the record out with no such filter.
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
- **It knows what day it is, and where.** The model has no clock, so
  "book a consultation tomorrow at 10" was a guess at the date from its
  training, written as a time with no zone that the server read as UTC.
  Every request now ends the system prompt with `firmClockContext()`:
  today's date and time in the firm's zone (see "The firm's day"), its
  UTC offset, and an
  example of a time written with it. The booking tools' times must carry
  a zone, and one without comes back to the model as a tool error it can
  correct — verified against a fake Claude server, which asked for
  "2026-11-30T10:00", got the error, retried with `-05:00` and booked
  15:00Z, 10am in New York. `test/zoned-times.test.ts` pins it.

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
  `User` later also gained an optional `email` (`setEmail`/
  `createUser({.., email})`) — unlike `displayName` there's no sane
  fallback, so it's simply absent until an attorney sets one via the
  Accounts panel. Originally added solely to route the deadline-alert
  digest to a matter's actual responsible attorney — see "Proactive
  deadline-risk alerts" above — `email`, and the later-added `phone`
  (same set-or-clear shape via `setPhone`/`createUser({.., phone})`),
  are now also surfaced as contact info in the Staff directory (see
  below).
- `review-ui/staff-service.ts` — `StaffService`, backing the "Staff"
  panel: a read-only directory of every account (username, display name,
  initials, role, disabled status, contact email/phone when on file, and
  a paralegal's current matter assignment) via `AuthService.listUsers()`/
  `AccessControl.getParalegalAssignment()`. Open to every logged-in human
  (messaging and scheduling both need "who else exists in the system" to
  address); denies only the `"system"` machine credential, which is never
  created via `createUser` and so can never appear here anyway.
  `initialsFor(displayName)` is exported standalone since it's a pure
  presentation-layer function: a single-word name takes its first two
  characters, a multi-word name takes the first letter of the first and
  last words, both uppercased. **Still read-only** — editing a colleague's
  contact info happens through the Accounts panel's existing "Set email"/
  "Set phone" actions (attorney-only, audited `account_email_set`/
  `account_phone_set`), the same gate `AccountsService` already enforces
  for every other account field; the Staff panel deliberately doesn't
  grow a second, parallel edit surface. Role is not editable anywhere,
  by design — see `AccountsService.create()`'s doc comment — changing it
  after creation would mean rewriting the access-control/paralegal-
  assignment/audit history that already keys on it, a materially bigger
  change than this directory was asked to make.
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
  `AuthService`, since a raw `actorId` means nothing in the UI. Everyone
  a direct or group conversation is started with, or a group gains, must
  be an existing staff account by exact actor id: a conversation belongs
  to the ids in it, so one started with an id nobody held yet was waiting
  for whoever was later given that id, history and all, and one with a
  client went nowhere, since clients can't read staff messages.
  `ConversationView` carries `lastMessageAt` (undefined until the first
  message, then whatever the newest one's `sentAt` is), which the
  Messages panel compares against a per-conversation "last opened"
  timestamp kept in `localStorage` to show a small "new" badge on a
  conversation with messages this browser hasn't seen yet. Deliberately
  client-side and per-viewer only — same convenience-storage pattern as
  the theme preference — never sent to the server, so it's not a
  cross-user read receipt the way client-firm messaging explicitly
  doesn't have (see "Client-firm messaging" below).
- `core/staff-schedule.ts` / `review-ui/staff-schedule-service.ts` —
  who's in the office/remote/out, one entry per (actor, date), backing
  the "Schedule" panel. Deliberately separate from `core/scheduling.ts`'s
  `SchedulingService`, which books client consultations — this tracks
  the staff's own whereabouts, not client-facing appointments. Read
  access is open to every logged-in human (the point is everyone can see
  who's in when); write access is narrower — anyone can set their own
  day, but only an attorney can set someone else's, the same
  self-service-vs-attorney-gated split as password change vs. password
  reset. An entry's day must be a real date and its status one the panel
  can show; "garbage" and "office" used to be stored as sent. The person
  must be on staff too — an existing account, by its exact actor id, and
  not a client (`isStaffMember`, answered from `AuthService` in
  `start.ts`): a typo put someone who doesn't exist on the day's "who's
  in" list, and a client's id put a client on it. A note is at most 200
  characters, trimmed. An attorney changing or removing a *colleague's*
  day is audited (`staff_schedule_set_for_colleague` /
  `_removed_for_colleague`) — the service's own comment said that case
  "needs accountability", and nothing recorded it; your own day isn't.
  `core/calendar-date.ts`'s `isCalendarDate()` is the one date check the
  billing, invoice, matter and schedule stores now share.
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
  authenticated caller could otherwise name arbitrarily. Both the
  matter view and "My hours" have a **"Download CSV"** button —
  bookkeeping and payroll both eventually need this data outside the
  browser, and re-typing it from the on-screen list isn't a reasonable
  ask. Same client-side, no-new-route shape as the Audit Log panel's
  export, sharing its `downloadCsv()` helper. An entry becomes a line
  on an itemised bill, so `BillingHoursStore.log()` holds every path to
  the limits the CSV import always applied: a real `YYYY-MM-DD` day and
  no more than 24 hours. Before, the panel and API took a date of
  "nope" and 1e308 hours — an Infinity-dollar invoice line.
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

## E-signature

`src/core/esignature.ts` / `src/integrations/esignature-pdf.ts` /
`src/review-ui/esignature-service.ts` — getting an already-attorney-
approved document (an engagement letter, a settlement, a stipulation)
actually signed. Closes a real gap: drafting, review, and billing all
existed, but nothing produced by this system could ever be signed by
anyone, and the signer is deliberately **not** assumed to be a Docket
user at all — a client, a witness, opposing counsel on a stipulation —
so this never goes through the client portal or `AccessControl`'s
`client_portal` category.

**§1's non-negotiable rule applies here too, not just at drafting.** A
`WorkProduct` can only be sent for signature once it is `released` —
never `draft`/`pending_review`/`approved` — enforced in
`ESignatureService.send()`'s source lookup, so this can never become a
second way around the attorney checkpoint. A staff-uploaded PDF
`document` has no such gate, since it was never agent-drafted content
to begin with; it must actually be a PDF (`contentType ===
"application/pdf"`) — signing an arbitrary file type isn't supported.

- `core/esignature.ts` — `ESignatureStore`. A `SignatureEnvelope` freezes
  the exact bytes sent (`pdfContent`, base64) and their SHA-256
  (`documentHash`) at send time — never a live reference to a source
  that could change out from under a signature already collected. Each
  `Signer` gets a single-use, hashed, time-boxed (14-day) bearer
  token — the identical shape and reasoning as `core/auth.ts`'s
  `PasswordResetRequest`: whoever holds it can sign with no other proof
  of identity, so only the hash is ever stored, never the plaintext.
  The hash is one SHA-256, not scrypt — see "Bearer tokens are checked
  in one hash" under "Transport & session security".
  The envelope completes (`status: "completed"`) the moment every
  signer has signed; a signer declining moves the *whole* envelope to
  `"declined"` rather than just that signer, since a document missing a
  required signature can't be partially executed. Only a still-`"sent"`
  (pending) envelope can be voided — a completed signature can't be
  un-signed, the same "void, don't edit" reasoning as a sent invoice.
- `integrations/esignature-pdf.ts` — the two PDF operations this needed
  that nothing else in this codebase did yet, over the `pdf-lib` this
  project already depends on for invoices/condensing:
  `renderPlainTextPdf()` turns a released `WorkProduct`'s plain-text
  content into a PDF in the first place (drafts had never had a PDF
  form before — invoices were the only thing that needed one), and
  `stampCertificateOfCompletion()` appends a **certificate of
  completion** page once every signer has signed — the document's hash
  and every signer's name/email/signature text/timestamp/IP address —
  the same "accountability has to be provable, not just asserted"
  reasoning as the audit log's hash chain, applied to a single document.
  Both are exported standalone and unit-tested without a live service,
  same pattern as `invoice-pdf.ts`'s `invoicePdfFilename`.
- `review-ui/esignature-service.ts` — `ESignatureService`, with two
  genuinely different trust boundaries in one class. Staff-facing
  methods (`send`/`get`/`listByMatter`/`void`/`downloadFinal`) take an
  `Actor` and go through `AccessControl`'s `case_file` category exactly
  like `DraftingService`/`DocumentsService` — `send` is paralegal/
  attorney, `void` is attorney-only (a paralegal prepares and sends a
  request, but withdrawing one already out for signature is
  supervisory, the same split `InvoicingService` draws for voiding a
  sent invoice). The signer-facing methods
  (`getForSigner`/`getDocumentForSigner`/`sign`/`decline`) take a bare
  bearer token instead and no `Actor` at all — the same shape as
  `AuthService.resetPasswordWithToken`, where holding the token already
  is the proof. A mail failure in `send()` doesn't abort the send — the
  envelope already exists and the response always carries every
  signer's raw signing URL regardless of whether email was configured,
  so staff can still deliver it by hand (the same "degrade, don't
  block" reasoning as `InvoicingService`'s preview-and-send-yourself
  fallback) — `emailed` in the response says whether mail actually went
  out. Every send/void/sign/decline is audited; a signer's own actions
  are recorded with `actor: { id: signer.email, role: "anonymous" }`,
  the same role `core/types.ts` already reserves for a pre-credential
  party, never `"system"` (that's the calendar/Stripe machine
  credential specifically).
- `server.ts` wires the staff side as `/api/esignature/matters/:matterId`
  (list/send) and `/api/esignature/matters/:matterId/:id`
  (get/`/void`/`/final-pdf`), gated by the normal cookie session like
  everything else. The signer side is `/api/sign/:token` (status),
  `/api/sign/:token/document` (the PDF, served `inline` so a browser can
  preview it rather than downloading it — `sendBinary()` gained a
  `disposition` parameter for this), `/api/sign/:token` `POST` (sign),
  and `/api/sign/:token/decline` — all public and unauthenticated,
  handled in the same bucket as `/api/forgot-password`/
  `/api/reset-password/confirm` before the normal actor-resolution step
  runs, since a signer has no Docket session to resolve. Both buckets
  404 when no `ESignatureService` was passed to `createReviewServer`.
- `start.ts` constructs `ESignatureService` whenever `PUBLIC_BASE_URL` is
  set — the same var Twilio/Stripe/calendar-OAuth/password-reset already
  share for their own callback/link URLs, so this needed **no new env
  var and no new vendor at all**: it's built entirely from
  `pdf-lib`+whatever `EmailSender` is already configured (optional —
  see the degrade-gracefully behavior above) +the existing
  `DocumentStore`/`WorkProductStore`/`AccessControl`. `persistence/
  system-state.ts` snapshots `ESignatureStore` alongside everything
  else.
- The dashboard's **Signatures** panel (same role gate as Drafting/
  Cases): pick a matter, pick an uploaded PDF or a released draft, add
  one or more signers by name/email, and send — the response shows
  each signer's raw link right there (useful whether or not email is
  configured) so staff always has it to hand. The matter's signature
  requests list shows each signer's live status, a "Void" button
  (attorney-only, reason required), and a "Download final PDF" button
  once completed. `public/sign.html`/`sign.js`/`sign.css` are the
  signer's own page — no login, no account, just the token in the URL —
  showing the document inline (a same-origin `<iframe>` onto
  `/api/sign/:token/document`, which the CSP's `default-src 'self'`
  already allows with no policy change needed), a "type your full name
  to sign" field plus an explicit consent checkbox, and a "Decline to
  sign" option.
- **A file that can't carry a certificate is refused when it's sent.**
  The certificate is appended only when the last signer signs, and a
  file labelled PDF that pdf-lib can't open — damaged, or
  password-protected, which court and bank documents often are — used
  to be accepted and fail at that moment. By then the signature was
  recorded, so the signer saw the raw parser error for a signature that
  had gone through, the envelope read "completed" while its download
  said "not yet fully signed", the link was spent, and **the signature
  never reached the audit log** (reproduced against a running server).
  Now `send()` checks the file opens (`canStampPdf()`), and `sign()`
  audits the signature *before* building the certificate; if that still
  fails it writes `esignature_certificate_failed` with the reason, the
  signer is told they've signed, and the download says the signed copy
  couldn't be produced rather than that anyone still has to sign.
- **The certificate says exactly who signed.** The standard PDF fonts
  can't draw "Ł" or "李", which printed as "?ukasz" and "??" — on the
  one page whose job is to identify the signer. `asTyped()` keeps the
  drawable text and adds every character as a code point ("?ukasz
  Nowak (as typed: U+0141 ukasz Nowak)"). A long value also no longer
  runs off the bottom of the page (room is checked per line), and names
  are capped at 200 characters where staff enter them and where the
  signer types theirs. A signer's optional reason for declining used to
  be stored whole, on the envelope and in the audit log (900 KB, in a
  probe); it's kept to 2,000 characters, marked "(shortened)", and the
  decline itself always goes through.

What this doesn't do: let a client sign through the client portal (the
signer is deliberately outside that surface entirely, reached only
through the emailed/shared token link), support any source document
type other than a PDF or a released `WorkProduct`'s rendered text,
offer multiple signers a defined signing *order* (every signer's link
works the moment the envelope is sent — there's no "wait for signer 1
before signer 2 can sign" sequencing), or let anyone — including an
attorney — edit a signer list or swap the underlying document once a
single signature has been collected. It's a real, legally-meaningful
click-to-sign capture (typed name, explicit consent, IP/timestamp,
document hash, a certificate of completion), not a cryptographic
PKI-backed signature the way some paid vendors offer.

## Legal risk assessment

`src/core/risk-assessment.ts` / `ParalegalDraftingSession.draftRiskAssessment()`
— a structured risk memo drafted from the Drafting panel's "Draft risk
assessment" card. Adapted for a law firm from the `legal-risk-assessment`
skill (see "Vendored skills" below): severity 1–5 × likelihood 1–5,
banded 1–4 low / 5–9 medium / 10–15 high / 16–25 critical, with the
action list each band calls for (critical: managing attorney, co-counsel,
litigation hold, notify the malpractice carrier if a claim is
conceivable).

- **The score is computed in code, never accepted from a caller.**
  `scoreRisk()` is the only place severity and likelihood become a score
  and level; the route ignores any `score`/`level` in the request body,
  and an out-of-range or fractional rating is a 400. A memo can't read
  "low risk" over inputs that multiply to 20, whether the cause is a
  typo, a model's arithmetic, or someone nudging the number. The panel
  shows a live "Score 16 — critical risk" preview purely as a
  convenience; the server recomputes it.
- **Every rating needs its reason.** Description, severity rationale,
  likelihood rationale and recommended approach are required — a bare
  number is an opinion nobody can review.
- **It's a draft like any other.** The memo is a `risk_assessment`
  `WorkProduct` carrying the unconditional
  `RISK_ASSESSMENT_REQUIRES_ATTORNEY_JUDGMENT_FLAG` — severity and
  likelihood are judgements, so an attorney has to clear the flag
  (confirming or changing the rating) before it can be approved. Same
  `case_file` access check as every other draft.

What this doesn't do: maintain a firm-wide risk register, re-score over
time, or decide whether to escalate — it structures the analysis and
says what each level usually calls for.

## Vendored skills

`.claude/skills/` holds Claude Code skills for developing this project,
each vendored as **plain markdown only** — no scripts or executables —
with its source and licence recorded at the top and a short "Docket
context" note saying how it applies here. They were read before being
added; upstream installers (`npx skills add …`) were deliberately not
run, since that executes code fetched from the network.

- `legal-risk-assessment` (anthropics/knowledge-work-plugins,
  Apache-2.0) — the framework behind "Legal risk assessment" above.
- `legal-response` (same source, Apache-2.0) — templated responses with
  escalation checks; written for an in-house team, so most of it is
  reference, not a feature.
- `diagnosing-bugs` (mattpocock/skills, MIT) — the reproduce → hypothesise
  → instrument → fix loop. Its helper script template was left out.
- `code-review-two-axis` (mattpocock/skills, MIT, renamed from
  `code-review` to avoid clashing with the built-in one) — Standards
  (this file) vs Spec (`docs/spec.md`) review.

Considered and not added: `persona-exec-assistant` (needs the
Google Workspace `gws` binary installed and authenticated),
`assistant-ui` (React-only; the dashboard is framework-free under a
strict CSP), and `legal-writing` / `cocounsel-legal:deep-research`
(not present in the archives provided).

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
  with a `client`/`adverse`/`related` role — plus the standard
  case-detail fields a firm tracks day to day: `court`, `caseNumber`
  (the court's own docket number — never this system's internal
  `matterId`), `opposingCounsel` (free text; deliberately separate from
  `parties`, which names the adverse *client*, never their attorney),
  and `keyDates` (`{label, date}[]`, a quick-reference memo —
  deliberately informal and single-sourced, unlike `core/deadline.ts`'s
  `DeadlineTracker`, which requires two independent sources to agree
  before a date counts as confirmed; nothing here gates a draft's
  approval the way an unconfirmed tracked deadline does). Deliberately
  keyed on the same `matterId` string rather than a new primary key, so
  every existing store keeps working untouched and a matter can still
  be referenced before its record is filled in. A record here is
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
  - **A role that names no side can't hide a conflict.** Party roles and
    matter statuses used to be stored exactly as sent, so a party saved
    as "Adverse" or "opposing party" screened as *informational* — a
    Rule 1.7 conflict that required no attorney review, through the
    Conflicts panel and the receptionist's intake gate alike.
    `MatterStore.upsert()` now reads a role or status forgivingly ("
    Adverse " is adverse, "Open" is open) and refuses anything else
    rather than guess a side; party names and key-date labels are
    required, and a key date must be a real day. A record already saved
    with an unrecognised role is screened as *possibly either side*
    (`sidesOf()` in `conflicts.ts`), so it over-matches like the rest of
    the checker, and `POST /api/conflicts/check` refuses a requested
    role it doesn't know. Found by sending each write route what a
    careless caller would; `test/input-integrity.test.ts` pins it.
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
  screening work — the matter-record form is organized into sections
  (Basics, Court & docket, Opposing counsel, Key dates, Parties, Notes)
  rather than one flat block, now that it covers this many fields.
  - **Saving the form keeps every party.** A save rebuilds the whole
    party list from the form's boxes, and there were only two — clients
    and adverse — with no way to write a note. So saving a matter from
    the panel, even just to fix its title, deleted every *related* party
    (witnesses, co-defendants) and every party's note that the API or
    an import had recorded. A third box takes related parties, and any
    party line can end in `— note` (or `-- note`), so the form can now
    show everything it saves. `test/matter-party-lines.test.ts` runs the
    page's own `partyToLine`/`lineToParty` to pin the round trip.

### Firm-wide conflicts audit

`ConflictChecker.audit()` / `MattersService.auditConflicts()` — the
Conflicts panel's attorney-only **"Firm-wide audit"** card. A *check*
screens new names on the way in; the audit screens the whole book against
itself, because a firm ends up on both sides of someone in perfectly
ordinary ways the check never sees: a party added to a matter after it
was screened, two matters opened by different attorneys the same week, a
file reopened, an import.

- **Graded by what the rules care about**, worst first:
  `current_adversity` (client on one live matter, adverse on another —
  Rule 1.7; a prospective matter counts as live, same as a check),
  `former_client_adversity` (a closed matter's client is adverse on a live
  one — Rule 1.9), `past_adversity` (the firm acted against someone on a
  now-closed matter and represents them elsewhere — rarely a conflict by
  itself), and `review` (one client written two ways, e.g. "Maria Ruiz" /
  "Maria Elena Ruiz"). One matter listing the same name on both sides is
  called out separately as almost certainly a data-entry mistake.
- **Over-matches only where it pays.** Adversity findings keep every
  `possible` match (same surname and first initial), like a check. The
  spelling list only takes `strong` ones: the first run against a
  3,000-matter book flagged 9,800 pairs of different clients who shared
  a surname and initial — "Jane Smith" and "John Smith" are usually
  relatives — and a list that size is one nobody reads.
- **One finding per pair of names**, listing every matter on each side,
  so an adversary the firm faces on 400 matters is one quiet non-finding
  rather than 80,000 rows — and a returning client recorded the same way
  each time isn't a finding at all.
- **Fast without cutting corners.** Each name is normalized once and only
  names sharing a token are compared — every match `compareNames()` can
  return needs one (the shorter name's rarest token for a strong match,
  the surname for a possible one). A seeded test checks this against
  brute-force comparison of every name with every other, so the shortcut
  can't silently miss a pair; 3,000 matters run in well under a second.
- **Read-only, attorney-only, audited.** It changes no record and clears
  nothing. Attorney-only, unlike a check, because it lays out every
  matter's parties by another route. Each run writes
  `conflicts_audit_run` with its counts — "when did the firm last look,
  and what did it find" is what a later inquiry asks. `POST
  /api/conflicts/audit` (POST because it writes that entry).
- Each matter id in a finding opens that record in the editor below,
  since fixing a finding usually means correcting a party list. A
  "Download CSV" button exports one row per appearance for a file memo.
  The list is capped at 500 findings, most serious first, and says so
  when cut.
- **What it doesn't cover is shown with every report**: `related`
  parties (witnesses, co-defendants) aren't compared, nor the free-text
  opposing-counsel field, and nothing not written on a matter record can
  be found.

### Importing from another system (CSV)

`core/csv.ts` / `core/data-import.ts` / `review-ui/import-service.ts` —
the attorney-only **Import** panel, which brings matters (with their
clients and adverse parties) and time entries over from Clio, MyCase,
PracticePanther or a spreadsheet. A firm that can't get its history in
tends not to switch, or keeps the old system running "for reference",
which is how records end up in two places disagreeing. But an import is
also the fastest way to put a lot of wrong data into a system at once,
so most of the design is about what it refuses to do quietly:

- **Preview, then commit exactly what was previewed.** `planImport()` is
  pure: it reads the file and today's records and says, row by row, what
  it would create, skip (and why), or can't make sense of (with the line
  number a spreadsheet shows). The commit re-plans from the same file
  and refuses with **409** if the plan's `fingerprint` differs at all —
  someone created a matter meanwhile, or the column mapping changed — so
  what the attorney approved is what lands. A preview writes nothing:
  no records, no audit entries, no save.
- **Nothing existing is overwritten or merged.** A matter number already
  in Docket is skipped and left alone. Party lists drive every future
  conflicts check; an import rewriting them would weaken screening
  invisibly.
- **Time already billed in the old system stays out.** Imported hours
  can be added to a new invoice here, and billing a client twice for the
  same work is a fee violation. A "Billed"/"Status"/"Invoice #" column
  decides it; a value the planner can't read is a refused row, not a
  guess; a file with no such column gets a warning saying anything
  imported is billable again. Expenses and non-billable time are skipped
  too, and importing the same file twice adds nothing the second time —
  counted as a multiset, so two genuinely identical 0.1-hour calls in
  one file both still import.
- **Imported matters are conflict-screened** against every existing
  record *and* each other, by building the post-import book in a scratch
  `MatterStore` (Rule 1.10 makes the whole firm the scope). A hit
  doesn't block — these engagements already exist, and refusing to
  record one would hide the conflict rather than remove it — but a
  direct or former-client hit requires an explicit acknowledgement
  before the commit button works.
- **Time is credited to real accounts only.** A timekeeper with no
  matching attorney/paralegal account (by username or name, "Brooks,
  Ada" included) is a refused row, never "the person importing", since
  who did the work is what an itemised bill states. A disabled former
  colleague's account still matches, with a note.
- A matter can't be imported as **closed** while the trust ledger holds
  funds under its id, the same rule `MattersService.close()` enforces.
  Closed matters keep their real open/close dates
  (`MatterStore.upsert`'s `historical` option, which no HTTP body can
  reach and which never overrides an existing date), get a closing note
  naming the source, and a retention date from `fileRetentionYears`.
- Column names differ between tools, so each field has header aliases,
  each column is used for one field at most, and the preview shows which
  column each field came from with a dropdown to correct it. The aliases
  are written from these tools' documented export layouts and common
  spreadsheet conventions — **best guesses, not verified against live
  exports** (same caveat as CourtListener's field names); the "looks like
  a Clio export" line is cosmetic and decides nothing.
- `csv.ts` is a hand-rolled RFC 4180 reader (quoted commas, doubled
  quotes, line breaks inside values normalised to `\n`, CRLF/LF/CR, a
  BOM, semicolon- and tab-separated files). The browser reads the file
  as UTF-8 and falls back to Windows-1252 if that produced replacement
  characters, so "Muñoz" from an older Windows export still screens as
  Muñoz. Limits: 5 MB and 5,000 rows per file.

Audited as one `matter_imported` per matter (its history starts with
where it came from), one `billing_hours_imported` per matter receiving
time (count and total), and a `data_import_committed` summary with the
file name, counts, and whether conflicts were acknowledged. Routes:
`POST /api/import/preview` and `/api/import/commit` (attorney-only; a
non-attorney gets 403 even for a preview, which runs a firm-wide
conflicts screen). Always on — no vendor, no key. The Home "Getting
started" checklist offers it next to "Create your first matter".

What this doesn't do: import contacts on their own, documents, invoices,
payments or trust balances (trust history belongs to the old system's
ledger and its reconciliation; recreating it here would produce a ledger
that reconciles to nothing), or update records that already exist.

### Closing a matter, and file retention

`MattersService.close()` / `.reopen()` / `.listRetentionDue()`.

**One rule is enforced in code: a matter holding client funds in trust
cannot be closed.** Closing a file with the client's money still in the
trust account is how balances become unclaimed property — money held for
someone the firm has stopped dealing with, which triggers escheat
obligations in most jurisdictions and is a reliable way to fail a trust
audit. The error says the amount and what to do about it (refund it, or
apply it to an invoice — both already exist).

**Everything else is a warning, never a block.** An unpaid invoice is a
perfectly ordinary reason to close a matter and keep chasing the debt;
work product that never finished review may genuinely no longer need it.
Those are the closing attorney's calls, and refusing them would only
teach people to route around the close. The warnings come back *with*
the successful close rather than instead of it.

Closing requires a note recording the disposition, and stamps a
**retention date** from `FirmConfig.fileRetentionYears`. There is
deliberately no default: retention periods differ substantially by
jurisdiction and matter type, so absent config a matter closes with no
retention date rather than one this software invented. Reopening clears
both the closed date and the retention date, so a live matter can never
surface as "due for review". The period must be whole years from 0 to
100 (`checkedRetentionYears()`), checked once at boot for the config file
— which stops the server with a plain message — and on the close route's
override. Neither was checked: `"fileRetentionYears": "7"` in the JSON
made `addYears` concatenate and stamp a retention date in the year
20267, and 2.5 stored "2028.5-11-25", which no review list ever finds. A
numeric string is now read as its number.

`listRetentionDue()` lists closed matters past their date — and is *only*
a list. Nothing here deletes anything, and a test asserts there is no
`destroy`/`purge`/`shred` method at all. Destroying a client file
carries notice obligations and differs by jurisdiction; software that
shredded files on a timer would create malpractice exposure rather than
reduce it. The point is to stop a firm keeping everything forever
because nobody remembered to look.

Both close and reopen are attorney-only and audited. A refused close is
**409** (`MatterClosingError`) — the ledger's state says no, it isn't a
malformed request.

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
  - **That gate used to be bypassable.** Only a deposit adds to a
    balance, so the ledger recorded *any* other type string as money
    leaving — but the attorney-only check named just the three outbound
    types. A paralegal sending `"Disbursement"`, `"teleport"` or
    `"reversal"` moved client funds out with no attorney (reproduced: $600
    of a $1,000 retainer). Now `TrustLedger.record()` accepts only
    deposit/disbursement/earned_fee_transfer/refund (a reversal only via
    `reverse()`), amounts must be safe integers, and the service fails
    closed — **anything but a deposit is attorney-only**, without relying
    on the ledger's list. `TrustAccountingError` gained a `kind`, so a
    malformed entry is a 400 and only a ledger conflict (an overdraw) is a
    409. Pinned in `test/trust-server.test.ts` and
    `test/money-integrity.test.ts`.
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
  money the firm would then owe back. A draft's due date must be a real
  day and its note at most 2,000 characters — both are printed on the
  client's bill, and a due date of "garbage" or "2026-13-45" used to be
  printed there and counted from by the overdue and aging reports. A
  payment's method must be one the
  client's copy can name (`card`/`ach`/`check`/`cash`/`other`, plus the
  internal `trust_application`).
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
  confidently wrong paycheck. An entry is one person's hours on one day
  (at most 24), and a rate must be a safe integer of cents — a billion
  hours and a 1e17-cent rate used to be stored and priced into gross pay;
  a shift over 24 hours is refused at "Post to payroll" as probably left
  open. Access is about privacy between
  colleagues rather than matters: setting a rate is attorney-only, you
  can see your own hours and rate, and only an attorney can see anyone
  else's or run the firm-wide summary. The period summary's
  **"Download CSV"** button exports the currently run summary (name,
  hours, gross pay, any dates missing a rate) — the same shared
  `downloadCsv()` shape as the other exports in this doc, for handing a
  pay period to a bookkeeper or payroll provider.
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

**Everything the total adds up is printed.** A line's category was
never checked, and the bill prints only time, expenses and fixed fees —
so a line sent as `"source": "other"` was counted in the total and
printed under no heading: an invisible charge on a client's bill
(reproduced: a $900 "Hidden surcharge" inside a $950 total, nowhere on
the page). `addLineItem()` now refuses any other category, and
`sectionFor()` prints a line already saved that way under fixed fees in
all three renderings. Amounts must also be *safe* integers — past 2^53
an integer stops being exact, and 1e16 cents plus a cent is still 1e16 —
and a line's "date worked" must be a real day.

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
and clicking one jumps straight to that invoice. A **"Download CSV"**
button exports the same currently loaded list — this is the one most
likely to actually leave the browser, headed to a bookkeeper — via the
same shared `downloadCsv()` helper as the Audit Log/Billing/Deadlines
exports.

**Payment reminders.** `emailReminder()` sends a covering note plus the
full itemisation and the PDF, from a "Send reminder" button on each
outstanding receivable. Three deliberate choices:

- **Not automated.** The receivables query and the mail transport both
  exist, so a nightly dunning job would be easy — and wrong. Automated
  chasing mails the client who is disputing the bill, or who agreed
  terms with a partner last week, or whose relative just died. When to
  press is a judgement about a relationship, not a cron expression. What
  the software does instead is make the judgement easy to make well:
  show what's overdue, show when this client was last chased and how
  often, and send in one click.
- **It doesn't accuse anyone.** The overwhelmingly common reason a legal
  bill goes unpaid is that it was mislaid. The wording states what is
  owed and since when, allows that payment may have crossed in the post,
  and invites a reply about anything disputed. A firm wanting something
  sterner can write it themselves.
- **It refuses to chase a paid invoice** outright rather than leaving it
  to the UI — asking a client for money they don't owe is the worst
  outcome available here. Drafts and voided invoices are refused too.

Deliveries carry a `kind` (`invoice` / `reminder`), so the record
distinguishes issuing a bill from chasing one, and `listOutstanding()`
returns `reminderCount`/`lastRemindedAt` so a third reminder in a week
is a deliberate act rather than an accident. Attorney-only, and audited
with the balance chased.

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
`POST /api/invoices/matters/:matterId/:invoiceId/remind`,
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
  through `Intl`; the firm's zone is the one described in "The firm's
  day" below.
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
changed them and why (a correction must move at least one punch — one
that changed nothing used to add a history line reading as if something
had). `postToPayroll` creates the payroll entry *first*
and only then marks the shift posted, so a failure can't mark hours paid
that aren't; once posted the shift locks against correction, so the two
records can't disagree.

**A correction is an instant, in the past, that no other shift
covers.** The panel used to correct a punch through two prompt boxes
asking for "ISO 8601, e.g. 2026-07-26T09:00:00Z" — so an attorney fixing
a 9am start typed 09:00Z, which is UTC, and moved someone's paid hours
by their distance from Greenwich; a time typed without a zone was read
in the *server's* zone, with the same result on a UTC host. It is now an
inline form of local date-time pickers, prefilled with the current
punches and labelled with the browser's zone, converted to an instant
before sending. `TimeClock.adjust()` itself refuses a time without a
zone or offset, stores it normalised, refuses one more than a minute in
the future (hours not yet worked), and refuses a correction that makes
two of one person's shifts cover the same minutes — the usual shape is a
forgotten clock-out "fixed" to the next morning, after the next shift
began — as a 409 naming the shift it would overlap.
`test/punch-corrections.test.ts` pins these. The panel's "firm time
zone" tile used to print "America/New_York" in the stat figure's
display type, which can't wrap and pushed the whole page sideways (46px
on a desktop, 133px on a phone); it shows the city, with the full zone
underneath, and no stat tile can widen its grid any more.

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
  - On its own the chain catches an entry edited **in place**. It does
    not catch a log **rebuilt from scratch** — a rebuilt chain is a
    perfectly valid chain — nor entries **truncated off the end**, since
    a shorter chain is still internally consistent. That is what
    anchoring below is for.
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

### Anchoring — the part the chain can't do alone

`core/audit-anchor.ts` / `integrations/audit-anchor-targets.ts` /
`integrations/anchor-audit.ts`. An **anchor** is one value — the hash of
the most recent entry, which by the chaining commits to every entry
before it — published somewhere the person who controls the database
does not. Later the chain is re-derived and compared. If they disagree,
the log was rewritten, however tidy it now looks.

Verified against a real deployment: a log rebuilt from scratch with an
entry erased (every hash recomputed, so `verifyIntegrity()` reports
"intact") is caught by the anchor comparison, which reports the exact
sequence and both hashes.

**The destination is the whole security property**, and it is an
operational choice this code deliberately does not make:

- A file on the same disk under the same account is close to worthless —
  the same person edits both.
- `FileAnchorTarget` becomes real on an append-only mount, or a path a
  log shipper drains off the machine. JSON Lines, appended never
  rewritten, so a shortened file shows as missing sequences.
- `EmailAnchorTarget` mails the head hash to the firm's partners — for a
  small firm usually the most genuinely independent option available,
  since those mailboxes are hosted elsewhere. It is **write-only on
  purpose**: this app can send mail but cannot read a mailbox, and
  pretending to verify against something it can't see would be worse
  than being explicit. Verification falls back to the local record, and
  a real investigation compares that against the emails by hand.
- `MultiAnchorTarget` fans out, because a single destination is a single
  point of collusion. One failing destination doesn't stop the others —
  a partial anchor beats none — and the failure is written into the
  receipt rather than swallowed.

Two behaviours worth naming:

- **Anchoring writes its own audit entry**, which changes the head hash.
  So "has anything happened since the last anchor?" can't be answered by
  comparing head hashes — the answer would always be yes, and a nightly
  job would anchor forever on an idle system, burying the anchors that
  attest to real work. `countSince(sequence, ignoring)` excludes
  `audit_anchored`, so seven nightly runs on a firm that did nothing
  produce exactly one anchor.
- **Publishing happens before the local record is written.** A local
  record of an anchor that never left the building is a false assurance,
  worse than no record.

`npm run anchor:audit` is the standalone runner (cron/systemd timer),
deliberately outside the app process — same reasoning as
`sync:calendar`, plus two of its own: anchoring shouldn't depend on
someone remembering to click a button (an anchor bounds the window in
which a rewrite goes undetected), and running it from a machine the
database administrator doesn't control makes the *schedule* independent
too. It **refuses to anchor** a log that is already broken or already
disagrees with a published anchor, since doing so would publish a hash
vouching for damage.

Configured via `AUDIT_ANCHOR_FILE` and/or `AUDIT_ANCHOR_EMAILS` (the
latter needs `SMTP_HOST`/`SMTP_FROM`). Absent, the panel says outright
that a rebuilt log would still verify, rather than implying safety.

`AuditService.list()` takes a filter object (`matterId`, `actorId`,
`action` substring, `from`/`to` dates) — the Audit Log panel exposes all
five, since a log you can only read start-to-finish isn't one anyone
uses. Redaction for `system_admin_no_content` drops `changes` too:
before/after values are exactly the privileged content that role is
walled off from.

**"Download CSV"** exports exactly what's currently on screen — the
same filtered set `AuditService.list()` just returned, client-side,
with no new server route — for a bar complaint, litigation hold, or
internal review where the entries need to leave the browser. RFC
4180-quoted with a UTF-8 BOM so it opens correctly in Excel rather than
being guessed into a legacy codepage. The same `downloadCsv()` helper
(`app.js`) backs the Billing panel's two CSV exports below — one place
that does the quoting/BOM/blob-download mechanics, not three.

That one place also guards against **spreadsheet formula injection**:
a cell starting with `=`, `+`, `-`, `@`, a tab or a carriage return is
prefixed with `'`, because Excel and its kin run such a cell as a
formula. Party names and descriptions can now arrive from outside the
firm (a CSV import, the public booking form), so a name like
`=HYPERLINK(...)` must not become live when someone exports the audit
log. Plain numbers such as `-4` (days overdue) are left alone.

## Search

`review-ui/search-service.ts` — the box in the top bar, backing a
**Search** panel. The need is mundane and constant (*"where's that
motion about the traffic stop?"*), and without it a firm with two
hundred matters navigates by memory.

Searches five things: matter records (caption, id, description, party
names), drafted work product (the text itself), uploaded **file names**,
saved research references, and logged time descriptions — often where
what actually happened is written down.

**Access control is the hard part, not the matching.** A search box is
the classic way privileged material leaks, because it reaches across
every store at once. Every hit goes through the same
`AccessControl.authorize()` check as the panel it came from, and an
unreachable matter is **silently omitted** — not refused, not counted,
not hinted at, since "3 results hidden" is itself a disclosure. Verified
live: a paralegal assigned to one matter searching a term that only
appears in another gets "Nothing found", while the attorney gets two
hits. Receptionists can't search at all.

Two implementation points worth naming:

- **Authorization is cached per (matter, category) for the duration of a
  search.** Uncached, a query touching 500 records across 40 matters
  would write 500 denial entries into the audit log and drown it. A
  test pins the bound at exactly `matters × categories + 1`.
- **Every search is logged**, with the query. A search is precisely the
  kind of broad access an attorney reviewing an incident wants a record
  of, and the query is the interesting part of it.

Ranking is deliberately simple: an exact phrase outranks scattered
words, and a title match outranks a body match. This is a
find-the-thing-you-remember tool, not an IR system, and predictable
beats clever.

`SearchResults.notSearched` is displayed on every search rather than
buried in docs: **file contents are not indexed, only file names.** A
firm that assumes otherwise will conclude a document doesn't exist when
it simply wasn't looked inside — being explicit is the difference
between a limitation and a trap. (Drafting a report from a PDF extracts
its text into work product, which *is* searchable.) `server.ts` wires
`GET /api/search?q=`; 404 without a `SearchService`.

## Matter timeline

`review-ui/matter-timeline-service.ts` — a "Timeline" card on the Cases
panel's matter detail: everything on file for one matter, newest first —
the matter opened and closed, drafts created and every trip through
review (with who), documents uploaded, deadlines as entered (and by which
source), appointments booked/moved/cancelled, invoices drafted, issued
and voided, payments, trust movements, client messages and signature
requests. Each entry opens the panel that owns it *with this matter
already loaded*, so the jump lands on the record rather than an empty
form. The question it answers is the one every file review starts with —
"what's happened on this matter?" — which used to mean opening seven
panels and putting the dates together by hand.

- **Nothing here is a new permission.** Opening the timeline needs the
  same `case_file` check as opening the matter on the Cases panel, and a
  refusal there refuses the whole request. Inside it, each source is read
  through its own panel's check: `billing_internal` for invoices,
  payments and trust; `SchedulingService`'s own check for appointments;
  deadlines for an attorney only, as on the Deadlines panel. A source the
  viewer can't reach is **silently omitted** — no "3 items hidden", the
  same reasoning as Search. A test runs it against a stricter rule set
  that refuses billing, and billing simply isn't there.
- **Dates are never guessed.** `WorkProduct` gained `createdAt` (set at
  creation, persisted in its snapshot) because `history` only records
  transitions, so a draft never submitted had no date at all. Drafts
  persisted before it existed show "date not recorded" at the end of the
  list rather than an invented date. An appointment carries its time as
  `scheduledFor` so the browser shows it in the viewer's own time zone,
  and only on the newest entry, since an older "scheduled" may have been
  for a time since moved.
- Read-only; `GET /api/cases/:matterId/timeline` (404 without a
  `MatterTimelineService`), capped at the newest 500 entries with a note
  when cut. Always on — it only re-reads what other panels already
  guard. Laid out as a docket sheet: dates down the margin, a rule beside
  them, stacking to one column on a phone; entries aren't clickable rows,
  only their "Open in…" link is.

What this doesn't do: logged billable time (that's the Billing panel's
list, and would drown the rest), audit-log entries (attorney-only, and a
different question — who *looked*, not what happened), or anything about
a matter that was never recorded in Docket.

## Analytics

`review-ui/analytics-service.ts` — `AnalyticsService`, backing the
"Analytics" panel: a read-only rollup of data every other panel already
produces, answering a different kind of question than any one of them
does on its own — who's carrying the most open matters, how much is
overdue and by how much, is AI-drafting/billable time trending up or
down. No new fact about the firm lives here and no write path does
either.

**Deliberately attorney-only**, same reasoning as `AuditService`/
`AccountsService` rather than `InvoicingService.listOutstanding()`'s
silently-omit-what-you-can't-reach pattern: a firm-wide rollup has no
narrower version that would mean anything, so rather than invent a
partial one it's restricted to the role that already sees everything.
A paralegal wanting their own caseload already has it on the Cases
panel, scoped the normal way. It reads `MatterStore`/`InvoiceStore`/
`BillingHoursStore`/`UtilizationTracker` directly rather than through
`MattersService`/`InvoicingService`/etc. — the same choice
`AuditService` makes over the raw `AuditLog` — because every one of
those wrapping services exists specifically to add matter-level
`AccessControl` scoping this panel doesn't want.

Four reports:

- `caseloadByAttorney()` — open/closed matter counts per
  `responsibleAttorneyId`, including an explicit `"(unassigned)"`
  bucket rather than silently dropping an unowned matter from the
  count.
- `matterStatusCounts()` — the panel's headline tiles.
- `invoiceAging()` — every unpaid, non-void, sent invoice bucketed by
  days overdue (`current`/`1-30`/`31-60`/`61-90`/`90+`). Deliberately
  duplicates (rather than imports) `InvoicingService.listOutstanding()`'s
  balance/overdue math, since that method's job is per-matter-scoped
  delivery and this one's is a firm-wide rollup — the two should never
  silently disagree about what "overdue" means by sharing a code path
  that later changes for one reason and not the other.
- `utilizationTrend()` / `billableHoursTrend()` — finished AI-agent
  minutes and logged billable hours, by day, over a configurable
  trailing window (default 30 days). Both bucket by when the entry
  *started*, same convention `TimeClock` uses for an overnight shift;
  an AI-utilization entry still open (no `endedAt`) contributes
  nothing yet, same as an open time-clock shift never counting toward
  a total.

`server.ts` wires `GET /api/analytics/caseload`, `/matter-status`,
`/invoice-aging`, `/utilization-trend`, and `/billable-hours-trend`
(the latter two taking `?withinDays=`); 404 without an
`AnalyticsService`. Nav item hidden unless role is `attorney`, same
client-side-convenience-only caveat as Accounts/Audit Log — the real
gate is server-side in `AnalyticsService` itself.

## The firm's day

Every check that compares a date with "today" now asks it in the firm's
zone. Before, each one took UTC's date (`toISOString().slice(0, 10)`) or
the host's, and a UTC host is a day ahead of the Americas every evening
and a day behind Asia and Australia every morning. `core/calendar-date.ts`
holds the helpers: `calendarDayIn()`, `todayIn()`, `dayOf()` (the
firm-local day of an instant) and `checkedTimeZone()`. What it fixed:

- **The receptionist's court dates**: see "Weekdays and dates are the
  firm's" above. This was the one that mattered, because it under-
  escalated.
- **Coming due** (and so the deadline digest and the calendar file): a
  deadline due today in New York showed as a day overdue after 7pm.
- **The dates on a bill**: "Issued" and each payment line, in the text,
  HTML and PDF copies, printed the UTC day, so a bill sent at 8pm showed
  tomorrow's date. `RenderableFirm.timeZone`. Days overdue (the
  receivables list, the reminder's "due on … N days ago") use the firm's
  day too.
- **Closing a file**: the closing day, and the retention date counted
  from it, were UTC's. A New York file closed at 8pm on New Year's Eve
  was kept until 1 January seven years on, not 31 December.
  `listRetentionDue()` uses the same day.
- **The public booking form** used the host's day. On a UTC host, a New
  York visitor choosing today after 7pm was told to pick a day within the
  next 60 days. The window is now the firm's, and `/api/public/booking/
  config` returns the firm's `today`, so the page's date picker opens on
  the same window the server checks, wherever the visitor is.
- **Analytics** (aging, the daily trends), **the calendar file's**
  "from the start of today" (UTC's midnight is 11am in Sydney, which
  dropped that morning's appointments), the **CSV import's** "today", and
  the **demo seed** (whose sample deadline, fourteen days on by UTC, was
  fifteen days on in Honolulu and missed Coming due; it's now ten days
  from the firm's day).

**One zone, checked at boot.** `start.ts` resolves `FIRM_TIME_ZONE` if
set, else the firm config's `businessHours.timezone`, else the host's,
and passes it everywhere: the time clock, the assistant's clock and
everything above. The time clock used to ignore the config's zone and
the assistant preferred it, so the two could disagree. A zone the
runtime doesn't recognise ("Eastern") now stops the server with a plain
message, as does a bad business-hours zone. A server that started anyway
would have failed every request that asked what day it is. If both
settings are given and differ, the server warns at boot. Absent any zone
(tests, a service built without one), each service keeps what it did
before: UTC, or the host's day for the booking form and the receptionist.
`test/firm-days.test.ts` pins each case at 8pm in New York and 1am in
Sydney.

What it doesn't do: let a single firm work in several zones. One firm,
one day.

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
- **Only a sign-in failure is a 401.** The dashboard answers every 401
  by sending the browser to the sign-in page, so a 401 for anything else
  throws a signed-in person out mid-task. The status used to be picked by
  matching `AuthError` message text, and anything unmatched fell through
  to 401: a mistyped code while setting up two-factor, confirming before
  starting, an expired passkey registration, a blank username on "Create
  account". `AuthError` now carries a `kind` (`unauthenticated` /
  `invalid` / `forbidden` / `conflict` / `not_found` / `unavailable`),
  defaulting to `unauthenticated` so every sign-in path keeps its 401
  (and the login throttle its accounting), and `errorStatus` maps the
  kind — the same fix `TimeClockError` got when its prose-matching broke.
  `test/mfa-server.test.ts` pins that each of those mistakes leaves the
  session working.
- **Request-body ceiling** — see "PDF intake…" above for why the
  per-file upload cap alone wasn't one. That ceiling (~34 MB, sized for a
  document upload) used to apply from the first byte of *every* request,
  so each route that needs no sign-in — login, passkey login, password
  reset, the public booking form, a signer's link, the Stripe and Twilio
  webhooks — buffered up to 34 MB for anyone who asked, a few dozen
  concurrent requests from running the process out of memory. A request
  is now held to 1 MB (`UNAUTHENTICATED_BODY_LIMIT_BYTES`) until
  `resolveActor()` has seen a session or the system key, and only then
  gets the full ceiling. None of those routes takes more than a few
  kilobytes. `test/request-parsing-server.test.ts` pins both halves: a
  2 MB anonymous body is a 413 before it's buffered, and the same size
  from a signed-in attorney is an ordinary upload.
- `serveStatic` compares against `PUBLIC_DIR + path.sep`, not a bare
  `startsWith`: the latter also accepts a sibling directory whose name
  merely begins with it, which `../public-x/secret` would reach.
- **Ids in the URL path are decoded, in one place** (`pathSegments()`).
  The dashboard puts every id into a URL with `encodeURIComponent`, but
  25 route handlers split the raw path and keyed on what they found, so
  a matter typed as "Ruiz 2026" was stored as `Ruiz%202026` by every
  route taking its id from the path (documents, drafting, billing,
  trust…) and as `Ruiz 2026` by every route taking it from a JSON body
  (scheduling, assignments) — one matter split in two. The Cases panel
  then encoded the stored id again and opened an empty matter. Segments
  are split before decoding, so an encoded `/` stays inside one id, and a
  malformed escape is kept as written rather than failing. A matter
  stored percent-encoded before the fix is still reachable under that
  id. Found in a review pass; `test/request-parsing-server.test.ts` pins
  it.
- **A JSON body must be an object.** Every route reads named fields off
  it, so `null` came back as "Cannot read properties of null" and `[]`
  was read as an empty record (an untitled matter). `readJsonBody()`
  now refuses anything but an object with a plain 400.
- **A cookie Docket didn't set can't lock anyone out.** Cookie values
  were decoded strictly, so a stray `promo=50%off` from another app on
  the same domain made every request, the dashboard page included, a 400
  "URI malformed". Decoding is now tolerant, same as path segments.
- **Bearer tokens are checked in one hash** (`core/token-hash.ts`).
  Signing links and password-reset links were stored with a per-record
  salt and scrypt, so checking a presented token meant one scrypt *per
  outstanding link*, and `scryptSync` blocks the process. With 30
  signatures out, each request to `/api/sign/<anything>` — public, no
  sign-in — held the whole server for 1.5 s (measured), so a few
  requests a second took Docket down for everyone. These tokens are 192
  random bits, which leaves a slow hash nothing to slow down, so they're
  now one SHA-256 per lookup, compared timing-safely, and anything not
  shaped like a token (48 hex characters) is refused before hashing.
  Measured after: 1.1 ms with 30 outstanding. A record issued before the
  change (non-empty salt) is still checked the old way until it
  expires, so no link already sent stops working. Passwords keep
  scrypt — they're guessable, which is what it's for.
- **Sign-in takes as long for a username that doesn't exist.** Both
  `login()` and `beginPasskeyLogin()` returned before hashing when the
  account was missing or disabled: about 0 ms against about 50 ms for a
  wrong password, so the identical message hid nothing from a
  stopwatch. `#checkPassword()` now hashes every attempt, against a
  random value no password produces when there's no account (measured
  on a running server: 56.4 ms unknown vs 56.8 ms wrong password). The
  forgot-password route had the same leak through its email; see
  "Self-service password reset".
- **The system API key can't be used to make the server hash.** Any
  request carrying `x-system-api-key` cost one blocking scrypt (~45 ms),
  with no session needed and no limit, so the same few-requests-a-second
  trick worked here too — and the integrations themselves paid it on
  every call. The key stays scrypt-hashed at rest, since an operator may
  choose it (`CALENDAR_SYSTEM_API_KEY`) and a chosen key can be
  guessable. But once a key has passed, a SHA-256 of it is remembered
  **in memory only** (never in the snapshot, cleared by
  `setSystemApiKey`), so the integration's later calls cost about a
  millisecond. Any other value is counted per address under its own
  `LoginThrottle.systemKeyKey` — not `ipKey`, so a misconfigured cron job
  can't lock the office out of signing in — and after five wrong keys
  the address gets a 429 before anything is hashed. The remembered key
  is checked *before* the throttle, so a stranger at a shared address
  can't lock the real integration out; the one gap is a restart, until
  the integration's first successful call. Measured on a running server:
  first good call 50 ms, then 1 ms; wrong keys 42 ms each, then 429 in
  under 1 ms.

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
- **An account is a person, with an identity of its own.** Account
  creation used to store whatever it was sent, which opened two holes
  (both reproduced against a running server):
  - *A password login with role `"system"`.* It passed every check that
    tells the integrations' machine credential from a person: it
    recorded a `calendar_system` deadline confirmation, so one attorney
    could supply both of a deadline's "independent" sources; it read
    every appointment with the client's email attached; and it could
    fetch another attorney's Google Calendar access token. A role naming
    nothing ("superuser") was stored too, and passed every "any staff
    member" check. `createUser()` now accepts only `LOGIN_ROLES`
    (attorney, paralegal, receptionist, staff, client).
  - *A second account under a colleague's actor id.* The actor id is who
    an account *is* everywhere else (audit entries, matter assignments,
    direct messages, timesheets, payroll), so a "twin" created with a
    paralegal's actor id read that paralegal's direct messages and was
    recorded as them. Actor ids are now unique (compared case-
    insensitively, so "P1" is "p1"), and the ids the server acts as
    itself (`calendar-integration`, `system`, `public-booking-form`,
    `anonymous`) are reserved.
  - Records saved before the fix **fail closed**: `#canSignIn()` runs at
    every sign-in path (password, passkey, password reset) and on every
    request, so a stored system-role login, a nameless role, or the
    later of two accounts sharing an actor id can't sign in or keep a
    session. The record stays listed in Accounts so an attorney can see
    it and disable it.
  - Smaller checks at the same point: a username is one word of at most
    64 characters, stored trimmed (it is the default actor id, so
    " dana" and "dana" were different people); a full name is at most
    120 characters; an email must look like one (a line break in it
    would be a new mail header) and a phone number needs a digit — on
    `setEmail`/`setPhone` too. A duplicate username or actor id stays
    a 400, as before. `test/account-integrity.test.ts` pins all of it.

This is still a real-vendor-shaped seed, not a finished identity system,
though MFA *is* now built — see "Two-factor authentication" below. Both
attorney-initiated **and** self-service email-link password reset are
now built — see "Password reset/change" below and "Self-service
password reset" further down. Adding/disabling accounts after the
one-time boot-time
seed *is* built now — see `AccountsService` below — but it's
attorney-gated, in-app account management, not a self-service flow (no
invite links, no self-signup — a new account is still always created by
an attorney). It replaces the *trust* gap
(headers anyone could set) with a *real* one (credentialed sessions),
which is the prerequisite §5/§6 called for, not the last word on
production auth.

### Two-factor authentication

`src/core/totp.ts` — RFC 6238 TOTP hand-rolled over `node:crypto`, the
same dependency-light call as the Google Calendar JWT flow and the SMTP
client. It's pinned against the RFC's own published test vectors, so
"does this implement the standard" is a checkable question rather than a
transitive-dependency one, and any authenticator app (Google
Authenticator, 1Password, Authy) works with it.

The system holds case files, trust balances and the audit log behind a
single password, and a password is the credential most likely to be
phished or reused. Four decisions carry the design:

- **Enrollment isn't switched on until a code has been proven to work.**
  `beginMfaEnrollment()` only stores a *pending* secret and gates
  nothing; `confirmMfaEnrollment()` requires a working code before the
  factor becomes real. Generating a secret and immediately enforcing it
  locks out anyone who mistyped it, misread the QR link, or whose phone
  clock is wrong — and that person is exactly who the firm needs able to
  log in.
- **A lost phone must not be a permanent lockout.** Ten single-use
  recovery codes are issued at enrollment, shown once and stored hashed
  like passwords. Losing those too is what `AccountsService.resetMfa()`
  is for — attorney-only, session-revoking, and audited as
  `account_mfa_reset`, because it *is* a real bypass of someone else's
  second factor and the most attractive action in the Accounts panel to
  anyone who has already compromised one attorney account. It can't be
  made safer by restricting it further, only less usable; what makes it
  survivable is that it leaves a record in a log whose integrity is
  separately provable.
- **A code can't be replayed inside its own window.** `verifyTotp()`
  returns the matching *step* rather than a boolean specifically so the
  last accepted step can be recorded and refused a second time — a code
  stays valid for its whole 30 seconds otherwise.
- **An MFA challenge is not a failed login.** `MfaRequiredError` is a
  distinct type from `AuthError` because the login throttle must treat
  them oppositely: counting the normal first half of a two-step sign-in
  would lock an attorney out of their own matters after five ordinary
  logins. A *wrong* code does count — that one is guessing.

Both *weakening* the factor and *establishing* it re-prove the password
(`verifyPassword`) even though the caller already holds a session: a
borrowed unlocked laptop shouldn't be enough to strip the protection on
the account — and, symmetrically, shouldn't be enough to plant one
either. That second half matters because MFA is opt-in: most accounts
have none yet, so a session alone letting someone silently enroll a
secret only *they* hold would be a durable, covert foothold — the
legitimate owner's next login would demand a code they can't produce,
recoverable only through an attorney's `resetMfa`. `beginMfaEnrollment`
checks the password; `confirmMfaEnrollment` doesn't need to (nothing is
live until it succeeds with a code from the secret that check already
gated). Disabling and resetting both revoke every live session, so the
change can't be ridden on an existing one.

The routes are `GET /api/mfa`, `POST /api/mfa/begin|confirm|disable|
recovery-codes` (all self-service, taking no user id at all — enrolling
a factor onto someone else's account would be a way to lock them out of
it) plus `POST /api/accounts/:id/reset-mfa`. The UI is the **Security**
panel, open to every logged-in human, and a `2FA` badge with the unused
recovery-code count in the Accounts panel.

What this doesn't do: show a scannable QR image (the `otpauth://` link
is offered instead — tapping it on the phone works, and so does typing
the key; rendering a QR would mean hand-rolling an encoder for the same
information). WebAuthn/passkeys *are* now supported — see "Passkeys
(WebAuthn)" below.

### Passkeys (WebAuthn)

A second factor alongside (or instead of) TOTP: a device's fingerprint,
face, or PIN, via the real browser platform standard rather than typing
a six-digit code. Not yet a passwordless/first-factor replacement — see
"What this doesn't do" below — closing that gap would mean changing what
`/api/login` means by "a password," a materially bigger redesign than
this pass was.

- `integrations/webauthn-provider.ts` — `WebAuthnProvider`, a vendor-
  agnostic seam over WebAuthn verification, same pattern as
  `ClaudeClient`/`CaseLawSearchClient`/`SpeechToText` elsewhere in this
  project: `core/auth.ts` depends on the interface only, never on a
  concrete library, so tests drive real unit coverage with a fake
  implementation instead of needing a hardware or software authenticator
  simulator. `SimpleWebAuthnProvider` is the real implementation, over
  `@simplewebauthn/server` — a justified dependency exception to this
  project's dependency-light style, same reasoning as `pdf-parse`/
  `pdf-lib`/`pg`: correctly verifying a WebAuthn attestation/assertion
  means parsing CBOR and validating COSE-keyed ES256/RS256/EdDSA
  signatures against the exact bytes the browser signed, and a subtly
  wrong hand-rolled verifier there is a security bug, not a style
  violation. **Its two `verify*` methods never reject, only resolve
  `{ verified: false }`** — `@simplewebauthn/server` itself *does* throw
  on malformed input (confirmed live against a garbage response), so
  `SimpleWebAuthnProvider` catches that and normalizes it, keeping
  `core/auth.ts` free of a try/catch around every call and ensuring a
  bad request always surfaces as a clean `AuthError`, never an uncaught
  exception at the HTTP layer.
- **`core/auth.ts` only ever imports the interface as a type**, never
  the concrete provider or `@simplewebauthn/server` itself — keeping
  core's "no vendor dependencies" property intact (the same reasoning
  `PaymentProcessor`/`ManualPaymentProcessor` already follow: the
  default concrete implementation is constructed and injected by
  `start.ts`, not by core). `AuthService.setWebAuthnProvider()` wires
  one in post-construction, the same shape as `setSystemApiKey()` — the
  relying-party identity (`rpID`/`origin`) is a deployment fact
  `AuthService` itself shouldn't have to know, and every existing
  `new AuthService()` call site across this codebase's tests keeps
  working unchanged since the parameter is optional. Absent, every
  passkey method throws "passkeys are not configured on this server" —
  same "absent config means the surface doesn't exist" pattern as
  everywhere else, though in practice `start.ts` always wires a real one
  (see below — this is the one integration in this project that needs
  no vendor secret at all).
- **Registering and removing both re-prove the password**, same
  reasoning as `beginMfaEnrollment`/`disableMfa` — a session alone must
  not be enough to plant or strip a factor. Removing a passkey only
  revokes every live session when that removal turns the account's
  second-factor requirement off *entirely* (no TOTP, no passkeys left);
  removing one of several factors doesn't change what `login()` still
  demands at the next sign-in, so there's nothing a forced re-login
  everywhere would protect against — a real refinement over blindly
  copying `disableMfa`'s always-revoke behavior.
- **A registration/login ceremony's challenge is single-use, short-lived
  (5 minutes), in-memory only** — the same "throwaway call state"
  pattern as `CalendarConnectionService`'s pending OAuth state and
  `AudioClipStore`. Losing it on a restart just means starting the
  ceremony over.
- **`login()`'s gate widened carefully, not loosely.** The existing
  `if (user.mfa)` branch (TOTP) is untouched; a new `else if
  (user.passkeys.length > 0)` branch throws the same `MfaRequiredError`
  for a passkey-only account, since a WebAuthn assertion needs an async
  round trip `login()`'s synchronous signature can't do. `MfaRequiredError`
  gained a `hasPasskey` flag so the login route — and the login page —
  know to offer "use a passkey instead" even when there's no TOTP code
  field to show at all. The actual passkey verification happens through
  two new, separate methods: `beginPasskeyLogin(username, password)`
  re-proves the password (the same check `login()` does, since this is
  an alternative entry into the same two-step flow, not a bypass of it)
  and returns a challenge scoped to that account's registered
  credentials; `completePasskeyLogin(username, response, remember)`
  verifies the assertion and issues a session exactly like `login()`
  does — deliberately taking **no password**, since the still-valid
  pending challenge from `begin` already proved it once for this same
  ceremony, the same non-double-checking the TOTP code step already
  gets.
- `server.ts` wires `POST /api/login/passkey/begin`/`complete` in the
  same public, unauthenticated bucket as `/api/login` itself, under the
  *same login-throttle keys/accounting* — a wrong password at `begin` is
  exactly as much a guessing attempt as a wrong password at `/api/login`
  and has to count the same way, or the throttle would have a bypass
  route around it. Self-service management is
  `GET /api/webauthn` (list, no public key exposed — the registration-
  complete response is sanitized the same way), `POST /api/webauthn/
  register/begin`/`complete`, and `DELETE /api/webauthn/:id` — same
  shape as `/api/mfa/*`, no user id anywhere, acts only on the caller's
  own account. `/api/webauthn` is also in `MFA_SETUP_ALLOWED_PATHS` and
  `needsMfaSetup()` now treats a passkey as equally satisfying the
  firm-wide `MFA_REQUIRED_ROLES` policy as TOTP — the policy cares that
  *a* second factor is enrolled, not which kind.
- **The client-side JSON↔`ArrayBuffer` translation is hand-rolled**, in
  both `app.js` (the Security panel's "Add a passkey") and `login.js`
  (the "Use a passkey instead" button) — no `@simplewebauthn/browser`
  or any other client library, since neither page has a bundler and the
  CSP only loads scripts from `'self'`: there's nowhere to load a CDN
  script from even if one were wanted, and the translation itself is
  base64url encode/decode, not cryptography, the same class of call
  this project already makes for the `FileReader`-to-base64 upload flow.
  The Security panel's passkey card hides itself entirely if
  `window.PublicKeyCredential` doesn't exist (an old browser) or the
  server 404s the surface (not configured) — same degrade-not-break
  pattern as the Google Calendar card.
- `start.ts` constructs `SimpleWebAuthnProvider` **unconditionally** —
  the one integration in this project that needs no vendor secret at
  all, since WebAuthn is a browser platform standard, not a third-party
  service. What it does need is the deployment's real identity: a
  WebAuthn credential is cryptographically bound to the exact origin it
  was registered against, so `WEBAUTHN_RP_ID`/`WEBAUTHN_ORIGIN` default
  to `PUBLIC_BASE_URL`'s hostname/URL when set, or a plain
  `http://localhost:<PORT>` otherwise — registration and login both work
  for local dev against `npm run start:review-ui` with zero extra
  configuration.
- Verified live end-to-end against a Chromium CDP virtual authenticator
  (real WebAuthn ceremonies, real cryptographic signatures verified by
  `@simplewebauthn/server`, not a mock): registering a passkey from the
  Security panel, then signing in with it from the login page after a
  password-only attempt correctly came back `mfaRequired`/`hasPasskey`.
  A second run against the same persisted account correctly refused a
  plain password-only login outright once a passkey was on file —
  exactly the gate this feature exists to add.

What this doesn't do: passwordless/first-factor login (a passkey is
only ever the *second* factor here — the password step in `login()` is
unchanged and still required first), resident-key/"sign in as anyone
this device remembers" discoverable-credential flows, platform vs.
cross-platform authenticator preference, or automatic migration for an
account that loses its only device — same recovery story as TOTP: an
attorney's `resetMfa` clears every second factor (TOTP *and* passkeys)
for someone locked out.

#### Firm-wide MFA policy

Enrollment above is per-person and voluntary by default — the gap this
closes is that a firm that decided everyone in a given role must have a
second factor had no way to make that a *control* rather than something
checked by eyeballing `2FA` badges in the Accounts panel.

`MFA_REQUIRED_ROLES` (a comma-separated role list, e.g.
`attorney,paralegal`) tells `server.ts` which roles it applies to.
Once a role is named, any account in it that hasn't confirmed a factor
gets every `/api/*` route refused with a clear reason **except**
`/api/me`, `/api/mfa/*`, `/api/logout`, and `/api/change-password` —
`needsMfaSetup()` is the one place that list and that check live.

Two things about the design are load-bearing:

- **It never blocks login itself.** Refusing the password step would
  mean the only way back in for someone who's simply never set up a
  factor yet is an attorney's `resetMfa` — a bypass meant for a lost
  phone, not for "day one, hasn't gotten to it." Instead the account
  always signs in and is routed straight to enrolling, using only
  itself.
- **It unblocks immediately, no new login required.** The check runs
  fresh on every request from `AuthService`'s live record, not from
  anything baked into the session at login time — so the moment
  `confirmMfaEnrollment` succeeds, the very next request goes through.
  A design that required logging out and back in to pick up the change
  would make the requirement itself feel like the obstacle.

`GET /api/me` reports `mfaSetupRequired` so the dashboard doesn't have
to wait for a blocked call to find out — a sticky banner ("Firm policy
requires two-factor authentication for your role") appears the moment
the account is loaded and clears itself the moment enrollment is
confirmed, without a page reload. It's a separate element from the
regular error banner on purpose: that one gets cleared at the start of
almost every action in the app, which would make a "you must do this"
notice disappear the instant anyone tried to do anything else.

What this doesn't do: require MFA for the `"system"` machine credential
(it was never a candidate — `MFA_REQUIRED_ROLES` only accepts human
roles), or retroactively invalidate a live session that predates the
policy being turned on — it takes effect on that session's very next
request, same as any other access change in this project.

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

### Self-service password reset ("forgot password")

A third path alongside the two above, for the case neither covers:
nobody with attorney access is around (or available fast enough), and
the account holder doesn't remember the current password to use
`changePassword`. Same email-link shape most production auth means by
"forgot password," built as the same kind of single-use, hashed,
time-boxed secret `MfaRecoveryCode`/the system API key already are —
not stored as plaintext anywhere, including in the persisted snapshot.

- `AuthService.requestPasswordReset(username, ttlMinutes = 60)` issues
  a token (returned once, in-memory, never logged) for a known, enabled
  username — and `undefined` for an unknown or disabled one, or for an
  account that already has `MAX_LIVE_PASSWORD_RESETS_PER_ACCOUNT` (3)
  live, unused links: each one is an email to the account holder, so
  without a cap anyone who knew a username could fill that inbox. The
  distinction never leaves this method: the HTTP route
  (`POST /api/forgot-password`, public/unauthenticated, same bucket as
  `/api/login`) sends the *exact same* response either way, the same
  no-enumeration reasoning `handleLogin` already follows for a wrong
  password vs. an unknown username. Every call also prunes already-
  expired requests from the list first, so a long-running server's
  snapshot doesn't accumulate dead tokens forever; `fromSnapshot` does
  the same pruning on load, so a token that expired while the process
  was down can't come back as redeemable.
- `AuthService.resetPasswordWithToken(token, newPassword)` redeems it —
  single-use (`usedAt` marks it spent), rejecting a reused or expired
  token with the same generic "invalid or expired" message either way
  (no reason to tell a guesser which failure mode they hit). Needs no
  proof of the *old* password, same as an attorney's `resetPassword()` —
  holding a valid token already is the proof — but like
  `changePassword()` it clears `mustChangePassword` (this is the account
  holder choosing their own password) and revokes every live session.
- **Where the email goes**: the account's own `User.email` (see "Staff
  directory…" above — the same field added for deadline-alert routing).
  No email on file means no link can be sent, so
  `POST /api/forgot-password` still returns the identical generic
  message (nothing it ever says distinguishes "no such account" from
  "account exists but has no email") — the holder calls the office,
  the same fallback this project already names for every other gap. The
  email is sent **after** the reply, not before it: waiting on the mail
  server made a real account with an email answer a second or more
  later than any other username, which told anyone timing the route
  which usernames exist. If the transport fails, that's logged
  server-side rather than changing the response — the token is real
  either way, so inventing a different answer because the send failed
  would just be a second kind of lie.
- `server.ts`'s `PasswordResetConfig` (a plain config object, same
  shape as `TwilioVoiceConfig`) carries the `EmailSender` and the
  externally-reachable base URL the reset link points at. Absent
  (`passwordReset` not passed to `createReviewServer`),
  `/api/forgot-password` still exists and responds — just by saying
  self-service reset isn't set up for this firm, rather than silently
  issuing a token nobody can retrieve. `start.ts` wires it whenever
  `PUBLIC_BASE_URL` (the same var the Twilio integration already names)
  and a real `EmailSender` are both configured.
- `public/forgot-password.html`/`.js` and `public/reset-password.html`/
  `.js` are new, unauthenticated static pages (reachable the same way
  `login.html` already is, with no session required) — a "Forgot your
  password?" link on the login page leads to the first; the emailed
  link leads to the second, which reads `?token=` from its own URL. A
  missing token shows an inline message rather than a broken form.

What this doesn't do: email verification at signup (there is no
self-service signup at all — an account is still always created by an
attorney), rate-limit `/api/forgot-password` per address beyond the
per-account cap above (the token's 192 bits of entropy is the real
defense against guessing, the same reasoning session tokens rely on
without their own separate throttle), or support a second mail
template/locale.

## Client portal

`src/review-ui/client-portal-service.ts` — the one surface in this
system a client logs into directly, rather than only ever receiving
email from. Backs the "My Matters" panel.

A `"client"` role (`Actor.role`, `AuthService`'s `UserRole`) is a real,
credentialed account like any other — created from the Accounts panel,
subject to the same login throttle, MFA, and password rules as
everyone else. **The whole design constraint is that it sees a strictly
narrower view than staff, not the same data with a different login:**

- `core/access-control.ts` gained a `client_portal` `FieldCategory` and
  a parallel grant table (`grantClientAccess`/`revokeClientAccess`/
  `getClientMatterIds`) — deliberately **not** the paralegal-assignment
  model. A paralegal assignment is one matter at a time because a
  paralegal *acts* on a matter; a client grant is additive, because a
  returning client reasonably has several matters over the years and
  granting a new one shouldn't cost them the last. A client actor
  authorized against any *other* category (`case_file`,
  `billing_internal`, `high_sensitivity`) is denied outright, even on a
  matter it's otherwise granted — those categories carry privileged
  drafts, internal notes, and every timekeeper's rate, none of which a
  client-safe view is built to filter.
- `ClientPortalService` builds its own hand-picked projection rather
  than passing an internal record through: a matter is
  `{ matterId, title, status }` — never `description` or `parties` (a
  `Matter`'s parties name the adverse side); a *staff-uploaded* document
  only appears if staff explicitly marked it `visibleToClient` on
  `core/document-store.ts` (defaults to `false` on upload, same as a
  draft starting unreviewed — `DocumentsService.setClientVisibility()`
  is the one write path, and it's audited
  `document_shared_with_client`/`document_unshared_with_client`); an
  invoice is exactly what `InvoicingService.emailInvoice()` already
  sent to this client's inbox (`listForClient`/`previewForClient`/
  `renderPdfForClient`, added to `InvoicingService` itself so the
  rendering logic isn't duplicated) — **never a draft**, since a client
  seeing a paralegal's in-progress guess before an attorney commits it
  is the same "not final" leak the review gate exists to prevent
  everywhere else; the trust balance is a single number
  (`TrustLedger.balanceForMatter`), never the entry history, which can
  carry narrative descriptions of firm work a balance doesn't need to
  say.
- **Online payment is now built** — see "Online invoice payment (Stripe
  Checkout)" below. `ManualPaymentProcessor` (staff-initiated card
  charges, see "Invoicing, payments, and staff payroll" above) is
  unaffected; Checkout is a separate, client-initiated path. Without
  `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET` configured, the panel
  falls back to the firm's payment instructions text exactly as before
  (the same letterhead field the invoice itself prints), the honest
  "say what's actually configured" pattern `emailTransportReady()`
  already uses elsewhere.
- **`core/messaging.ts` still has no client access.** `StaffService`,
  `StaffScheduleService`, `PayrollService`, and `TimeClockService` all
  predate the client portal and were written as "open to every
  logged-in human" meaning *every staff role* — none of them anticipated
  a client account. Adding the `"client"` role therefore required
  auditing all five and denying `"client"` by name in each, the same way
  `"system"` already was: a client account could otherwise have read the
  entire staff directory (who's assigned to which matter), posted to the
  firm-wide announcements, seen who's in the office, or appeared as a
  line on the firm's own payroll. The staff `MessagingStore` stays
  staff-only — see the client-firm thread below, which is deliberately
  a *separate*, narrower store rather than a client being added to this
  one.
- Server routes are mostly `GET`, under `/api/client-portal/*`
  (`matters`, `matters/:id`, `matters/:id/invoices/:id/preview`,
  `matters/:id/invoices/:id/pdf`, `matters/:id/documents/:id`, `limits`),
  plus one `POST /api/client-portal/matters/:id/documents` — see
  "Client document uploads" below for the one thing a client can
  actually create through this surface. `AccountsService.grantMatterAccess()`/
  `revokeMatterAccess()` (attorney-only, audited
  `client_portal_access_granted`/`_revoked`) are how a client gets
  access to a matter in the first place, exposed as
  `POST /api/accounts/:id/grant-matter-access` /
  `.../revoke-matter-access` and a chip-list-plus-input control in the
  Accounts panel next to a client account. A grant is refused unless the
  matter has a record: one naming any other id used to be accepted and
  wait, invisible to the client, until a matter was opened under that
  id — and since matter numbers are the firm's own, a typo ("2026-0143"
  for "2026-0142") gave the client whichever matter the firm opened next
  under that number, for someone else. Revoking needs no record.
- The dashboard gives a client account a different shell, not a
  trimmed staff one: every nav item is hidden except **My Matters** and
  **Security** (a client still manages its own password/MFA), and login
  lands directly on My Matters rather than the staff Home panel, which
  would otherwise show tiles for surfaces the account can't reach.

What this doesn't do: letting a client see anything about a matter
beyond title/status/its own invoices and explicitly-shared documents,
or a self-service signup — same as everywhere else in this project, an
account is created by an attorney, not by the client themselves. Online
payment *is* now built (see "Online invoice payment (Stripe Checkout)"
below), and client-firm messaging *is* now built too (see below).

### Online invoice payment (Stripe Checkout)

`integrations/checkout-provider.ts` / `integrations/stripe-checkout.ts`
close the gap the client portal always named: a client reading their
own invoice had no way to actually pay it from here, only the firm's
payment-instructions text. Stripe was chosen because it's the one
processor this project can integrate without a merchant account the
sandbox can provision — nothing about the design is Stripe-specific
beyond `stripe-checkout.ts` itself.

- **This is a different shape from `PaymentProcessor`
  (`integrations/payment-processor.ts`), deliberately.** That interface
  models a direct, synchronous `charge(token)` call, staff-initiated,
  for a card already tokenized (e.g. a terminal, or Stripe Elements
  embedded in the app). Stripe Checkout is a *hosted* page: the browser
  is redirected to Stripe's own domain, Stripe collects the card, and
  the result comes back asynchronously — a redirect plus a webhook, not
  a return value. `CheckoutProvider` (`createSession()` only) is the
  seam for that shape; `StripeCheckoutProvider` is the one
  implementation, hand-rolled over `fetch` against Stripe's REST API
  (form-encoded with bracket-notation nested params, since Stripe's API
  predates JSON bodies) — same dependency-light style as every other
  integration here, no `stripe` SDK.
- **The client never touches money directly — only *initiates* a
  session.** `InvoicingService.createCheckoutSession(actor, matterId,
  invoiceId)` is client-only, matter-scoped through the existing
  `client_portal` category, and charges exactly the invoice's *current*
  balance (never the original total, so a partially paid invoice can't
  be charged twice for the part already paid). `matterId`/`invoiceId`
  go on the session as structured `metadata` — never parsed back out of
  the free-text description — so the webhook can reconcile a payment to
  exactly one invoice without guessing, the same "trust structured
  fields, not free text" rule `google-calendar.ts`'s
  `extendedProperties.private` already follows.
- **Only the webhook, after signature verification, can ever record the
  resulting payment.** `InvoicingService.recordCheckoutPayment()`
  requires the `"system"` role outright — the same role
  `confirmDeadline`'s `calendar_system` source and `recordCalendarSync`
  already use for "a verified machine event, not a human request." A
  client calling this directly (there's no route that would even let
  them) couldn't anyway. It's idempotent against a retried webhook — a
  session or payment-intent id already accounted for, as a payment or
  as an unapplied receipt (below), is left alone — and records on the
  invoice no more than its current balance.
- **Money Stripe took is never dropped.** The amount used to be capped
  at the balance and the rest discarded without a trace, and if the
  invoice had been voided the whole charge went unrecorded (the webhook
  logged an error and answered 200). That happens in ordinary use: a
  client pays from two tabs, a check is recorded while the payment page
  is open, an attorney voids and reissues a bill. The money is in the
  firm's account either way, and it's the client's. Anything that can't
  go on the bill is now kept as an `UnappliedReceipt` (`overpaid`,
  `nothing_owed`, `invoice_void`, `invoice_missing`) with Stripe's
  references and an `online_payment_unapplied` audit entry. It shows on
  the Invoices panel's "Paid online, but not on a bill" card and in
  Home's "Needs your attention" list, for staff who can reach the matter.
  An attorney records what was done with it (refunded, and the refund's
  reference), once, audited as `online_payment_unapplied_resolved`.
  Docket doesn't issue the refund; that stays in Stripe, as before.
  Routes: `GET /api/invoices/unapplied-receipts` and
  `POST /api/invoices/unapplied-receipts/:id/resolve`.
- **Only money that has arrived is recorded.** Sessions don't restrict
  payment methods, so a firm with bank debits switched on in Stripe got
  `checkout.session.completed` with `payment_status: "unpaid"` the moment
  a client authorised an ACH debit. That was recorded as a card payment,
  marking the bill paid days before the debit cleared, or whether or not
  it cleared at all. `parseCheckoutSessionCompletedEvent()` now takes a
  completed session only when it's `paid`, and records a delayed one on
  `checkout.session.async_payment_succeeded`, as `ach` for a US bank
  debit and `other` for anything else. `test/online-payments.test.ts`
  pins both fixes, over HTTP too.
- `verifyStripeSignature()` implements Stripe's own webhook scheme
  (`Stripe-Signature: t=<timestamp>,v1=<hmac>[,v1=...]`, HMAC-SHA256
  over `${timestamp}.${rawBody}`, timing-safe comparison, replay
  protection via a timestamp tolerance, and tolerating more than one
  `v1` during a secret-rotation window) — fails closed on a missing or
  wrong signature, same posture as `twilio-voice.ts`'s
  `verifyTwilioSignature`. It's checked against the **raw request
  body bytes**, not the re-parsed-and-re-serialized JSON, which
  wouldn't byte-for-byte match what Stripe actually signed.
  `parseCheckoutSessionCompletedEvent()` is exported standalone so the
  parsing rules are unit-testable without a live Stripe webhook, same
  reasoning as `google-calendar.ts`'s `parseDeadlineEvent()`.
- `server.ts` wires `POST /api/client-portal/matters/:id/invoices/:id/checkout-session`
  (client-initiated, inside the existing client-portal route handler)
  and the public, session-less `POST /api/stripe/webhook` (Stripe calls
  this directly, not through a Docket session — signature verification
  is the entire auth story, same bucket as the Twilio webhooks). A
  webhook event this app doesn't recognize, or one that fails to
  record for some other reason, still gets a `200` back (Stripe retries
  on anything else, and retrying a genuinely bad event forever
  accomplishes nothing) — the failure is logged server-side instead.
  Both routes 404 without `stripeWebhook`/a `checkout`-configured
  `InvoicingService` passed to `createReviewServer`.
- The My Matters panel's invoice list gains a "Pay now" button on any
  invoice with a balance due, which **does a real full-page navigation**
  to Stripe's hosted page — not an API call that returns inline, the
  same reasoning the Google Calendar "Connect" button already uses for
  its own OAuth redirect. Landing back on `/?invoicePaid=1&matterId=...`
  shows a toast and reopens that matter; `/?invoicePaymentCancelled=1`
  shows a plain "nothing was charged" notice. The success redirect
  deliberately doesn't claim the balance is already updated — the
  webhook records the payment asynchronously, usually before the
  browser even gets back, but not guaranteed.
- `start.ts` wires this up only when `STRIPE_SECRET_KEY`/
  `STRIPE_WEBHOOK_SECRET`/`PUBLIC_BASE_URL` are all set — the same
  `PUBLIC_BASE_URL` the Twilio/calendar-OAuth/password-reset features
  already share for their own callback URLs. Absent any of the three,
  the client portal shows no "Pay now" button and falls back to the
  firm's payment-instructions text exactly as it always did.

What this doesn't do: refunds through Stripe (a refund still has to be
handled the way every other correction in this system is — void and
reissue, or a manual adjustment — Checkout only ever *collects* money),
partial payment amounts chosen by the client (a session is always for
the exact current balance, never less), saved payment methods or
subscriptions, or automatic webhook-secret rotation (regenerate it in
the Stripe dashboard and update `STRIPE_WEBHOOK_SECRET` by hand, the
same manual-rotation story as the Google Calendar service-account key).

### Client document uploads

`ClientPortalService.uploadDocument()` is this surface's one write
path — everything else in "My Matters" is read-only. A client who
needs to send the firm something (a signed form, an ID scan, a
requested record) previously had no way to do that except email or
mail it in, even though they're already logged into a portal that
shows them the matter.

- Same per-file size cap as the staff-facing `DocumentsService.upload`
  (reuses its exported `DEFAULT_MAX_UPLOAD_BYTES`, and `start.ts` wires
  both services to the exact same configured limit so the two paths
  into one document store never disagree about what's too big) —
  `GET /api/client-portal/limits` surfaces it the same way
  `GET /api/documents/limits` does for staff.
- `core/document-store.ts`'s `CaseDocument` gained `uploadedByClient`
  (defaults `false`, true only for this path). A client-submitted
  document is the one case where `visibleToClient` defaults to `true`
  instead of `false` at upload — hiding someone's own just-sent file
  from them would be a confusing "did that even go through?" moment —
  but it's still flagged `uploadedByClient` for staff, since nobody on
  staff has reviewed it yet, the same "flag it, don't auto-trust it"
  reasoning as `RESEARCH_REQUIRES_VERIFICATION_FLAG`. The Cases panel
  shows a "submitted by client" badge on these so staff can tell at a
  glance which documents came in unreviewed versus which the firm
  itself put there.
- Audited as `client_document_uploaded`, same pattern as
  `document_uploaded` on the staff side.
- The My Matters panel's "Documents shared with you" card gained a
  file picker and an "Upload" button right below the document list,
  mirroring the Cases panel's own upload control exactly (same
  `FileReader`-to-base64 flow).

What this doesn't do: let staff require or request a specific document
(there's no "please upload X" prompt — a client uploads on their own
initiative), or review/approve a client upload before it's visible to
them — it's visible to the uploader immediately; only the staff-facing
flag distinguishes it as unreviewed.

### Client-firm messaging

`src/core/client-messages.ts` / `src/review-ui/client-messaging-service.ts`
— a message thread between a firm and a client, one per matter. Backs a
"Messages" card in both the client's My Matters panel and staff's Cases
panel, reading and writing the *same* thread.

Deliberately not part of `core/messaging.ts`, which is staff-only and
denies `"client"` by name (see above) — that store models direct/group/
announcement conversations between colleagues, none of which apply to a
client relationship. This is simpler on purpose: exactly one thread per
matter. A co-client (two client accounts both granted the same matter)
shares it rather than getting a private line each — it's a conversation
about the matter, the same reasoning `core/matters.ts` gives for parties.

It's the one surface in this system two different actor kinds both read
*and write*, so `ClientMessagingService` picks the `AccessControl`
category by who's asking rather than sharing one check: a client goes
through `client_portal` (exactly the matters it's been granted); staff
goes through `case_file` (an attorney unconditionally, a paralegal only
its one assigned matter) — the same gate the Drafting/Cases panels
already use. Every other role is denied outright before either check
runs. Every post is audited (`client_message_posted`) — a client-facing
exchange about a matter is exactly the sort of thing an attorney
reviewing an incident, or a bar complaint, needs a record of. There is
no edit or delete, same reasoning as the audit log and the internal
`MessagingStore`. A message is at most 10,000 characters
(`MAX_MESSAGE_LENGTH`, shared with staff messages): there was no limit,
a signed-in request may be ~34 MB, and every message lives in the one
state document Postgres caps at 1 GB — so about thirty posts from a
client account, someone outside the firm, would have stopped anything
the firm does from being saved. The refusal says to upload anything
longer as a document; the message boxes carry the same `maxlength`.

Discoverability needed one small fix elsewhere: `CasesService`'s Cases
panel list was derived only from work product, documents, and paralegal
assignments — a matter granted to a client but with nothing else filed
on it (the common case right after granting access) wouldn't appear,
leaving staff with no way to find the thread a client could already post
to. `CasesService` now also includes every matterId with a client
grant (`AccessControl.listClientAssignments()`) in that list.

Server routes are `GET|POST /api/client-messages/matters/:matterId` —
the one client-adjacent surface with a `POST`, since unlike
`/api/client-portal/*` this one is genuinely bidirectional. 404s if no
`ClientMessagingService` was passed to `createReviewServer`.

What this doesn't do: attachments, read receipts, or replacing a phone
call for anything urgent — the client-facing copy says so. It also
doesn't route through email or any notification; a client or a staff
member finds a reply by opening the panel, the same as every other
message-shaped surface in this project.

## Attorney review-gate UI — "Docket"

`src/review-ui/` — the attorney-facing app over `review-gate.ts`
(§8 build order step 5), plus `src/core/work-product-store.ts`, the
in-memory registry that makes drafted `WorkProduct`s discoverable (a
`ParalegalDraftingSession` given a `store` registers into it automatically).
Branded **Docket**: one app shell (sidebar nav, no full-page reloads
between sections) over twenty-six panels — Home, My Matters, Search,
Review Queue, Deadlines,
Scheduling, Live Intake Demo, Drafting, Cases, Signatures, Conflicts, Trust, Invoices,
Time Clock, Payroll, Research, Assistant,
Staff, Messages, Schedule, Billing, Security, Analytics, Accounts, Import, and
Audit Log (Drafting/
Cases/Signatures/Research/Assistant/Billing and Analytics/Accounts/Import/Audit Log hidden from the
nav for roles that can't use them; Staff/Messages/Schedule are open to
every logged-in *staff* human so they're never hidden **for a staff
role** — a client account is denied those surfaces server-side, see
"Client portal" below, and the nav hides them for it too). Review Queue
and
Deadlines are themselves attorney-only server-side (`ReviewGateService`
gates every method, including reads), so the dashboard only fires their
initial load once `GET /api/me` confirms the role — a non-attorney
session sees an inline "attorney-only" message instead of a background
403 on login. A client account gets a different shell entirely: every
nav item is hidden except **My Matters** and **Security** — see below.

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
  ends, never touching `system-state.ts` or a real matter.
  - **Only receptionists and attorneys can start one**, refused up front
    (`INTAKE_ROLES`), and only the person who started a session can
    continue it. It used to be open to every signed-in account, with a
    role check only once the call reached the intake questions — *after*
    the script's conflicts screen had run against the firm's real
    matters. So a client account could type a party's name at the
    conflict question and learn from the reply ("There may be a conflict
    of interest here") whether the firm acts for or against that person,
    unaudited (reproduced with the demo seed's "Jordan Smith"). The
    public booking form never answers that question, and the
    Conflicts panel's check is staff-only and audited. The tab is hidden
    for other roles. Found by sweeping every route as each role;
    `test/intake-demo.test.ts` pins it.
  - **Training mode.** The panel is a training tool, not just a chat
    window. `ReceptionistChatSession.handleMessage()` now returns a
    `TurnTrace` on every turn (`{ label, triggers, state }` — e.g.
    "Emergency escalation · in_custody", "Conflict-of-interest check",
    "Intake question: court_date", plus a snapshot of `IntakeState`). It
    is **purely observational** — nothing in routing, escalation, or
    access control reads it, so it can't weaken any gate. The UI shows
    it as a badge under each agent bubble, a live "Call status" list
    (caller type, interpreter, consent, conflict check), and an end-of-call
    **debrief** (agent turns, final caller type, triggers fired) with a
    plain-text **transcript download**.
  - `review-ui/intake-scenarios.ts` — `INTAKE_SCENARIOS`, canned caller
    scripts (routine call, in custody, imminent police questioning, court
    within 48h, protective-order issue, crisis/self-harm, legal-advice
    request, narrated facts, vulnerable caller, AI opt-out, interpreter
    needed, consent refused, conflict of interest, billing call,
    third-party caller). Served by `GET /api/intake/scenarios`; the panel
    offers "Send next scripted line" and "Play through automatically".
    They are content only — they type lines into the real session like a
    human would, never shortcutting a gate. Practice-area-agnostic: every
    scenario targets a core trigger, not a criminal-law-specific one.
    `test/intake-scenarios.test.ts` plays each one through a real
    `ReceptionistChatSession` and pins the outcome, because a training
    script that silently stopped demonstrating its gate would be worse
    than none. Party names are deliberately not `Smith`/`Doe`-style
    common names: a "routine" scenario that fuzzy-matched the demo seed's
    "Jordan Smith" ended in a (correct) conflict hit and stopped being a
    baseline.
  - **Two real bugs found by building the scenarios, both fixed and
    pinned by tests in `receptionist-chat-agent.test.ts`.** (1) *The
    interpreter-first gate (§2) could never fire from a caller's words.*
    `extractSignalsFromText` detected "I need an interpreter", but nothing
    carried it into `IntakeState.interpreterNeeded`, which `Router.route()`
    reads (and which it folds in *over* the raw turn signal) — so the gate
    was dead code outside a hand-built state in `router.test.ts`. The chat
    agent now makes it sticky state. (2) *Every natural "no" to the custody
    or protective-order question escalated.* The raw-text extractor matches
    `in custody`/`protective order` as literal substrings with no negation
    awareness, so "No, I'm not currently in custody" was flagged as an
    emergency, and the caller's actual answer never overrode that false
    positive. The existing tests missed both because they answered a bare
    "no". Fixed narrowly: a **plain** custody denial now forwards an
    explicit `inCustody: false` that wins over the substring match, but a
    denial that also mentions an arrest/jail ("no, but they arrested me
    this morning") is left to the extractor and still escalates, and the
    protective-order answer never forwards `false` (the extractor needs
    violation wording to flag it, so a plain "no" was never a false
    positive and a forwarded `false` would hide a real violation). Follow-ups
    from review: an interpreter-first caller is re-asked the caller-type
    question after the language is given (otherwise they stay `unknown` and
    get the third-party brush-off), and an interpreter request is not
    counted as an answer to the recording-consent question.
- `accounts-service.ts` — `AccountsService`, backing the "Accounts" panel
  — see "Real authentication" above for what it does and doesn't do.
- `drafting-service.ts` — `DraftingService`, backing the "Drafting" panel
  — see "Paralegal drafting agent" above for what it does and why it adds
  its own `AccessControl` check on top of `ParalegalDraftingSession`.
- `documents-service.ts` / `cases-service.ts` — `DocumentsService` and
  `CasesService`, backing the "Cases" panel — see `document-store.ts`'s
  entry above for what they do.
- `esignature-service.ts` — `ESignatureService`, backing the
  "Signatures" panel (plus the public, session-less `/api/sign/:token*`
  routes a signer uses directly, no login at all) — see "E-signature"
  above for what it does.
- `research-service.ts` — `ResearchService`, backing the "Research" panel
  — see "Legal research — CourtListener" above for what it does.
- `assistant-service.ts` — `AssistantService`, backing the "Assistant"
  panel — see "AI Assistant — Claude" above for what it does.
- `staff-service.ts` / `messaging-service.ts` / `staff-schedule-service.ts`
  / `billing-hours-service.ts` — backing the "Staff", "Messages",
  "Schedule", and "Billing" panels respectively — see "Staff directory,
  messaging, staff schedule, and billing hours" above for what each does.
- `analytics-service.ts` — `AnalyticsService`, backing the "Analytics"
  panel — see "Analytics" above for what it does.
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
  `/api/documents/*`, `/api/cases*`, `/api/esignature/*`, `/api/audit*`, `/api/research/*`,
  `/api/assistant/*`, `/api/staff`, `/api/messages/*`,
  `/api/staff-schedule/*`, `/api/billing-hours/*`, `/api/pdf-reports/*`,
  and `/api/analytics/*`
  are 404 if no `IntakeDemoSessions`/`AccountsService`/`DraftingService`/
  `DocumentsService`/`CasesService`/`ESignatureService`/`AuditService`/`ResearchService`/
  `AssistantService`/`StaffService`/`MessagingService`/
  `StaffScheduleService`/`BillingHoursService`/`PdfReportService`/
  `AnalyticsService` was
  passed to `createReviewServer`, respectively (the public
  `/api/sign/:token*` bucket 404s the same way, same `ESignatureService`
  check). `npm run build` copies
  `public/` into `dist/` since `tsc` only compiles `.ts` files.
- `public/manifest.webmanifest` / `public/sw.js` / `public/icons/` —
  PWA support: Docket is installable (a home-screen icon, a standalone
  window) on top of the same deployed website, no app store or separate
  build. The icons are the brand mark rendered at 32/180/192/512px, not
  a different asset. `sw.js` never intercepts `/api/*` (those responses
  are per-request and often privileged — caching one risks serving
  stale case data, or a different session's response) and is
  network-first, not cache-first, for the static shell it does cache,
  since this app redeploys often and a returning visitor should see
  today's code; the cache is only an offline fallback. Registered from
  both `app.js` and `login.js` so the install prompt can fire before
  anyone's signed in. `server.ts`'s `MIME_TYPES` serves `.png` and
  `.webmanifest` correctly for this; the favicon links added alongside
  it incidentally closed a long-standing gap — there was never a
  `<link rel="icon">` anywhere, so browsers were always guessing at
  `/favicon.ico`.
- `public/login.html` — Docket-branded sign-in: a cover page (wordmark,
  "Every matter, on the record.", the three promises the app keeps, and
  the 3D file stack) beside the form — username/password + a "remember
  me" checkbox, posting to `/api/login`. Below 960px the cover drops away
  and the form stands alone. `public/theme.js` applies the light/dark
  choice made inside the app to the sign-in and password pages, so
  signing out doesn't flash the other theme.
- `public/depth.js` — the 3D layer, shared by the sign-in, password and
  dashboard pages. Markup opts in by attribute: `[data-tilt]` turns an
  element toward the pointer with a light sheen following it (the
  sign-in card, Home's stat tiles), `[data-parallax]` lets layers inside
  drift with the pointer. It only writes CSS custom properties through
  the CSSOM — never a style attribute — so the strict CSP stands; the
  stylesheets do the transforms. The sign-in page's legal pad is now a
  desk receding in perspective with a floating stack of case files above
  it; Home opens on a greeting banner with its own file stack; the brand
  mark takes a turn on hover. Everything is gated on `html.depth-on`,
  which depth.js sets only for a fine pointer with motion not reduced —
  with `prefers-reduced-motion` or on a touch screen the pages are flat
  and still (verified: computed transform `none`, scene hidden on a
  phone, no sideways scroll). `sw.js`'s shell cache gained the file and
  moved to `docket-shell-v2`. The second pass carries depth across every
  panel, all in `app.css`: panels swing up into place when switched to
  (a transform only for the animation's length, so it never becomes a
  containing block for the toasts/palette, which live outside panels
  anyway); every `.card` sits on a short stack of paper — two sheets
  drawn as extra box-shadows, so layout is untouched — that fans out on
  hover; the tab you're on joins the page; and chat bubbles arrive from
  a little way back. (Since the case-binder redesign below, panels turn
  in from the binder's spine rather than swinging up.) The flat entrance animations that
  predate depth.js now also stop under `prefers-reduced-motion`, which
  they previously ignored.
  A phone-width sweep of every panel (390px) found the whole dashboard
  scrolled sideways by about 200px: the top bar's account row (search,
  theme, name, "Change password", "Log out") never wrapped. It now wraps
  under the panel title, and no panel scrolls sideways at that width.
- `public/index.html` / `public/app.js` / `public/app.css` — the Docket
  app shell: a binder of index tabs (brand + panel nav), a page with a
  top bar showing the panel's docket line and who's signed in, and one
  panel each for **Home** (the landing panel: a
  role-aware set of stat tiles, a "Needs your attention" list that
  deep-links into the Review Queue, and a "Today" list showing your own
  schedule entry and the latest announcements — it only requests data
  the current role can read, so nothing 403s in the background, and each
  tile is best-effort so one unavailable surface can't blank the page.
  Before this, the app opened on the attorney-only Review Queue, so a
  paralegal's first impression was the words "attorney-only". Home also
  carries an attorney-only **"Getting started" checklist**, derived
  entirely from data the page already fetched for its other tiles (plus
  one extra call, `/api/invoices/email-transport`, that nothing else on
  Home needed): invite your team (`knownStaff.length > 1`), create your
  first real matter (any `/api/cases` row not prefixed `demo-` — see
  `DEMO_SEED` above), and connect email. It renders only while at least
  one item is undone, and disappears on its own once all three are — no
  separate "mark complete" action, since the underlying data already
  says so. "Dismiss" hides it regardless of completion, stored in
  `localStorage` as a per-viewer convenience — nothing the server needs
  to know or that other sessions should share, same reasoning as the
  rest of this project's few client-side-only preferences), the
  Review Queue (list/detail/approve/reject/request-revision/
  clear-flag/release), Deadlines (status check/independent confirmation/
  conflict list/a "Download CSV" on the Coming due list), Scheduling
  (book/list/reschedule/cancel/complete/
  reminders), Live Intake Demo (a chat window driving `intake-demo.ts` —
  pick a training scenario or go free-form, "Start new demo conversation",
  then type caller turns or step/play through the scripted ones; each
  agent reply carries a trace badge, a live call-status list and an
  end-of-call debrief + transcript download, a "Listen" button on each
  of the agent's own scripted replies, and "Read replies aloud"/"Play a
  sample call out loud" — see "Training mode" above and "Dashboard
  'Listen' buttons"), Drafting (pick a
  matter, draft from a template/research summary/risk assessment/billing narrative, then
  revise/submit, plus a "Listen" button on a draft's content — nav item
  hidden unless `GET /api/me` reports role
  `attorney` or `paralegal`), Cases (a clickable list of every matter,
  expanding into that matter's uploaded documents — upload a file and
  download it back out as a data URI, plus "Draft report from this PDF"
  and "Condense" actions on any uploaded PDF (see "PDF intake,
  document-report drafting, and PDF condensing" above) — alongside its
  drafted work product and a "Client messages" thread with whichever
  client accounts are granted the matter (see "Client-firm messaging"
  above); same role gate as Drafting), Signatures (pick a matter,
  pick an uploaded PDF or a released draft, add signers, send — see
  "E-signature" above — same role gate as Drafting), Research (search
  case law, "Save to
  matter" on any result, and a per-matter quick-access list with a
  Remove action — same role gate as Drafting), Assistant (a chat window
  driving `assistant-service.ts` — "Start new conversation" then ask it
  to search/draft/schedule; same role gate as Drafting), Staff (a
  read-only directory of every account — username, display name,
  initials, role, and a paralegal's matter assignment — open to every
  logged-in human, never hidden), Messages (an Announcements chat window
  every human can post to, a "start DM"/"create group" form, a
  conversation list with an "Open" button into a chat window, and a
  "Listen" button on every message when `SPEECH_TOOLS=true` — also
  never hidden), Schedule (set your own or, as an attorney, anyone's
  in-office/remote/out entry for a date; view everyone's status for a
  date or one actor's upcoming entries — also never hidden), Billing (log
  hours against a matter with a date/hours/description, view a matter's
  logged hours with a running total and a "Download CSV" button, and view
  your own hours across every matter with the same export — same role
  gate as Drafting), Analytics (matters-by-status
  tiles, caseload by attorney, invoice aging, and billable-hours/
  AI-utilization trends over a selectable window — all read-only, see
  "Analytics" above; nav item hidden unless role is `attorney`),
  Accounts (add a login with a
  username/full name/email/temporary password/role, disable/re-enable
  one, set or change an account's email, and
  for paralegal accounts specifically, assign/unassign a matter — nav
  item hidden unless role is `attorney`), Import (bring matters and
  time entries over from another system as CSV, with a row-by-row
  preview, column overrides and a conflicts acknowledgement before
  anything is written — see "Importing from another system (CSV)";
  nav item hidden unless role is `attorney`), and Audit Log (every access
  grant/denial and work-product transition, append-only, optionally
  filtered by matter id, with a "Download CSV" button for the currently
  filtered entries — nav item hidden unless role is `attorney`). The
  Drafting/Cases/Signatures/Research/Assistant/Billing and Analytics/Accounts/Audit Log hides
  are client-side convenience only; the real gate is server-side in
  `AccountsService`/`DraftingService`/`DocumentsService`/`CasesService`/
  `ESignatureService`/`ResearchService`/`AssistantService`/`BillingHoursService`/`AuditService`/
  `AnalyticsService`.
  Any `401` from the API redirects the browser back to `/login.html`.
  Every field that names a person is a `<select>` populated from
  `GET /api/staff` (showing display names, defaulting to you, and
  excluding you from "message someone"; the directory lists client
  portal accounts too, for the audit log's filter, but the staff pickers
  leave them out), and every matter field offers
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
- `DEMO_SEED=true`, only meaningful on that same first-run condition
  (no accounts exist yet), additionally populates two sample matters,
  an unconfirmed deadline, a scheduled appointment, and a work-product
  draft sitting in `pending_review` — see `seedDemoData()` in
  `start.ts`. Exists purely to shorten the gap between "deploy this"
  and "see something on screen" (see `DEPLOY.md`'s "Trying it out with
  sample data") — a fresh instance with zero accounts and `DEMO_SEED`
  unset behaves exactly as it always has, an empty system waiting for
  its first real matter.

### Visual design: the case binder

The whole interface was redesigned around one idea: the thing a
litigator actually works from is a binder on a desk. It replaced a
navy-and-brass dashboard with a dark sidebar, which read as a generic
SaaS template.

- **Layout.** The navigation is a column of index tabs on the desk; the
  panel you're on is the page those tabs open to, and its tab is cut
  from the same paper and *joins* the page (concave corners drawn with
  radial gradients, so it reads as one sheet rather than a highlighted
  row). The page has two more sheets peeking out beneath it. Section
  headings in the rail are numbered like a docket's divisions
  ("01 · CASEWORK"), and every panel's heading carries a docket line
  above it — the tab's number in the binder and its section ("No. 07 ·
  CASEWORK"), worked out by `setPanelHeading()` from the visible tabs,
  so it stays right whichever tabs a role can see. On phones the tabs
  move to the page's top edge, like a folder's, and scroll sideways.
- **Colour.** Paper and ink, with jobs kept apart: verdigris (`--accent`)
  for anything you can act on (links, focus, the "you can click this"
  hover), **ink** for primary buttons, and **stamp red** (`--accent-2`)
  only for the brand and the tab you're on — so red never means "click
  me" and never doubles as a status colour. Danger/warn/ok stay their
  own hues. Dark mode is the same binder under a lamp (warm near-blacks,
  paper-coloured primary buttons), not a blue-black theme.
- **Type.** Fraunces for headings, IBM Plex Sans for reading, IBM Plex
  Mono for docket details (matter numbers, stamps, keyboard hints) — all
  self-hosted from `public/fonts/` with their OFL licences, so the CSP's
  `font-src 'self'` needs no exception. Badges are rubber stamps (mono,
  uppercase, inked border); each panel's explanation is a margin note
  with a red rule; stats are index cards with a coloured tab.
- **The mark.** A folder with a red tab and a paper "D" cut out of it,
  drawn once as inline SVG whose parts take their colours from CSS
  (`.m-body`/`.m-tab`/`.m-glyph`), so it inverts in dark mode.
  `public/icons/` are the same mark rendered on paper at 32/180/192/512.
- **Checked, not eyeballed.** Every panel was swept in light, dark,
  phone (390px) and tablet widths with no console errors and no
  sideways scroll; the sweep found one regression (a select with long
  options pushing the Deadlines card past a phone screen), fixed by
  capping fields at their container's width.
- **Dark-mode pass.** Every panel screenshotted in dark mode and checked
  side by side. Two things were off-palette in *both* themes: search
  result titles got the browser's own pure-yellow `<mark>` (only the
  snippet's marks were styled), and the native file picker's button
  stayed a flat grey slab. Every `<mark>` now uses a `--highlight`
  token (a highlighter stroke by day, amber at night), and
  `::file-selector-button` is drawn as one of the app's own buttons.
  The booking form's focus outline was stamp red, against the
  "red never means click me" rule; it's verdigris now.

### Accessibility

Audited with axe-core (WCAG 2.1 A/AA) on the sign-in, password and
booking pages and fourteen panels in both themes, plus a contrast
measurement of every visible text node against its real background
(axe can't judge text over the paper textures, which are gradients),
plus keyboard-only Playwright runs. What that found and what changed:

- **Keyboard focus was invisible on every button and tab.** `.btn`,
  the binder tabs and the sign-in buttons reset with `all: unset`, which
  also removed the focus outline — the `:focus-visible` rule existed but
  lost on source order. Focus rings are now restated last, specifically
  enough to win, in both stylesheets.
- **Clickable rows couldn't be reached by keyboard.** A Review Queue
  item, a matter in Cases and Home's stat cards open on click but are
  `<li>`/`<div>`, so a keyboard-only user could read the queue and never
  open anything in it. One shared hook in `app.js` (a `MutationObserver`,
  so no row-building code had to change) makes every clickable row and
  tile focusable and opens it on Enter/Space. A list whose rows are all
  clickable becomes a group of buttons (`role="none"` on the list,
  `role="button"` on rows); a mixed list keeps list semantics with
  focusable rows, since a button can't sit directly inside a list
  (axe's `list` rule caught the first attempt).
- **Contrast.** The rail's small labels were 2.8:1 in light mode, the
  red section numbers on the desk 3.7:1, and the sign-in fine print was
  dimmed with `opacity`. `--text-muted`/`--rail-muted` were darkened
  (lightened in dark mode) to clear 4.5:1, a separate `--stamp-text`
  carries red as *text* a shade darker than the red used for fills, and
  the opacity dimming is gone. The only remaining sub-4.5 text is a
  disabled button, which WCAG exempts.
- **Structure.** A "Skip to the page" link comes first in the tab order;
  the nav is labelled and the tab you're on carries
  `aria-current="page"`; the error banner on every page is
  `role="alert"`; the chat transcripts (Live Intake, Assistant,
  Messages) are `role="log"` live regions so new replies are announced;
  the Import panel's row count is a status region. The command palette
  already closed on Escape and returned focus to where it was opened.

**Second pass — the remaining panels.** Scheduling, Conflicts,
Invoices, Trust, Payroll, Time Clock, Accounts, Security and Signatures
as an attorney, plus My Matters and Security as a client account — each
with real content on screen (booking requests, a signature request,
sent and draft invoices with the detail open, trust entries, a conflicts
audit), in both themes. axe found nothing and every visible text node
clears its contrast ratio (bar a disabled button, which WCAG exempts).
Tabbing through every stop on every one of those panels found two
things:

- **No focus ring on any date or time field.** Tabbing into one puts
  focus on its day/month/year part *inside* the control, and Chromium
  then matches `:focus-within` but not `:focus` — so the field's ring
  appeared for a mouse click and never for the keyboard. Fourteen fields
  across Scheduling, Conflicts, Payroll and Time Clock, plus the public
  booking page's preferred-day field. The field focus rule now covers
  `:focus-within` too.
- **Rows that looked clickable and weren't.** A booking request's
  conflict hits are a list inside a list row, and `ul.list li` gave each
  one the row's card, hover lift and pointer cursor. A list nested in a
  row is now part of that row (`ul.list li li`), matching the keyboard
  hook, which only ever treated direct children as rows. A probe of all
  24 panels found no other nested list for the rule to touch.

`test/stylesheet-a11y.test.ts` pins these, and the general rule behind
the first pass's worst finding: any selector reset with `all: unset`
must have a `:focus-visible` rule, so a new button style can't silently
lose its ring again.

### Dead ends — features a server wasn't started with

A sweep booted Docket with no optional configuration and, as attorney,
paralegal and receptionist, opened every panel and pressed every
primary button. What it found:

- **Two panels whose main action could only fail.** Assistant (no
  `ANTHROPIC_API_KEY`) answered "Start" with a raw "not configured", and
  Signatures (no `PUBLIC_BASE_URL`) failed only once a matter was typed.
  `GET /api/capabilities` now tells the dashboard, once per sign-in,
  which optional features exist (booleans only; staff roles only), and
  each such panel opens on a plain note — what isn't set up, which
  setting turns it on, and for Signatures that email is optional — with
  its controls disabled. The tab stays, so the feature stays
  discoverable. Nothing is decided by the probe: every route still
  404s on its own when its service is absent, and a failed probe leaves
  the panels exactly as they were.
- **Requests made only to be refused.** Scheduling asked for booking
  requests and Security for the calendar connection on every visit,
  logging a 404 each time; both now skip the request when the probe
  says the feature is off — and wait for the probe to answer, since a
  panel opened in the first moment after sign-in found it still unread,
  took that as "available" and asked anyway. A receptionist's matter autocomplete asked
  for the attorney/paralegal-only matter list on nearly every panel
  and got a 403 each time; it no longer asks.
- **"Draft" with no matter chosen** posted to `/api/drafting/matters//…`
  and showed the server's bare "not found". It now says to pick a matter
  first.
- **An error followed you between panels.** Accounts' "username must not
  be empty" was still on screen on the Import panel. Switching panels
  clears the banner.
- And the 401 above: pressing "Create account" with a blank username
  signed the attorney out.

`/api/appointments*` (see `scheduling.ts` above) is wired into the same
server, gated by `SchedulingService`'s own optional `AccessControl`
integration rather than `ReviewGateService` — scheduling is a
receptionist-role concern, not attorney-only, so it deliberately isn't
behind the attorney-only service. It still requires a logged-in session
(any role) like every other `/api/*` route.

## Persistence

`src/persistence/` — real durability behind a storage-agnostic seam, not
an in-memory-only demo.

**Two robustness bugs found by running it, both fixed and pinned by
tests:** the atomic-write temp path was `${file}.${pid}.${Date.now()}.tmp`,
so two saves inside one millisecond from one process produced the *same*
temp file — the first renamed it into place and the second's rename hit
`ENOENT`. Worse, `onMutated` fired the save as a floating promise, so
that rejection crashed the whole server and took every logged-in user
with it. The temp suffix is now random, and saves are chained through
one promise (so two writers are never in flight) and never fatal: a
failed save logs loudly and the next mutation retries.
 §8's "not yet built — persistence" is resolved
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

Deploying this as a publicly reachable website (Render/Fly.io/Docker
Compose/plain Docker) is covered separately in `DEPLOY.md` — the
`Dockerfile`, `render.yaml`, `fly.toml`, and `docker-compose.yml` at the
repo root back those four paths.

```
npm install
npm run typecheck        # tsc --noEmit
npm test                  # vitest run — Postgres-backed persistence tests skip cleanly if TEST_DATABASE_URL / a local Postgres isn't reachable
ATTORNEY_USERNAME=you ATTORNEY_PASSWORD=at-least-8-chars npm run start:review-ui   # first boot: seeds your login
# ATTORNEY_USERNAME=you ATTORNEY_PASSWORD=at-least-8-chars DEMO_SEED=true npm run start:review-ui   # same, plus sample matters/deadline/appointment/draft to click around immediately — see DEPLOY.md
npm run start:review-ui   # subsequent boots — attorney review-gate dashboard at http://localhost:3000
# STATE_FILE=./data/system-state.json PORT=3000 npm run start:review-ui  # override the file-backed default
# DATABASE_URL=postgres://user:pass@host:5432/docket npm run start:review-ui  # use Postgres instead of the file store
# TRUST_PROXY=true npm run start:review-ui                               # only behind a real TLS-terminating reverse proxy — see "Real authentication"
# MFA_REQUIRED_ROLES=attorney,paralegal npm run start:review-ui           # optional — blocks those roles' sessions from everything but enrolling MFA until they do (see "Firm-wide MFA policy")
# FIRM_CONFIG_FILE=./data/firm-config.json npm run start:review-ui        # enable scheduling business-hours/attorney-assignment/branding, and the invoice letterhead (firmName + letterhead.addressLines/phone/billingEmail/paymentInstructions)
# CALENDAR_SYSTEM_API_KEY=... npm run start:review-ui                     # pin the calendar-integration key instead of auto-generating one
GOOGLE_SERVICE_ACCOUNT_EMAIL=... GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY=... GOOGLE_CALENDAR_ID=... DOCKET_BASE_URL=http://localhost:3000 DOCKET_SYSTEM_API_KEY=... npm run sync:calendar  # one-shot Google Calendar deadline sync (run on a schedule, e.g. cron)
# ... && npm run sync:calendar:push                                       # one-shot: push pending appointments out to Google Calendar (same env vars; the other sync direction)
# GOOGLE_OAUTH_CLIENT_ID=... GOOGLE_OAUTH_CLIENT_SECRET=... PUBLIC_BASE_URL=https://docket.example.com npm run start:review-ui  # enable attorneys connecting their own Google Calendar from the Security panel (see "Per-attorney Google Calendar connections")
# ... GOOGLE_CALENDAR_PER_ATTORNEY=true npm run sync:calendar:push          # push to each attorney's own connected calendar instead of the one shared GOOGLE_CALENDAR_ID (GOOGLE_SERVICE_ACCOUNT_* become fallback-only for attorneys with no connection)
# SMTP_HOST=... SMTP_FROM=... DOCKET_BASE_URL=http://localhost:3000 DOCKET_SYSTEM_API_KEY=... FIRM_NAME="..." npm run send:reminders  # one-shot: email whichever appointment reminders are due right now (run on a schedule, e.g. cron every few minutes); add TWILIO_ACCOUNT_SID=... TWILIO_AUTH_TOKEN=... TWILIO_SMS_FROM_NUMBER=... to also text them
# SMTP_HOST=... SMTP_FROM=... DOCKET_BASE_URL=http://localhost:3000 DOCKET_SYSTEM_API_KEY=... npm run send:deadline-alerts  # one-shot: email each matter's responsible attorney their own at-risk deadlines (run on a schedule, e.g. daily cron); add DEADLINE_ALERT_RECIPIENT=partners@firm.example as a catch-all for matters with no responsible attorney/email on file
# TWILIO_ACCOUNT_SID=... TWILIO_AUTH_TOKEN=... PUBLIC_BASE_URL=https://docket.example.com npm run start:review-ui  # enable the telephony integration; also point a Twilio number's voice webhook at $PUBLIC_BASE_URL/api/voice/twilio/incoming in the Twilio console
# SMTP_HOST=smtp.example.com SMTP_FROM=... PUBLIC_BASE_URL=https://docket.example.com npm run start:review-ui  # enable self-service "forgot password" email links (reuses PUBLIC_BASE_URL and whichever SMTP_* vars are already set for invoices — see "Self-service password reset")
# (no config needed) "Download calendar (.ics)" on the Deadlines and Scheduling panels — the caller's own deadlines/appointments as a calendar file; see "Calendar file export (.ics)"
# (no config needed) the Import panel is always on for attorneys — CSV exports from Clio/MyCase/PracticePanther or a spreadsheet; see "Importing from another system (CSV)"
# PUBLIC_BOOKING=true npm run start:review-ui                            # turn on the public /book.html consultation-request page (requests land in the Scheduling panel; staff accept and pick the time — see "Self-service public booking")
# PUBLIC_BASE_URL=https://docket.example.com npm run start:review-ui     # enable the Signatures panel's e-signature requests (see "E-signature") — needs no new vendor; emails each signer's link whenever SMTP_* is also set, otherwise the panel shows the raw link for staff to share
# STRIPE_SECRET_KEY=sk_... STRIPE_WEBHOOK_SECRET=whsec_... PUBLIC_BASE_URL=https://docket.example.com npm run start:review-ui  # enable a "Pay now" button on outstanding invoices in the client portal (see "Online invoice payment (Stripe Checkout)"); also point a Stripe webhook endpoint at $PUBLIC_BASE_URL/api/stripe/webhook listening for checkout.session.completed and checkout.session.async_payment_succeeded in the Stripe dashboard
# VOICEBOX_BASE_URL=http://127.0.0.1:17493 VOICEBOX_PROFILE_ID=...                    # optional — defaults to Voicebox's own local port/default voice
# SPEECH_TOOLS=true npm run start:review-ui                               # use the firm's Voicebox voice for "Listen"/read-aloud (otherwise the browser's own offline voice is used, where the device has one) — independent of Twilio, reuses VOICEBOX_BASE_URL/VOICEBOX_PROFILE_ID
# COURTLISTENER_API_TOKEN=...                                             # optional — search works unauthenticated at a lower rate limit
# ANTHROPIC_API_KEY=sk-ant-...  ANTHROPIC_MODEL=claude-sonnet-5  npm run start:review-ui  # enable the Assistant panel; ANTHROPIC_MODEL/ANTHROPIC_BASE_URL are optional overrides
# INTAKE_NATURAL_PHRASING=true ANTHROPIC_API_KEY=sk-ant-... npm run start:review-ui  # let Claude add a short acknowledgement before Live Intake questions (sends caller text to Anthropic; gates and questions stay scripted — see "acknowledgements.ts")
# AUDIT_ANCHOR_FILE=/mnt/append-only/anchors.jsonl AUDIT_ANCHOR_EMAILS=partner@firm.example npm run start:review-ui  # publish the audit head hash outside this database (see "Anchoring")
# ... && npm run anchor:audit                                             # one-shot anchor, meant for cron — refuses if the chain is already broken
# fileRetentionYears in FIRM_CONFIG_FILE                                  # optional — how long a closed file is kept; absent, matters close with no retention date
# FIRM_TIME_ZONE=America/New_York npm run start:review-ui                 # optional — the firm's zone, where every "today" is counted (court dates the receptionist hears, Coming due, overdue invoices, closing dates, the Time Clock); defaults to the firm config's business-hours zone, then the host's
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
- Self-service invites/signup (an account is still always created by
  an attorney) — attorney-initiated password reset, self-service
  password change, self-service email-link password reset, TOTP
  two-factor authentication, and adding/disabling users after the
  one-time boot-time seed are all built (see "Real authentication"
  above)
- A normalized relational schema for the Postgres adapter, if this ever
  needs to scale past what one JSON blob per deployment comfortably
  handles (see "Persistence" above) — a bigger redesign, deliberately not
  done preemptively
