/** Configuration provided to Spud.init() */
export interface SpudConfig {
  /** API key for authenticating with the Spud platform */
  apiKey: string;
  /** Base URL of the Spud API (default: https://api.spud.dev) */
  baseUrl?: string;
  /** Heartbeat interval in ms (default: 60000) */
  heartbeatIntervalMs?: number;
  /** How many ms before JWT expiry to trigger a silent refresh (default: 300000 = 5min) */
  refreshBeforeExpiryMs?: number;
}

/** JWT payload fields the SDK inspects (subset — we only read what we need) */
export interface JwtClaims {
  exp: number; // Unix seconds
  iat: number;
  sub: string;
}

/** Token response from POST /v1/auth/token */
export interface TokenResponse {
  token: string;
  expires_at: number; // Unix seconds
}

/** Parameters for an explicit govern call */
export interface GovernRequest {
  /** The action the agent intends to take */
  action: string;
  /** Arbitrary context for the governance decision */
  context?: Record<string, unknown>;
  /** Whether to block until a decision is returned (default: true) */
  blocking?: boolean;
}

/** Response from POST /v1/govern */
export interface GovernResponse {
  /** Whether the action is permitted */
  permitted: boolean;
  /** Human-readable reason for the decision */
  reason?: string;
  /** Opaque decision id for audit trail */
  decision_id: string;
}

// ── Agent types ────────────────────────────────────────────────────────

/** Governance mode controls how the SDK reacts to governance decisions. */
export type GovernanceMode =
  | "enforcing"   // Block on deny
  | "permissive"  // Log but allow
  | "dry-run";    // Evaluate but don't block or log

/** Represents a single tool invocation the agent wants to make. */
export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

/** Async function that enriches governance context per tool call. */
export type EnrichmentHook = (
  toolCall: ToolCall,
) => Promise<Record<string, unknown>>;

/**
 * Failure policy — controls behaviour when the governance service is
 * unreachable.
 *
 * Tool name patterns support trailing wildcards: `"get_*"` matches any
 * tool whose name starts with `"get_"`.
 */
export interface FailurePolicy {
  /** Tool name patterns that fail open (allow when governance is down). */
  failOpen?: string[];
  /** Tool name patterns that fail closed (deny when governance is down). */
  failClosed?: string[];
  /** Default when a tool matches neither list (default: "closed"). */
  default?: "open" | "closed";
}

/** Configuration for spud.agent(). */
export interface AgentConfig {
  /** Governance mode (default: "enforcing"). */
  mode?: GovernanceMode;
  /** Failure policy for when governance is unreachable. */
  failurePolicy?: FailurePolicy;
}

/** Result of an intercept() governance check. */
export interface InterceptResult {
  /** Whether the tool call should proceed (accounts for mode + failure policy). */
  proceed: boolean;
  /** The governance decision (synthetic on failure). */
  decision: GovernResponse;
}

/** Configuration for agent.proxy(). */
export interface ProxyConfig {
  /** Full URL of the upstream MCP server endpoint. */
  upstream: string;
}

/** JSON-RPC 2.0 request shape (subset used by MCP). */
export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
}

/** MCP tools/call params. */
export interface ToolCallParams {
  name: string;
  arguments?: Record<string, unknown>;
}

/** Errors surfaced by the SDK */
export class SpudError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = "SpudError";
  }
}
