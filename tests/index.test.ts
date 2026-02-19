import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Spud, SpudError } from "../src/index.js";

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

// ── Tests ──────────────────────────────────────────────────────────────

describe("Spud.init()", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns a SpudInstance with govern() and destroy()", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(tokenResponse(3600)));

    const spud = await Spud.init({
      apiKey: "sk-test",
      baseUrl: "https://api.test",
    });

    expect(spud.isConnected).toBe(true);
    expect(typeof spud.govern).toBe("function");
    expect(typeof spud.destroy).toBe("function");

    spud.destroy();
    expect(spud.isConnected).toBe(false);
  });

  it("govern() delegates to POST /v1/govern", async () => {
    const governResp = {
      permitted: true,
      reason: "OK",
      decision_id: "dec-001",
    };

    fetchSpy.mockResolvedValueOnce(jsonResponse(tokenResponse(3600)));
    fetchSpy.mockResolvedValueOnce(jsonResponse(governResp));

    const spud = await Spud.init({
      apiKey: "sk-test",
      baseUrl: "https://api.test",
    });

    const decision = await spud.govern({
      action: "send_email",
      context: { to: "admin@example.com" },
    });

    expect(decision.permitted).toBe(true);
    expect(decision.decision_id).toBe("dec-001");

    spud.destroy();
  });

  it("rejects with SpudError when API key is invalid", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response("Unauthorized", { status: 401 }),
    );

    await expect(
      Spud.init({ apiKey: "bad", baseUrl: "https://api.test" }),
    ).rejects.toThrow("Token exchange failed");
  });

  it("exports SpudError class", () => {
    const err = new SpudError("test", "TEST_CODE", 400);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("SpudError");
    expect(err.code).toBe("TEST_CODE");
    expect(err.statusCode).toBe(400);
  });
});
