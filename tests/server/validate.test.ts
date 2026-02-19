import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";
import { SpudValidator } from "../../src/server/validate.js";
import type { SpudRequest } from "../../src/types.js";
import { SpudError } from "../../src/types.js";

// ── Crypto helpers for test JWTs ──────────────────────────────────────

let rsaKeyPair: CryptoKeyPair;
let rsaPublicJwk: JsonWebKey;

const KID = "test-key-1";

const VALID_CLAIMS = {
  tenant_id: "tenant-abc",
  profile: "production",
  permissions: ["tool:read", "tool:write"],
  scope: "agent",
  event_id: "evt-123",
  sub: "agent-456",
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + 3600,
};

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

async function signJwt(
  claims: Record<string, unknown>,
  kid: string,
  privateKey: CryptoKey,
): Promise<string> {
  const header = { alg: "RS256", typ: "JWT", kid };
  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const payloadB64 = base64UrlEncode(JSON.stringify(claims));
  const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    data,
  );
  const signatureB64 = uint8ArrayToBase64Url(new Uint8Array(signature));
  return `${headerB64}.${payloadB64}.${signatureB64}`;
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function jwksResponse(publicJwk: JsonWebKey, kid: string) {
  return jsonResponse({
    keys: [{ ...publicJwk, kid, alg: "RS256", use: "sig" }],
  });
}

// ── Setup ─────────────────────────────────────────────────────────────

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

// ── Tests ─────────────────────────────────────────────────────────────

