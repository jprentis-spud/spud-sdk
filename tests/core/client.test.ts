import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SpudClient } from "../../src/core/client.js";

// ── Helpers ────────────────────────────────────────────────────────────

/** Build a fake token response that expires `expiresInSec` from now. */
function tokenResponse(expiresInSec: number) {
  return {
    token: "jwt-token-" + Math.random().toString(36).slice(2),
    expires_at: Math.floor(Date.now() / 1000) + expiresInSec,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("SpudClient", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ── connect() ──────────────────────────────────────────────────────

  describe("connect()", () => {
    it("exchanges the API key for a JWT", async () => {
      const tok = tokenResponse(3600);
      fetchSpy.mockResolvedValueOnce(jsonResponse(tok));

      const client = new SpudClient({
        apiKey: "sk-test",
        baseUrl: "https://api.test",
      });
      await client.connect();

      expect(fetchSpy).toHaveBeenCalledWith(
        "https://api.test/v1/auth/token",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ api_key: "sk-test" }),
        }),
      );
      expect(client.isConnected).toBe(true);

      client.destroy();
    });

    it("throws SpudError when token exchange fails", async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response("Unauthorized", { status: 401 }),
      );

      const client = new SpudClient({
        apiKey: "bad-key",
        baseUrl: "https://api.test",
      });

      await expect(client.connect()).rejects.toThrow("Token exchange failed");

      client.destroy();
    });

    it("strips trailing slashes from baseUrl", async () => {
      const tok = tokenResponse(3600);
      fetchSpy.mockResolvedValueOnce(jsonResponse(tok));

      const client = new SpudClient({
        apiKey: "sk-test",
        baseUrl: "https://api.test///",
      });
      await client.connect();

      expect(fetchSpy).toHaveBeenCalledWith(
        "https://api.test/v1/auth/token",
        expect.anything(),
      );

      client.destroy();
    });
  });

  // ── request() ──────────────────────────────────────────────────────

  describe("request()", () => {
    it("attaches Bearer token to outgoing requests", async () => {
      const tok = tokenResponse(3600);
      fetchSpy.mockResolvedValueOnce(jsonResponse(tok)); // connect
      fetchSpy.mockResolvedValueOnce(jsonResponse({ ok: true })); // request

      const client = new SpudClient({
        apiKey: "sk-test",
        baseUrl: "https://api.test",
      });
      await client.connect();
      await client.request("POST", "/v1/govern", { action: "test" });

      const requestCall = fetchSpy.mock.calls[1];
      expect(requestCall[0]).toBe("https://api.test/v1/govern");

      const init = requestCall[1] as RequestInit;
      const headers = init.headers as Record<string, string>;
      expect(headers["Authorization"]).toMatch(/^Bearer jwt-token-/);

      client.destroy();
    });

    it("throws when called before connect()", async () => {
      const client = new SpudClient({
        apiKey: "sk-test",
        baseUrl: "https://api.test",
      });

      await expect(
        client.request("GET", "/v1/status"),
      ).rejects.toThrow("not connected");

      client.destroy();
    });

    it("throws when called after destroy()", async () => {
      const tok = tokenResponse(3600);
      fetchSpy.mockResolvedValueOnce(jsonResponse(tok));

      const client = new SpudClient({
        apiKey: "sk-test",
        baseUrl: "https://api.test",
      });
      await client.connect();
      client.destroy();

      await expect(
        client.request("GET", "/v1/status"),
      ).rejects.toThrow("destroyed");
    });

    it("throws SpudError on non-OK responses", async () => {
      const tok = tokenResponse(3600);
      fetchSpy.mockResolvedValueOnce(jsonResponse(tok)); // connect
      fetchSpy.mockResolvedValueOnce(
        new Response("Forbidden", { status: 403 }),
      ); // request

      const client = new SpudClient({
        apiKey: "sk-test",
        baseUrl: "https://api.test",
      });
      await client.connect();

      await expect(
        client.request("POST", "/v1/govern", {}),
      ).rejects.toThrow("API request failed");

      client.destroy();
    });
  });

  // ── Silent token refresh ───────────────────────────────────────────

  describe("silent refresh", () => {
    it("refreshes the token before expiry", async () => {
      // Token that expires in 10 minutes
      const tok1 = tokenResponse(600);
      const tok2 = tokenResponse(3600);

      fetchSpy.mockResolvedValueOnce(jsonResponse(tok1)); // initial connect
      fetchSpy.mockResolvedValueOnce(jsonResponse(tok2)); // refresh

      const client = new SpudClient({
        apiKey: "sk-test",
        baseUrl: "https://api.test",
        refreshBeforeExpiryMs: 5 * 60_000, // refresh 5min before expiry
      });
      await client.connect();

      // At this point, the token expires in 600s. Refresh should fire at
      // (600s - 300s) = 300s = 5 min from now.
      // Advance time to just past 5 min.
      await vi.advanceTimersByTimeAsync(5 * 60_000 + 100);

      // The refresh call should have been made
      const tokenCalls = fetchSpy.mock.calls.filter(
        (c) => (c[0] as string).includes("/v1/auth/token"),
      );
      expect(tokenCalls.length).toBe(2); // initial + refresh

      client.destroy();
    });
  });

  // ── Heartbeat ──────────────────────────────────────────────────────

  describe("heartbeat", () => {
    it("sends heartbeats at the configured interval", async () => {
      const tok = tokenResponse(3600);
      fetchSpy.mockResolvedValue(jsonResponse({}));
      fetchSpy.mockResolvedValueOnce(jsonResponse(tok));

      const client = new SpudClient({
        apiKey: "sk-test",
        baseUrl: "https://api.test",
        heartbeatIntervalMs: 10_000,
      });
      await client.connect();

      // Advance 35s → should trigger ~3 heartbeats
      await vi.advanceTimersByTimeAsync(35_000);

      const heartbeatCalls = fetchSpy.mock.calls.filter(
        (c) => (c[0] as string).includes("/v1/heartbeat"),
      );
      expect(heartbeatCalls.length).toBe(3);

      client.destroy();
    });

    it("stops heartbeats after destroy()", async () => {
      const tok = tokenResponse(3600);
      fetchSpy.mockResolvedValue(jsonResponse({}));
      fetchSpy.mockResolvedValueOnce(jsonResponse(tok));

      const client = new SpudClient({
        apiKey: "sk-test",
        baseUrl: "https://api.test",
        heartbeatIntervalMs: 10_000,
      });
      await client.connect();
      client.destroy();

      await vi.advanceTimersByTimeAsync(60_000);

      const heartbeatCalls = fetchSpy.mock.calls.filter(
        (c) => (c[0] as string).includes("/v1/heartbeat"),
      );
      expect(heartbeatCalls.length).toBe(0);
    });
  });

  // ── destroy() ──────────────────────────────────────────────────────

  describe("destroy()", () => {
    it("clears isConnected and stops timers", async () => {
      const tok = tokenResponse(3600);
      fetchSpy.mockResolvedValueOnce(jsonResponse(tok));

      const client = new SpudClient({
        apiKey: "sk-test",
        baseUrl: "https://api.test",
      });
      await client.connect();
      expect(client.isConnected).toBe(true);

      client.destroy();
      expect(client.isConnected).toBe(false);
    });
  });
});
