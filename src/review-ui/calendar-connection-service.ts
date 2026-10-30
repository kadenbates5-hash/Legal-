import { randomBytes } from "node:crypto";
import { AccessDeniedError, type Actor } from "../core/types.js";
import type { CalendarConnectionStore } from "../core/calendar-connections.js";
import type { AuditLog } from "../core/audit.js";
import type { AuthService } from "../core/auth.js";
import { buildGoogleAuthUrl, exchangeCodeForTokens, fetchGoogleAccountEmail, refreshAccessToken } from "../integrations/google-oauth.js";

/**
 * Self-service "connect your Google Calendar" — the per-attorney
 * counterpart to the firm-wide shared service-account calendar
 * `google-calendar.ts` already supports. Same self-service shape as
 * MFA enrollment: no attorney gate, every method acts only on the
 * caller's own connection (or, for `accessTokenFor`, is restricted to
 * the `"system"` credential instead) — connecting or disconnecting
 * *someone else's* calendar has no legitimate use here.
 *
 * The OAuth `state` parameter does double duty as CSRF protection
 * (Google's own requirement) *and* as how `completeConnect()` learns
 * which actor to connect — the public callback route Google redirects
 * to has no Docket session of its own to read. A pending state is
 * single-use and short-lived (`PENDING_TTL_MS`), swept on every call,
 * same "throwaway, not a real record" reasoning `AudioClipStore`/
 * `intake-demo.ts` already give for their own in-memory, un-persisted
 * state.
 */
const PENDING_TTL_MS = 10 * 60 * 1000;

export interface CalendarConnectionStatus {
  connected: boolean;
  connectedEmail?: string;
}

export class CalendarConnectionService {
  #store: CalendarConnectionStore;
  #clientId: string;
  #clientSecret: string;
  #redirectUri: string;
  #auditLog: AuditLog | undefined;
  #auth: AuthService | undefined;
  #pending = new Map<string, { actorId: string; expiresAt: number }>();

  constructor(params: {
    store: CalendarConnectionStore;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    auditLog?: AuditLog;
    auth?: AuthService;
  }) {
    this.#store = params.store;
    this.#clientId = params.clientId;
    this.#clientSecret = params.clientSecret;
    this.#redirectUri = params.redirectUri;
    this.#auditLog = params.auditLog;
    this.#auth = params.auth;
  }

  status(actor: Actor): CalendarConnectionStatus {
    const connection = this.#store.get(actor.id);
    return connection ? { connected: true, ...(connection.connectedEmail ? { connectedEmail: connection.connectedEmail } : {}) } : { connected: false };
  }

  beginConnect(actor: Actor): { authUrl: string } {
    this.#sweep();
    const state = randomBytes(24).toString("hex");
    this.#pending.set(state, { actorId: actor.id, expiresAt: Date.now() + PENDING_TTL_MS });
    return { authUrl: buildGoogleAuthUrl({ clientId: this.#clientId, redirectUri: this.#redirectUri, state }) };
  }

  /**
   * Called from the public OAuth callback route — there is no Actor
   * available yet, only whatever `state` Google hands back unchanged.
   * Returns the actorId the connection was recorded against, so the
   * route can redirect somewhere sensible without needing to look it
   * up a second way.
   */
  async completeConnect(code: string, state: string): Promise<{ actorId: string }> {
    this.#sweep();
    const pending = this.#pending.get(state);
    if (!pending) {
      throw new Error("this Google Calendar connection request is invalid or has expired — try connecting again from the Security panel");
    }
    this.#pending.delete(state);

    const tokens = await exchangeCodeForTokens({
      clientId: this.#clientId,
      clientSecret: this.#clientSecret,
      redirectUri: this.#redirectUri,
      code,
    });
    if (!tokens.refreshToken) {
      throw new Error(
        "Google didn't grant a refresh token — if you've connected this app before, remove its access in your Google Account's permissions and try again",
      );
    }
    const connectedEmail = await fetchGoogleAccountEmail(tokens.accessToken);
    this.#store.set({
      actorId: pending.actorId,
      refreshToken: tokens.refreshToken,
      connectedEmail,
      connectedAt: new Date().toISOString(),
    });
    this.#audit(pending.actorId, "calendar_connected", connectedEmail ? `email=${connectedEmail}` : "no email returned");
    return { actorId: pending.actorId };
  }

  disconnect(actor: Actor): void {
    this.#store.remove(actor.id);
    this.#audit(actor.id, "calendar_disconnected", "");
  }

  /**
   * System-only: resolves a *fresh access token*, never the refresh
   * token itself, for the standalone calendar-sync job
   * (`per-attorney-calendar-publisher.ts`) to use against one
   * attorney's own calendar. Handing out only a short-lived access
   * token — refreshed here, server-side, on every call — means the
   * external sync process never holds the long-lived credential at
   * all, the same reasoning `MattersService.clientEmailFor`/
   * `StaffService.emailForActorId` already give for handing a machine
   * credential the one narrow thing it needs rather than something
   * broader.
   */
  async accessTokenFor(actor: Actor, attorneyActorId: string): Promise<{ connected: false } | { connected: true; accessToken: string }> {
    if (actor.role !== "system") {
      throw new AccessDeniedError(`resolving a calendar access token requires the system credential (got role '${actor.role}')`);
    }
    const connection = this.#store.get(attorneyActorId);
    if (!connection) return { connected: false };
    const tokens = await refreshAccessToken({
      clientId: this.#clientId,
      clientSecret: this.#clientSecret,
      refreshToken: connection.refreshToken,
    });
    return { connected: true, accessToken: tokens.accessToken };
  }

  #sweep(): void {
    const now = Date.now();
    for (const [state, entry] of this.#pending) {
      if (entry.expiresAt <= now) this.#pending.delete(state);
    }
  }

  #audit(actorId: string, action: string, detail: string): void {
    const role = this.#auth?.listUsers().find((u) => u.actorId === actorId)?.role ?? "staff";
    this.#auditLog?.append({ actor: { id: actorId, role }, matterId: undefined, action, detail });
  }
}
