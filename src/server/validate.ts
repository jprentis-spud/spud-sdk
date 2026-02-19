import type { webcrypto } from "node:crypto";
import { SpudError } from "../types.js";
import type {
  SpudClaims,
  SpudRequest,
  SpudResponse,
  SpudServerConfig,
} from "../types.js";

const DEFAULT_BASE_URL = "https://api.spud.dev";
const DEFAULT_JWKS_CACHE_TTL_MS = 3_600_000; // 1 hour

// ── JWKS types ────────────────────────────────────────────────────────

interface JwksKey {
  kty: string;
  kid: string;
  alg: string;
  use?: string;
  // RSA fields
  n?: string;
  e?: string;
  // EC fields
  crv?: string;
  x?: string;
  y?: string;
}

interface Jwks {
  keys: JwksKey[];
}

// ── Validator ─────────────────────────────────────────────────────────

/**
 * JWT validator — the "Braces" side of Belt and Braces.
 *
 * Fetches JWKS from the Spud platform, validates inbound JWT signatures,
 * checks expiry, and exposes decoded claims.
 *
 * Works with Express, Hono, or any HTTP framework:
 * - `validateToken(token)` — lowest-level, validate any JWT string
 * - `validate(request)` — Web API Request (Hono, Bun, Deno, Workers)
 * - `middleware()` — Express/Connect-compatible middleware
 */
export class SpudValidator {
  private readonly baseUrl: string;
  private readonly jwksCacheTtlMs: number;
  private jwksCache: Jwks | null = null;
  private jwksCachedAt = 0;
  private readonly cryptoKeyCache = new Map<string, CryptoKey>();

  constructor(config: SpudServerConfig) {
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.jwksCacheTtlMs = config.jwksCacheTtlMs ?? DEFAULT_JWKS_CACHE_TTL_MS;
  }

  /** Fetch JWKS eagerly on startup to fail fast if unreachable. */
  async init(): Promise<void> {
    await this.fetchJwks();
  }

  // ── Public API ──────────────────────────────────────────────────────

  /**
   * Validate a raw JWT string and return decoded claims.
   * Verifies signature against JWKS and checks expiry.
   */
  async validateToken(token: string): Promise<SpudClaims> {
    const parts = token.split(".");
    if (parts.length !== 3) {
      throw new SpudError("Invalid JWT format", "INVALID_JWT");
    }

    const [headerB64, payloadB64, signatureB64] = parts;

    // Decode header to get kid + alg
    let header: Record<string, unknown>;
    try {
      header = JSON.parse(base64UrlDecode(headerB64));
    } catch {
      throw new SpudError("Invalid JWT header encoding", "INVALID_JWT");
    }
    const kid = header.kid as string | undefined;
    const alg = header.alg as string | undefined;

    if (!kid || !alg) {
      throw new SpudError(
        "JWT missing kid or alg in header",
        "INVALID_JWT",
      );
    }

    // Look up signing key from JWKS
    const key = await this.getSigningKey(kid, alg);

    // Verify signature
    const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    const signature = base64UrlToArrayBuffer(signatureB64);
    const algParams = getVerifyParams(alg);
    const valid = await crypto.subtle.verify(algParams, key, signature, data);

    if (!valid) {
      throw new SpudError("Invalid JWT signature", "INVALID_SIGNATURE");
    }

    // Decode and validate claims
    const claims = JSON.parse(base64UrlDecode(payloadB64)) as SpudClaims;
    const now = Math.floor(Date.now() / 1000);

    if (claims.exp !== undefined && claims.exp < now) {
      throw new SpudError("JWT has expired", "TOKEN_EXPIRED");
    }

    return claims;
  }

  /**
   * Validate from a Web API Request — extracts the `X-Spud-Token` header.
   * Works with Hono, Bun, Deno, Cloudflare Workers, and Node 18+.
   */
  async validate(request: Request): Promise<SpudClaims> {
    const token = request.headers.get("x-spud-token");
    if (!token) {
      throw new SpudError(
        "Missing X-Spud-Token header",
        "MISSING_TOKEN",
        401,
      );
    }
    return this.validateToken(token);
  }