describe("SpudValidator", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function createValidator(): Promise<SpudValidator> {
    fetchSpy.mockResolvedValueOnce(jwksResponse(rsaPublicJwk, KID));
    const validator = new SpudValidator({
      apiKey: "sk-test",
      baseUrl: "https://api.test",
    });
    await validator.init();
    return validator;
  }

  // ── init() ────────────────────────────────────────────────────────

  describe("init()", () => {
    it("fetches JWKS on startup", async () => {
      fetchSpy.mockResolvedValueOnce(jwksResponse(rsaPublicJwk, KID));

      const validator = new SpudValidator({
        apiKey: "sk-test",
        baseUrl: "https://api.test",
      });
      await validator.init();

      expect(fetchSpy).toHaveBeenCalledWith(
        "https://api.test/.well-known/jwks.json",
      );
    });

    it("throws SpudError when JWKS fetch fails", async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response("Not Found", { status: 404 }),
      );

      const validator = new SpudValidator({
        apiKey: "sk-test",
        baseUrl: "https://api.test",
      });

      await expect(validator.init()).rejects.toThrow("Failed to fetch JWKS");
    });

    it("strips trailing slashes from baseUrl", async () => {
      fetchSpy.mockResolvedValueOnce(jwksResponse(rsaPublicJwk, KID));

      const validator = new SpudValidator({
        apiKey: "sk-test",
        baseUrl: "https://api.test///",
      });
      await validator.init();

      expect(fetchSpy).toHaveBeenCalledWith(
        "https://api.test/.well-known/jwks.json",
      );
    });
  });

  // ── validateToken() ───────────────────────────────────────────────

  describe("validateToken()", () => {
    it("validates a properly signed JWT and returns claims", async () => {
      const validator = await createValidator();
      const token = await signJwt(VALID_CLAIMS, KID, rsaKeyPair.privateKey);

      const claims = await validator.validateToken(token);

      expect(claims.tenant_id).toBe("tenant-abc");
      expect(claims.profile).toBe("production");
      expect(claims.permissions).toEqual(["tool:read", "tool:write"]);
      expect(claims.scope).toBe("agent");
      expect(claims.event_id).toBe("evt-123");
      expect(claims.sub).toBe("agent-456");
    });

    it("rejects a JWT with invalid format (not 3 parts)", async () => {
      const validator = await createValidator();

      await expect(
        validator.validateToken("not.a.valid.jwt.token"),
      ).rejects.toThrow("Invalid JWT format");
    });

    it("rejects a JWT with missing kid in header", async () => {
      const validator = await createValidator();
      const header = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
      const payload = base64UrlEncode(JSON.stringify(VALID_CLAIMS));
      const fakeToken = `${header}.${payload}.fakesig`;

      await expect(
        validator.validateToken(fakeToken),
      ).rejects.toThrow("JWT missing kid or alg");
    });

    it("rejects a JWT with invalid signature", async () => {
      const validator = await createValidator();

      // Generate a different key pair and sign with that
      const otherKeyPair = await crypto.subtle.generateKey(
        {
          name: "RSASSA-PKCS1-v1_5",
          modulusLength: 2048,
          publicExponent: new Uint8Array([1, 0, 1]),
          hash: "SHA-256",
        },
        true,
        ["sign", "verify"],
      );
      const token = await signJwt(VALID_CLAIMS, KID, otherKeyPair.privateKey);

      await expect(
        validator.validateToken(token),
      ).rejects.toThrow("Invalid JWT signature");
    });

    it("rejects an expired JWT", async () => {
      const validator = await createValidator();
      const expiredClaims = {
        ...VALID_CLAIMS,
        exp: Math.floor(Date.now() / 1000) - 60, // expired 1 minute ago
      };
      const token = await signJwt(expiredClaims, KID, rsaKeyPair.privateKey);

      await expect(
        validator.validateToken(token),
      ).rejects.toThrow("JWT has expired");
    });

    it("rejects a JWT signed with unknown kid", async () => {
      const validator = await createValidator();

      // Mock the JWKS refresh (will return the same JWKS without the unknown kid)
      fetchSpy.mockResolvedValueOnce(jwksResponse(rsaPublicJwk, KID));

      const token = await signJwt(
        VALID_CLAIMS,
        "unknown-kid",
        rsaKeyPair.privateKey,
      );

      await expect(
        validator.validateToken(token),
      ).rejects.toThrow("Signing key not found: unknown-kid");
    });

    it("refreshes JWKS cache on unknown kid before failing", async () => {
      const validator = await createValidator();

      // Return JWKS with the new kid on refresh
      const newKid = "rotated-key-2";
      fetchSpy.mockResolvedValueOnce(jwksResponse(rsaPublicJwk, newKid));

      const token = await signJwt(VALID_CLAIMS, newKid, rsaKeyPair.privateKey);
      const claims = await validator.validateToken(token);

      expect(claims.tenant_id).toBe("tenant-abc");
      // The second fetch call is the JWKS refresh
      expect(fetchSpy).toHaveBeenCalledTimes(2); // init + refresh
    });
  });

  // ── validate() (Web API Request) ──────────────────────────────────

  describe("validate()", () => {
    it("extracts X-Spud-Token from Request headers and validates", async () => {
      const validator = await createValidator();
      const token = await signJwt(VALID_CLAIMS, KID, rsaKeyPair.privateKey);

      const request = new Request("https://example.com/api/tool", {
        headers: { "X-Spud-Token": token },
      });

      const claims = await validator.validate(request);
      expect(claims.tenant_id).toBe("tenant-abc");
    });

    it("throws MISSING_TOKEN when X-Spud-Token header is absent", async () => {
      const validator = await createValidator();
      const request = new Request("https://example.com/api/tool");

      await expect(validator.validate(request)).rejects.toThrow(
        "Missing X-Spud-Token header",
      );

      try {
        await validator.validate(request);
      } catch (err) {
        expect((err as SpudError).code).toBe("MISSING_TOKEN");
        expect((err as SpudError).statusCode).toBe(401);
      }
    });
  });

  // ── middleware() (Express-compatible) ──────────────────────────────

  describe("middleware()", () => {
    function mockRes() {
      const res = {
        _status: 0,
        _body: null as unknown,
        status(code: number) {
          res._status = code;
          return res;
        },
        json(body: unknown) {
          res._body = body;
        },
      };
      return res;
    }

    it("sets req.spud and calls next() on valid token", async () => {
      const validator = await createValidator();
      const token = await signJwt(VALID_CLAIMS, KID, rsaKeyPair.privateKey);
      const mw = validator.middleware();

      const req: SpudRequest = { headers: { "x-spud-token": token } };
      const res = mockRes();
      const next = vi.fn();

      // Middleware is async internally via .then()
      await new Promise<void>((resolve) => {
        mw(req, res, () => {
          next();
          resolve();
        });
      });

      expect(next).toHaveBeenCalled();
      expect(req.spud).toBeDefined();
      expect(req.spud!.tenant_id).toBe("tenant-abc");
      expect(req.spud!.permissions).toEqual(["tool:read", "tool:write"]);
    });

    it("returns 401 when X-Spud-Token header is missing", async () => {
      const validator = await createValidator();
      const mw = validator.middleware();

      const req: SpudRequest = { headers: {} };
      const res = mockRes();
      const next = vi.fn();

      mw(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(401);
      expect((res._body as Record<string, unknown>).code).toBe("MISSING_TOKEN");
    });

    it("returns 401 on invalid token", async () => {
      const validator = await createValidator();
      const mw = validator.middleware();

      const req: SpudRequest = { headers: { "x-spud-token": "bad.token.here" } };
      const res = mockRes();
      const next = vi.fn();

      // Wait for async validation to settle
      await new Promise<void>((resolve) => {
        const origJson = res.json.bind(res);
        res.json = (body: unknown) => {
          origJson(body);
          resolve();
        };
        mw(req, res, next);
      });

      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(401);
    });

    it("handles array header values (Express multi-value headers)", async () => {
      const validator = await createValidator();
      const token = await signJwt(VALID_CLAIMS, KID, rsaKeyPair.privateKey);
      const mw = validator.middleware();

      const req: SpudRequest = { headers: { "x-spud-token": [token] } };
      const res = mockRes();
      const next = vi.fn();

      await new Promise<void>((resolve) => {
        mw(req, res, () => {
          next();
          resolve();
        });
      });

      expect(next).toHaveBeenCalled();
      expect(req.spud!.tenant_id).toBe("tenant-abc");
    });
  });

  // ── JWKS caching ──────────────────────────────────────────────────

  describe("JWKS caching", () => {
    it("uses cached JWKS within TTL", async () => {
      const validator = await createValidator();
      const token1 = await signJwt(VALID_CLAIMS, KID, rsaKeyPair.privateKey);
      const token2 = await signJwt(
        { ...VALID_CLAIMS, event_id: "evt-456" },
        KID,
        rsaKeyPair.privateKey,
      );

      await validator.validateToken(token1);
      await validator.validateToken(token2);

      // Only 1 JWKS fetch — the init() call (subsequent use cache)
      const jwksCalls = fetchSpy.mock.calls.filter(
        (c) => (c[0] as string).includes("jwks.json"),
      );
      expect(jwksCalls.length).toBe(1);
    });
  });

  // ── Unsupported algorithm ─────────────────────────────────────────

  describe("unsupported algorithm", () => {
    it("rejects JWT with unsupported algorithm", async () => {
      const validator = await createValidator();

      // Craft a JWT header with unsupported alg
      const header = base64UrlEncode(
        JSON.stringify({ alg: "HS256", typ: "JWT", kid: KID }),
      );
      const payload = base64UrlEncode(JSON.stringify(VALID_CLAIMS));
      const fakeToken = `${header}.${payload}.fakesig`;

      await expect(
        validator.validateToken(fakeToken),
      ).rejects.toThrow("Unsupported JWT algorithm");
    });
  });
});
