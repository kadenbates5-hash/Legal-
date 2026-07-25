import type { CalendarEventsSource } from "./calendar-events-source.js";

/**
 * Practice-area/vendor-agnostic sync engine: reads deadline events from
 * whatever `CalendarEventsSource` is configured and confirms each one
 * against Docket's own HTTP API, exactly the way any other API client
 * would — using the calendar integration's `x-system-api-key` credential
 * (see `core/auth.ts`), never a shortcut into `DeadlineTracker` directly.
 * That keeps this integration honest about being "just another client":
 * it can't confirm anything the API itself wouldn't accept from any
 * `"system"`-role caller.
 */
export interface CalendarSyncResult {
  confirmed: number;
  failures: { eventId: string; matterId: string; deadlineType: string; error: string }[];
}

export class CalendarDeadlineSync {
  #eventsSource: CalendarEventsSource;
  #docketBaseUrl: string;
  #systemApiKey: string;

  constructor(params: { eventsSource: CalendarEventsSource; docketBaseUrl: string; systemApiKey: string }) {
    this.#eventsSource = params.eventsSource;
    this.#docketBaseUrl = params.docketBaseUrl.replace(/\/+$/, "");
    this.#systemApiKey = params.systemApiKey;
  }

  async run(): Promise<CalendarSyncResult> {
    const events = await this.#eventsSource.listDeadlineEvents();
    const result: CalendarSyncResult = { confirmed: 0, failures: [] };

    for (const event of events) {
      try {
        const res = await fetch(`${this.#docketBaseUrl}/api/deadlines/confirm`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-system-api-key": this.#systemApiKey },
          body: JSON.stringify({
            matterId: event.matterId,
            type: event.deadlineType,
            date: event.date,
            source: "calendar_system",
          }),
        });
        if (!res.ok) {
          throw new Error(`${res.status} ${await res.text()}`);
        }
        result.confirmed++;
      } catch (err) {
        result.failures.push({
          eventId: event.eventId,
          matterId: event.matterId,
          deadlineType: event.deadlineType,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return result;
  }
}
