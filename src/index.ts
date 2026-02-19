import { SpudClient } from "./core/client.js";
import { govern } from "./core/govern.js";
import { SpudAgent } from "./agent/wrapper.js";
import { SpudValidator } from "./server/validate.js";
import { report } from "./server/report.js";
import type {
  SpudConfig,
  SpudServerConfig,
  AgentConfig,
  GovernRequest,
  GovernResponse,
  ReportRequest,
  ReportResponse,
  SpudClaims,
  SpudRequest,
  SpudResponse,
} from "./types.js";

export type {
  SpudConfig,
  SpudServerConfig,
  AgentConfig,
  GovernRequest,
  GovernResponse,
  GovernanceMode,
  ToolCall,
  EnrichmentHook,
  FailurePolicy,
  InterceptResult,
  ProxyConfig,
  ReportRequest,
  ReportResponse,
  SpudClaims,
  SpudRequest,
  SpudResponse,
} from "./types.js";
export { SpudError } from "./types.js";
export { SpudAgent, SpudProxy } from "./agent/wrapper.js";
export { SpudValidator } from "./server/validate.js";

/** Handle returned by Spud.init() — the main entry point for the SDK. */
export interface SpudInstance {
  /**
   * Explicit governance check (Belt and Braces "manual escape hatch").
   *
   * Ask the Spud platform whether a specific action is permitted before
   * executing it.
   */
  govern(req: GovernRequest): Promise<GovernResponse>;

  /**
   * Create an agent wrapper — the "Belt" in Belt and Braces.
   *
   * Returns a SpudAgent that intercepts tool calls, runs governance
   * checks, and can proxy MCP HTTP traffic.
   */
  agent(config?: AgentConfig): SpudAgent;

  /** Whether the SDK currently holds a valid connection. */
  readonly isConnected: boolean;

  /** Tear down the SDK: stop heartbeats and token refresh. */
  destroy(): void;
}

/** Handle returned by SpudServer.init() — the server-side "Braces" entry point. */
export interface SpudServerInstance {
  /**
   * Validate a raw JWT string and return decoded claims.
   * Verifies signature against JWKS and checks expiry.
   */
  validateToken(token: string): Promise<SpudClaims>;

  /**
   * Validate from a Web API Request — extracts the X-Spud-Token header.
   * Works with Hono, Bun, Deno, Cloudflare Workers, and Node 18+.
   */
  validate(request: Request): Promise<SpudClaims>;

  /**
   * Express/Connect-compatible middleware.
   * On success, sets req.spud with decoded claims and calls next().
   * On failure, responds with 401 JSON error.
   */
  middleware(): (req: SpudRequest, res: SpudResponse, next: () => void) => void;

  /**
   * Report execution outcome back to the Spud platform, closing the
   * audit loop via POST /v1/confirm.
   */
  report(req: ReportRequest): Promise<ReportResponse>;

  /** Whether the SDK currently holds a valid connection. */
  readonly isConnected: boolean;

  /** Tear down the SDK: stop heartbeats, token refresh, and JWKS cache. */
  destroy(): void;
}

/**
 * Top-level Spud namespace.
 *
 * ```ts
 * import { Spud } from "@spud/sdk";
 *
 * const spud  = await Spud.init({ apiKey: process.env.SPUD_API_KEY! });
 * const agent = spud.agent({ mode: "enforcing" });
 *
 * agent.enrichContext(async () => ({ user_id: currentUser.id }));
 *
 * const decision = await agent.intercept({ name: "send_email", arguments: {} });
 * ```
 */
export const Spud = {
  /**
   * Initialise the SDK: exchanges the API key for a JWT, starts the
   * heartbeat, and returns a SpudInstance you can use for governance
   * calls and agent wrapping.
   */
  async init(config: SpudConfig): Promise<SpudInstance> {
    const client = new SpudClient(config);
    await client.connect();

    return {
      govern: (req: GovernRequest) => govern(client, req),
      agent: (agentConfig?: AgentConfig) =>
        new SpudAgent(client, agentConfig ?? {}),
      get isConnected() {
        return client.isConnected;
      },
      destroy: () => client.destroy(),
    };
  },
};

/**
 * Server-side namespace — the "Braces" in Belt and Braces.
 *
 * ```ts
 * import { SpudServer } from "@spud/sdk";
 *
 * const server = await SpudServer.init({ apiKey: process.env.SPUD_API_KEY! });
 *
 * // Express middleware — validates X-Spud-Token, sets req.spud
 * app.use(server.middleware());
 *
 * app.post("/tools/execute", async (req, res) => {
 *   // req.spud has decoded claims: tenant_id, profile, permissions, scope
 *   const result = await executeTool(req.body);
 *
 *   // Close the audit loop
 *   await server.report({
 *     event_id: req.spud.event_id,
 *     result: "success",
 *   });
 *
 *   res.json(result);
 * });
 * ```
 */
export const SpudServer = {
  /**
   * Initialise the server SDK: exchanges the API key for a JWT (for
   * report/confirm calls), fetches JWKS (for token validation), and
   * returns a SpudServerInstance.
   */
  async init(config: SpudServerConfig): Promise<SpudServerInstance> {
    const client = new SpudClient({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
    });
    await client.connect();

    const validator = new SpudValidator(config);
    await validator.init();

    return {
      validateToken: (token: string) => validator.validateToken(token),
      validate: (request: Request) => validator.validate(request),
      middleware: () => validator.middleware(),
      report: (req: ReportRequest) => report(client, req),
      get isConnected() {
        return client.isConnected;
      },
      destroy: () => {
        validator.destroy();
        client.destroy();
      },
    };
  },
};
