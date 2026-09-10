/**
 * Clerk authentication middleware for the management dashboard.
 *
 * Two modes, selected by configuration:
 *
 *  - dev-open (no valid CLERK_SECRET_KEY): management routes behave as
 *    anonymous. GET /api/management/me returns {authenticated:false} and
 *    every other management route answers 401. Public GETs elsewhere are
 *    unaffected — they never pass through here.
 *
 *  - secured (valid CLERK_SECRET_KEY + publishable key): sessions are
 *    verified server-side by @clerk/express clerkMiddleware, which is
 *    mounted (in src/index.ts) on /api/management before this module's
 *    guards run. It attaches a branded req.auth FUNCTION; read sessions
 *    via getAuth() (see sessionUserId below), never req.auth directly.
 *
 * Key policy: the secret key (sk_) is server-only. The publishable key
 * (pk_) is public by design — it is the only Clerk value the frontend
 * ever receives (via the 401 body of GET /api/management/me).
 *
 * Admin policy: a single allowlist entry, ADMIN_CLERK_USER_ID (a Clerk
 * userId, format user_…). No IDs are hardcoded. The comparison is
 * constant-time. If ADMIN_CLERK_USER_ID is unset in secured mode, every
 * signed-in user is rejected — fail closed.
 */

import type { Request, RequestHandler } from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import { getAuth } from "@clerk/express";

/** The Clerk-related slice of the app Config. */
export interface ClerkAuthConfig {
  /** CLERK_SECRET_KEY — empty or malformed = dev-open mode. */
  clerkSecretKey: string;
  /** CLERK_PUBLISHABLE_KEY — pk_…, public. Empty = management auth off. */
  clerkPublishableKey: string;
  /** ADMIN_CLERK_USER_ID — the single admin allowlist entry. */
  adminClerkUserId: string;
}

/**
 * Syntactically plausible Clerk secret key (sk_…).
 * Anything else — empty string or a deploy placeholder like ROTATE_ME —
 * means dev-open mode: the Clerk middleware is never mounted and no
 * session can exist.
 */
export function isClerkSecretKey(key: string): boolean {
  return /^sk_[A-Za-z0-9_-]{10,}$/.test(key);
}

/** Management auth is active: valid-format secret key + publishable key. */
export function clerkEnabled(cfg: ClerkAuthConfig): boolean {
  return isClerkSecretKey(cfg.clerkSecretKey) && cfg.clerkPublishableKey !== "";
}

/**
 * Clerk Frontend API origin (https://<slug>.clerk.accounts.dev) derived
 * from a publishable key at runtime — no hardcoded domains.
 *
 * This is Clerk's own key encoding (see @clerk/shared parsePublishableKey
 * / keys.mjs, which clerk-js also uses to pick its FAPI host when no
 * proxy URL is set): the segment after pk_test_/pk_live_ is the base64
 * encoding of "<frontendApi>$".
 *
 * Validation mirrors the SDK's isValidDecodedPublishableKey: the decoded
 * value must end with exactly one '$' (at the last position) and contain
 * a dot. Malformed keys return null — callers fail closed (no CSP
 * origin, no script URL) rather than guessing.
 */
export function clerkFapiOrigin(publishableKey: string): string | null {
  const match = /^pk_(?:test|live)_([A-Za-z0-9_-]+)$/.exec(publishableKey);
  if (!match) return null;

  // Node's "base64" decoder also accepts the URL-safe alphabet ('-' and
  // '_') and never throws — it skips invalid chars. Malformed segments
  // fail the '$'/dot validation below.
  const decoded = Buffer.from(match[1], "base64").toString("utf8");

  if (!decoded.endsWith("$") || decoded.indexOf("$") !== decoded.length - 1) {
    return null; // must be exactly one '$', at the end
  }
  const host = decoded.slice(0, -1);
  if (!host.includes(".")) return null;
  return `https://${host}`;
}

/**
 * helmet CSP directives allowing Clerk's Frontend API origin — added on
 * top of helmet's defaults when management auth is configured:
 *
 *   script-src  — clerk-js + @clerk/ui browser bundles load from the
 *                 FAPI origin (public/app.js loadClerkJs)
 *   connect-src — clerk-js fetch/XHR to the FAPI origin
 *   frame-src   — the Clerk sign-in modal iframe is hosted on the FAPI
 *                 origin
 *
 * Returns {} (helmet's stock defaults, byte-for-byte unchanged) when
 * Clerk is not configured (dev-open) or the key is malformed — the
 * dashboard itself never needs these; only the sign-in flow does.
 * No 'unsafe-inline', no wildcards, no hardcoded domains.
 */
