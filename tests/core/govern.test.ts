import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SpudClient } from "../../src/core/client.js";
import { govern } from "../../src/core/govern.js";

// ── Helpers ────────────────────────────────────────────────────────────

function tokenResponse(expiresInSec: number) {
  return {
    token: "jwt-token-test",
    expires_at: Math.floor(Date.now() / 1000) + expiresInSec,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function connectedClient(): Promise<SpudClient> {
  const client = new SpudClient({
    apiKey: "sk-test",
    baseUrl: "https://api.test",
  });
  await client.connect();
  return client;
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("govern()", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("sends a POST to /v1/govern with action and context", async () => {
    const governResp = {
      permitted: true,
      reason: "Policy allows this action",
      decision_id: "dec-123",
    };

    fetchSpy.mockResolvedValueOnce(jsonResponse(tokenResponse(3600))); // connect
    fetchSpy.mockResolvedValueOnce(jsonResponse(governResp)); // govern

    const client = await connectedClient();
    const result = await govern(client, {
      action: "send_email",
      context: { to: "user@example.com" },
    });

    expect(result.permitted).toBe(true);
    expect(result.decision_id).toBe("dec-123");

    // Verify the request body
    const governCall = fetchSpy.mock.calls[1];
    const body = JSON.parse(governCall[1]?.body as string);
    expect(body.action).toBe("send_email");
    expect(body.context).toEqual({ to: "user@example.com" });
    expect(body.blocking).toBe(true); // default

    client.destroy();
  });

  it("defaults blocking to true and context to empty object", async () => {
    const governResp = {
      permitted: false,
      reason: "Blocked by policy",
      decision_id: "dec-456",
    };

    fetchSpy.mockResolvedValueOnce(jsonResponse(tokenResponse(3600)));
    fetchSpy.mockResolvedValueOnce(jsonResponse(governResp));

    const client = await connectedClient();
    await govern(client, { action: "delete_database" });

    const governCall = fetchSpy.mock.calls[1];
    const body = JSON.parse(governCall[1]?.body as string);
    expect(body.context).toEqual({});
    expect(body.blocking).toBe(true);

    client.destroy();
  });

  it("passes blocking: false when specified", async () => {
    const governResp = {
      permitted: true,
      decision_id: "dec-789",
    };

    fetchSpy.mockResolvedValueOnce(jsonResponse(tokenResponse(3600)));
    fetchSpy.mockResolvedValueOnce(jsonResponse(governResp));

    const client = await connectedClient();
    await govern(client, {
      action: "log_event",
      blocking: false,
    });

    const governCall = fetchSpy.mock.calls[1];
    const body = JSON.parse(governCall[1]?.body as string);
    expect(body.blocking).toBe(false);

    client.destroy();
  });

  it("propagates API errors from the client", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(tokenResponse(3600)));
    fetchSpy.mockResolvedValueOnce(
      new Response("Internal Server Error", { status: 500 }),
    );

    const client = await connectedClient();
    await expect(
      govern(client, { action: "crash" }),
    ).rejects.toThrow("API request failed");

    client.destroy();
  });
});
