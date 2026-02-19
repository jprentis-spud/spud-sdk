import { SpudClient } from "./core/client.js";
import { govern } from "./core/govern.js";
import type {
  SpudConfig,
  GovernRequest,
  GovernResponse,
} from "./types.js";

export type {
  SpudConfig,
  GovernRequest,
  GovernResponse,
} from "./types.js";
export { SpudError } from "./types.js";

/** Handle returned by Spud.init() — the main entry point for the SDK. */
export interface SpudInstance {
  /**
   * Explicit governance check (Belt and Braces "manual escape hatch").
   *
   * Ask the Spud platform whether a specific action is permitted before
   * executing it.
   */
  govern(req: GovernRequest): Promise<GovernResponse>;

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
 * const spud = await Spud.init({ apiKey: process.env.SPUD_API_KEY! });
 * const decision = await spud.govern({ action: "send_email" });
 * ```
 */
export const Spud = {
  /**
   * Initialise the SDK: exchanges the API key for a JWT, starts the
   * heartbeat, and returns a SpudInstance you can use for governance
   * calls.
   */
  async init(config: SpudConfig): Promise<SpudInstance> {
    const client = new SpudClient(config);
    await client.connect();

    return {
      govern: (req: GovernRequest) => govern(client, req),
      get isConnected() {
        return client.isConnected;
      },
      destroy: () => client.destroy(),
    };
  },
};
