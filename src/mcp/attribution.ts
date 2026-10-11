/**
 * Who is calling the HTTP MCP endpoint, for analytics only. Nothing here
 * changes how a request is served.
 *
 * - The client's own name and version (`clientInfo`) only arrive with
 *   `initialize`. The endpoint is stateless, so the reply carries them back
 *   in a signed `Mcp-Session-Id`, which clients must echo on every later
 *   request. Every tool call can then be labelled with the declared client,
 *   with nothing stored on the server.
 * - A consistency check compares what the caller says (User-Agent, session)
 *   with where it calls from (network). A mismatch is a hint, not proof.
 * - Distinct callers per day are counted from a hash of address and
 *   User-Agent with a random salt that changes daily and is never stored.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { clientFamily } from "../core/analytics.js";
import type { Network } from "../core/network.js";

export interface ClientInfo {
  name: string;
  version: string;
}

/** `consistent`, `mismatch` (signals disagree), `no_session` (no session ID sent), `bad_session` (not one we issued). */
export type Consistency = "consistent" | "mismatch" | "no_session" | "bad_session";

const MAX_NAME = 64;
const MAX_VERSION = 32;
const SIG_BYTES = 16;

/** Issues and checks the signed session IDs. */
export class SessionTokens {
  private readonly key: Buffer;

  /** Without a secret, a random one is used: sessions then stop verifying after a restart. */
  constructor(secret?: string) {
    this.key = secret ? createHash("sha256").update(secret).digest() : randomBytes(32);
  }

  issue(info: ClientInfo): string {
    const payload = Buffer.from(
      JSON.stringify({ n: String(info.name).slice(0, MAX_NAME), v: String(info.version).slice(0, MAX_VERSION), r: randomBytes(9).toString("base64url") }),
    ).toString("base64url");
    return `${payload}.${this.sign(payload)}`;
  }

  /** The client info inside a session ID we issued, or null for anything else. */
  verify(token: string | undefined): ClientInfo | null {
    if (!token) return null;
    const [payload, sig, extra] = token.split(".");
    if (!payload || !sig || extra !== undefined) return null;
    const want = Buffer.from(this.sign(payload));
    const got = Buffer.from(sig);
    if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
    try {
      const body = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { n?: unknown; v?: unknown };
      if (typeof body.n !== "string" || typeof body.v !== "string") return null;
      return { name: body.n, version: body.v };
    } catch {
      return null;
    }
  }

  private sign(payload: string): string {
    return createHmac("sha256", this.key).update(payload).digest().subarray(0, SIG_BYTES).toString("base64url");
  }
}

/** Families that name one product (as opposed to a library or "other"). */
const PRODUCTS = new Set([
  "claude-code", "claude-ai", "cursor", "windsurf", "vscode", "codex", "openai", "gemini", "zed", "cline", "continue", "goose",
]);

/**
 * Families whose User-Agent says the call comes from the vendor's own cloud
 * (claude.ai and Claude Desktop connectors run in Anthropic's cloud, ChatGPT
 * connectors in OpenAI's).
 */
const VENDOR_CLOUD: Record<string, Network> = { "claude-ai": "anthropic", openai: "openai" };

/** The most specific family: the session's clientInfo, unless only the User-Agent names a product. */
export function pickClient(sessionFamily: string | undefined, uaFamily: string): string {
  if (!sessionFamily) return uaFamily;
  if (!PRODUCTS.has(sessionFamily) && PRODUCTS.has(uaFamily)) return uaFamily;
  return sessionFamily;
}

export function checkConsistency(e: {
  sessionSent: boolean;
  session: ClientInfo | null;
  uaFamily: string;
  network: Network;
}): Consistency {
  const expected = VENDOR_CLOUD[e.uaFamily];
  const located = e.network !== "unknown" && e.network !== "private";
  if (expected && located && e.network !== expected) return "mismatch";
  if (e.session) {
    const declared = clientFamily(e.session.name);
    if (PRODUCTS.has(declared) && PRODUCTS.has(e.uaFamily) && declared !== e.uaFamily) return "mismatch";
    return "consistent";
  }
  return e.sessionSent ? "bad_session" : "no_session";
}

/**
 * A metric-safe version label for a client family: the major version, or
 * `0.<minor>` for 0.x releases (where the minor is what moves). Versions are
 * whatever the caller sends, so only known products get one, within
 * plausible ranges; everything else is `other`.
 */
export function versionLabel(family: string, version: string | undefined): string {
  if (!PRODUCTS.has(family)) return "other";
  const m = /^v?(\d{1,3})(?:\.(\d{1,3}))?/.exec(version?.trim() ?? "");
  if (!m) return "other";
  const major = Number(m[1]);
  const minor = Number(m[2] ?? 0);
  if (major === 0) return minor < 200 ? `0.${minor}` : "other";
  return major <= 30 ? String(major) : "other";
}

/** Counts each caller once per UTC day. */
export class DailyCallers {
  private day = "";
  private salt = randomBytes(32);
  private seen = new Set<string>();

  constructor(
    private readonly max = 200_000,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** True the first time this address + User-Agent is seen for this client today. */
  firstToday(ip: string | undefined, userAgent: string | undefined, client: string): boolean {
    if (!ip) return false;
    const today = this.now().toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.salt = randomBytes(32);
      this.seen = new Set();
    }
    if (this.seen.size >= this.max) return false;
    const key = createHash("sha256").update(this.salt).update(ip).update("\0").update(userAgent ?? "").digest("base64url").slice(0, 22);
    const id = `${client}:${key}`;
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    return true;
  }
}
