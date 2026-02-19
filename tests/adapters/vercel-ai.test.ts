import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SpudClient } from "../../src/core/client.js";
import { SpudAgent } from "../../src/agent/wrapper.js";
import { SpudError } from "../../src/types.js";
import {
  spudMiddleware,
  wrapTools,
} from "../../src/adapters/vercel-ai.js";
import type {
  GenerateResult,
  StreamPart,
  VercelAITools,
} from "../../src/adapters/vercel-ai.js";

// ── Helpers ────────────────────────────────────────────────────────────

function tokenResponse(expiresInSec: number) {
  return {
    token: "jwt-vercel-test",
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

function makeStreamFromParts(parts: StreamPart[]): ReadableStream<StreamPart> {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) {
        controller.enqueue(part);
      }
      controller.close();
    },
  });
}

async function collectStream(
  stream: ReadableStream<StreamPart>,
): Promise<StreamPart[]> {
  const reader = stream.getReader();
  const parts: StreamPart[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
  }
  return parts;
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("Vercel AI adapter", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ── spudMiddleware — wrapGenerate ─────────────────────────────────

  describe("spudMiddleware — wrapGenerate", () => {
    it("passes through results with no tool calls", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(tokenResponse(3600)));

      const client = await connectedClient();
      const agent = new SpudAgent(client, { mode: "enforcing" });
      const middleware = spudMiddleware(agent);

      const result: GenerateResult = { text: "Hello", toolCalls: [] };
      const output = await middleware.wrapGenerate!({
        doGenerate: () => Promise.resolve(result),
        params: {},
        model: {},
      });

      expect(output).toEqual(result);
      // Only token exchange — no governance call
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      client.destroy();
    });

    it("keeps permitted tool calls", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(tokenResponse(3600)));
      fetchSpy.mockResolvedValueOnce(
        jsonResponse(governResponse(true)),
      );

      const client = await connectedClient();
      const agent = new SpudAgent(client, { mode: "enforcing" });
      const middleware = spudMiddleware(agent);

      const toolCall = {
        toolCallType: "function" as const,
        toolCallId: "tc-1",
        toolName: "get_weather",
        args: JSON.stringify({ location: "NYC" }),
      };

      const output = await middleware.wrapGenerate!({
        doGenerate: () => Promise.resolve({ toolCalls: [toolCall] }),
        params: {},
        model: {},
      });

      expect(output.toolCalls).toHaveLength(1);
      expect(output.toolCalls![0].toolName).toBe("get_weather");

      client.destroy();
    });

    it("removes denied tool calls", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(tokenResponse(3600)));
      fetchSpy.mockResolvedValueOnce(
        jsonResponse(governResponse(false, "Denied")),
      );

      const client = await connectedClient();
      const agent = new SpudAgent(client, { mode: "enforcing" });
      const middleware = spudMiddleware(agent);

      const toolCall = {
        toolCallType: "function" as const,
        toolCallId: "tc-1",
        toolName: "send_email",
        args: JSON.stringify({ to: "a@b.com" }),
      };

      const output = await middleware.wrapGenerate!({
        doGenerate: () => Promise.resolve({ toolCalls: [toolCall] }),
        params: {},
        model: {},
      });

      expect(output.toolCalls).toHaveLength(0);

      client.destroy();
    });

    it("filters mixed permitted and denied tool calls", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(tokenResponse(3600)));
      fetchSpy.mockResolvedValueOnce(jsonResponse(governResponse(true)));
      fetchSpy.mockResolvedValueOnce(
        jsonResponse(governResponse(false, "No")),
      );
      fetchSpy.mockResolvedValueOnce(jsonResponse(governResponse(true)));

      const client = await connectedClient();
      const agent = new SpudAgent(client, { mode: "enforcing" });
      const middleware = spudMiddleware(agent);

      const toolCalls = [
        {
          toolCallType: "function" as const,
          toolCallId: "tc-1",
          toolName: "read_file",
          args: "{}",
        },
        {
          toolCallType: "function" as const,
          toolCallId: "tc-2",
          toolName: "delete_file",
          args: "{}",
        },
        {
          toolCallType: "function" as const,
          toolCallId: "tc-3",
          toolName: "list_files",
          args: "{}",
        },
      ];

      const output = await middleware.wrapGenerate!({
        doGenerate: () => Promise.resolve({ toolCalls }),
        params: {},
        model: {},
      });

      expect(output.toolCalls).toHaveLength(2);
      expect(output.toolCalls!.map((tc) => tc.toolName)).toEqual([
        "read_file",
        "list_files",
      ]);

      client.destroy();
    });

    it("sends parsed arguments to governance", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(tokenResponse(3600)));
      fetchSpy.mockResolvedValueOnce(jsonResponse(governResponse(true)));

      const client = await connectedClient();
      const agent = new SpudAgent(client, { mode: "enforcing" });
      const middleware = spudMiddleware(agent);

      const args = { sql: "DROP TABLE users" };

      await middleware.wrapGenerate!({
        doGenerate: () =>
          Promise.resolve({
            toolCalls: [
              {
                toolCallType: "function" as const,
                toolCallId: "tc-1",
                toolName: "query_db",
                args: JSON.stringify(args),
              },
            ],
          }),
        params: {},
        model: {},
      });

      const governCall = fetchSpy.mock.calls[1];
      const body = JSON.parse(governCall[1]?.body as string);

      expect(body.action).toBe("tool:query_db");
      expect(body.context.tool_arguments).toEqual(args);

      client.destroy();
    });

    it("handles malformed args JSON gracefully", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(tokenResponse(3600)));
      fetchSpy.mockResolvedValueOnce(jsonResponse(governResponse(true)));

      const client = await connectedClient();
      const agent = new SpudAgent(client, { mode: "enforcing" });
      const middleware = spudMiddleware(agent);

      const output = await middleware.wrapGenerate!({
        doGenerate: () =>
          Promise.resolve({
            toolCalls: [
              {
                toolCallType: "function" as const,
                toolCallId: "tc-1",
                toolName: "broken",
                args: "not-json{{{",
              },
            ],
          }),
        params: {},
        model: {},
      });

      // Should still work — args fallback to {}
      expect(output.toolCalls).toHaveLength(1);

      client.destroy();
    });
  });

  // ── spudMiddleware — wrapStream ───────────────────────────────────

  describe("spudMiddleware — wrapStream", () => {
    it("passes through text parts unchanged", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(tokenResponse(3600)));

      const client = await connectedClient();
      const agent = new SpudAgent(client, { mode: "enforcing" });
      const middleware = spudMiddleware(agent);

      const parts: StreamPart[] = [
        { type: "text-delta", textDelta: "Hello" },
        { type: "text-delta", textDelta: " world" },
        { type: "finish", finishReason: "stop" },
      ];

      const { stream } = await middleware.wrapStream!({
        doStream: () =>
          Promise.resolve({ stream: makeStreamFromParts(parts) }),
        params: {},
        model: {},
      });

      const collected = await collectStream(stream);

      expect(collected).toHaveLength(3);
      expect(collected[0].type).toBe("text-delta");
      expect(collected[2].type).toBe("finish");

      client.destroy();
    });

    it("forwards permitted tool call stream parts", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(tokenResponse(3600)));
      fetchSpy.mockResolvedValueOnce(jsonResponse(governResponse(true)));

      const client = await connectedClient();
      const agent = new SpudAgent(client, { mode: "enforcing" });
      const middleware = spudMiddleware(agent);

      const parts: StreamPart[] = [
        {
          type: "tool-call-delta",
          toolCallId: "tc-1",
          toolName: "get_weather",
          argsTextDelta: '{"lo',
        },
        {
          type: "tool-call-delta",
          toolCallId: "tc-1",
          toolName: "get_weather",
          argsTextDelta: 'c":"NYC"}',
        },
        {
          type: "tool-call",
          toolCallId: "tc-1",
          toolName: "get_weather",
          args: '{"loc":"NYC"}',
        },
      ];

      const { stream } = await middleware.wrapStream!({
        doStream: () =>
          Promise.resolve({ stream: makeStreamFromParts(parts) }),
        params: {},
        model: {},
      });

      const collected = await collectStream(stream);

      // All 3 parts forwarded: 2 deltas + 1 complete
      expect(collected).toHaveLength(3);
      expect(collected[0].type).toBe("tool-call-delta");
      expect(collected[1].type).toBe("tool-call-delta");
      expect(collected[2].type).toBe("tool-call");

      client.destroy();
    });

    it("drops denied tool call stream parts", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(tokenResponse(3600)));
      fetchSpy.mockResolvedValueOnce(
        jsonResponse(governResponse(false, "Denied")),
      );

      const client = await connectedClient();
      const agent = new SpudAgent(client, { mode: "enforcing" });
      const middleware = spudMiddleware(agent);

      const parts: StreamPart[] = [
        { type: "text-delta", textDelta: "Let me help" },
        {
          type: "tool-call-delta",
          toolCallId: "tc-1",
          toolName: "send_email",
          argsTextDelta: "{}",
        },
        {
          type: "tool-call",
          toolCallId: "tc-1",
          toolName: "send_email",
          args: "{}",
        },
        { type: "finish", finishReason: "tool-calls" },
      ];

      const { stream } = await middleware.wrapStream!({
        doStream: () =>
          Promise.resolve({ stream: makeStreamFromParts(parts) }),
        params: {},
        model: {},
      });

      const collected = await collectStream(stream);

      // Only text-delta and finish remain
      expect(collected).toHaveLength(2);
      expect(collected[0].type).toBe("text-delta");
      expect(collected[1].type).toBe("finish");

      client.destroy();
    });

    it("handles mixed permitted and denied tool calls in stream", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(tokenResponse(3600)));
      fetchSpy.mockResolvedValueOnce(jsonResponse(governResponse(true)));
      fetchSpy.mockResolvedValueOnce(
        jsonResponse(governResponse(false)),
      );

      const client = await connectedClient();
      const agent = new SpudAgent(client, { mode: "enforcing" });
      const middleware = spudMiddleware(agent);

      const parts: StreamPart[] = [
        {
          type: "tool-call-delta",
          toolCallId: "tc-1",
          toolName: "read_file",
          argsTextDelta: "{}",
        },
        {
          type: "tool-call",
          toolCallId: "tc-1",
          toolName: "read_file",
          args: "{}",
        },
        {
          type: "tool-call-delta",
          toolCallId: "tc-2",
          toolName: "delete_file",
          argsTextDelta: "{}",
        },
        {
          type: "tool-call",
          toolCallId: "tc-2",
          toolName: "delete_file",
          args: "{}",
        },
      ];

      const { stream } = await middleware.wrapStream!({
        doStream: () =>
          Promise.resolve({ stream: makeStreamFromParts(parts) }),
        params: {},
        model: {},
      });

      const collected = await collectStream(stream);

      // Only read_file parts: 1 delta + 1 complete
      expect(collected).toHaveLength(2);
      expect(collected[0].type).toBe("tool-call-delta");
      expect(collected[0].toolName).toBe("read_file");
      expect(collected[1].type).toBe("tool-call");
      expect(collected[1].toolName).toBe("read_file");

      client.destroy();
    });

    it("preserves non-stream properties from doStream result", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(tokenResponse(3600)));

      const client = await connectedClient();
      const agent = new SpudAgent(client, { mode: "enforcing" });
      const middleware = spudMiddleware(agent);

      const result = await middleware.wrapStream!({
        doStream: () =>
          Promise.resolve({
            stream: makeStreamFromParts([]),
            rawCall: { rawPrompt: "test", rawSettings: {} },
            rawResponse: { headers: { "x-test": "1" } },
          }),
        params: {},
        model: {},
      });

      expect((result as Record<string, unknown>).rawCall).toEqual({
        rawPrompt: "test",
        rawSettings: {},
      });

      client.destroy();
    });
  });

  // ── wrapTools ─────────────────────────────────────────────────────

  describe("wrapTools", () => {
    it("wraps tool execute with governance check", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(tokenResponse(3600)));
      fetchSpy.mockResolvedValueOnce(jsonResponse(governResponse(true)));

      const client = await connectedClient();
      const agent = new SpudAgent(client, { mode: "enforcing" });

      const executeSpy = vi.fn().mockResolvedValue({ temp: 72 });

      const tools: VercelAITools = {
        weather: {
          description: "Get weather",
          parameters: {},
          execute: executeSpy,
        },
      };

      const governed = wrapTools(agent, tools);
      const result = await governed.weather.execute!({ location: "NYC" });

      expect(result).toEqual({ temp: 72 });
      expect(executeSpy).toHaveBeenCalledWith(
        { location: "NYC" },
        undefined,
      );

      client.destroy();
    });

    it("throws SpudError when governance denies", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(tokenResponse(3600)));
      fetchSpy.mockResolvedValueOnce(
        jsonResponse(governResponse(false, "Email sending blocked")),
      );

      const client = await connectedClient();
      const agent = new SpudAgent(client, { mode: "enforcing" });

      const executeSpy = vi.fn();
      const tools: VercelAITools = {
        sendEmail: {
          description: "Send email",
          parameters: {},
          execute: executeSpy,
        },
      };

      const governed = wrapTools(agent, tools);

      await expect(
        governed.sendEmail.execute!({ to: "a@b.com" }),
      ).rejects.toThrow(SpudError);

      expect(executeSpy).not.toHaveBeenCalled();

      client.destroy();
    });

    it("passes tool arguments to governance context", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(tokenResponse(3600)));
      fetchSpy.mockResolvedValueOnce(jsonResponse(governResponse(true)));

      const client = await connectedClient();
      const agent = new SpudAgent(client, { mode: "enforcing" });

      const tools: VercelAITools = {
        query: {
          parameters: {},
          execute: vi.fn().mockResolvedValue("ok"),
        },
      };

      const governed = wrapTools(agent, tools);
      await governed.query.execute!({ sql: "SELECT 1" });

      const governCall = fetchSpy.mock.calls[1];
      const body = JSON.parse(governCall[1]?.body as string);

      expect(body.action).toBe("tool:query");
      expect(body.context.tool_arguments).toEqual({ sql: "SELECT 1" });

      client.destroy();
    });

    it("preserves tools without execute", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(tokenResponse(3600)));

      const client = await connectedClient();
      const agent = new SpudAgent(client, { mode: "enforcing" });

      const tools: VercelAITools = {
        noExec: {
          description: "No execute",
          parameters: {},
        },
      };

      const governed = wrapTools(agent, tools);

      expect(governed.noExec.execute).toBeUndefined();
      expect(governed.noExec.description).toBe("No execute");

      client.destroy();
    });

    it("passes options through to original execute", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(tokenResponse(3600)));
      fetchSpy.mockResolvedValueOnce(jsonResponse(governResponse(true)));

      const client = await connectedClient();
      const agent = new SpudAgent(client, { mode: "enforcing" });

      const executeSpy = vi.fn().mockResolvedValue("ok");
      const options = { toolCallId: "tc-1" };

      const tools: VercelAITools = {
        myTool: { parameters: {}, execute: executeSpy },
      };

      const governed = wrapTools(agent, tools);
      await governed.myTool.execute!({ a: 1 }, options);

      expect(executeSpy).toHaveBeenCalledWith({ a: 1 }, options);

      client.destroy();
    });

    it("uses default denial message when reason is absent", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(tokenResponse(3600)));
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({ permitted: false, decision_id: "d-1" }),
      );

      const client = await connectedClient();
      const agent = new SpudAgent(client, { mode: "enforcing" });

      const tools: VercelAITools = {
        myTool: { parameters: {}, execute: vi.fn() },
      };

      const governed = wrapTools(agent, tools);

      try {
        await governed.myTool.execute!({});
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(SpudError);
        expect((err as SpudError).message).toContain(
          'Tool "myTool" denied',
        );
        expect((err as SpudError).code).toBe("TOOL_DENIED");
      }

      client.destroy();
    });
  });
});
