import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { SmtpEmailSender, buildMimeMessage } from "../src/integrations/smtp-email.js";

/**
 * A minimal SMTP server that speaks just enough of the protocol to
 * exercise the client's real conversation — greeting, EHLO, AUTH, the
 * envelope, and the dot-terminated body. Worth the ~40 lines: the
 * failure modes this catches (a missing CRLF, an unhandled multi-line
 * 250-, a body that terminates early on a lone dot) are exactly the ones
 * a mocked transport would hide.
 */
interface FakeSmtp {
  server: Server;
  port: number;
  commands: string[];
  bodies: string[];
}

function startFakeSmtp(options: { capabilities?: string[]; failAt?: string } = {}): Promise<FakeSmtp> {
  const capabilities = options.capabilities ?? ["AUTH PLAIN LOGIN"];
  const state: FakeSmtp = { server: undefined as unknown as Server, port: 0, commands: [], bodies: [] };

  const server = createServer((socket: Socket) => {
    let inData = false;
    let body = "";
    socket.setEncoding("utf8");
    socket.write("220 fake.smtp ESMTP ready\r\n");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let index: number;
      while ((index = buffer.indexOf("\r\n")) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (inData) {
          if (line === ".") {
            inData = false;
            state.bodies.push(body);
            body = "";
            socket.write("250 2.0.0 Ok: queued\r\n");
          } else {
            // Undo dot-stuffing, exactly as a real server does.
            body += `${line.startsWith("..") ? line.slice(1) : line}\n`;
          }
          continue;
        }
        state.commands.push(line);
        const verb = line.split(" ")[0]!.toUpperCase();
        if (options.failAt && line.toUpperCase().startsWith(options.failAt)) {
          socket.write("550 5.0.0 refused by test\r\n");
        } else if (verb === "EHLO") {
          // Multi-line reply, which is what real servers send.
          socket.write(capabilities.map((c) => `250-${c}\r\n`).join("") + "250 HELP\r\n");
        } else if (verb === "AUTH") {
          socket.write(line.toUpperCase().startsWith("AUTH LOGIN") ? "334 VXNlcm5hbWU6\r\n" : "235 2.7.0 Authenticated\r\n");
        } else if (verb === "DATA") {
          inData = true;
          socket.write("354 End data with <CR><LF>.<CR><LF>\r\n");
        } else if (verb === "QUIT") {
          socket.write("221 2.0.0 Bye\r\n");
          socket.end();
        } else if (/^[A-Za-z0-9+/=]+$/.test(line) && !line.includes(":")) {
          // A base64 AUTH LOGIN continuation.
          socket.write(state.commands.filter((c) => /^[A-Za-z0-9+/=]+$/.test(c)).length >= 2 ? "235 2.7.0 Authenticated\r\n" : "334 UGFzc3dvcmQ6\r\n");
        } else {
          socket.write("250 2.0.0 Ok\r\n");
        }
      }
    });
    socket.on("error", () => {
      /* the client destroys the socket after QUIT */
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      state.server = server;
      state.port = (server.address() as AddressInfo).port;
      resolve(state);
    });
  });
}

let fake: FakeSmtp | undefined;

afterEach(async () => {
  if (fake) await new Promise<void>((resolve) => fake!.server.close(() => resolve()));
  fake = undefined;
});

function senderFor(port: number, extra: Record<string, unknown> = {}) {
  return new SmtpEmailSender({
    host: "127.0.0.1",
    port,
    from: "billing@firm.example",
    fromName: "Reyes & Okafor LLP",
    // The fake server speaks plaintext, which is what the loopback-relay
    // opt-out is for. The refusal to downgrade *without* it is asserted
    // in its own test below.
    allowInsecurePlaintext: true,
    ...extra,
  });
}

describe("SmtpEmailSender", () => {
  it("walks the real SMTP conversation and delivers the body", async () => {
    fake = await startFakeSmtp();
    const sender = senderFor(fake.port);

    const result = await sender.send({
      to: "maria@example.com",
      subject: "Invoice INV-00001 — State v. Ruiz",
      text: "BALANCE DUE: $800.00",
      html: "<p>BALANCE DUE: $800.00</p>",
    });

    expect(result.messageId).toMatch(/^<.+@127\.0\.0\.1>$/);
    expect(fake.commands).toContain("MAIL FROM:<billing@firm.example>");
    expect(fake.commands).toContain("RCPT TO:<maria@example.com>");
    expect(fake.commands).toContain("DATA");

    const body = fake.bodies[0]!;
    expect(body).toContain("From: Reyes & Okafor LLP <billing@firm.example>");
    expect(body).toContain("To: maria@example.com");
    // The em dash makes the subject non-ASCII, so it travels as an RFC 2047
    // encoded-word rather than raw bytes.
    const subject = /^Subject: (.+)$/m.exec(body)![1]!;
    expect(Buffer.from(/=\?UTF-8\?B\?(.+)\?=/.exec(subject)![1]!, "base64").toString("utf8")).toBe(
      "Invoice INV-00001 — State v. Ruiz",
    );
    expect(body).toContain("multipart/alternative");
    expect(body).toContain("BALANCE DUE: $800.00");
    expect(body).toContain("<p>BALANCE DUE: $800.00</p>");
  });

  it("authenticates when credentials are supplied", async () => {
    fake = await startFakeSmtp({ capabilities: ["AUTH PLAIN LOGIN"] });
    const sender = senderFor(fake.port, { user: "billing", password: "hunter2" });
    await sender.send({ to: "maria@example.com", subject: "Hi", text: "Hello" });
    const auth = fake.commands.find((c) => c.startsWith("AUTH PLAIN "))!;
    expect(auth).toBeDefined();
    expect(Buffer.from(auth.split(" ")[2]!, "base64").toString()).toBe("\0billing\0hunter2");
  });

  it("refuses to send in the clear when the server offers no STARTTLS", async () => {
    fake = await startFakeSmtp({ capabilities: ["SIZE 1000000"] });
    // Default port-587 behaviour: plaintext socket that must upgrade.
    const sender = new SmtpEmailSender({ host: "127.0.0.1", port: fake.port, from: "billing@firm.example" });
    await expect(sender.send({ to: "maria@example.com", subject: "Hi", text: "Hello" })).rejects.toThrow(
      /does not offer STARTTLS/i,
    );
    expect(fake.bodies).toHaveLength(0);
  });

  it("surfaces a rejected recipient rather than reporting a send", async () => {
    fake = await startFakeSmtp({ failAt: "RCPT TO" });
    const sender = senderFor(fake.port);
    await expect(sender.send({ to: "maria@example.com", subject: "Hi", text: "Hello" })).rejects.toThrow(/RCPT TO failed/i);
    expect(fake.bodies).toHaveLength(0);
  });

  it("rejects an address that could inject a header before opening a socket", async () => {
    const sender = new SmtpEmailSender({ host: "127.0.0.1", port: 1, from: "billing@firm.example" });
    await expect(
      sender.send({ to: "maria@example.com\r\nRCPT TO:<leak@evil.example>", subject: "Hi", text: "Hello" }),
    ).rejects.toThrow(/does not look like/i);
  });
});

