# AI receptionist & paralegal system — project specification

Pilot practice area: criminal law · Design goal: scalable core usable by any practice area/firm

## 1. Purpose and scope

An AI system with two coordinated agents for a law firm:

- A **receptionist agent** — client- and public-facing, handles voice and chat
- A **paralegal agent** — internal, attorney-facing, produces work product

Built as three layers so the criminal-law pilot is "core + criminal module,"
and future practice areas are new modules, not new systems:

1. **Core layer** (same for every firm): routing, scheduling, confidentiality
   rules, escalation engine, audit logging, human-in-the-loop gates
2. **Practice-area module** (swappable): intake questions, deadline logic,
   templates, jargon, escalation triggers specific to the area
3. **Firm-level config**: attorney assignments, hours, tone/branding,
   sign-off rules

**Non-negotiable design rule**: nothing produced by either agent reaches a
client, a filing, or an invoice without passing through a human attorney
checkpoint. The agents draft and triage; they do not finalize.

## 2. Receptionist agent (criminal law module)

Channels: voice and chat, same triage logic across both.

Core functions:

- Answer calls/chats; identify caller type (new client, existing client,
  family member of a client, billing question, emergency)
- Schedule/reschedule consultations, send reminders
- Take basic intake info — contact details, brief issue description —
  without legal analysis
- Route to the right human, fast

Hard-coded behaviors (no exceptions):

- **No legal advice, ever.** Questions like "am I going to jail," "do I have
  a case," "should I talk to police" get a redirect to an attorney, never
  an answer, however sympathetically asked.
- **Interrupt/redirect people trying to explain what happened.** Acknowledge,
  don't ask follow-up questions, get them to a human quickly. Pre-retention
  statements may not yet be privileged.
- **Confidentiality with third parties.** Family members calling for updates
  are not the client. Default: "I can't share case details, but I can pass
  along a message" — even to a spouse or parent.
- **Emergency escalation, not queued triage**, for: in-custody calls,
  imminent police questioning, court appearance within 24–48 hours, active
  protective-order issues.
- **Conflict-of-interest check at intake**, before any substantive
  information is collected — catches co-defendant/witness/victim overlaps
  early.
- **Recording consent** handled per two-party/one-party consent rules of the
  relevant state, disclosed up front.
- **Language/interpreter routing** as a first-triage question, not an
  afterthought.
- **Vulnerable-caller handling** — minors, visibly impaired/intoxicated
  callers, someone in acute distress — gentler script, faster human
  handoff.
- **Client opt-out path** — a caller/client who doesn't want AI involvement
  in their matter routes cleanly to a fully human workflow.
- **Accessible design** (ADA-relevant) given this channel is public-facing.

## 3. Paralegal agent (criminal law module)

Core functions:

- Draft from templates: engagement letters, discovery requests,
  correspondence, motions
- Legal research summaries, with citations, explicitly flagged as needing
  attorney verification
- Case file organization
- Document review/redlining, exhibit prep
- Correspondence drafts
- Billing/time-entry narrative drafts (see §4 — internal only)

Hard-coded behaviors:

- **Mandatory attorney review gate** on everything before it leaves the
  system — this is the UPL guardrail.
- **Deadline calculations are never single-sourced.** Speedy trial,
  arraignment, and bail-hearing deadlines are the top malpractice risk in
  criminal defense — agent-calculated dates require redundant
  human/calendar-system verification. (Full deadline-tracking design — not
  yet specified; flagged as an open item, §7.)
- **Padilla flag**: any plea-related drafting for a noncitizen client must
  hard-trigger an immigration-consequence advisory flag for attorney review
  (per *Padilla v. Kentucky*), not rely on someone remembering to check.
- **Protective-order/discovery handling**: documents carry a metadata tag
  (e.g. "protective order — no distribution") that the system checks before
  any drafting, copying, or sharing action.
- **High-sensitivity data tier** for cooperating-witness/informant
  information — access-restricted beyond standard matter-scoping.

## 4. AI utilization tracking (internal only — not client billing)

