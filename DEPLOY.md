# Deploying Docket

Docket is a single dependency-light Node HTTP server (`src/review-ui/start.ts`)
with no framework and no build-time coupling to any one host — `Dockerfile`
is the one artifact every path below shares. Pick whichever fits what you
already have:

## Option A — Render (easiest, free Postgres included)

1. Push this repo to GitHub (or your own git host) if it isn't already.
2. In the Render dashboard: **New → Blueprint**, point it at the repo.
   Render reads `render.yaml` and provisions both the web service and a
   free Postgres database automatically.
3. Render will prompt for `ATTORNEY_USERNAME`/`ATTORNEY_PASSWORD` (marked
   `sync: false` in `render.yaml` so they're entered once, not committed).
   These seed your first login — see "Real authentication" in CLAUDE.md.
4. Deploy. Render builds the `Dockerfile` and gives you a public
   `https://docket-<random>.onrender.com` URL immediately — that's the
   whole thing.

Nothing else is required to get a real, publicly reachable instance.
Everything past this (SMTP, Twilio, Google Calendar, Anthropic, etc.) is
optional and can be added later as env vars in the Render dashboard — see
the `Commands` section of CLAUDE.md for the full list.

## Option B — Fly.io

```
fly apps create <your-app-name>       # then edit `app = "..."` in fly.toml to match
fly postgres create                   # optional but recommended — see below
fly secrets set ATTORNEY_USERNAME=you ATTORNEY_PASSWORD=at-least-8-chars TRUST_PROXY=true
fly secrets set DATABASE_URL=postgres://...     # from `fly postgres create`, or skip and use the volume instead
fly volumes create docket_data --size 1         # only needed if you skipped DATABASE_URL
fly deploy
```

`fly.toml` is pre-filled with the port, health check, and TLS
termination Fly expects — `fly deploy` is the only command that needs to
succeed for `https://<your-app-name>.fly.dev` to go live.

## Option C — Any VPS you already control (Docker Compose)

```
cp .env.example .env    # fill in a real POSTGRES_PASSWORD and attorney credentials
docker compose up -d
```

This starts Docket plus its own Postgres container, both on the same
Docker network, listening on port 3000. Put a real reverse proxy in front
of it for TLS — Caddy is the least fuss (`docket.example.com { reverse_proxy
localhost:3000 }` is the entire Caddyfile) — and set `TRUST_PROXY=true`
(already set in `docker-compose.yml`) so Docket trusts the proxy's
`X-Forwarded-*` headers for secure cookies and login-throttle IPs; see
"Transport & session security" in CLAUDE.md for why that flag exists and
why it's dangerous to set without a real proxy in front.

## Option D — Build and run the container yourself, anywhere

```
docker build -t docket .
docker run -p 3000:3000 \
  -e ATTORNEY_USERNAME=you -e ATTORNEY_PASSWORD=at-least-8-chars \
  -e DATABASE_URL=postgres://... \
  docket
```

Works on any Docker host — a bare EC2/GCE box, a Kubernetes `Deployment`,
whatever you already run. `DATABASE_URL` is the one variable worth
setting even for a quick test: without it, Docket falls back to a
file-backed store inside the container (`STATE_FILE`, default
`./data/system-state.json`), which is wiped on every redeploy unless you
mount a volume at `/app/data`.

## What to set no matter which option you pick

- `ATTORNEY_USERNAME` / `ATTORNEY_PASSWORD` — seeds the first login on an
  empty database. Only takes effect once, on first boot with zero
  accounts — see "Real authentication" in CLAUDE.md.
- `DATABASE_URL` — strongly recommended for anything beyond a quick demo;
  the file-backed default doesn't survive most hosts' redeploys/restarts.
- `TRUST_PROXY=true` — **only** behind a real TLS-terminating reverse
  proxy (Render/Fly/most PaaS already are one). Without it, session
  cookies won't be marked `Secure` and login-throttle IP tracking won't
  work correctly.

Everything else — SMTP for invoices/reminders, Twilio for the voice
channel, Google Calendar sync, the CourtListener research panel, the
Claude-powered Assistant panel — is optional, off by default, and
documented with its own env vars in CLAUDE.md's "Commands" section. None
of it is required for the core app (Review Queue, Deadlines, Scheduling,
Drafting, Cases, Conflicts, Trust, Invoices, Staff, Messages, Accounts,
Audit Log) to work on day one.
