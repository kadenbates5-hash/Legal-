# Legal AI Receptionist & Paralegal System

AI system with two coordinated agents for a law firm — a client-facing
receptionist agent and an attorney-facing paralegal agent — built as a
practice-area-agnostic core plus swappable modules. Pilot practice area is
criminal law.

See `docs/spec.md` for the full project specification and `CLAUDE.md` for
the architecture of what's implemented so far.

This repository implements all six steps of the spec's suggested build
order (§8): the **core layer** (routing, escalation, confidentiality/
access-control, human-in-the-loop review gates, audit logging, and AI
utilization tracking); the **receptionist agent** (chat and voice
channels); the **paralegal drafting agent**; the **attorney review-gate
UI**; and file-backed **persistence** — plus the interfaces a
practice-area module and firm config plug into. See CLAUDE.md's "Not yet
built" section for what's still ahead (real STT/TTS vendor, real auth, a
production database).

## Setup

```
npm install
npm run typecheck
npm test
npm run start:review-ui   # attorney review-gate dashboard at http://localhost:3000
```
