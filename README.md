# Docket — AI Receptionist & Paralegal System

AI system with two coordinated agents for a law firm — a client-facing
receptionist agent and an attorney-facing paralegal agent — built as a
practice-area-agnostic core plus swappable modules. Pilot practice area is
criminal law. **Docket** is the app that ties it together: a paralegal
drafting workspace, an attorney review queue, deadline tracking,
scheduling, a live receptionist demo, and account management, behind real
login.

See `docs/spec.md` for the full project specification and `CLAUDE.md` for
the architecture of what's implemented so far.

This repository implements all six steps of the spec's suggested build
order (§8): the **core layer** (routing, escalation, confidentiality/
access-control, human-in-the-loop review gates, audit logging, redundant
deadline tracking, consultation scheduling/reminders, and AI utilization
tracking); the **receptionist agent** (chat and voice channels); the
**paralegal drafting agent**; **Docket**, the app, with real, credentialed
login (scrypt-hashed passwords, session cookies, an optional "remember
me", TLS-aware cookies behind a real reverse proxy, attorney-initiated
password reset, and self-service password change), a live in-app
demo of the receptionist agent, a Drafting panel where a paralegal writes
up contracts/motions/discovery requests/research summaries/billing
narratives and submits them for review, a Cases panel where a paralegal
uploads and names the actual files for a matter (contracts, exhibits,
scanned forms) and can click into any case to see its documents and
drafted work product side by side, a Research panel where a paralegal or
attorney searches real case law (via CourtListener) and saves citations
for quick access on a matter, attorney-gated account management
(add a login, disable/re-enable one, assign a paralegal to a matter —
access is revoked/scoped immediately), and an attorney-only Audit Log
panel over the append-only, privilege-sensitive audit trail; **persistence**
that's either file-backed or a real Postgres database; and a **Google
Calendar integration** (`npm run sync:calendar`) that confirms deadlines
against a shared calendar as the independent `calendar_system` source;
a **Voicebox** STT/TTS integration behind the receptionist voice
channel's vendor-agnostic interfaces (local, open-source — see
CLAUDE.md's "Voicebox voice integration" for what that tradeoff means);
a **Twilio telephony integration** so a real phone call reaches the
receptionist agent end to end (Twilio webhook → Voicebox transcribes →
the same router/escalation state machine as chat → Voicebox speaks the
reply back); and an **Assistant panel** — a real, tool-calling Claude API
integration for attorneys/paralegals that can search case law, draft and
revise work product, manage research, and handle scheduling, scoped to
exactly what the logged-in user's own account can already do, and
permanently barred from the review-gate/deadline-confirmation/account-
management surfaces no matter who's using it; a **Staff** directory panel
(username, display name, initials, role, and a paralegal's matter
assignment, visible to every logged-in human); a **Messages** panel with
direct messages, named group chats, and a firm-wide Announcements channel
anyone can post to; a **Schedule** panel tracking who's in the office,
remote, or out on a given day (self-service, or attorney-set for anyone
else); a **Billing** panel where lawyers and paralegals log billable
hours against a matter, kept distinct from the AI-utilization
telemetry; and, on the Cases panel, a PDF intake pipeline — draft a
report from an uploaded PDF's extracted text (always flagged for
attorney verification) or condense one into a smaller file — plus the
interfaces a practice-area module and firm config
plug into; and a **Conflicts** panel with real matter records (client and
adverse parties) behind a firm-wide conflict-of-interest screen —
name-normalizing so "Acme, Inc." and "ACME Corporation" are one
adversary, classifying hits against ABA Model Rules 1.7/1.9 and
searching every matter because Rule 1.10 imputes a conflict to the whole
firm, auditing every check, and wired into live intake so a caller who
names a current client stops the conversation; a **Trust** panel for
client funds (IOLTA) where a client's balance can never go negative,
entries are corrected by reversal rather than edited, money is integer
cents, moving funds *out* is attorney-only, and three-way reconciliation
reports a discrepancy to the penny; and an audited, attorney-only
**client file export** bundling everything held for a matter, since the
client file belongs to the client; an **Invoices** panel that bills
clients (pulling logged time onto a draft), locks an invoice's lines once
it's sent, records payments, and can apply a client's trust funds to a
bill — writing both the invoice payment and the matching trust withdrawal
so the two can never disagree, behind a vendor-agnostic payment-processor
seam that works manually until a processor is chosen — and that emails a
client their bill as a **fully itemised invoice** (every time line
carrying the date, the timekeeper, the task, the hours and the rate,
split into services / expenses / fixed fees) — attached as a **PDF** and
downloadable from the panel, previewable on screen
before it goes, refusing to send in the clear over SMTP, and skipping
hours already billed so pressing the button twice can't double-bill, and
showing an **accounts-receivable** view of everything outstanding across
your matters with the most overdue first, each with a one-click payment
**reminder** (deliberately manual, never automated dunning — and it
refuses to chase an invoice that's already paid);
a **Time Clock** panel to punch in and out with daily, weekly and
monthly totals counted in the firm's own timezone, where open shifts
never inflate a total and corrections are attorney-only and keep the
original on the record; and a **Payroll**
panel for what the firm pays its staff, with historical rates so a raise
never restates an already-paid period. Docket opens on a
role-aware **Home** panel showing what
needs you, and every person/matter field is a picker rather than an id
typed from memory. Security-wise it ships **login brute-force
throttling** (per-username and per-IP, audited, time-boxed so it can't
be used to lock a real attorney out permanently), a strict
**Content-Security-Policy** with no inline script, clickjacking and
MIME-sniffing defenses, and a hard request-body ceiling. The **audit
log** records who did what across the whole app — including field-level
before/after for record edits — and is **hash-chained**, so an entry
deleted or altered straight in the database breaks the chain and is
reported by the panel's "Verify the chain" button. Because a chain can be
rebuilt by anyone with database access, the head hash can also be
**anchored** — published to an append-only file or emailed to the
partners — so a log quietly rebuilt from scratch is caught by comparison
against a copy that whoever administers the database could not have
altered. `npm run anchor:audit` runs it on a schedule. See CLAUDE.md's
"Transport & session security" for the details, and its "Not yet built"
section for what's still ahead
(the one-time Twilio console step of pointing a real phone number at
this, MFA, Google Calendar key rotation/vendor due-diligence).

## Setup

```
npm install
npm run typecheck
npm test
ATTORNEY_USERNAME=you ATTORNEY_PASSWORD=at-least-8-chars npm run start:review-ui
```

First boot seeds your attorney login from those env vars and prints a
generated calendar-integration API key (or set `CALENDAR_SYSTEM_API_KEY`
yourself) — see CLAUDE.md's "Real authentication" section. Subsequent
boots just need `npm run start:review-ui`; visit
http://localhost:3000/login.html to sign in.

By default state is a local JSON file (`STATE_FILE`, default
`./data/system-state.json`). Set `DATABASE_URL` to use Postgres instead —
the table (`docket_state`) is created automatically on first connect. Set
`TRUST_PROXY=true` only when actually deployed behind a reverse proxy that
terminates TLS and sets `X-Forwarded-Proto` itself — never on a
directly-exposed process.

## Deploying (e.g. Railway)

The app is a plain Node HTTP server (`npm run build && npm start`,
respects `PORT`), so it runs on any Node-hosting PaaS. Railway steps:

1. Push this repo to GitHub (already done if you're reading this from a
   clone) and create a new Railway project from it — Railway's Nixpacks
   builder auto-detects `npm run build` (build command) and `npm start`
   (start command) from `package.json`.
2. Set environment variables on the Railway service: at minimum
   `ATTORNEY_USERNAME` / `ATTORNEY_PASSWORD` (first-boot login seed —
   see "Real authentication" in CLAUDE.md) and `TRUST_PROXY=true`
   (Railway terminates TLS in front of your service, so the session
   cookie needs to know to trust `X-Forwarded-Proto`). Add any of the
   optional integration env vars from the Commands section in CLAUDE.md
   as needed (Twilio, Voicebox, CourtListener, Anthropic, Google
   Calendar).
3. **Attach a persistent Volume** if you're staying on the file-backed
   store (the default — no `DATABASE_URL` set): mount it at whatever
   `STATE_FILE`'s directory resolves to (default `./data`, so mount at
   `/app/data` and leave `STATE_FILE` unset, or set `STATE_FILE` to a
   path inside the volume). **This step is not optional** — most PaaS
   containers, Railway included, wipe the filesystem on every redeploy
   or restart; without a mounted volume, every account/matter/message
   this app has ever stored disappears the next time you ship a change.
   Moving to Postgres (set `DATABASE_URL` to a Railway Postgres
   add-on's connection string) sidesteps this entirely, since the
   database is a separate, persistent service — see "Persistence" in
   CLAUDE.md for that tradeoff.
4. Deploy. Railway assigns a public URL and sets `PORT` itself — `start.ts`
   already reads it. Once it's up, visit `https://<your-app>.up.railway.app/login.html`.

The same shape (build once, run `node dist/review-ui/start.js`, read
`PORT`/`DATABASE_URL`/`TRUST_PROXY` from the environment) works on
Render or Fly.io too — only the console steps for setting env vars and
attaching persistent storage differ.
