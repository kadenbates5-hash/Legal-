import { createConnection, type Socket } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { randomUUID } from "node:crypto";
import {
  assertSafeEmailAddress,
  type EmailMessage,
  type EmailResult,
  type EmailSender,
} from "./email-sender.js";

/**
 * A real SMTP client, hand-rolled over `node:net`/`node:tls` rather than
 * pulling in nodemailer — the same call this project made for the Google
 * Calendar JWT flow and the Anthropic and CourtListener clients. SMTP's
 * submission path is a small, stable, well-specified conversation
 * (RFC 5321 §4, RFC 4954 for AUTH), and the dependency-light style holds
 * here as it did there.
 *
 * Two transport shapes, because both are in wide use:
 *
 * - **Implicit TLS** (port 465): the socket is TLS from the first byte.
 * - **STARTTLS** (port 587): a plaintext socket that upgrades before
 *   authenticating. This client **requires** the upgrade to succeed and
 *   aborts if the server doesn't advertise STARTTLS. It will not fall
 *   back to sending in the clear: the password is the firm's mail
 *   credential and the payload is a privileged client document, so a
 *   silent downgrade is the one failure mode worth refusing outright.
 *   `allowInsecurePlaintext` exists for a loopback relay and is off by
 *   default — it has to be asked for, deliberately, in writing.
 *
 * Not implemented, deliberately: connection pooling, retry/backoff, and
 * DKIM signing. A firm sending through its own provider already has
 * DKIM/SPF applied server-side, and a run of invoices is a handful of
 * messages, not a campaign — this is transactional mail, not a mailing
 * list.
 */
export interface SmtpConfig {
  host: string;
  port?: number;
  user?: string;
  password?: string;
  /** The envelope and header From. Must be an address the server will accept. */
  from: string;
  /** Display name on the From header, e.g. the firm's name. */
  fromName?: string;
  /** Implicit TLS from the first byte. Defaults to true on port 465. */
  implicitTls?: boolean;
  /**
   * Opt out of the STARTTLS requirement. The only legitimate use is a
   * relay reachable *only* over loopback or a trusted private network,
   * where the operator has decided the hop needs no transport security —
   * some firms run exactly that in front of their real mail provider.
   * Off by default, and never something to set to make a connection
   * error go away: the payload is a client's itemised bill.
   */
  allowInsecurePlaintext?: boolean;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;

/** One line of an SMTP reply: the numeric code and the accompanying text. */
interface SmtpReply {
  code: number;
  text: string;
}

/**
 * Wraps a socket in the read-a-reply / write-a-command conversation SMTP
 * actually is. Replies can be multi-line ("250-STARTTLS" then "250 OK"),
 * so a reply isn't complete until a line arrives whose code is followed
 * by a space rather than a hyphen.
 */
class SmtpConnection {
  #socket: Socket | TLSSocket;
  #buffer = "";
  #timeoutMs: number;

  constructor(socket: Socket | TLSSocket, timeoutMs: number) {
    this.#socket = socket;
    this.#timeoutMs = timeoutMs;
    this.#socket.setEncoding("utf8");
  }

  get socket(): Socket | TLSSocket {
    return this.#socket;
  }

