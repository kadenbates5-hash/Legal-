import { readJsonFile, writeJsonFile } from "./json-file-store.js";

/**
 * The storage seam `system-state.ts` reads/writes through. Deliberately
 * generic (a single JSON blob in, a single JSON blob out) rather than
 * anything schema-shaped — every domain object already reduces to plain
 * data via `toSnapshot()`/`fromSnapshot()`, so the store itself never
 * needs to know what a `WorkProduct` or a `User` is. Swapping backends
 * (file → Postgres → whatever's next) means adding a new `StateStore`
 * implementation, not touching `system-state.ts` or anything upstream of
 * it — see `postgres-store.ts` for the second implementation.
 */
export interface StateStore {
  read<T>(defaultValue: T): Promise<T>;
  write(data: unknown): Promise<void>;
}

/** Wraps the existing atomic file read/write (json-file-store.ts) as a StateStore. */
export function fileStateStore(filePath: string): StateStore {
  return {
    read: (defaultValue) => readJsonFile(filePath, defaultValue),
    write: (data) => writeJsonFile(filePath, data),
  };
}
