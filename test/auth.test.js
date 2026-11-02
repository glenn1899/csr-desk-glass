import assert from "node:assert/strict";
import test from "node:test";
import { handleRequest } from "../src/index.js";
import { onRequest as start } from "../src/routes/auth-start.js";
import {
  ACCESS_KEY,
  CALENDAR_SCOPE,
  REFRESH_KEY,
  handleCallback,
} from "../src/lib/oauth.js";

const OWNER = { "Cf-Access-Authenticated-User-Email": "owner@example.com" };

function mockKv() {
  const store = new Map();
  return {
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value) {
      store.set(key, String(value));
    },
    async delete(key) {
      store.delete(key);
    },
  };
}

test("connect refuses to start without a verified Access token", async () => {
  const response = await handleRequest(
    new Request("https://desk.example/auth/start", {
      headers: { "Cf-Access-Authenticated-User-Email": "glenn@oibc.ca" },
    }),
    { GOOGLE_CLIENT_ID: "client-id", GOOGLE_CLIENT_SECRET: "client-secret", ALLOWED_EMAIL: "glenn@oibc.ca" },
  );
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("location"), null);
  const body = await response.json();
  assert.equal(body.error, "Cloudflare Access is required.");
  assert.equal(JSON.stringify(body).includes("client-secret"), false);
  assert.equal(JSON.stringify(body).includes("glenn@oibc.ca"), false);
});

test("connect redirects to Google with read-only offline consent", async () => {
  const response = await start({
    request: new Request("https://desk.example/auth/start", { headers: OWNER }),
    env: { GOOGLE_CLIENT_ID: "client-id", GOOGLE_CLIENT_SECRET: "client-secret" },
  });
  assert.equal(response.status, 302);
  const location = new URL(response.headers.get("location"));
  assert.equal(location.origin + location.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(location.searchParams.get("client_id"), "client-id");
  assert.equal(location.searchParams.get("client_secret"), null);
  assert.equal(location.searchParams.get("redirect_uri"), "https://desk.example/auth/callback");
  assert.equal(location.searchParams.get("response_type"), "code");
  assert.equal(location.searchParams.get("scope"), CALENDAR_SCOPE);
  assert.equal(location.searchParams.get("access_type"), "offline");
  assert.equal(location.searchParams.get("prompt"), "consent");
  const state = location.searchParams.get("state");
  assert.match(state, /^[a-f0-9]{64}$/);
  const cookie = response.headers.get("set-cookie");
  assert.match(cookie, new RegExp(`cal_oauth_state=${state}`));
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /Path=\/auth/);
  const text = await response.text();
  assert.equal(text.includes("client-secret"), false);
  assert.equal(location.toString().includes("client-secret"), false);
});

test("connect does not start when the client is not configured", async () => {
  const response = await start({
    request: new Request("https://desk.example/auth/start", { headers: OWNER }),
    env: {},
  });
  assert.equal(response.status, 400);
  assert.equal(response.headers.get("location"), null);
});

test("callback refuses a visitor without a verified Access token", async () => {
  const response = await handleRequest(
    new Request("https://desk.example/auth/callback?code=auth-code&state=" + "a".repeat(64), {
      headers: {
        cookie: `cal_oauth_state=${"a".repeat(64)}`,
        "Cf-Access-Authenticated-User-Email": "glenn@oibc.ca",
      },
    }),
    { GOOGLE_CLIENT_ID: "client-id", GOOGLE_CLIENT_SECRET: "client-secret", CAL_KV: mockKv() },
  );
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error, "Cloudflare Access is required.");
});

test("callback rejects a state that does not match the cookie", async () => {
  let called = false;
  const kv = mockKv();
  const response = await handleCallback(
    new Request(`https://desk.example/auth/callback?code=auth-code&state=${"b".repeat(64)}`, {
      headers: { ...OWNER, cookie: `cal_oauth_state=${"a".repeat(64)}` },
    }),
    { GOOGLE_CLIENT_ID: "client-id", GOOGLE_CLIENT_SECRET: "client-secret", CAL_KV: kv },
    async () => {
      called = true;
      return new Response("{}", { status: 200 });
    },
  );
  assert.equal(called, false);
  assert.equal(response.status, 302);
  assert.equal(new URL(response.headers.get("location")).searchParams.get("calendar"), "error");
  assert.equal(await kv.get(REFRESH_KEY), null);
});

