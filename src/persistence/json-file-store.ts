import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";

/**
 * Dependency-free, atomic JSON-file read/write. §8's "not yet built —
 * persistence" stopgap: everything upstream of this (core, receptionist,
 * paralegal, review-ui) operates on plain-data snapshots via each domain
 * object's `toSnapshot`/`fromSnapshot`, so swapping this for a real
 * database adapter later only means replacing this one file — nothing
 * about the snapshot shapes or the callers needs to change.
 *
 * Writes go to a temp file and are renamed into place, so a crash mid-write
 * can never leave a half-written, corrupt state file — you either get the
 * old version or the new one, never a mix.
 */
export async function readJsonFile<T>(filePath: string, defaultValue: T): Promise<T> {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch (err) {
    if (isNotFound(err)) return defaultValue;
    throw err;
  }
}

export async function writeJsonFile(filePath: string, data: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  // Random suffix, not pid+timestamp. Two saves in the same millisecond
  // from the same process produced the *same* temp path: the first
  // renamed it into place, the second's rename then failed with ENOENT
  // and — as a floating promise — took the whole server down. Observed,
  // not theoretical.
  const tempPath = `${filePath}.${randomBytes(8).toString("hex")}.tmp`;
  await writeFile(tempPath, JSON.stringify(data, null, 2), "utf8");
  await rename(tempPath, filePath);
}

function isNotFound(err: unknown): boolean {
  return err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT";
}
