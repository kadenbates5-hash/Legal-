import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createReviewServer } from "../src/review-ui/server.js";
import { ReviewGateService } from "../src/review-ui/review-service.js";
import { WorkProductStore } from "../src/core/work-product-store.js";
import { AuthService } from "../src/core/auth.js";
import { SpeechService } from "../src/review-ui/speech-service.js";
import type { TextToSpeech } from "../src/receptionist/voice-agent.js";

class FakeTextToSpeech implements TextToSpeech {
  async synthesize(text: string): Promise<unknown> {
    return Buffer.from(`audio:${text}`, "utf8");
  }
}

let server: Server;
let baseUrl: string;
let attorneyCookie: string;
let receptionCookie: string;
let clientCookie: string;

async function loginCookie(username: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password: "correct-horse" }),
  });
  expect(res.status).toBe(200);
  return res.headers.get("set-cookie")!.split(";")[0]!;
}

beforeEach(async () => {
  const auth = new AuthService();
  auth.createUser({ username: "attorney1", password: "correct-horse", role: "attorney", actorId: "a1" });
  auth.createUser({ username: "reception1", password: "correct-horse", role: "receptionist", actorId: "r1" });
  auth.createUser({ username: "client1", password: "correct-horse", role: "client", actorId: "c1" });

  server = createReviewServer(new ReviewGateService(new WorkProductStore()), auth, {
    speech: new SpeechService(new FakeTextToSpeech()),
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  attorneyCookie = await loginCookie("attorney1");
  receptionCookie = await loginCookie("reception1");
  clientCookie = await loginCookie("client1");
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("speech HTTP API", () => {
  it("404s when speech tools aren't configured", async () => {
    const auth = new AuthService();
    auth.createUser({ username: "attorney1", password: "correct-horse", role: "attorney", actorId: "a1" });
    const bare = createReviewServer(new ReviewGateService(new WorkProductStore()), auth);
    await new Promise<void>((resolve) => bare.listen(0, resolve));
    const url = `http://127.0.0.1:${(bare.address() as AddressInfo).port}`;
    const login = await fetch(`${url}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "attorney1", password: "correct-horse" }),
    });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const res = await fetch(`${url}/api/speech/synthesize`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ text: "hi" }),
    });
    expect(res.status).toBe(404);
    await new Promise<void>((resolve) => bare.close(() => resolve()));
  });

  it("returns synthesized audio bytes for an attorney", async () => {
    const res = await fetch(`${baseUrl}/api/speech/synthesize`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: attorneyCookie },
      body: JSON.stringify({ text: "Please call the office back." }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/wav");
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.toString("utf8")).toBe("audio:Please call the office back.");
  });

  it("allows a receptionist (the Live Intake Demo's script-preview use case)", async () => {
    const res = await fetch(`${baseUrl}/api/speech/synthesize`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: receptionCookie },
      body: JSON.stringify({ text: "Thanks for calling, how can I help?" }),
    });
    expect(res.status).toBe(200);
  });

  it("denies a client account", async () => {
    const res = await fetch(`${baseUrl}/api/speech/synthesize`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: clientCookie },
      body: JSON.stringify({ text: "hi" }),
    });
    expect(res.status).toBe(403);
  });

  it("requires a session", async () => {
    const res = await fetch(`${baseUrl}/api/speech/synthesize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hi" }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects empty text with 400", async () => {
    const res = await fetch(`${baseUrl}/api/speech/synthesize`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: attorneyCookie },
      body: JSON.stringify({ text: "   " }),
    });
    expect(res.status).toBe(400);
  });
});