export function clerkCspDirectives(cfg: ClerkAuthConfig): Record<string, string[]> {
  if (!clerkEnabled(cfg)) return {};
  const origin = clerkFapiOrigin(cfg.clerkPublishableKey);
  if (!origin) return {};
  return {
    "script-src": ["'self'", origin],
    "connect-src": ["'self'", origin],
    "frame-src": ["'self'", origin],
  };
}

/**
 * Session userId, read via the SDK's getAuth() rather than req.auth
 * directly: clerkMiddleware attaches req.auth as a branded FUNCTION
 * (req.auth(opts) returns the AuthObject), so req.auth?.userId was
 * always undefined (fleet-ops-r7j). getAuth() is the sanctioned reader.
 *
 * Defensive fallback: when req.auth is not a branded function
 * (middleware not mounted — dev-open mode, or a stub lacking the
 * brand), getAuth() throws; treat that as "no session".
 */
export function sessionUserId(req: Request): string | null {
  let auth: { userId: string | null };
  try {
    auth = getAuth(req);
  } catch {
    return null; // clerkMiddleware not in the chain: no session exists
  }
  return auth.userId ?? null;
}

/**
 * Attach a Clerk-shaped req.auth to a request: the same branded
 * function clerkMiddleware produces (see @clerk/express
 * brandRequestAuth). Exported so tests stub the REAL middleware shape
 * instead of inventing one — the brand symbol is Symbol.for-registered
 * globally by the SDK precisely so stubs and SDK interoperate.
 *
 * The returned AuthObject mirrors the SDK's signed-in shape: real
 * getAuth() pipes it through getAuthObjectForAcceptedToken, which
 * REQUIRES tokenType:"session_token" to accept the session (a bare
 * {userId} is rejected as signed-out). Signed-out stubs carry
 * userId:null, matching signedOutAuthObject.
 */
export function attachStubAuth(req: Request, userId: string | null): void {
  const clerkAuthBrand = Symbol.for("@clerk/express.auth");
  const handler = Object.assign(
    userId ? () => ({ userId, tokenType: "session_token" }) : () => ({ userId: null }),
    { [clerkAuthBrand]: true },
  );
  (req as Request & { auth?: unknown }).auth = handler;
}

/**
 * Constant-time string equality.
 * Both sides are hashed to a fixed length first so timingSafeEqual never
 * throws on length mismatch and no length information leaks.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** True when the session user is the configured admin (allowlist of one). */
export function isAdminUser(userId: string, cfg: ClerkAuthConfig): boolean {
  if (!cfg.adminClerkUserId || !userId) return false;
  return constantTimeEquals(userId, cfg.adminClerkUserId);
}

/**
 * Require a verified Clerk session. 401 otherwise.
 * In dev-open mode no session can exist, so this always answers 401.
 */
export function requireClerkUser(cfg: ClerkAuthConfig): RequestHandler {
  return (req, res, next) => {
    if (!clerkEnabled(cfg)) {
      res.status(401).json({ authenticated: false, clerkConfigured: false });
      return;
    }
    const userId = sessionUserId(req);
    if (!userId) {
      res.status(401).json({
        authenticated: false,
        clerkConfigured: true,
        publishableKey: cfg.clerkPublishableKey,
      });
      return;
    }
    next();
  };
}

/**
 * Require the session user to be the configured admin.
 * Requires a session first (requireClerkUser), then a constant-time
 * allowlist match on ADMIN_CLERK_USER_ID. Signed-in non-admins get
 * 403 {error:"forbidden"}; everyone without a session gets 401.
 */
export function requireAdmin(cfg: ClerkAuthConfig): RequestHandler {
  const requireUser = requireClerkUser(cfg);
  return (req, res, next) => {
    requireUser(req, res, () => {
      const userId = sessionUserId(req);
      if (!userId) return; // requireUser already answered 401
      if (!isAdminUser(userId, cfg)) {
        res.status(403).json({ error: "forbidden", authenticated: true });
        return;
      }
      next();
    });
  };
}
