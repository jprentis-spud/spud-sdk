import { SpudClient, fetchWithTimeout } from "../core/client.js";
import { AgentContext } from "./context.js";
import type {
  AgentConfig,
  EnrichmentHook,
  GovernResponse,
  InterceptResult,
  JsonRpcRequest,
  ProxyConfig,
  ToolCall,
  ToolCallParams,
} from "../types.js";

/**
 * Agent SDK wrapper — the "Belt" in Belt and Braces.
 *
 * Intercepts outbound agent tool calls, runs governance checks against
 * the Spud platform, and applies the configured governance mode and
 * failure policy.
 *
 * ```ts
 * const spud  = await Spud.init({ apiKey: "..." });
 * const agent = spud.agent({ mode: "enforcing" });
 *
 * agent.enrichContext(async (tc) => ({ user_id: currentUser.id }));
 *
 * // Option A — low-level intercept
 * const { proceed } = await agent.intercept({ name: "send_email", arguments: {} });
 *
 * // Option B — MCP HTTP proxy
 * const proxy = agent.proxy({ upstream: "http://mcp-server:3000" });
 * // proxy.handler is (Request) => Promise<Response>
 * ```
 */
export class SpudAgent {
  private readonly client: SpudClient;
  private readonly ctx: AgentContext;

  constructor(client: SpudClient, config: AgentConfig) {
    this.client = client;
    this.ctx = new AgentContext(config);
  }

  // ── Enrichment ───────────────────────────────────────────────────

  /**
   * Register an enrichment hook that provides business context for
   * governance decisions (user id, org, roles, etc.).
   */
  enrichContext(hook: EnrichmentHook): this {
    this.ctx.addHook(hook);
    return this;
  }

  // ── Low-level intercept ──────────────────────────────────────────

  /**
   * Run a governance check for a single tool call.
   *
   * Returns `{ proceed, decision }` where `proceed` accounts for the
   * governance mode and failure policy.
   */
  async intercept(toolCall: ToolCall): Promise<InterceptResult> {
    const entityContext = await this.ctx.buildContext(toolCall);

    let decision: GovernResponse;
    try {
      decision = await this.client.request<GovernResponse>(
        "POST",
        "/v1/govern",
        {
          action: `tool:${toolCall.name}`,
          context: {
            ...entityContext,
            tool_name: toolCall.name,
            tool_arguments: toolCall.arguments,
          },
          blocking: true,
        },
      );
    } catch {
      // Governance service unreachable — apply failure policy
      const failMode = this.ctx.failureModeFor(toolCall.name);
      const allowed = failMode === "open";
      return {
        proceed: allowed,
        decision: {
          permitted: allowed,
          reason: allowed
            ? "Governance unavailable — fail-open applied"
            : "Governance unavailable — fail-closed applied",
          decision_id: "",
        },
      };
    }

    const mode = this.ctx.mode;

    if (mode === "dry-run" || mode === "permissive") {
      return { proceed: true, decision };
    }

    // enforcing
    return { proceed: decision.permitted, decision };
  }

  // ── MCP HTTP proxy ───────────────────────────────────────────────

  /**
   * Create an MCP HTTP transport proxy.
   *
   * The returned `SpudProxy` has a `handler` that can be used with any
   * Web-API-compatible server (Node 18+, Bun, Deno, Cloudflare Workers).
   */
  proxy(config: ProxyConfig): SpudProxy {
    return new SpudProxy(this, this.client, config);
  }
}

// ── MCP Proxy ────────────────────────────────────────────────────────

/**
 * HTTP proxy that sits between an MCP client and an MCP server.
 *
 * Intercepts `tools/call` JSON-RPC messages, governs them, then either
 * forwards to the upstream with the Spud JWT attached or returns a
 * JSON-RPC error.
 */
export class SpudProxy {
  private readonly agent: SpudAgent;
  private readonly client: SpudClient;
  private readonly upstream: string;

  constructor(agent: SpudAgent, client: SpudClient, config: ProxyConfig) {
    this.agent = agent;
    this.client = client;
    this.upstream = config.upstream.replace(/\/+$/, "");
  }

  /**
   * Web-API-compatible request handler.
   * Bound as an arrow so it can be passed directly as a callback.
   */
  handler = async (request: Request): Promise<Response> => {
    const text = await request.text();

    let body: JsonRpcRequest;
    try {
      body = JSON.parse(text) as JsonRpcRequest;
    } catch {
      // Not valid JSON — forward as-is and let upstream handle it
      return this.forward(request.headers, text);
    }

    // Only intercept tools/call — pass everything else through
    if (body.method !== "tools/call") {
      return this.forward(request.headers, text);
    }

    const params = body.params as ToolCallParams;
    const toolCall: ToolCall = {
      name: params.name,
      arguments: params.arguments ?? {},
    };

    const result = await this.agent.intercept(toolCall);

    if (!result.proceed) {
      return jsonRpcError(
        body.id,
        result.decision.reason ?? "Action denied by governance policy",
      );
    }

    return this.forward(request.headers, text);
  };

  // ── Private helpers ────────────────────────────────────────────────

  private async forward(
    originalHeaders: Headers,
    body: string,
  ): Promise<Response> {
    const headers = new Headers(originalHeaders);

    // Attach the Spud JWT so the upstream (the "Braces" side) can
    // verify governance was applied.
    const token = this.client.authToken;
    if (token) {
      headers.set("X-Spud-Token", token);
    }

    return fetchWithTimeout(
      this.upstream,
      {
        method: "POST",
        headers,
        body,
      },
      this.client.timeoutMs,
    );
  }
}

// ── JSON-RPC helpers ───────────────────────────────────────────────────

function jsonRpcError(
  id: number | string,
  message: string,
): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      error: {
        code: -32600,
        message,
      },
    }),
    {
      status: 200, // JSON-RPC errors still use HTTP 200
      headers: { "Content-Type": "application/json" },
    },
  );
}
