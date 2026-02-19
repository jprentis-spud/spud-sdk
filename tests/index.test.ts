import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";
import { Spud, SpudServer, SpudError, SpudAgent, SpudValidator } from "../src/index.js";

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

  it("agent() returns a SpudAgent instance", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(tokenResponse(3600)));

    const spud = await Spud.init({
      apiKey: "sk-test",
      baseUrl: "https://api.test",
    });

    const agent = spud.agent({ mode: "enforcing" });
    expect(agent).toBeInstanceOf(SpudAgent);

    const agentDefault = spud.agent();
    expect(agentDefault).toBeInstanceOf(SpudAgent);

    spud.destroy();
  });

  it("exports SpudError class", () => {
    const err = new SpudError("test", "TEST_CODE", 400);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("SpudError");
    expect(err.code).toBe("TEST_CODE");
    expect(err.statusCode).toBe(400);
  });
});

// ── SpudServer ────────────────────────────────────────────────────────

// Crypto helpers for test JWTs
let rsaKeyPair: CryptoKeyPair;
let rsaPublicJwk: JsonWebKey;

const KID = "test-key-1";

function base64UrlEncode(str: string): string {
  const base64 = btoa(str);
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function uint8ArrayToBase64Url(arr: Uint8Array): string {
  let binary = "";
  for (const byte of arr) {
    binary += String.fromCharCode(byte);
  }
  return base64UrlEncode(binary);
}

async function signTestJwt(
  claims: Record<string, unknown>,
): Promise<string> {
  const header = { alg: "RS256", typ: "JWT", kid: KID };
  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const payloadB64 = base64UrlEncode(JSON.stringify(claims));
  const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    rsaKeyPair.privateKey,
    data,
  );
  return `${headerB64}.${payloadB64}.${uint8ArrayToBase64Url(new Uint8Array(signature))}`;
}

function jwksJsonResponse(publicJwk: JsonWebKey, kid: string) {
  return jsonResponse({
    keys: [{ ...publicJwk, kid, alg: "RS256", use: "sig" }],
  });
}

beforeAll(async () => {
  rsaKeyPair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  rsaPublicJwk = await crypto.subtle.exportKey("jwk", rsaKeyPair.publicKey);
});

describe("SpudServer.init()", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns a SpudServerInstance with validate, middleware, report, destroy", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(tokenResponse(3600))); // client connect
    fetchSpy.mockResolvedValueOnce(jwksJsonResponse(rsaPublicJwk, KID)); // JWKS

    const server = await SpudServer.init({
      apiKey: "sk-test",
      baseUrl: "https://api.test",
    });

    expect(server.isConnected).toBe(true);
    expect(typeof server.validateToken).toBe("function");
    expect(typeof server.validate).toBe("function");
    expect(typeof server.middleware).toBe("function");
    expect(typeof server.report).toBe("function");
    expect(typeof server.destroy).toBe("function");

    server.destroy();
    expect(server.isConnected).toBe(false);
  });

  it("validateToken() validates JWTs via JWKS", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(tokenResponse(3600)));
    fetchSpy.mockResolvedValueOnce(jwksJsonResponse(rsaPublicJwk, KID));

    const server = await SpudServer.init({
      apiKey: "sk-test",
      baseUrl: "https://api.test",
    });

    const token = await signTestJwt({
      tenant_id: "t-1",
      profile: "prod",
      permissions: ["read"],
      scope: "agent",
      event_id: "evt-1",
      sub: "a-1",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    });

    const claims = await server.validateToken(token);
    expect(claims.tenant_id).toBe("t-1");

    server.destroy();
  });

  it("report() sends POST to /v1/confirm", async () => {
    const confirmResp = { acknowledged: true };
    fetchSpy.mockResolvedValueOnce(jsonResponse(tokenResponse(3600)));
    fetchSpy.mockResolvedValueOnce(jwksJsonResponse(rsaPublicJwk, KID));
    fetchSpy.mockResolvedValueOnce(jsonResponse(confirmResp));

    const server = await SpudServer.init({
      apiKey: "sk-test",
      baseUrl: "https://api.test",
    });

    const result = await server.report({
      event_id: "evt-server-1",
      result: "success",
    });

    expect(result.acknowledged).toBe(true);

    const confirmCall = fetchSpy.mock.calls[2];
    expect(confirmCall[0]).toBe("https://api.test/v1/confirm");

    server.destroy();
  });

  it("exports SpudValidator class", () => {
    expect(SpudValidator).toBeDefined();
    expect(typeof SpudValidator).toBe("function");
  });
});