describe("buildMimeMessage", () => {
  it("strips newlines out of header values", () => {
    const message = buildMimeMessage(
      { to: "maria@example.com", subject: "Invoice\r\nBcc: leak@evil.example", text: "Hi" },
      { from: "billing@firm.example" },
      "<id@firm.example>",
    );
    expect(message).not.toMatch(/Subject:.*\r\nBcc:/);
    expect(message).toContain("Subject: Invoice Bcc: leak@evil.example");
  });

  it("encodes a non-ASCII subject so it doesn't arrive as mojibake", () => {
    const message = buildMimeMessage(
      { to: "maria@example.com", subject: "Facture — Société Générale", text: "Hi" },
      { from: "billing@firm.example" },
      "<id@firm.example>",
    );
    expect(message).toMatch(/Subject: =\?UTF-8\?B\?/);
  });

  it("sends a single text/plain part when there is no HTML alternative", () => {
    const message = buildMimeMessage(
      { to: "maria@example.com", subject: "Hi", text: "Hello" },
      { from: "billing@firm.example" },
      "<id@firm.example>",
    );
    expect(message).toContain('Content-Type: text/plain; charset="utf-8"');
    expect(message).not.toContain("multipart/alternative");
  });
});

describe("buildMimeMessage — attachments", () => {
  const pdf = Buffer.from("%PDF-1.7\nfake invoice bytes\n%%EOF\n");

  it("nests the readable body and the file in a multipart/mixed", () => {
    const message = buildMimeMessage(
      {
        to: "maria@example.com",
        subject: "Invoice INV-00001",
        text: "BALANCE DUE: $800.00",
        html: "<p>BALANCE DUE: $800.00</p>",
        attachments: [{ filename: "INV-00001.pdf", contentType: "application/pdf", content: pdf }],
      },
      { from: "billing@firm.example" },
      "<id@firm.example>",
    );

    expect(message).toContain("Content-Type: multipart/mixed;");
    expect(message).toContain("Content-Type: multipart/alternative;");
    expect(message).toContain('Content-Type: application/pdf; name="INV-00001.pdf"');
    expect(message).toContain("Content-Transfer-Encoding: base64");
    expect(message).toContain('Content-Disposition: attachment; filename="INV-00001.pdf"');
    // The bytes survive the round trip.
    const encoded = message.split("Content-Disposition: attachment;")[1]!.split("\r\n\r\n")[1]!.split("\r\n--")[0]!;
    expect(Buffer.from(encoded.replace(/\r\n/g, ""), "base64").equals(pdf)).toBe(true);
  });

  it("wraps base64 at 76 characters, as RFC 2045 requires", () => {
    const big = Buffer.alloc(4000, 0x41);
    const message = buildMimeMessage(
      {
        to: "maria@example.com",
        subject: "Invoice",
        text: "See attached",
        attachments: [{ filename: "big.pdf", contentType: "application/pdf", content: big }],
      },
      { from: "billing@firm.example" },
      "<id@firm.example>",
    );
    const encoded = message.split("Content-Disposition: attachment;")[1]!.split("\r\n\r\n")[1]!;
    for (const line of encoded.split("\r\n")) expect(line.length).toBeLessThanOrEqual(76);
  });

  it("strips a filename that could terminate the header", () => {
    const message = buildMimeMessage(
      {
        to: "maria@example.com",
        subject: "Invoice",
        text: "See attached",
        attachments: [
          { filename: 'evil".pdf\r\nBcc: leak@evil.example', contentType: "application/pdf", content: pdf },
        ],
      },
      { from: "billing@firm.example" },
      "<id@firm.example>",
    );
    // The point isn't that the text disappears — it's that it can never
    // begin a line, which is the only way it would be read as a header.
    for (const line of message.split("\r\n")) expect(line.startsWith("Bcc:")).toBe(false);
    expect(message).toContain('filename="evil.pdf Bcc: leak@evil.example"');
  });

  it("stays a plain multipart/alternative when there is nothing attached", () => {
    const message = buildMimeMessage(
      { to: "maria@example.com", subject: "Invoice", text: "Hi", html: "<p>Hi</p>" },
      { from: "billing@firm.example" },
      "<id@firm.example>",
    );
    expect(message).not.toContain("multipart/mixed");
    expect(message).toContain("multipart/alternative");
  });
});
