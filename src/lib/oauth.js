export const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
export const REFRESH_KEY = "google_refresh_token";
export const ACCESS_KEY = "google_access_token";

const STATE_COOKIE = "cal_oauth_state";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";

export function handleStart(request, env) {
  if (request.method.toUpperCase() !== "GET") return methodNotAllowed();
  if (blank(env.GOOGLE_CLIENT_ID) || blank(env.GOOGLE_CLIENT_SECRET)) {
    return jsonError("Google Calendar settings are incomplete.", 400);
  }
  const state = randomState();
  const redirectUri = callbackUrl(request);
  const url = new URL(AUTH_URL);
  url.searchParams.set("client_id", String(env.GOOGLE_CLIENT_ID).trim());
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", CALENDAR_SCOPE);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", state);
  const secure = new URL(request.url).protocol === "https:";
  return redirect(url.toString(), [stateCookie(state, secure)]);
}

export async function handleCallback(request, env, fetchImpl = fetch) {
  if (request.method.toUpperCase() !== "GET") return methodNotAllowed();
  const secure = new URL(request.url).protocol === "https:";
  const incoming = new URL(request.url);
  const state = incoming.searchParams.get("state") || "";
  const expected = readCookie(request, STATE_COOKIE);
  const clear = clearStateCookie(secure);
  if (!safeEqual(state, expected) || !/^[a-f0-9]{64}$/.test(state)) {
    return redirect(doneUrl(request, "error"), [clear]);
  }
  if (incoming.searchParams.get("error") || !incoming.searchParams.get("code")) {
    return redirect(doneUrl(request, "error"), [clear]);
  }
  if (!env.CAL_KV || typeof env.CAL_KV.put !== "function") {
    return jsonError("Calendar storage is not configured.", 500, [clear]);
  }
  if (blank(env.GOOGLE_CLIENT_ID) || blank(env.GOOGLE_CLIENT_SECRET)) {
    return jsonError("Google Calendar settings are incomplete.", 400, [clear]);
  }
  let tokens;
  try {
    tokens = await exchangeCode(request, env, incoming.searchParams.get("code"), fetchImpl);
  } catch {
    console.log(JSON.stringify({ level: "error", message: "calendar_connect_failed" }));
    return redirect(doneUrl(request, "error"), [clear]);
  }
  if (!tokens.refreshToken || !scopeIsCalendarReadonly(tokens.scope)) {
    console.log(JSON.stringify({ level: "error", message: "calendar_connect_rejected" }));
    return redirect(doneUrl(request, "error"), [clear]);
  }
  await env.CAL_KV.put(REFRESH_KEY, tokens.refreshToken);
  if (typeof env.CAL_KV.delete === "function") await env.CAL_KV.delete(ACCESS_KEY);
  return redirect(doneUrl(request, "connected"), [clear]);
}

export async function readRefreshToken(env) {
  if (env && env.CAL_KV && typeof env.CAL_KV.get === "function") {
    const stored = await env.CAL_KV.get(REFRESH_KEY);
    if (!blank(stored)) return String(stored).trim();
  }
  if (env && !blank(env.GOOGLE_REFRESH_TOKEN)) return String(env.GOOGLE_REFRESH_TOKEN).trim();
  return "";
}

export async function getAccessToken(env, fetchImpl = fetch) {
  if (env.CAL_KV && typeof env.CAL_KV.get === "function") {
    const cached = await env.CAL_KV.get(ACCESS_KEY);
    if (!blank(cached)) return String(cached).trim();
  }
  const refreshToken = await readRefreshToken(env);
  if (!refreshToken) throw new Error("Calendar is not connected yet.");
  const fresh = await requestAccessToken(env, refreshToken, fetchImpl);
  const ttl = accessTtl(fresh.expiresIn);
  if (env.CAL_KV && typeof env.CAL_KV.put === "function" && ttl >= 60) {
    try {
      await env.CAL_KV.put(ACCESS_KEY, fresh.accessToken, { expirationTtl: ttl });
    } catch {
      // This request can still use the token it just received.
    }
  }
  return fresh.accessToken;
}

export function accessTtl(expiresIn) {
  const seconds = Number(expiresIn);
  if (!Number.isFinite(seconds)) return 0;
  const safe = Math.floor(seconds) - 60;
  if (safe < 60) return 0;
  return Math.min(safe, 15 * 60);
}

async function exchangeCode(request, env, code, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(TOKEN_URL, {
      method: "POST",
      redirect: "error",
      referrerPolicy: "no-referrer",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        code: String(code),
        client_id: String(env.GOOGLE_CLIENT_ID).trim(),
        client_secret: String(env.GOOGLE_CLIENT_SECRET).trim(),
        redirect_uri: callbackUrl(request),
        grant_type: "authorization_code",
      }),
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw new Error("Google authorization failed.");
  }
  if (!response.ok) {
    try { await response.text(); } catch { /* discard */ }
    throw new Error("Google authorization failed.");
  }
  const payload = await response.json();
  return {
    refreshToken: payload && payload.refresh_token ? String(payload.refresh_token) : "",
    accessToken: payload && payload.access_token ? String(payload.access_token) : "",
    scope: payload && payload.scope ? String(payload.scope) : "",
  };
}

export function scopeIsCalendarReadonly(scope) {
  if (typeof scope !== "string") return false;
  const parts = scope.split(/\s+/).filter(Boolean);
  return parts.length === 1 && parts[0] === CALENDAR_SCOPE;
}

async function requestAccessToken(env, refreshToken, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(TOKEN_URL, {
      method: "POST",
      redirect: "error",
      referrerPolicy: "no-referrer",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        client_id: String(env.GOOGLE_CLIENT_ID).trim(),
        client_secret: String(env.GOOGLE_CLIENT_SECRET).trim(),
        refresh_token: refreshToken,
        grant_type: "refresh_token",
        scope: CALENDAR_SCOPE,
      }),
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw new Error("Google authorization failed.");
  }
  if (!response.ok) {
    try { await response.text(); } catch { /* discard */ }
    throw new Error("Google authorization failed.");
  }
  const payload = await response.json();
  if (!payload || !payload.access_token) throw new Error("Google authorization failed.");
  return {
    accessToken: String(payload.access_token),
    expiresIn: Number(payload.expires_in),
  };
}

function callbackUrl(request) {
  return `${new URL(request.url).origin}/auth/callback`;
}

function doneUrl(request, result) {
  const url = new URL("/", request.url);
  url.searchParams.set("calendar", result);
  return url.toString();
}

function randomState() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function stateCookie(state, secure) {
  const bits = [
    `${STATE_COOKIE}=${state}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/auth",
    "Max-Age=600",
  ];
  if (secure) bits.push("Secure");
  return bits.join("; ");
}

function clearStateCookie(secure) {
  const bits = [
    `${STATE_COOKIE}=`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/auth",
    "Max-Age=0",
  ];
  if (secure) bits.push("Secure");
  return bits.join("; ");
}

function readCookie(request, name) {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return "";
    }
  }
  return "";
}

function safeEqual(left, right) {
  const a = new TextEncoder().encode(String(left));
  const b = new TextEncoder().encode(String(right));
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

function redirect(location, cookies) {
  const headers = new Headers({
    location,
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
  });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(null, { status: 302, headers });
}

function jsonError(error, status, cookies = []) {
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(JSON.stringify({ ok: false, error }), { status, headers });
}

function methodNotAllowed() {
  return jsonError("Method not allowed.", 405);
}

function blank(value) {
  return value == null || String(value).trim() === "";
}
