import { describe, expect, it } from "vitest";
import { clientFamily } from "../src/core/analytics.js";
import { DailyCallers, SessionTokens, checkConsistency, pickClient, versionLabel } from "../src/mcp/attribution.js";

describe("clientFamily", () => {
  it("maps declared MCP client names and User-Agents to the same families", () => {
    const cases: [string, string][] = [
      ["claude-code", "claude-code"],
      ["claude-code/2.1.0 (cli)", "claude-code"],
      ["claude-ai", "claude-ai"],
      ["claude-ai (via mcp-remote 0.1.29)", "claude-ai"],
      ["Claude-User", "claude-ai"],
      ["codex-mcp-client", "codex"],
      ["codex_cli_rs/0.46.0", "codex"],
      ["openai-mcp", "openai"],
      ["ChatGPT", "openai"],
      ["cursor-vscode", "cursor"],
      ["Visual Studio Code", "vscode"],
      ["mcp-inspector", "inspector"],
      ["goose", "goose"],
      ["continue-client", "continue"],
      ["node", "node"],
    ];
    for (const [input, family] of cases) expect(clientFamily(input), input).toBe(family);
  });
});

describe("SessionTokens", () => {
  it("round-trips the declared client and rejects anything it did not issue", () => {
    const tokens = new SessionTokens("secret");
    const id = tokens.issue({ name: "claude-code", version: "2.1.0" });
    expect(id).toMatch(/^[\x21-\x7e]+$/); // visible ASCII, as the MCP spec requires
    expect(tokens.verify(id)).toEqual({ name: "claude-code", version: "2.1.0" });
    expect(new SessionTokens("secret").verify(id)).toEqual({ name: "claude-code", version: "2.1.0" });
    expect(new SessionTokens("other").verify(id)).toBeNull();
    const [payload, sig] = id.split(".");
    const forged = Buffer.from(JSON.stringify({ n: "cursor", v: "1", r: "x" })).toString("base64url");
    expect(tokens.verify(`${forged}.${sig}`)).toBeNull();
    expect(tokens.verify(`${payload}.${sig}.extra`)).toBeNull();
    expect(tokens.verify("a9b1c2d3-uuid-from-another-server")).toBeNull();
    expect(tokens.verify(undefined)).toBeNull();
  });

  it("issues a different ID for every session", () => {
    const tokens = new SessionTokens("secret");
    expect(tokens.issue({ name: "t", version: "1" })).not.toBe(tokens.issue({ name: "t", version: "1" }));
  });

  it("truncates long names and versions", () => {
    const tokens = new SessionTokens();
    const info = tokens.verify(tokens.issue({ name: "x".repeat(500), version: "1".repeat(500) }))!;
    expect(info.name).toHaveLength(64);
    expect(info.version).toHaveLength(32);
  });
});

describe("attribution rules", () => {
  it("prefers the declared client unless only the User-Agent names a product", () => {
    expect(pickClient(undefined, "curl")).toBe("curl");
    expect(pickClient("claude-code", "node")).toBe("claude-code");
    expect(pickClient("mcp-sdk", "cursor")).toBe("cursor");
    expect(pickClient("other", "python")).toBe("other");
  });

  it("flags signals that disagree", () => {
    const session = { name: "claude-code", version: "2.1.0" };
    expect(checkConsistency({ sessionSent: true, session, uaFamily: "claude-code", network: "isp" })).toBe("consistent");
    expect(checkConsistency({ sessionSent: true, session, uaFamily: "node", network: "aws" })).toBe("consistent");
    // The User-Agent and the declared name name different products.
    expect(checkConsistency({ sessionSent: true, session, uaFamily: "cursor", network: "isp" })).toBe("mismatch");
    // claude.ai and ChatGPT connectors call from their vendor's cloud.
    expect(checkConsistency({ sessionSent: false, session: null, uaFamily: "claude-ai", network: "anthropic" })).toBe("no_session");
    expect(checkConsistency({ sessionSent: false, session: null, uaFamily: "claude-ai", network: "aws" })).toBe("mismatch");
    expect(checkConsistency({ sessionSent: true, session, uaFamily: "openai", network: "isp" })).toBe("mismatch");
    // Without a network label there is nothing to compare.
    expect(checkConsistency({ sessionSent: false, session: null, uaFamily: "claude-ai", network: "unknown" })).toBe("no_session");
    expect(checkConsistency({ sessionSent: true, session: null, uaFamily: "codex", network: "isp" })).toBe("bad_session");
  });

  it("keeps version labels bounded, since callers choose them", () => {
    expect(versionLabel("claude-code", "2.1.0")).toBe("2");
    expect(versionLabel("cursor", "v1.7")).toBe("1");
    expect(versionLabel("codex", "0.46.0")).toBe("0.46");
    expect(versionLabel("codex", "0")).toBe("0.0");
    expect(versionLabel("codex", "0.512.0")).toBe("other");
    expect(versionLabel("claude-code", "31.0")).toBe("other");
    expect(versionLabel("claude-code", "latest")).toBe("other");
    expect(versionLabel("claude-code", undefined)).toBe("other");
    // Libraries and unknown names never get a version label.
    expect(versionLabel("other", "1.0.0")).toBe("other");
    expect(versionLabel("mcp-sdk", "1.0.0")).toBe("other");
  });
});

describe("DailyCallers", () => {
  it("counts each address + User-Agent once per client per UTC day", () => {
    let now = new Date("2026-10-09T10:00:00Z");
    const callers = new DailyCallers(1000, () => now);
    expect(callers.firstToday("1.2.3.4", "codex/0.46", "codex")).toBe(true);
    expect(callers.firstToday("1.2.3.4", "codex/0.46", "codex")).toBe(false);
    expect(callers.firstToday("1.2.3.4", "claude-code/2.1", "claude-code")).toBe(true);
    expect(callers.firstToday("5.6.7.8", "codex/0.46", "codex")).toBe(true);
    expect(callers.firstToday(undefined, "codex/0.46", "codex")).toBe(false);
    now = new Date("2026-10-10T00:00:01Z");
    expect(callers.firstToday("1.2.3.4", "codex/0.46", "codex")).toBe(true);
  });

  it("stops counting past its memory cap", () => {
    const callers = new DailyCallers(2);
    expect(callers.firstToday("1.1.1.1", "a", "x")).toBe(true);
    expect(callers.firstToday("2.2.2.2", "a", "x")).toBe(true);
    expect(callers.firstToday("3.3.3.3", "a", "x")).toBe(false);
  });
});
