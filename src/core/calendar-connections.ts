/**
 * Who has connected their own Google Calendar account, keyed by staff
 * `actorId` — the per-attorney counterpart to the single shared
 * service-account calendar `google-calendar.ts` already supports. See
 * `review-ui/calendar-connection-service.ts` for the self-service
 * connect/disconnect flow that writes here, and
 * `integrations/per-attorney-calendar-publisher.ts` for the sync engine
 * that reads it (indirectly, over HTTP — see that file's own doc
 * comment for why the refresh token itself never leaves this process).
 *
 * `refreshToken` is a real bearer secret, stored as plain data the same
 * way a session token is — not hashed like a password or recovery code,
 * because unlike those this has to be *used* (handed back to Google),
 * not just verified. It is the one new secret this project persists in
 * its own state blob rather than an environment variable (the service-
 * account private key and every other vendor credential here live in
 * env vars) — worth knowing before turning this on: whoever can read
 * the persisted state (the file, or the Postgres column) can use a
 * connected attorney's calendar for as long as the token stays valid,
 * the same operational trust boundary the audit log's anchoring
 * feature already exists to make visible, not one this file adds.
 */
export interface CalendarConnection {
  readonly actorId: string;
  readonly refreshToken: string;
  /** Best-effort, from Google's userinfo endpoint — for display only ("connected as x@gmail.com"), never used to authorize anything. */
  readonly connectedEmail: string | undefined;
  readonly connectedAt: string;
}

export class CalendarConnectionStore {
  #byActorId = new Map<string, CalendarConnection>();

  get(actorId: string): CalendarConnection | undefined {
    return this.#byActorId.get(actorId);
  }

  set(connection: CalendarConnection): void {
    this.#byActorId.set(connection.actorId, connection);
  }

  remove(actorId: string): void {
    this.#byActorId.delete(actorId);
  }

  toSnapshot(): CalendarConnection[] {
    return [...this.#byActorId.values()].map((c) => ({ ...c }));
  }

  static fromSnapshot(snapshot: readonly CalendarConnection[]): CalendarConnectionStore {
    const store = new CalendarConnectionStore();
    for (const connection of snapshot) store.#byActorId.set(connection.actorId, { ...connection });
    return store;
  }
}
