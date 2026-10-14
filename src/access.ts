// Who gets in, and who they are. One of four modes (ACCESS_MODE), checked for the page's voice connection and for
// every file it fetches (sounds, pictures, icons):
//
//   cloudflare-access  (recommended) WebTS sits behind a Cloudflare Access application. Access adds a signed token
//                      (Cf-Access-Jwt-Assertion) to every request; the bridge checks the token's signature against
//                      the team's public keys, its audience (CF_ACCESS_AUD) and its expiry, so a request that didn't
//                      come through Access is refused even if someone finds the bridge's own address.
//   header             Behind another login proxy (Authelia, oauth2-proxy, Authentik...) that puts the user name in a
//                      header (ACCESS_HEADER, default Remote-User). The bridge trusts that header, so it must only be
//                      reachable through the proxy.
//   public             Anyone with the address. Each browser gets its own TeamSpeak identity, remembered in a cookie.
//                      Needs I_UNDERSTAND_THIS_IS_PUBLIC=true.
//   signed-note        For your own gateway: it signs { id, name, exp } with ACCESS_NOTE_SECRET (HMAC-SHA256) into a
//                      header (ACCESS_NOTE_HEADER). See README.
//
// A person is { key, name }: the key decides their TeamSpeak identity and saved settings (so it must stay the same
// for them), the name is the default nickname.

import crypto from "crypto";
import type { IncomingMessage, ServerResponse } from "http";
import type { Config } from "./config.js";

export interface Person {
  key: string;
  name: string;
}

export const PUBLIC_COOKIE = "webts_id";

export function cookieValue(header: string | undefined, name: string): string | null {
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

const header = (req: IncomingMessage, name: string): string => {
  const v = req.headers[name];
  return (Array.isArray(v) ? v[0] : v || "").trim();
};

// A display name from an email address or a user name: the part before @, at most 30 characters.
export function nameFrom(value: string): string {
  return value.split("@")[0].replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 30) || "Guest";
}

// --- signed-note ---
export function signNote(person: { id: number; name: string }, secret: string, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ id: person.id, name: person.name, exp: now + 60_000 })).toString("base64url");
  return `${payload}.${crypto.createHmac("sha256", secret).update(payload).digest("base64url")}`;
}

export function verifyNote(note: string, secret: string, now = Date.now()): Person | null {
  if (!secret || !note || note.length > 2000) return null;
  const [payload, sig] = note.split(".");
  if (!payload || !sig) return null;
  const expected = Buffer.from(crypto.createHmac("sha256", secret).update(payload).digest("base64url"));
  const given = Buffer.from(sig);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!Number.isInteger(data.id) || data.id <= 0 || typeof data.exp !== "number" || data.exp < now) return null;
    return { key: `user:${data.id}`, name: nameFrom(String(data.name || "")) };
  } catch {
    return null;
  }
}

// --- cloudflare-access ---
interface Jwk { kid: string; kty: string; n: string; e: string; alg?: string }
let accessKeys: { keys: Map<string, crypto.KeyObject>; fetchedAt: number } | null = null;

async function accessKey(teamDomain: string, kid: string, fetchKeys = fetch): Promise<crypto.KeyObject | null> {
  const stale = !accessKeys || Date.now() - accessKeys.fetchedAt > 60 * 60 * 1000;
  if (stale || (!accessKeys!.keys.has(kid) && Date.now() - accessKeys!.fetchedAt > 60 * 1000)) {
    try {
      const res = await fetchKeys(`https://${teamDomain}/cdn-cgi/access/certs`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { keys?: Jwk[] };
      const keys = new Map<string, crypto.KeyObject>();
      for (const jwk of body.keys || []) {
        if (jwk.kty === "RSA" && jwk.kid) keys.set(jwk.kid, crypto.createPublicKey({ key: jwk as any, format: "jwk" }));
      }
      accessKeys = { keys, fetchedAt: Date.now() };
    } catch (e: any) {
      console.warn(`[Access] Couldn't fetch Cloudflare Access keys: ${e.message}`);
      if (!accessKeys) return null;
    }
  }
  return accessKeys!.keys.get(kid) ?? null;
}

export async function verifyAccessToken(token: string, teamDomain: string, aud: string,
  now = Date.now(), fetchKeys = fetch): Promise<Person | null> {
  const parts = token.split(".");
  if (parts.length !== 3 || token.length > 8192) return null;
  try {
    const head = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (head.alg !== "RS256" || typeof head.kid !== "string") return null;
    const key = await accessKey(teamDomain, head.kid, fetchKeys);
    if (!key) return null;
    const ok = crypto.verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], "base64url"));
    if (!ok) return null;
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.includes(aud)) return null;
    if (claims.iss !== `https://${teamDomain}`) return null;
    if (typeof claims.exp !== "number" || claims.exp * 1000 < now) return null;
    if (typeof claims.nbf === "number" && claims.nbf * 1000 > now + 60_000) return null;
    const who = String(claims.email || claims.common_name || claims.sub || "").toLowerCase();
    if (!who) return null;
    return { key: `cf:${who}`, name: nameFrom(who) };
  } catch {
    return null;
  }
}

// --- the check itself ---
export function createAccess(config: Config) {
  // public mode: the browser's own random id, set on the page's first load (and only by the bridge).
  const publicId = (req: IncomingMessage): string | null => {
    const id = cookieValue(header(req, "cookie"), PUBLIC_COOKIE);
    return id && /^[A-Za-z0-9_-]{22,64}$/.test(id) ? id : null;
  };

  return {
    mode: config.accessMode,

    async identify(req: IncomingMessage): Promise<Person | null> {
      switch (config.accessMode) {
        case "cloudflare-access": {
          const token = header(req, "cf-access-jwt-assertion") || cookieValue(header(req, "cookie"), "CF_Authorization") || "";
          return token ? verifyAccessToken(token, config.cfAccessTeamDomain, config.cfAccessAud) : null;
        }
        case "header": {
          const user = header(req, config.accessHeader);
          if (!user || user.length > 200) return null;
          const name = config.accessNameHeader ? header(req, config.accessNameHeader) : "";
          return { key: `hdr:${user.toLowerCase()}`, name: nameFrom(name || user) };
        }
        case "public": {
          const id = publicId(req);
          return id ? { key: `pub:${id}`, name: "Guest" } : null;
        }
        case "signed-note":
          return verifyNote(header(req, config.noteHeader), config.noteSecret);
      }
    },

    // public mode: give a browser its id when it loads the page (a year, only over this site, not readable by scripts).
    ensurePublicCookie(req: IncomingMessage, res: ServerResponse): void {
      if (config.accessMode !== "public" || publicId(req)) return;
      const secure = (config.publicUrl || "").startsWith("https://") || header(req, "x-forwarded-proto") === "https";
      const id = crypto.randomBytes(24).toString("base64url");
      res.setHeader("Set-Cookie", `${PUBLIC_COOKIE}=${id}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`);
    },
  };
}