  /**
   * Express/Connect-compatible middleware.
   *
   * On success, sets `req.spud` with decoded claims and calls `next()`.
   * On failure, responds with 401 JSON error.
   */
  middleware(): (
    req: SpudRequest,
    res: SpudResponse,
    next: () => void,
  ) => void {
    return (req: SpudRequest, res: SpudResponse, next: () => void) => {
      const raw = req.headers["x-spud-token"];
      const token = typeof raw === "string"
        ? raw
        : Array.isArray(raw) ? raw[0] : undefined;

      if (!token) {
        res
          .status(401)
          .json({ error: "Missing X-Spud-Token header", code: "MISSING_TOKEN" });
        return;
      }

      this.validateToken(token).then(
        (claims) => {
          req.spud = claims;
          next();
        },
        (err: unknown) => {
          if (err instanceof SpudError) {
            res.status(401).json({ error: err.message, code: err.code });
          } else {
            res
              .status(500)
              .json({ error: "Internal validation error" });
          }
        },
      );
    };
  }

  // ── JWKS management (private) ──────────────────────────────────────

  private async fetchJwks(): Promise<Jwks> {
    const now = Date.now();
    if (this.jwksCache && now - this.jwksCachedAt < this.jwksCacheTtlMs) {
      return this.jwksCache;
    }

    const res = await fetch(`${this.baseUrl}/.well-known/jwks.json`);
    if (!res.ok) {
      throw new SpudError(
        `Failed to fetch JWKS: ${res.status} ${res.statusText}`,
        "JWKS_FETCH_FAILED",
        res.status,
      );
    }

    this.jwksCache = (await res.json()) as Jwks;
    this.jwksCachedAt = now;
    this.cryptoKeyCache.clear();
    return this.jwksCache;
  }

  private async getSigningKey(kid: string, alg: string): Promise<CryptoKey> {
    const cached = this.cryptoKeyCache.get(kid);
    if (cached) return cached;

    let jwks = await this.fetchJwks();
    let jwk = jwks.keys.find((k) => k.kid === kid);

    if (!jwk) {
      // Force refresh in case of key rotation
      this.jwksCachedAt = 0;
      jwks = await this.fetchJwks();
      jwk = jwks.keys.find((k) => k.kid === kid);
    }

    if (!jwk) {
      throw new SpudError(
        `Signing key not found: ${kid}`,
        "KEY_NOT_FOUND",
      );
    }

    const key = await importJwk(jwk, alg);
    this.cryptoKeyCache.set(kid, key);
    return key;
  }
}

// ── JWT / JWKS helpers ───────────────────────────────────────────────

function base64UrlDecode(str: string): string {
  const padded = str + "=".repeat((4 - (str.length % 4)) % 4);
  const base64 = padded.replace(/-/g, "+").replace(/_/g, "/");
  return atob(base64);
}

function base64UrlToArrayBuffer(str: string): ArrayBuffer {
  const binary = base64UrlDecode(str);
  const buf = new ArrayBuffer(binary.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < binary.length; i++) {
    view[i] = binary.charCodeAt(i);
  }
  return buf;
}

function getVerifyParams(alg: string) {
  switch (alg) {
    case "RS256":
      return { name: "RSASSA-PKCS1-v1_5" } as const;
    case "ES256":
      return { name: "ECDSA", hash: "SHA-256" } as const;
    default:
      throw new SpudError(
        `Unsupported JWT algorithm: ${alg}`,
        "UNSUPPORTED_ALG",
      );
  }
}

function getImportParams(alg: string) {
  switch (alg) {
    case "RS256":
      return { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;
    case "ES256":
      return { name: "ECDSA", namedCurve: "P-256" } as const;
    default:
      throw new SpudError(
        `Unsupported JWT algorithm: ${alg}`,
        "UNSUPPORTED_ALG",
      );
  }
}

async function importJwk(jwk: JwksKey, alg: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "jwk",
    jwk as webcrypto.JsonWebKey,
    getImportParams(alg),
    false,
    ["verify"],
  );
}