Purpose: measure how much time the agents spend on a matter, for firm
operational insight. This is explicitly walled off from any client-facing
billing system — never presented or convertible into an invoice line.

Logged per task:

- Matter/case ID
- Agent role (receptionist / paralegal)
- Task type (drafting, research, intake, scheduling, deadline calc,
  document review, etc.)
- Start/end timestamp or duration
- Brief task description
- Status (completed / sent for review / revised after review / abandoned)

Useful derived views:

- Time per matter, time per task type firm-wide
- Agent time vs. human review/correction time (the real signal for whether
  a task is actually saving time yet)
- Trend over time as the system improves

Design notes: passive/automatic logging (not staff-initiated), granular
per-task storage, no attorney sign-off needed since it's operational
telemetry, not work product.

## 5. Confidentiality, privilege & data security

Confidentiality (Model Rule 1.6) vs. privilege — treated as distinct
problems:

- Confidentiality is broad: covers all information related to the
  representation, from any source, absent informed consent.
- Privilege is narrower and evidentiary, and can be waived accidentally
  (third party on a call, jail-line calls that are recorded/non-private).

Access control:

- Receptionist agent: scoped to intake/scheduling fields only — no
  case-file read access.
- Paralegal agent: scoped to its assigned matter only — no cross-matter
  visibility or shared context between cases.
- Enforced technically (permissions), not just by policy.

Vendor/tool due diligence checklist (complete before selecting any AI
vendor/model):

- Zero-data-retention option available?
- No training on firm data?
- Known/acceptable data storage jurisdiction?
- Could the vendor be compelled to disclose logs (relevant for a
  criminal-defense-specific subpoena risk)?
- Encryption in transit and at rest?

Pre-engagement minimization: before a retainer is signed, collect/store
only what's needed to triage or schedule — not a full case narrative —
since privileged status is uncertain at that stage.

Audit trail: treated as privilege-sensitive itself — access-restricted and
counsel-aware, not an open engineering log.

Breach response plan: written and approved before launch, with
notification timelines checked against the specific state's
breach-notification law.

Retention/destruction: a defined schedule per data category (case file /
intake-only / high-sensitivity), enforced automatically.

Consent & disclosure: specific, attorney-reviewed language naming the AI
system and what it touches — boilerplate engagement-letter language is not
considered adequate consent (per ABA Formal Opinion 512).

Jurisdiction check: confirm the specific state's own AI ethics guidance, if
any exists beyond the ABA's national opinion, before launch.

## 6. Compliance and risk items

- ABA Formal Opinion 512 (July 2024) is the governing national framework —
  covers competence, confidentiality, client communication, candor to
  tribunals, supervision, and fees. Several states have issued their own
  guidance beyond it.
- UPL guardrail: the receptionist never gives legal advice; the paralegal
  agent never finalizes work product without attorney sign-off.
- Court rules on AI-assisted filings — some courts require certifying
  whether AI was used in preparing a document; varies by
  jurisdiction/judge and needs tracking alongside bar guidance.
- Malpractice insurance carrier should be looped in before launch — some
  policies have exclusions or disclosure requirements around AI-assisted
  work.
- Staff training/change management — attorneys and staff need clear
  guidance on what the agent can/can't do and when to override it.

## 7. Open items — not yet specified

These were flagged during planning but need their own design pass before
or during the build:

1. Deadline/calendar tracking system with genuine redundancy (not
   single-sourced to the agent)
2. Document templates and intake question sets specific to criminal matters
3. Testing/red-teaming plan — edge cases like confessions mid-call, minors
   calling, crisis situations — before the receptionist agent ever talks to
   a real person

## 8. Suggested build approach

- Treat this document as the seed spec — feed it to Claude Code as the
  project brief/reference doc.
- Suggested build order: core routing/escalation engine → receptionist
  agent (chat channel first, voice second) → confidentiality/access-control
  layer → paralegal agent drafting functions → utilization tracking →
  attorney review-gate UI.
- Keep the human-review gates as actual enforced code paths (permissions,
  required approval steps) — not just instructions in a prompt that a model
  could be talked around.
- Resolve the three open items in §7 before connecting the system to real
  clients, even in pilot form.