  async readReply(): Promise<SmtpReply> {
    return new Promise<SmtpReply>((resolve, reject) => {
      const done = (err: Error | null, reply?: SmtpReply) => {
        clearTimeout(timer);
        this.#socket.off("data", onData);
        this.#socket.off("error", onError);
        this.#socket.off("close", onClose);
        if (err) reject(err);
        else resolve(reply!);
      };
      const timer = setTimeout(() => done(new Error("timed out waiting for an SMTP reply")), this.#timeoutMs);
      const onError = (err: Error) => done(err);
      const onClose = () => done(new Error("the SMTP server closed the connection unexpectedly"));
      const onData = (chunk: string) => {
        this.#buffer += chunk;
        // A complete reply ends with "NNN <text>\r\n" — a space, not a hyphen.
        const match = /^(\d{3}) [^\r\n]*\r?\n/m.exec(this.#buffer);
        if (!match) return;
        const end = match.index + match[0].length;
        const raw = this.#buffer.slice(0, end);
        this.#buffer = this.#buffer.slice(end);
        done(null, { code: Number(match[1]), text: raw.trim() });
      };
      this.#socket.on("data", onData);
      this.#socket.on("error", onError);
      this.#socket.on("close", onClose);
      // A reply may already have arrived and been buffered by a previous read.
      if (this.#buffer) onData("");
    });
  }

  write(line: string): void {
    this.#socket.write(`${line}\r\n`);
  }

  /** Sends a command and asserts the reply code, so no step fails silently. */
  async command(line: string, expected: number[], describe: string): Promise<SmtpReply> {
    this.write(line);
    const reply = await this.readReply();
    if (!expected.includes(reply.code)) {
      throw new Error(`SMTP ${describe} failed: ${reply.text}`);
    }
    return reply;
  }

  replaceSocket(socket: TLSSocket): void {
    this.#socket = socket;
    this.#buffer = "";
    this.#socket.setEncoding("utf8");
  }

  end(): void {
    this.#socket.destroy();
  }
}

export class SmtpEmailSender implements EmailSender {
  readonly name = "smtp";
  readonly canSend = true;
  readonly fromAddress: string;
  #config: Required<
    Pick<SmtpConfig, "host" | "port" | "from" | "timeoutMs" | "implicitTls" | "allowInsecurePlaintext">
  > &
    Pick<SmtpConfig, "user" | "password" | "fromName">;

  constructor(config: SmtpConfig) {
    const port = config.port ?? 587;
    this.fromAddress = assertSafeEmailAddress(config.from);
    this.#config = {
      host: config.host,
      port,
      from: this.fromAddress,
      timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      implicitTls: config.implicitTls ?? port === 465,
      allowInsecurePlaintext: config.allowInsecurePlaintext ?? false,
      ...(config.user ? { user: config.user } : {}),
      ...(config.password ? { password: config.password } : {}),
      ...(config.fromName ? { fromName: config.fromName } : {}),
    };
  }

  async send(message: EmailMessage): Promise<EmailResult> {
    const to = assertSafeEmailAddress(message.to);
    const replyTo = message.replyTo ? assertSafeEmailAddress(message.replyTo) : undefined;
    const messageId = `<${randomUUID()}@${this.#config.host}>`;

    const conn = new SmtpConnection(await this.#openSocket(), this.#config.timeoutMs);
    try {
      const greeting = await conn.readReply();
      if (greeting.code !== 220) throw new Error(`SMTP server did not greet us: ${greeting.text}`);

      let ehlo = await conn.command(`EHLO ${hostLabel()}`, [250], "EHLO");

      if (!this.#config.implicitTls && !this.#config.allowInsecurePlaintext) {
        if (!/STARTTLS/i.test(ehlo.text)) {
          throw new Error(
            `SMTP server ${this.#config.host}:${this.#config.port} does not offer STARTTLS — refusing to send an invoice, or a password, in the clear`,
          );
        }
        await conn.command("STARTTLS", [220], "STARTTLS");
        conn.replaceSocket(await this.#upgrade(conn.socket as Socket));
        // The session resets after the upgrade, so EHLO again — and it's
        // this second, encrypted response whose AUTH support counts.
        ehlo = await conn.command(`EHLO ${hostLabel()}`, [250], "EHLO after STARTTLS");
      }

      if (this.#config.user && this.#config.password) {
        await this.#authenticate(conn, ehlo.text);
      }

      await conn.command(`MAIL FROM:<${this.#config.from}>`, [250], "MAIL FROM");
      await conn.command(`RCPT TO:<${to}>`, [250, 251], "RCPT TO");
      await conn.command("DATA", [354], "DATA");
      conn.write(dotStuff(buildMimeMessage({ ...message, to, ...(replyTo ? { replyTo } : {}) }, this.#config, messageId)));
      await conn.command(".", [250], "message body");
      // Best-effort: the message is already accepted, so a failure here
      // isn't a delivery failure and mustn't be reported as one.
      try {
        await conn.command("QUIT", [221], "QUIT");
      } catch {
        /* ignore */
      }
      return { messageId };
    } finally {
      conn.end();
    }
  }

  async #openSocket(): Promise<Socket | TLSSocket> {
    const { host, port, implicitTls, timeoutMs } = this.#config;
    return new Promise((resolve, reject) => {
      const socket = implicitTls
        ? tlsConnect({ host, port, servername: host }, () => resolve(socket))
        : createConnection({ host, port }, () => resolve(socket));
      socket.setTimeout(timeoutMs, () => {
        socket.destroy();
        reject(new Error(`timed out connecting to ${host}:${port}`));
      });
      socket.once("error", reject);
    });
  }

  async #upgrade(socket: Socket): Promise<TLSSocket> {
    const { host, timeoutMs } = this.#config;
    return new Promise((resolve, reject) => {
      const secure = tlsConnect({ socket, servername: host }, () => resolve(secure));
      secure.setTimeout(timeoutMs, () => {
        secure.destroy();
        reject(new Error("timed out negotiating STARTTLS"));
      });
      secure.once("error", reject);
    });
  }

  /**
   * AUTH PLAIN where offered, LOGIN otherwise — the two every submission
   * server supports. Both send the password base64-encoded, which is
   * encoding rather than encryption; the TLS requirement above is what
   * actually protects it.
   */
  async #authenticate(conn: SmtpConnection, capabilities: string): Promise<void> {
    const user = this.#config.user!;
    const password = this.#config.password!;
    if (/AUTH[^\r\n]*PLAIN/i.test(capabilities)) {
      const token = Buffer.from(`\0${user}\0${password}`, "utf8").toString("base64");
      await conn.command(`AUTH PLAIN ${token}`, [235], "authentication");
      return;
    }
    if (/AUTH[^\r\n]*LOGIN/i.test(capabilities)) {
      await conn.command("AUTH LOGIN", [334], "authentication");
      await conn.command(Buffer.from(user, "utf8").toString("base64"), [334], "authentication (username)");
      await conn.command(Buffer.from(password, "utf8").toString("base64"), [235], "authentication (password)");
      return;
    }
    throw new Error("SMTP server offers no supported authentication mechanism (need PLAIN or LOGIN)");
  }
}

function hostLabel(): string {
  return "docket.local";
}

/**
 * Header values are single-line by construction here, but the subject
 * comes from an invoice number and matter title, so it passes through
 * this anyway. A newline in a header value is header injection.
 */
function headerSafe(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

/**
 * RFC 2047 encoded-word, so a matter title with an accent or a dash
 * doesn't arrive as mojibake. Only applied when the value isn't plain
 * ASCII, since an encoded-word is harder to read in a raw message.
 */
function encodeHeader(value: string): string {
  const safe = headerSafe(value);
  // eslint-disable-next-line no-control-regex
  if (!/[^\x20-\x7e]/.test(safe)) return safe;
  return `=?UTF-8?B?${Buffer.from(safe, "utf8").toString("base64")}?=`;
}

/**
 * SMTP ends a message body with a lone "." on its own line, so a line in
 * the message that *is* a lone dot has to be escaped or it truncates the
 * message. This is the single most commonly forgotten part of speaking
 * SMTP directly.
 */
function dotStuff(body: string): string {
  return body.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n").replace(/\r\n\./g, "\r\n..");
}

/**
 * Base64 for a message body has to be wrapped at 76 characters — RFC
 * 2045 caps an encoded line there, and servers are entitled to reject
 * or mangle anything longer. A multi-page PDF is one very long base64
 * string without this.
 */
function base64Lines(data: Buffer): string {
  return (data.toString("base64").match(/.{1,76}/g) ?? []).join("\r\n");
}

/** A filename is a header parameter, so quotes and newlines have to go. */
function attachmentFilename(name: string): string {
  return headerSafe(name).replace(/["\\]/g, "").slice(0, 120) || "attachment";
}

export function buildMimeMessage(
  message: EmailMessage,
  config: { from: string; fromName?: string },
  messageId: string,
): string {
  const headers = [
    `From: ${config.fromName ? `${encodeHeader(config.fromName)} <${config.from}>` : config.from}`,
    `To: ${headerSafe(message.to)}`,
    `Subject: ${encodeHeader(message.subject)}`,
    `Message-ID: ${messageId}`,
    `Date: ${new Date().toUTCString()}`,
    "MIME-Version: 1.0",
    ...(message.replyTo ? [`Reply-To: ${headerSafe(message.replyTo)}`] : []),
  ];
  const attachments = message.attachments ?? [];

  /* The readable body: one text/plain part, or a text+html alternative. */
  const altBoundary = `docket-alt-${randomUUID()}`;
  const bodyParts = message.html
    ? [
        `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
        "",
        `--${altBoundary}`,
        'Content-Type: text/plain; charset="utf-8"',
        "",
        message.text,
        `--${altBoundary}`,
        'Content-Type: text/html; charset="utf-8"',
        "",
        message.html,
        `--${altBoundary}--`,
      ]
    : ['Content-Type: text/plain; charset="utf-8"', "", message.text];

  if (attachments.length === 0) {
    return [...headers, ...bodyParts].join("\r\n");
  }

  // With attachments the whole readable body becomes the first part of a
  // multipart/mixed, which is the nesting mail clients expect: they show
  // the alternative inline and the files alongside it.
  const mixedBoundary = `docket-mixed-${randomUUID()}`;
  const lines = [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${mixedBoundary}"`,
    "",
    `--${mixedBoundary}`,
    ...bodyParts,
  ];
  for (const attachment of attachments) {
    const filename = attachmentFilename(attachment.filename);
    lines.push(
      `--${mixedBoundary}`,
      `Content-Type: ${headerSafe(attachment.contentType)}; name="${filename}"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${filename}"`,
      "",
      base64Lines(attachment.content),
    );
  }
  lines.push(`--${mixedBoundary}--`, "");
  return lines.join("\r\n");
}
