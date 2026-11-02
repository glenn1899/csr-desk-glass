const JWT_HEADER = "Cf-Access-Jwt-Assertion";
const DEFAULT_ALLOWED_EMAIL = "glenn@oibc.ca";
const CERT_TTL_MS = 10 * 60 * 1000;
const CLOCK_SKEW_SEC = 60;
const MAX_TOKEN_LENGTH = 16_384;

const certCache = new Map();

export function clearAccessCertCache() {
  certCache.clear();
}

export async function verifyAccessJwt(request, env, options = {}) {
  const headerToken = jwtFromHeader(request);
  const cookie = authorizationCookie(request);
  const access = options.ctx && options.ctx.access;
  const presence = {
    ctx: Boolean(access),
    header: Boolean(headerToken),
    cookie: cookie.present,
  };
  let used = "none";
  let ok = false;
  try {
    if (access) {
      used = "ctx";
      ok = await identityFromContext(access, env);
    } else if (headerToken) {
      used = "header";
      ok = await verifySignedToken(headerToken, env, options);
    } else if (cookie.token) {
      used = "cookie";
      ok = await verifySignedToken(cookie.token, env, options);
    }
  } catch {
    ok = false;
  }
  console.log(JSON.stringify({
    message: "access_check",
    ctx: presence.ctx,
    header: presence.header,
    cookie: presence.cookie,
    used: ok ? used : "none",
  }));
  return ok;
}

async function identityFromContext(access, env) {
  const expectedAud = configuredAud(env);
  if (!expectedAud || typeof access.getIdentity !== "function") return false;
  if (!audienceMatches(access.aud, expectedAud)) return false;
  const identity = await access.getIdentity();
  return emailAllowed(identity || {}, env);
}

async function verifySignedToken(token, env, options) {
  if (!token || token.length > MAX_TOKEN_LENGTH) return false;
  const team = configuredTeam(env);
  const expectedAud = configuredAud(env);
  if (!team || !expectedAud) return false;

  const parts = token.split(".");
  if (parts.length !== 3) return false;
  let header;
  let payload;
  try {
    header = decodeJson(parts[0]);
    payload = decodeJson(parts[1]);
  } catch {
    return false;
  }
  if (!header || header.alg !== "RS256" || !header.kid || typeof header.kid !== "string") return false;
  if (!payload || typeof payload !== "object") return false;

  const nowSec = Math.floor(((options.now instanceof Date ? options.now : new Date()).getTime()) / 1000);
  if (typeof payload.exp !== "number" || payload.exp < nowSec - CLOCK_SKEW_SEC) return false;
  if (typeof payload.nbf === "number" && payload.nbf > nowSec + CLOCK_SKEW_SEC) return false;
  const issuer = `https://${team}`;
  if (payload.iss !== issuer) return false;
  if (!audienceMatches(payload.aud, expectedAud)) return false;

  const jwk = await jwkForKid(team, header.kid, options.fetchImpl || fetch, nowSec * 1000);
  if (!jwk) return false;
  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256" },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    const signature = base64UrlToBytes(parts[2]);
    const signedOk = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, signed);
    return signedOk && emailAllowed(payload, env);
  } catch {
    return false;
  }
}

function jwtFromHeader(request) {
  const token = request.headers.get(JWT_HEADER);
  return token && token.trim() ? token.trim() : "";
}

function authorizationCookie(request) {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim().toLowerCase() !== "cf_authorization") continue;
    let raw = part.slice(eq + 1).trim();
    try {
      raw = decodeURIComponent(raw);
    } catch {
      return { present: true, token: "" };
    }
    return { present: true, token: raw.replace(/^"|"$/g, "") };
  }
  return { present: false, token: "" };
}

function configuredTeam(env) {
  const team = env && env.ACCESS_TEAM_DOMAIN ? String(env.ACCESS_TEAM_DOMAIN).trim() : "";
  if (!team || team.includes("/") || team.includes(" ")) return "";
  return team;
}

function configuredAud(env) {
  return env && env.ACCESS_AUD ? String(env.ACCESS_AUD).trim() : "";
}

function emailAllowed(payload, env) {
  const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
  if (!email) return false;
  const configured = env && env.ALLOWED_EMAIL != null && String(env.ALLOWED_EMAIL).trim()
    ? String(env.ALLOWED_EMAIL).trim()
    : DEFAULT_ALLOWED_EMAIL;
  return email === configured.toLowerCase();
}

async function jwkForKid(team, kid, fetchImpl, nowMs) {
  let entry = certCache.get(team);
  if (entry && entry.expires > nowMs && entry.keys.has(kid)) return entry.keys.get(kid);
  let response;
  try {
    response = await fetchImpl(`https://${team}/cdn-cgi/access/certs`, {
      method: "GET",
      redirect: "error",
      referrerPolicy: "no-referrer",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    return null;
  }
  if (!response || !response.ok) return null;
  const body = await response.json();
  if (!entry || entry.expires <= nowMs) {
    entry = { expires: nowMs + CERT_TTL_MS, keys: new Map() };
    certCache.set(team, entry);
  }
  const list = body && Array.isArray(body.keys) ? body.keys : [];
  for (const jwk of list) {
    if (!jwk || jwk.kty !== "RSA" || !jwk.kid || !jwk.n || !jwk.e) continue;
    entry.keys.set(String(jwk.kid), jwk);
  }
  return entry.keys.get(kid) || null;
}

function audienceMatches(aud, expected) {
  if (typeof aud === "string") return aud === expected;
  if (Array.isArray(aud)) return aud.some((item) => item === expected);
  return false;
}

function decodeJson(segment) {
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(segment)));
}

function base64UrlToBytes(value) {
  const padded = String(value).replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  const binary = atob(padded + pad);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
