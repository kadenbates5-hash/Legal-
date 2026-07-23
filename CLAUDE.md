# AI Receptionist & Paralegal System

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
   assignments, hours, tone/branding, sign-off rules.

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
- `scripts.ts` — the actual hard-coded reply text per directive.

Voice would reuse this same state machine behind a speech-to-text/
text-to-speech shim — not yet built.

## Practice-area module contract

A module implements `PracticeAreaModule` (`src/config/practice-area.ts`):
intake questions, document templates, and `deriveEscalationSignals()` to
translate module-specific context into core `EscalationSignals`. A module
can only *add* signals — core's trigger set has no suppression path.

`src/modules/criminal-law/index.ts` is the pilot module and also shows the
Padilla-flag and protective-order-flag pattern: module code calls
`workProduct.addFlag(...)`, and `review-gate.ts` blocks approval until an
attorney clears it.

## Commands

```
npm install
npm run typecheck   # tsc --noEmit
npm test             # vitest run
```

## Open items (§7 of the spec — resolve before connecting to real clients)

1. Deadline/calendar tracking system with genuine redundancy (not
   single-sourced to the agent) — not yet designed.
2. Full document templates and intake question sets specific to criminal
   matters — `criminal-law/index.ts` has only a minimal seed set.
3. Testing/red-teaming plan for edge cases (confessions mid-call, minors
   calling, crisis situations) before the receptionist agent talks to a
   real person.

## Not yet built

Core layer (step 1) and the receptionist chat agent (step 2, chat channel
only) are implemented. Still open, in order per §8:

- Receptionist agent, voice channel — same `router.ts` state machine behind
  a speech-to-text/text-to-speech shim
- Paralegal agent drafting functions — calls into `review-gate.ts`
- Attorney review-gate UI
- Persistence (everything above is currently in-memory)
