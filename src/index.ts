import { SpudClient } from "./core/client.js";
import { govern } from "./core/govern.js";
import { SpudAgent } from "./agent/wrapper.js";
import type {
  SpudConfig,
  AgentConfig,
  GovernRequest,
  GovernResponse,
} from "./types.js";

export type {
  SpudConfig,
  AgentConfig,
  GovernRequest,
  GovernResponse,
  GovernanceMode,
  ToolCall,
  EnrichmentHook,
  FailurePolicy,
  InterceptResult,
  ProxyConfig,
} from "./types.js";
export { SpudError } from "./types.js";
export { SpudAgent, SpudProxy } from "./agent/wrapper.js";

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
