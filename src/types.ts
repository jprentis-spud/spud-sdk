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