test("callback stores the refresh token and does not show it", async () => {
  const state = "c".repeat(64);
  const kv = mockKv();
  await kv.put(ACCESS_KEY, "ya29.old-access");
  const response = await handleCallback(
    new Request(`https://desk.example/auth/callback?code=auth-code&state=${state}`, {
      headers: { ...OWNER, cookie: `cal_oauth_state=${state}` },
    }),
    { GOOGLE_CLIENT_ID: "client-id", GOOGLE_CLIENT_SECRET: "client-secret", CAL_KV: kv },
    async (url, options) => {
      assert.equal(String(url), "https://oauth2.googleapis.com/token");
      assert.equal(options.method, "POST");
      const params = new URLSearchParams(String(options.body));
      assert.equal(params.get("grant_type"), "authorization_code");
      assert.equal(params.get("code"), "auth-code");
      assert.equal(params.get("redirect_uri"), "https://desk.example/auth/callback");
      assert.equal(params.get("client_secret"), "client-secret");
      return new Response(JSON.stringify({
        access_token: "ya29.should-not-leak",
        refresh_token: "refresh-should-not-leak",
        expires_in: 3600,
        scope: CALENDAR_SCOPE,
      }), { status: 200 });
    },
  );
  assert.equal(response.status, 302);
  const location = new URL(response.headers.get("location"));
  assert.equal(location.origin + location.pathname, "https://desk.example/");
  assert.equal(location.searchParams.get("calendar"), "connected");
  assert.equal(location.searchParams.get("code"), null);
  assert.equal(await kv.get(REFRESH_KEY), "refresh-should-not-leak");
  assert.equal(await kv.get(ACCESS_KEY), null);
  const cookie = response.headers.get("set-cookie");
  assert.match(cookie, /cal_oauth_state=/);
  assert.match(cookie, /Max-Age=0/);
  const shown = `${location}${(await response.text())}`;
  assert.equal(shown.includes("ya29"), false);
  assert.equal(shown.includes("refresh-should-not-leak"), false);
  assert.equal(shown.includes("client-secret"), false);
  assert.equal(shown.includes("auth-code"), false);
});

test("a refresh token with any other Google scope is not saved", async () => {
  const state = "d".repeat(64);
  const kv = mockKv();
  const response = await handleCallback(
    new Request(`https://desk.example/auth/callback?code=auth-code&state=${state}`, {
      headers: { cookie: `cal_oauth_state=${state}` },
    }),
    { GOOGLE_CLIENT_ID: "client-id", GOOGLE_CLIENT_SECRET: "client-secret", CAL_KV: kv },
    async () => new Response(JSON.stringify({
      access_token: "ya29.should-not-leak",
      refresh_token: "refresh-should-not-leak",
      expires_in: 3600,
      scope: `${CALENDAR_SCOPE} https://www.googleapis.com/auth/gmail.readonly`,
    }), { status: 200 }),
  );
  assert.equal(response.status, 302);
  assert.equal(new URL(response.headers.get("location")).searchParams.get("calendar"), "error");
  assert.equal(await kv.get(REFRESH_KEY), null);
  assert.equal((await response.text()).includes("refresh-should-not-leak"), false);
});

test("a rejected token exchange logs and shows only Google's error code", async () => {
  const state = "f".repeat(64);
  const kv = mockKv();
  const lines = [];
  const original = console.log;
  console.log = (line) => lines.push(String(line));
  let response;
  try {
    response = await handleCallback(
      new Request(`https://desk.example/auth/callback?code=4%2Fsecret-auth-code&state=${state}`, {
        headers: { cookie: `cal_oauth_state=${state}`, "Cf-Access-Authenticated-User-Email": "glenn@oibc.ca" },
      }),
      { GOOGLE_CLIENT_ID: "client-id", GOOGLE_CLIENT_SECRET: "client-secret", CAL_KV: kv },
      async () => new Response(JSON.stringify({
        error: "invalid_grant",
        error_description: "code 4/secret-auth-code client-secret glenn@oibc.ca",
      }), { status: 400 }),
    );
  } finally {
    console.log = original;
  }
  assert.equal(response.status, 302);
  const location = new URL(response.headers.get("location"));
  assert.equal(location.pathname, "/");
  assert.equal(location.searchParams.get("calendar"), "error");
  assert.equal(location.searchParams.get("reason"), "invalid_grant");
  assert.equal(await kv.get(REFRESH_KEY), null);
  assert.deepEqual(lines, [
    JSON.stringify({ level: "error", message: "calendar_connect_failed", status: 400, error: "invalid_grant" }),
  ]);
  const shown = `${lines.join("\n")}${location}`;
  assert.equal(shown.includes("secret-auth-code"), false);
  assert.equal(shown.includes("client-secret"), false);
  assert.equal(shown.includes("glenn@oibc.ca"), false);
  assert.equal(shown.includes("error_description"), false);
});

