import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SpudClient } from "../../src/core/client.js";
import { SpudAgent } from "../../src/agent/wrapper.js";

// ── Helpers ────────────────────────────────────────────────────────────

function tokenResponse(expiresInSec: number) {
  return {
    token: "jwt-token-agent-test",
    expires_at: Math.floor(Date.now() / 1000) + expiresInSec,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function governResponse(permitted: boolean, reason?: string) {
  return {
    permitted,
    reason,
    decision_id: `dec-${Math.random().toString(36).slice(2, 8)}`,
  };
}

async function connectedClient() {
  const client = new SpudClient({
    apiKey: "sk-test",
    baseUrl: "https://api.test",
  });
  await client.connect();
  return client;
}

function mcpToolsCall(name: string, args: Record<string, unknown> = {}) {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  });
}

function mcpOtherMethod(method: string) {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    method,
    params: {},
  });
}

function makeRequest(body: string): Request {
  return new Request("http://localhost:8080/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("SpudAgent", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ── intercept() — enforcing mode ───────────────────────────────────

  describe("intercept() — enforcing mode", () => {
    it("proceeds when governance permits", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(tokenResponse(3600)));
      fetchSpy.mockResolvedValueOnce(
        jsonResponse(governResponse(true, "Policy allows")),
      );

      const client = await connectedClient();
      const agent = new SpudAgent(client, { mode: "enforcing" });

      const result = await agent.intercept({
        name: "send_email",
        arguments: { to: "user@test.com" },
      });

      expect(result.proceed).toBe(true);
      expect(result.decision.permitted).toBe(true);

      client.destroy();
    });

    it("blocks when governance denies", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(tokenResponse(3600)));
      fetchSpy.mockResolvedValueOnce(
        jsonResponse(governResponse(false, "Email sending not allowed")),
      );

      const client = await connectedClient();
      const agent = new SpudAgent(client, { mode: "enforcing" });

      const result = await agent.intercept({
        name: "send_email",
        arguments: {},
      });

      expect(result.proceed).toBe(false);
      expect(result.decision.permitted).toBe(false);
      expect(result.decision.reason).toBe("Email sending not allowed");

      client.destroy();
    });

    it("sends tool name and arguments in governance context", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(tokenResponse(3600)));
      fetchSpy.mockResolvedValueOnce(
        jsonResponse(governResponse(true)),
      );

      const client = await connectedClient();
      const agent = new SpudAgent(client, { mode: "enforcing" });

      await agent.intercept({
        name: "query_db",
        arguments: { sql: "SELECT * FROM users" },
      });

      // Governance call is the second fetch (first is token exchange)
      const governCall = fetchSpy.mock.calls[1];
      const body = JSON.parse(governCall[1]?.body as string);

      expect(body.action).toBe("tool:query_db");
      expect(body.context.tool_name).toBe("query_db");
      expect(body.context.tool_arguments).toEqual({
        sql: "SELECT * FROM users",
      });

      client.destroy();
    });
  });

  // ── intercept() — permissive mode ──────────────────────────────────

  describe("intercept() — permissive mode", () => {
    it("proceeds even when governance denies", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(tokenResponse(3600)));
      fetchSpy.mockResolvedValueOnce(
        jsonResponse(governResponse(false, "Would be denied")),
      );

      const client = await connectedClient();
      const agent = new SpudAgent(client, { mode: "permissive" });

      const result = await agent.intercept({
        name: "delete_record",
        arguments: {},
      });

      expect(result.proceed).toBe(true);
      expect(result.decision.permitted).toBe(false); // raw decision still false
      expect(result.decision.reason).toBe("Would be denied");

      client.destroy();
    });
  });

  // ── intercept() — dry-run mode ─────────────────────────────────────

  describe("intercept() — dry-run mode", () => {
    it("proceeds even when governance denies", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(tokenResponse(3600)));
      fetchSpy.mockResolvedValueOnce(
        jsonResponse(governResponse(false, "Dry-run denial")),
      );

      const client = await connectedClient();
      const agent = new SpudAgent(client, { mode: "dry-run" });

      const result = await agent.intercept({
        name: "drop_table",
        arguments: {},
      });

      expect(result.proceed).toBe(true);
      expect(result.decision.permitted).toBe(false);

      client.destroy();
    });
  });

  // ── intercept() — failure modes ────────────────────────────────────

  describe("intercept() — failure modes", () => {
    it("fail-open allows when governance is unreachable", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(tokenResponse(3600)));
      fetchSpy.mockRejectedValueOnce(new Error("Network error"));

      const client = await connectedClient();
      const agent = new SpudAgent(client, {
        mode: "enforcing",
        failurePolicy: { failOpen: ["get_*"] },
      });

      const result = await agent.intercept({
        name: "get_user",
        arguments: {},
      });

      expect(result.proceed).toBe(true);
      expect(result.decision.reason).toContain("fail-open");

      client.destroy();
    });

    it("fail-closed denies when governance is unreachable", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(tokenResponse(3600)));
      fetchSpy.mockRejectedValueOnce(new Error("Network error"));

      const client = await connectedClient();
      const agent = new SpudAgent(client, {
        mode: "enforcing",
        failurePolicy: { failClosed: ["delete_*"] },
      });

      const result = await agent.intercept({
        name: "delete_user",
        arguments: {},
      });

      expect(result.proceed).toBe(false);
      expect(result.decision.reason).toContain("fail-closed");

      client.destroy();
    });

    it("defaults to fail-closed for uncategorised tools", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(tokenResponse(3600)));
      fetchSpy.mockRejectedValueOnce(new Error("timeout"));

      const client = await connectedClient();
      const agent = new SpudAgent(client, { mode: "enforcing" });

      const result = await agent.intercept({
        name: "unknown_tool",
        arguments: {},
      });

      expect(result.proceed).toBe(false);
      expect(result.decision.reason).toContain("fail-closed");

      client.destroy();
    });
  });

  // ── Enrichment hooks ───────────────────────────────────────────────

  describe("enrichContext()", () => {
    it("includes enrichment context in governance request", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(tokenResponse(3600)));
      fetchSpy.mockResolvedValueOnce(
        jsonResponse(governResponse(true)),
      );

      const client = await connectedClient();
      const agent = new SpudAgent(client, { mode: "enforcing" });

      agent.enrichContext(async () => ({
        user_id: "u-42",
        org_id: "org-7",
      }));

      await agent.intercept({ name: "send_email", arguments: {} });

      const governCall = fetchSpy.mock.calls[1];
      const body = JSON.parse(governCall[1]?.body as string);

      expect(body.context.user_id).toBe("u-42");
      expect(body.context.org_id).toBe("org-7");

      client.destroy();
    });

    it("supports chaining", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(tokenResponse(3600)));

      const client = await connectedClient();
      const agent = new SpudAgent(client, {});

      const returned = agent
        .enrichContext(async () => ({ a: 1 }))
        .enrichContext(async () => ({ b: 2 }));

      expect(returned).toBe(agent);

      client.destroy();
    });
  });

  // ── MCP Proxy ──────────────────────────────────────────────────────

  describe("proxy()", () => {
    it("forwards non-tools/call messages without governance check", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(tokenResponse(3600))); // connect
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({ jsonrpc: "2.0", id: 2, result: { tools: [] } }),
      ); // upstream

      const client = await connectedClient();
      const agent = new SpudAgent(client, { mode: "enforcing" });
      const proxy = agent.proxy({ upstream: "http://mcp-server:3000" });

      const request = makeRequest(mcpOtherMethod("tools/list"));
      const response = await proxy.handler(request);
      const body = await response.json();

      expect(body.result.tools).toEqual([]);

      // Only 2 fetch calls: token exchange + upstream forward
      // (no governance call)
      expect(fetchSpy).toHaveBeenCalledTimes(2);

      client.destroy();
    });

    it("intercepts tools/call and blocks denied actions", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(tokenResponse(3600))); // connect
      fetchSpy.mockResolvedValueOnce(
        jsonResponse(governResponse(false, "Not allowed")),
      ); // govern

      const client = await connectedClient();
      const agent = new SpudAgent(client, { mode: "enforcing" });
      const proxy = agent.proxy({ upstream: "http://mcp-server:3000" });

      const request = makeRequest(mcpToolsCall("send_email", { to: "a@b.com" }));
      const response = await proxy.handler(request);
      const body = await response.json();

      expect(body.error).toBeDefined();
      expect(body.error.message).toBe("Not allowed");
      expect(body.jsonrpc).toBe("2.0");
      expect(body.id).toBe(1);

      client.destroy();
    });

    it("intercepts tools/call and forwards permitted actions", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(tokenResponse(3600))); // connect
      fetchSpy.mockResolvedValueOnce(
        jsonResponse(governResponse(true)),
      ); // govern
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({
          jsonrpc: "2.0",
          id: 1,
          result: { content: [{ type: "text", text: "sent" }] },
        }),
      ); // upstream

      const client = await connectedClient();
      const agent = new SpudAgent(client, { mode: "enforcing" });
      const proxy = agent.proxy({ upstream: "http://mcp-server:3000" });

      const request = makeRequest(mcpToolsCall("send_email"));
      const response = await proxy.handler(request);
      const body = await response.json();

      expect(body.result.content[0].text).toBe("sent");

      client.destroy();
    });

    it("attaches X-Spud-Token header on forwarded requests", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(tokenResponse(3600))); // connect
      fetchSpy.mockResolvedValueOnce(
        jsonResponse(governResponse(true)),
      ); // govern
      fetchSpy.mockResolvedValueOnce(jsonResponse({ jsonrpc: "2.0", id: 1, result: {} })); // upstream

      const client = await connectedClient();
      const agent = new SpudAgent(client, { mode: "enforcing" });
      const proxy = agent.proxy({ upstream: "http://mcp-server:3000" });

      const request = makeRequest(mcpToolsCall("get_user"));
      await proxy.handler(request);

      // The upstream forward is the last fetch call
      const upstreamCall = fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1];
      const headers = upstreamCall[1]?.headers as Headers;
      expect(headers.get("X-Spud-Token")).toBe("jwt-token-agent-test");

      client.destroy();
    });

    it("forwards to configured upstream URL", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(tokenResponse(3600)));
      fetchSpy.mockResolvedValueOnce(jsonResponse({ jsonrpc: "2.0", id: 2, result: {} }));

      const client = await connectedClient();
      const agent = new SpudAgent(client, { mode: "enforcing" });
      const proxy = agent.proxy({
        upstream: "http://mcp-server:3000/mcp/v1",
      });

      const request = makeRequest(mcpOtherMethod("initialize"));
      await proxy.handler(request);

      const upstreamCall = fetchSpy.mock.calls[1];
      expect(upstreamCall[0]).toBe("http://mcp-server:3000/mcp/v1");

      client.destroy();
    });

    it("permissive mode forwards even when denied", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(tokenResponse(3600))); // connect
      fetchSpy.mockResolvedValueOnce(
        jsonResponse(governResponse(false, "Would deny")),
      ); // govern
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({ jsonrpc: "2.0", id: 1, result: {} }),
      ); // upstream

      const client = await connectedClient();
      const agent = new SpudAgent(client, { mode: "permissive" });
      const proxy = agent.proxy({ upstream: "http://mcp-server:3000" });

      const request = makeRequest(mcpToolsCall("delete_all"));
      const response = await proxy.handler(request);
      const body = await response.json();

      // Should forward — no JSON-RPC error
      expect(body.error).toBeUndefined();
      expect(body.result).toBeDefined();

      client.destroy();
    });

    it("handler is callable as a standalone function", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(tokenResponse(3600)));
      fetchSpy.mockResolvedValueOnce(jsonResponse({ jsonrpc: "2.0", id: 2, result: {} }));

      const client = await connectedClient();
      const agent = new SpudAgent(client, {});
      const proxy = agent.proxy({ upstream: "http://mcp-server:3000" });

      // Destructure handler — must work without `this` binding
      const { handler } = proxy;
      const request = makeRequest(mcpOtherMethod("ping"));
      const response = await handler(request);

      expect(response.status).toBe(200);

      client.destroy();
    });
  });
});
