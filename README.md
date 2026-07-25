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
me", and TLS-aware cookies behind a real reverse proxy), a live in-app
demo of the receptionist agent, a Drafting panel where a paralegal writes
up contracts/motions/discovery requests/research summaries/billing
narratives and submits them for review, a Cases panel where a paralegal
uploads and names the actual files for a matter (contracts, exhibits,
scanned forms) and can click into any case to see its documents and
drafted work product side by side, attorney-gated account management
(add a login, disable/re-enable one, assign a paralegal to a matter —
access is revoked/scoped immediately), and an attorney-only Audit Log
panel over the append-only, privilege-sensitive audit trail; and
**persistence** that's either file-backed or a real Postgres database —
plus the interfaces a practice-area module and firm config plug into.
See CLAUDE.md's "Not yet built" section for what's still ahead (real
STT/TTS vendor, password reset/MFA, a real calendar vendor).

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
