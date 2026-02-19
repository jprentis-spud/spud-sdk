import {
  SpudConfig,
  SpudError,
  TokenResponse,
} from "../types.js";

const DEFAULT_BASE_URL = "https://api.spud.dev";
const DEFAULT_HEARTBEAT_MS = 60_000;
const DEFAULT_REFRESH_BEFORE_EXPIRY_MS = 5 * 60_000; // 5 minutes
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000; // 30 seconds
const MAX_REASONABLE_TOKEN_LIFETIME_SEC = 7 * 24 * 3_600; // 7 days

/**
 * Low-level API client that owns the JWT lifecycle.
 *
 * Responsibilities:
 *  - Exchange an API key for a JWT via POST /v1/auth/token
 *  - Cache the JWT in memory
 *  - Silently refresh the JWT before it expires
 *  - Send a heartbeat at a fixed interval
 */
export class SpudClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly heartbeatMs: number;
  private readonly refreshBeforeExpiryMs: number;
  private readonly requestTimeoutMs: number;

  private jwt: string | null = null;
  private jwtExpiresAt = 0; // Unix seconds

  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private destroyed = false;

  constructor(config: SpudConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.heartbeatMs = config.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_MS;
    this.refreshBeforeExpiryMs =
      config.refreshBeforeExpiryMs ?? DEFAULT_REFRESH_BEFORE_EXPIRY_MS;
    this.requestTimeoutMs =
      config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  // ── Bootstrap ──────────────────────────────────────────────────────

  /** Exchange the API key for a JWT token and start background timers. */
  async connect(): Promise<void> {
    await this.fetchToken();
    this.scheduleRefresh();
    this.startHeartbeat();
  }

  /** Tear down timers and clear the cached JWT. */
  destroy(): void {
    this.destroyed = true;
    if (this.refreshTimer !== null) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.jwt = null;
    this.jwtExpiresAt = 0;
  }

  // ── Authenticated requests ─────────────────────────────────────────

  /**
   * Make an authenticated request to the Spud API.
   * Automatically attaches the cached JWT as a Bearer token.
   */
  async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    if (this.destroyed) {
      throw new SpudError("Client has been destroyed", "CLIENT_DESTROYED");
    }
    if (!this.jwt) {
      throw new SpudError(
        "Client is not connected — call connect() first",
        "NOT_CONNECTED",
      );
    }

    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.jwt}`,
      "Content-Type": "application/json",
    };

    const res = await fetchWithTimeout(
      url,
      {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      },
      this.requestTimeoutMs,
    );

    if (!res.ok) {
      throw new SpudError(
        `API request failed: ${res.status} ${res.statusText}`,
        "API_ERROR",
        res.status,
      );
    }

    return (await res.json()) as T;
  }

  // ── Token lifecycle (private) ──────────────────────────────────────

  private async fetchToken(): Promise<void> {
    const url = `${this.baseUrl}/v1/auth/token`;
    const res = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: this.apiKey }),
      },
      this.requestTimeoutMs,
    );

    if (!res.ok) {
      throw new SpudError(
        `Token exchange failed: ${res.status} ${res.statusText}`,
        "AUTH_FAILED",
        res.status,
      );
    }

    const data = (await res.json()) as TokenResponse;

    // Validate that expires_at is sane before trusting it
    const nowSec = Math.floor(Date.now() / 1000);
    if (data.expires_at <= nowSec) {
      throw new SpudError(
        "Token exchange returned an already-expired token",
        "INVALID_TOKEN",
      );
    }
    if (data.expires_at > nowSec + MAX_REASONABLE_TOKEN_LIFETIME_SEC) {
      throw new SpudError(
        "Token exchange returned an unreasonable expiry",
        "INVALID_TOKEN",
      );
    }

    this.jwt = data.token;
    this.jwtExpiresAt = data.expires_at;
  }

  private scheduleRefresh(): void {
    if (this.destroyed) return;

    const nowSec = Math.floor(Date.now() / 1000);
    const msUntilExpiry = (this.jwtExpiresAt - nowSec) * 1000;
    const delay = Math.max(msUntilExpiry - this.refreshBeforeExpiryMs, 0);

    this.refreshTimer = setTimeout(async () => {
      try {
        await this.fetchToken();
        this.scheduleRefresh();
      } catch {
        // If refresh fails, retry in 30s rather than giving up.
        this.refreshTimer = setTimeout(() => this.scheduleRefresh(), 30_000);
      }
    }, delay);
  }

  // ── Heartbeat (private) ────────────────────────────────────────────

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      if (this.destroyed || !this.jwt) return;
      // Fire-and-forget heartbeat — failures are non-fatal.
      fetchWithTimeout(
        `${this.baseUrl}/v1/heartbeat`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.jwt}`,
            "Content-Type": "application/json",
          },
        },
        this.requestTimeoutMs,
      ).catch(() => {
        // Heartbeat failures are silently ignored.
      });
    }, this.heartbeatMs);
  }

  // ── Accessors ───────────────────────────────────────────────────────

  /** Whether the client currently holds a valid JWT. */
  get isConnected(): boolean {
    return this.jwt !== null && !this.destroyed;
  }

  /** Seconds until the cached JWT expires, or 0 if not connected. */
  get secondsUntilExpiry(): number {
    if (!this.jwt) return 0;
    return Math.max(this.jwtExpiresAt - Math.floor(Date.now() / 1000), 0);
  }

  /** Current JWT, or null if not connected. Used by the agent proxy. */
  get authToken(): string | null {
    return this.jwt;
  }

  /** Configured request timeout in ms. Used by the proxy and validator. */
  get timeoutMs(): number {
    return this.requestTimeoutMs;
  }
}

// ── Fetch with timeout ─────────────────────────────────────────────────

/**
 * Wraps fetch with an AbortController-based timeout.
 * Prevents hanging requests from blocking the application indefinitely.
 */
export function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  return fetch(url, { ...init, signal: controller.signal }).finally(() => {
    clearTimeout(timer);
  });
}
