import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SpudClient } from "../../src/core/client.js";
import { report } from "../../src/server/report.js";

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

describe("report()", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("sends POST to /v1/confirm with event_id and result", async () => {
    const confirmResp = { acknowledged: true };

    fetchSpy.mockResolvedValueOnce(jsonResponse(tokenResponse(3600))); // connect
    fetchSpy.mockResolvedValueOnce(jsonResponse(confirmResp)); // report

    const client = await connectedClient();
    const result = await report(client, {
      event_id: "evt-123",
      result: "success",
    });

    expect(result.acknowledged).toBe(true);

    // Verify the request body
    const confirmCall = fetchSpy.mock.calls[1];
    expect(confirmCall[0]).toBe("https://api.test/v1/confirm");

    const body = JSON.parse(confirmCall[1]?.body as string);
    expect(body.event_id).toBe("evt-123");
    expect(body.result).toBe("success");
    expect(body.metadata).toEqual({});

    client.destroy();
  });

  it("includes metadata when provided", async () => {
    const confirmResp = { acknowledged: true };

    fetchSpy.mockResolvedValueOnce(jsonResponse(tokenResponse(3600)));
    fetchSpy.mockResolvedValueOnce(jsonResponse(confirmResp));

    const client = await connectedClient();
    await report(client, {
      event_id: "evt-456",
      result: "failure",
      metadata: { error_message: "Permission denied", rows_affected: 0 },
    });

    const confirmCall = fetchSpy.mock.calls[1];
    const body = JSON.parse(confirmCall[1]?.body as string);
    expect(body.event_id).toBe("evt-456");
    expect(body.result).toBe("failure");
    expect(body.metadata).toEqual({
      error_message: "Permission denied",
      rows_affected: 0,
    });

    client.destroy();
  });

  it("defaults metadata to empty object when omitted", async () => {
    const confirmResp = { acknowledged: true };

    fetchSpy.mockResolvedValueOnce(jsonResponse(tokenResponse(3600)));
    fetchSpy.mockResolvedValueOnce(jsonResponse(confirmResp));

    const client = await connectedClient();
    await report(client, {
      event_id: "evt-789",
      result: "error",
    });

    const confirmCall = fetchSpy.mock.calls[1];
    const body = JSON.parse(confirmCall[1]?.body as string);
    expect(body.metadata).toEqual({});

    client.destroy();
  });

  it("sends Bearer token in Authorization header", async () => {
    const confirmResp = { acknowledged: true };

    fetchSpy.mockResolvedValueOnce(jsonResponse(tokenResponse(3600)));
    fetchSpy.mockResolvedValueOnce(jsonResponse(confirmResp));

    const client = await connectedClient();
    await report(client, {
      event_id: "evt-auth",
      result: "success",
    });

    const confirmCall = fetchSpy.mock.calls[1];
    const init = confirmCall[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toMatch(/^Bearer jwt-token-/);

    client.destroy();
  });

  it("propagates API errors from the client", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(tokenResponse(3600)));
    fetchSpy.mockResolvedValueOnce(
      new Response("Internal Server Error", { status: 500 }),
    );

    const client = await connectedClient();
    await expect(
      report(client, { event_id: "evt-fail", result: "success" }),
    ).rejects.toThrow("API request failed");

    client.destroy();
  });

  it("supports all result types: success, failure, error", async () => {
    const confirmResp = { acknowledged: true };

    for (const resultType of ["success", "failure", "error"] as const) {
      fetchSpy.mockResolvedValueOnce(jsonResponse(tokenResponse(3600)));
      fetchSpy.mockResolvedValueOnce(jsonResponse(confirmResp));

      const client = await connectedClient();
      const result = await report(client, {
        event_id: `evt-${resultType}`,
        result: resultType,
      });

      expect(result.acknowledged).toBe(true);
      client.destroy();
    }
  });
});
