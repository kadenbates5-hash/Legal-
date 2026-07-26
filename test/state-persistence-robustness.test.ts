import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJsonFile, writeJsonFile } from "../src/persistence/json-file-store.js";

let dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "docket-persist-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs = [];
});

describe("writeJsonFile — concurrent writes", () => {
  it("survives many writes fired in the same tick", async () => {
    // The original bug: the temp path was `${file}.${pid}.${Date.now()}.tmp`,
    // so two saves inside one millisecond from one process produced the
    // *same* temp file. The first renamed it into place; the second's
    // rename hit ENOENT — and as a floating promise that crashed the
    // whole server. This reproduces the timing that caused it.
    const file = join(await tempDir(), "state.json");
    await Promise.all(
      Array.from({ length: 40 }, (_, i) => writeJsonFile(file, { attempt: i })),
    );
    const written = JSON.parse(await readFile(file, "utf8")) as { attempt: number };
    expect(typeof written.attempt).toBe("number");
  });

  it("leaves no temp files behind", async () => {
    const dir = await tempDir();
    const file = join(dir, "state.json");
    await Promise.all(Array.from({ length: 20 }, (_, i) => writeJsonFile(file, { i })));
    expect((await readdir(dir)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("never leaves a half-written file readable", async () => {
    const file = join(await tempDir(), "state.json");
    const big = { entries: Array.from({ length: 2000 }, (_, i) => ({ i, text: "x".repeat(200) })) };
    // Interleave writes with reads; every read must parse, because a
    // reader only ever sees a fully renamed file.
    await Promise.all([
      ...Array.from({ length: 10 }, () => writeJsonFile(file, big)),
      ...Array.from({ length: 10 }, async () => {
        const value = await readJsonFile<{ entries?: unknown[] } | null>(file, null);
        if (value !== null) expect(Array.isArray(value.entries)).toBe(true);
      }),
    ]);
  });

  it("creates the directory if it doesn't exist yet", async () => {
    const file = join(await tempDir(), "nested", "deeper", "state.json");
    await writeJsonFile(file, { ok: true });
    expect(await readJsonFile(file, null)).toEqual({ ok: true });
  });

  it("returns the default for a file that was never written", async () => {
    expect(await readJsonFile(join(await tempDir(), "absent.json"), { fallback: true })).toEqual({ fallback: true });
  });
});
