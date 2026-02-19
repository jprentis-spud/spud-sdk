import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SpudClient } from "../../src/core/client.js";
import { SpudAgent } from "../../src/agent/wrapper.js";
import { SpudError } from "../../src/types.js";
import { wrapTool, wrapTools } from "../../src/adapters/langchain.js";
import type { LangChainTool } from "../../src/adapters/langchain.js";

// ── Helpers ────────────────────────────────────────────────────────────

function tokenResponse(expiresInSec: number) {
  return {
    token: "jwt-langchain-test",
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

function fakeTool(
  name: string,
  invokeFn?: (input: unknown, config?: unknown) => Promise<unknown>,
): LangChainTool {
  return {
    name,
    description: `A fake ${name} tool`,
    invoke: invokeFn ?? vi.fn().mockResolvedValue(`${name} result`),
  };
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("LangChain adapter", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ── wrapTool ──────────────────────────────────────────────────────

  describe("wrapTool", () => {
    it("invokes the original tool when governance permits", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(tokenResponse(3600)));
      fetchSpy.mockResolvedValueOnce(
        jsonResponse(governResponse(true)),
      );

      const client = await connectedClient();
      const agent = new SpudAgent(client, { mode: "enforcing" });

      const invokeSpy = vi.fn().mockResolvedValue("search result");
      const tool = fakeTool("web_search", invokeSpy);
      const wrapped = wrapTool(agent, tool);

      const result = await wrapped.invoke({ query: "test" });

      expect(result).toBe("search result");
      expect(invokeSpy).toHaveBeenCalledWith(
        { query: "test" },
        undefined,
      );

      client.destroy();
    });

    it("throws SpudError when governance denies", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(tokenResponse(3600)));
      fetchSpy.mockResolvedValueOnce(
        jsonResponse(governResponse(false, "Tool not allowed")),
      );

      const client = await connectedClient();
      const agent = new SpudAgent(client, { mode: "enforcing" });

      const invokeSpy = vi.fn();
      const tool = fakeTool("delete_all", invokeSpy);
      const wrapped = wrapTool(agent, tool);

      await expect(wrapped.invoke({})).rejects.toThrow(SpudError);
      expect(invokeSpy).not.toHaveBeenCalled();

      client.destroy();
    });

    it("sends tool name and arguments to governance", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(tokenResponse(3600)));
      fetchSpy.mockResolvedValueOnce(
        jsonResponse(governResponse(true)),
      );

      const client = await connectedClient();
      const agent = new SpudAgent(client, { mode: "enforcing" });

      const tool = fakeTool("query_db");
      const wrapped = wrapTool(agent, tool);

      await wrapped.invoke({ sql: "SELECT 1" });

      const governCall = fetchSpy.mock.calls[1];
      const body = JSON.parse(governCall[1]?.body as string);

      expect(body.action).toBe("tool:query_db");
      expect(body.context.tool_arguments).toEqual({ sql: "SELECT 1" });

      client.destroy();
    });

    it("preserves tool name and description", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(tokenResponse(3600)));

      const client = await connectedClient();
      const agent = new SpudAgent(client, { mode: "enforcing" });

      const tool = fakeTool("my_tool");
      const wrapped = wrapTool(agent, tool);

      expect(wrapped.name).toBe("my_tool");
      expect(wrapped.description).toBe("A fake my_tool tool");

      client.destroy();
    });

    it("preserves prototype chain", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(tokenResponse(3600)));

      const client = await connectedClient();
      const agent = new SpudAgent(client, { mode: "enforcing" });

      class CustomTool {
        name = "custom";
        description = "Custom tool";
        customMethod() {
          return "custom";
        }
        async invoke() {
          return "result";
        }
      }

      const tool = new CustomTool();
      const wrapped = wrapTool(agent, tool);

      expect(wrapped).toBeInstanceOf(CustomTool);
      expect(wrapped.customMethod()).toBe("custom");

      client.destroy();
    });

    it("handles string input by wrapping in { input } object", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(tokenResponse(3600)));
      fetchSpy.mockResolvedValueOnce(
        jsonResponse(governResponse(true)),
      );

      const client = await connectedClient();
      const agent = new SpudAgent(client, { mode: "enforcing" });

      const invokeSpy = vi.fn().mockResolvedValue("ok");
      const tool = fakeTool("simple", invokeSpy);
      const wrapped = wrapTool(agent, tool);

      await wrapped.invoke("hello");

      const governCall = fetchSpy.mock.calls[1];
      const body = JSON.parse(governCall[1]?.body as string);

      expect(body.context.tool_arguments).toEqual({ input: "hello" });

      // Original tool receives the raw string
      expect(invokeSpy).toHaveBeenCalledWith("hello", undefined);

      client.destroy();
    });

    it("passes config through to original invoke", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(tokenResponse(3600)));
      fetchSpy.mockResolvedValueOnce(
        jsonResponse(governResponse(true)),
      );

      const client = await connectedClient();
      const agent = new SpudAgent(client, { mode: "enforcing" });

      const invokeSpy = vi.fn().mockResolvedValue("ok");
      const tool = fakeTool("my_tool", invokeSpy);
      const wrapped = wrapTool(agent, tool);

      const config = { callbacks: [] };
      await wrapped.invoke({ x: 1 }, config);

      expect(invokeSpy).toHaveBeenCalledWith({ x: 1 }, config);

      client.destroy();
    });

    it("uses default denial message when reason is absent", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(tokenResponse(3600)));
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({ permitted: false, decision_id: "d-1" }),
      );

      const client = await connectedClient();
      const agent = new SpudAgent(client, { mode: "enforcing" });

      const tool = fakeTool("blocked_tool");
      const wrapped = wrapTool(agent, tool);

      try {
        await wrapped.invoke({});
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(SpudError);
        expect((err as SpudError).message).toContain('"blocked_tool"');
        expect((err as SpudError).code).toBe("TOOL_DENIED");
      }

      client.destroy();
    });
  });

  // ── wrapTools ─────────────────────────────────────────────────────

  describe("wrapTools", () => {
    it("wraps all tools in the array", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(tokenResponse(3600)));
      fetchSpy.mockResolvedValueOnce(
        jsonResponse(governResponse(true)),
      );
      fetchSpy.mockResolvedValueOnce(
        jsonResponse(governResponse(true)),
      );

      const client = await connectedClient();
      const agent = new SpudAgent(client, { mode: "enforcing" });

      const tool1 = fakeTool("search");
      const tool2 = fakeTool("calculator");

      const wrapped = wrapTools(agent, [tool1, tool2]);

      expect(wrapped).toHaveLength(2);
      expect(wrapped[0].name).toBe("search");
      expect(wrapped[1].name).toBe("calculator");

      // Both should be governed
      await wrapped[0].invoke({});
      await wrapped[1].invoke({});

      // token + 2 governance calls
      expect(fetchSpy).toHaveBeenCalledTimes(3);

      client.destroy();
    });

    it("returns empty array for empty input", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(tokenResponse(3600)));

      const client = await connectedClient();
      const agent = new SpudAgent(client, { mode: "enforcing" });

      const wrapped = wrapTools(agent, []);

      expect(wrapped).toHaveLength(0);

      client.destroy();
    });
  });
});
