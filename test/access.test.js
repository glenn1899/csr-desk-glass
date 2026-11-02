import assert from "node:assert/strict";
import test from "node:test";
import { clearAccessCertCache, verifyAccessJwt } from "../src/lib/access.js";
import { handleRequest } from "../src/index.js";

const TEAM = "dry-mud-91ba.cloudflareaccess.com";
const AUD = "f3e04809e143ccb2737c5becfe83dd36c5852415051eb808ff95e638974bdec5";
const ISSUER = `https://${TEAM}`;
const SITE = "https://csr-desk-glass.glenn-889.workers.dev";

function env(extra = {}) {
  return { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ...extra };
}

function bytesToBase64Url(bytes) {
  const list = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of list) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function signingKey(kid) {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  jwk.kid = kid;
  jwk.alg = "RS256";
  jwk.use = "sig";
  return { pair, jwk };
}

async function sign(pair, payload, kid, headerExtra = {}) {
  const header = bytesToBase64Url(new TextEncoder().encode(JSON.stringify({
    alg: "RS256",
    kid,
    typ: "JWT",
    ...headerExtra,
  })));
  const body = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const data = `${header}.${body}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    pair.privateKey,
    new TextEncoder().encode(data),
  );
  return `${data}.${bytesToBase64Url(signature)}`;
}

function claims(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: ISSUER,
    aud: AUD,
    exp: now + 3600,
    iat: now,
    email: "glenn@oibc.ca",
    marker: "TOKENMARKER",
    ...overrides,
  };
}

function certFetch(jwk, calls) {
  return async (url) => {
    calls.push(String(url));
    assert.equal(String(url), `${ISSUER}/cdn-cgi/access/certs`);
    return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
  };
}

test("a signed Access token for this team and audience is accepted", async () => {
  clearAccessCertCache();
  const { pair, jwk } = await signingKey("key-ok");
  const calls = [];
  const token = await sign(pair, claims({ aud: [AUD, "other-app"] }), "key-ok", {
    jku: "https://evil.example/certs",
  });
  const request = new Request(`${SITE}/api/events`, { headers: { "Cf-Access-Jwt-Assertion": token } });
  assert.equal(await verifyAccessJwt(request, env(), { fetchImpl: certFetch(jwk, calls) }), true);
  assert.equal(await verifyAccessJwt(request, env(), { fetchImpl: certFetch(jwk, calls) }), true);
  assert.deepEqual(calls, [`${ISSUER}/cdn-cgi/access/certs`]);
});

test("tokens with the wrong audience, issuer, expiry, or signature are rejected", async () => {
  clearAccessCertCache();
  const { pair, jwk } = await signingKey("key-bad");
  const fetchImpl = certFetch(jwk, []);
  const now = Math.floor(Date.now() / 1000);
  const wrongAud = await sign(pair, claims({ aud: "someone-else" }), "key-bad");
  const wrongIss = await sign(pair, claims({ iss: "https://evil.example" }), "key-bad");
  const expired = await sign(pair, claims({ exp: now - 120 }), "key-bad");
  const notYet = await sign(pair, claims({ nbf: now + 120 }), "key-bad");
  const good = await sign(pair, claims(), "key-bad");
  const tampered = `${good.slice(0, good.lastIndexOf("."))}${good.endsWith("a") ? "b" : "a"}`;
  for (const token of [wrongAud, wrongIss, expired, notYet, tampered, "not-a-jwt"]) {
    const request = new Request(`${SITE}/api/events`, { headers: { "Cf-Access-Jwt-Assertion": token } });
    assert.equal(await verifyAccessJwt(request, env(), { fetchImpl }), false);
  }
});

test("an unsigned token does not fetch certificates", async () => {
  clearAccessCertCache();
  let called = false;
  const header = bytesToBase64Url(new TextEncoder().encode(JSON.stringify({ alg: "none", kid: "key-ok" })));
  const body = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(claims())));
  const request = new Request(`${SITE}/api/events`, {
    headers: { "Cf-Access-Jwt-Assertion": `${header}.${body}.` },
  });
  assert.equal(await verifyAccessJwt(request, env(), { fetchImpl: async () => { called = true; return new Response("{}"); } }), false);
  assert.equal(called, false);
});

test("calendar and connect routes require a valid Access JWT", async () => {
  clearAccessCertCache();
  const { pair, jwk } = await signingKey("key-route");
  const token = await sign(pair, claims(), "key-route");
  const fetchImpl = certFetch(jwk, []);
  const denied = await handleRequest(new Request(`${SITE}/api/events`), env(), { fetchImpl });
  assert.equal(denied.status, 401);
  assert.equal(denied.headers.get("cache-control"), "private, no-store");
  assert.equal((await denied.json()).error, "Cloudflare Access is required.");

  const allowed = await handleRequest(new Request(`${SITE}/api/events`, {
    headers: { "Cf-Access-Jwt-Assertion": token },
  }), env(), { fetchImpl });
  assert.equal(allowed.status, 200);
  const body = await allowed.json();
  assert.equal(body.source, "sample");
  assert.equal(JSON.stringify(body).includes(token), false);
  assert.equal(JSON.stringify(body).includes("TOKENMARKER"), false);

  const start = await handleRequest(new Request(`${SITE}/auth/start`, {
    headers: {
      "Cf-Access-Jwt-Assertion": token,
      "Cf-Access-Authenticated-User-Email": "other@example.com",
    },
  }), env({
    GOOGLE_CLIENT_ID: "client-id",
    GOOGLE_CLIENT_SECRET: "client-secret",
  }), { fetchImpl });
  assert.equal(start.status, 302);
  assert.equal(new URL(start.headers.get("location")).searchParams.get("scope"), "https://www.googleapis.com/auth/calendar.readonly");
  assert.equal(start.headers.get("location").includes("client-secret"), false);
});

test("only the email inside the verified token is allowed", async () => {
  clearAccessCertCache();
  const { pair, jwk } = await signingKey("key-email");
  const fetchImpl = certFetch(jwk, []);
  const settings = env();
  const wrong = await sign(pair, claims({ email: "other@example.com" }), "key-email");
  const missing = await sign(pair, claims({ email: undefined }), "key-email");
  const spoofed = await handleRequest(new Request(`${SITE}/api/events`, {
    headers: {
      "Cf-Access-Jwt-Assertion": wrong,
      "Cf-Access-Authenticated-User-Email": "glenn@oibc.ca",
    },
  }), settings, { fetchImpl });
  assert.equal(spoofed.status, 401);
  assert.equal(JSON.stringify(await spoofed.json()).includes("glenn@oibc.ca"), false);

  const noEmail = await handleRequest(new Request(`${SITE}/auth/callback`, {
    headers: {
      "Cf-Access-Jwt-Assertion": missing,
      "Cf-Access-Authenticated-User-Email": "glenn@oibc.ca",
    },
  }), settings, { fetchImpl });
  assert.equal(noEmail.status, 401);

  const headerOnly = await handleRequest(new Request(`${SITE}/auth/start`, {
    headers: { "Cf-Access-Authenticated-User-Email": "glenn@oibc.ca" },
  }), settings, { fetchImpl });
  assert.equal(headerOnly.status, 401);
});