test("an unsafe or unknown token error is not shown", async () => {
  const state = "a".repeat(64);
  const kv = mockKv();
  const lines = [];
  const original = console.log;
  console.log = (line) => lines.push(String(line));
  let unsafe;
  let unknown;
  let unlisted;
  try {
    unsafe = await handleCallback(
      new Request(`https://desk.example/auth/callback?code=secret-auth-code&state=${state}`, {
        headers: { cookie: `cal_oauth_state=${state}` },
      }),
      { GOOGLE_CLIENT_ID: "client-id", GOOGLE_CLIENT_SECRET: "client-secret", CAL_KV: kv },
      async () => new Response("client-secret secret-auth-code glenn@oibc.ca", {
        status: 502,
        headers: { "content-type": "text/html" },
      }),
    );
    unknown = await handleCallback(
      new Request(`https://desk.example/auth/callback?code=secret-auth-code&state=${state}`, {
        headers: { cookie: `cal_oauth_state=${state}` },
      }),
      { GOOGLE_CLIENT_ID: "client-id", GOOGLE_CLIENT_SECRET: "client-secret", CAL_KV: kv },
      async () => new Response(JSON.stringify({
        error: "ya29.not-a-code",
        error_description: "client-secret",
      }), { status: 400 }),
    );
    unlisted = await handleCallback(
      new Request(`https://desk.example/auth/callback?code=secret-auth-code&state=${state}`, {
        headers: { cookie: `cal_oauth_state=${state}` },
      }),
      { GOOGLE_CLIENT_ID: "client-id", GOOGLE_CLIENT_SECRET: "client-secret", CAL_KV: kv },
      async () => new Response(JSON.stringify({ error: "server_error" }), { status: 500 }),
    );
  } finally {
    console.log = original;
  }
  for (const response of [unsafe, unknown, unlisted]) {
    const location = new URL(response.headers.get("location"));
    assert.equal(location.searchParams.get("calendar"), "error");
    assert.equal(location.searchParams.get("reason"), null);
    assert.equal(await kv.get(REFRESH_KEY), null);
  }
  assert.deepEqual(lines.map((line) => JSON.parse(line)), [
    { level: "error", message: "calendar_connect_failed", status: 502 },
    { level: "error", message: "calendar_connect_failed", status: 400 },
    { level: "error", message: "calendar_connect_failed", status: 500, error: "server_error" },
  ]);
  const shown = lines.join("\n");
  assert.equal(shown.includes("secret-auth-code"), false);
  assert.equal(shown.includes("client-secret"), false);
  assert.equal(shown.includes("ya29"), false);
  assert.equal(shown.includes("glenn@oibc.ca"), false);
});

test("the code exchange posts the same redirect URI that connect start uses", async () => {
  const origin = "https://csr-desk-glass.glenn-889.workers.dev";
  const started = await start({
    request: new Request(`${origin}/auth/start`),
    env: { GOOGLE_CLIENT_ID: " client-id ", GOOGLE_CLIENT_SECRET: " client-secret " },
  });
  const redirectUri = new URL(started.headers.get("location")).searchParams.get("redirect_uri");
  assert.equal(redirectUri, `${origin}/auth/callback`);

  const state = "b".repeat(64);
  let seen;
  await handleCallback(
    new Request(`${origin}/auth/callback?code=4%2F0Aauth-code&state=${state}`, {
      headers: { cookie: `cal_oauth_state=${state}` },
    }),
    { GOOGLE_CLIENT_ID: " client-id ", GOOGLE_CLIENT_SECRET: " client-secret ", CAL_KV: mockKv() },
    async (url, options) => {
      seen = { url: String(url), options };
      return new Response(JSON.stringify({
        access_token: "ya29.should-not-leak",
        refresh_token: "refresh-should-not-leak",
        expires_in: 3600,
        scope: CALENDAR_SCOPE,
      }), { status: 200 });
    },
  );
  assert.equal(seen.url, "https://oauth2.googleapis.com/token");
  assert.equal(seen.options.method, "POST");
  assert.equal(seen.options.headers["content-type"], "application/x-www-form-urlencoded");
  assert.equal(typeof seen.options.body, "string");
  const params = new URLSearchParams(seen.options.body);
  assert.deepEqual([...params.keys()], ["code", "client_id", "client_secret", "redirect_uri", "grant_type"]);
  assert.equal(params.get("code"), "4/0Aauth-code");
  assert.equal(params.get("client_id"), "client-id");
  assert.equal(params.get("client_secret"), "client-secret");
  assert.equal(params.get("redirect_uri"), redirectUri);
  assert.equal(params.get("grant_type"), "authorization_code");
  assert.equal(seen.options.body.includes("scope="), false);
});

test("the desk page shows an allowlisted connect error", async () => {
  const response = await handleRequest(new Request("https://desk.example/"));
  const html = await response.text();
  assert.match(html, /Could not connect the calendar \(invalid_client\)\./);
  assert.match(html, /Could not connect the calendar \(invalid_grant\)\./);
  assert.match(html, /Could not connect the calendar \(redirect_uri_mismatch\)\./);
  assert.match(html, /hasOwnProperty\.call\(connectErrors, connectCode\)/);
  assert.equal(html.includes('connectNote = params.get("reason")'), false);
});

test("a malformed state cookie is ignored", async () => {
  const kv = mockKv();
  const response = await handleCallback(
    new Request(`https://desk.example/auth/callback?code=auth-code&state=${"e".repeat(64)}`, {
      headers: { cookie: "cal_oauth_state=%E0%A4%A" },
    }),
    { GOOGLE_CLIENT_ID: "client-id", GOOGLE_CLIENT_SECRET: "client-secret", CAL_KV: kv },
    async () => {
      throw new Error("should not exchange");
    },
  );
  assert.equal(response.status, 302);
  assert.equal(new URL(response.headers.get("location")).searchParams.get("calendar"), "error");
  assert.equal(await kv.get(REFRESH_KEY), null);
});
