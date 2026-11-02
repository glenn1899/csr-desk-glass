import assert from "node:assert/strict";
import test from "node:test";
import { onRequest } from "../src/routes/events.js";
import { mapGoogleItems } from "../src/lib/google.js";
import { ACCESS_KEY, CALENDAR_SCOPE, REFRESH_KEY } from "../src/lib/oauth.js";
import { loadEvents } from "../src/lib/schedule.js";

const NOW = new Date("2026-11-02T15:00:00Z");

test("sample mode labels the events and includes one in progress", async () => {
  const result = await loadEvents({}, { now: NOW });
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.source, "sample");
  assert.equal(result.body.timezone, "America/Toronto");
  assert.match(result.body.notice, /Sample calendar/);
  assert.ok(result.body.events.every((event) => event.title.startsWith("Sample:")));
  const current = result.body.events.find((event) => event.id === "sample-current");
  assert.ok(new Date(current.start) <= NOW && NOW < new Date(current.end));
  assert.equal(JSON.stringify(result.body).includes("@"), false);
});

test("a partial Google setup does not fall back to sample data", async () => {
  const result = await loadEvents({ GOOGLE_CLIENT_ID: "client-id" }, { now: NOW });
  assert.equal(result.status, 400);
  assert.equal(result.body.ok, false);
  assert.equal(result.body.source, "google");
  assert.equal(result.body.events.length, 0);
  assert.match(result.body.error, /incomplete/);
});

test("configured Google settings without a refresh token are not sample data", async () => {
  const result = await loadEvents({
    GOOGLE_CLIENT_ID: "client-id",
    GOOGLE_CLIENT_SECRET: "client-secret",
    CALENDAR_ID: "primary",
    CAL_KV: mockKv(),
  }, { now: NOW });
  assert.equal(result.status, 409);
  assert.equal(result.body.reason, "not_connected");
  assert.equal(result.body.error, "Calendar is not connected yet.");
  assert.equal(result.body.events.length, 0);
  assert.equal(JSON.stringify(result.body).includes("client-secret"), false);
});

test("Google tokens stay out of the response", async () => {
  const refreshToken = "super-secret-refresh-token-value";
  const clientSecret = "super-secret-client-secret-value";
  let authorized = false;
  const result = await loadEvents({
    GOOGLE_CLIENT_ID: "client-id.apps.googleusercontent.com",
    GOOGLE_CLIENT_SECRET: clientSecret,
    GOOGLE_REFRESH_TOKEN: refreshToken,
    CALENDAR_ID: "primary",
  }, {
    now: NOW,
    fetchImpl: async (url, options) => {
      const href = String(url);
      if (href.includes("oauth2.googleapis.com")) {
        assert.equal(options.method, "POST");
        const params = new URLSearchParams(String(options.body));
        assert.equal(params.get("grant_type"), "refresh_token");
        assert.equal(params.get("refresh_token"), refreshToken);
        assert.equal(params.get("scope"), CALENDAR_SCOPE);
        return new Response(JSON.stringify({ access_token: "ya29.test-access", expires_in: 3600 }), { status: 200 });
      }
      authorized = options.headers.authorization === "Bearer ya29.test-access";
      assert.equal(href.includes("calendars/primary/events"), true);
      assert.equal(href.includes("singleEvents=true"), true);
      return new Response(JSON.stringify({
        items: [
          {
            id: "g-1",
            status: "confirmed",
            summary: "Client call",
            location: "Phone",
            start: { dateTime: "2026-11-02T09:30:00-08:00" },
            end: { dateTime: "2026-11-02T10:00:00-08:00" },
          },
          {
            id: "g-2",
            status: "cancelled",
            summary: "Hidden",
            start: { dateTime: "2026-11-02T11:00:00-05:00" },
            end: { dateTime: "2026-11-02T12:00:00-05:00" },
          },
          {
            id: "g-3",
            summary: "Holiday",
            start: { date: "2026-11-02" },
            end: { date: "2026-11-03" },
          },
        ],
      }), { status: 200 });
    },
  });
  assert.equal(authorized, true);
  assert.equal(result.status, 200);
  assert.equal(result.body.source, "google");
  const titles = result.body.events.map((event) => event.title);
  assert.deepEqual(titles, ["Holiday", "Client call"]);
  const call = result.body.events.find((event) => event.title === "Client call");
  assert.equal(call.start, "2026-11-02T12:30:00-05:00");
  assert.equal(call.location, "Phone");
  const holiday = result.body.events.find((event) => event.title === "Holiday");
  assert.equal(holiday.allDay, true);
  assert.equal(holiday.startDate, "2026-11-02");
  const body = JSON.stringify(result);
  assert.equal(body.includes(refreshToken), false);
  assert.equal(body.includes(clientSecret), false);
  assert.equal(body.includes("ya29"), false);
});

test("a saved KV refresh token is preferred and the access token is cached briefly", async () => {
  const kv = mockKv({ [REFRESH_KEY]: "kv-refresh-token" });
  let tokenCalls = 0;
  const fetchImpl = async (url, options) => {
    if (String(url).includes("oauth2.googleapis.com")) {
      tokenCalls += 1;
      const params = new URLSearchParams(String(options.body));
      assert.equal(params.get("refresh_token"), "kv-refresh-token");
      assert.equal(params.get("scope"), CALENDAR_SCOPE);
      assert.notEqual(params.get("refresh_token"), "env-refresh-token");
      return new Response(JSON.stringify({ access_token: "ya29.cached-access", expires_in: 3600 }), { status: 200 });
    }
    return new Response(JSON.stringify({ items: [] }), { status: 200 });
  };
  const env = {
    GOOGLE_CLIENT_ID: "client-id",
    GOOGLE_CLIENT_SECRET: "client-secret",
    GOOGLE_REFRESH_TOKEN: "env-refresh-token",
    CALENDAR_ID: "primary",
    CAL_KV: kv,
  };
  await loadEvents(env, { now: NOW, fetchImpl });
  await loadEvents(env, { now: NOW, fetchImpl });
  assert.equal(tokenCalls, 1);
  assert.equal(await kv.get(ACCESS_KEY), "ya29.cached-access");
  const saved = kv.puts.find((entry) => entry.key === ACCESS_KEY);
  assert.equal(saved.opts.expirationTtl, 15 * 60);
  assert.equal(JSON.stringify(saved.opts).includes("env-refresh-token"), false);
});

test("a short-lived access token is not cached", async () => {
  const kv = mockKv({ [REFRESH_KEY]: "kv-refresh-token" });
  let tokenCalls = 0;
  const fetchImpl = async (url) => {
    if (String(url).includes("oauth2.googleapis.com")) {
      tokenCalls += 1;
      return new Response(JSON.stringify({ access_token: "ya29.short", expires_in: 90 }), { status: 200 });
    }
    return new Response(JSON.stringify({ items: [] }), { status: 200 });
  };
  const env = {
    GOOGLE_CLIENT_ID: "client-id",
    GOOGLE_CLIENT_SECRET: "client-secret",
    CALENDAR_ID: "primary",
    CAL_KV: kv,
  };
  await loadEvents(env, { now: NOW, fetchImpl });
  await loadEvents(env, { now: NOW, fetchImpl });
  assert.equal(tokenCalls, 2);
  assert.equal(await kv.get(ACCESS_KEY), null);
});

test("a token request failure does not echo the refresh token", async () => {
  const refreshToken = "super-secret-refresh-token-value";
  const result = await loadEvents({
    GOOGLE_CLIENT_ID: "client-id",
    GOOGLE_CLIENT_SECRET: "client-secret",
    GOOGLE_REFRESH_TOKEN: refreshToken,
    CALENDAR_ID: "primary",
  }, {
    now: NOW,
    fetchImpl: async () => {
      throw new Error(`network down ${refreshToken}`);
    },
  });
  const body = JSON.stringify(result);
  assert.equal(result.status, 502);
  assert.equal(result.body.error, "Google authorization failed.");
  assert.equal(body.includes(refreshToken), false);
});

test("Google items from another zone are normalized before display", () => {
  const [event] = mapGoogleItems([{
    id: "summer",
    summary: "Summer call",
    start: { dateTime: "2026-07-01T09:30:00-07:00", timeZone: "America/Los_Angeles" },
    end: { dateTime: "2026-07-01T10:00:00-07:00", timeZone: "America/Los_Angeles" },
  }]);
  assert.equal(event.start, "2026-07-01T12:30:00-04:00");
  assert.equal(event.end, "2026-07-01T13:00:00-04:00");
});

test("the worker route serves sample JSON with a 30 second private cache", async () => {
  const response = await onRequest({
    request: new Request("https://desk.example/api/events?token=ya29.not-a-setting"),
    env: {},
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, max-age=30");
  assert.equal(response.headers.get("cdn-cache-control"), "no-store");
  assert.equal(response.headers.get("x-robots-tag"), "noindex");
  assert.match(response.headers.get("content-type"), /^application\/json/);
  const body = await response.json();
  assert.equal(body.source, "sample");
  assert.equal(body.ok, true);
  assert.equal(JSON.stringify(body).includes("ya29"), false);
});

test("failed responses are not cached", async () => {
  const rejected = await onRequest({
    request: new Request("https://desk.example/api/events", { method: "POST" }),
    env: {},
  });
  assert.equal(rejected.status, 405);
  assert.equal(rejected.headers.get("allow"), "GET, HEAD");
  assert.equal(rejected.headers.get("cache-control"), "private, no-store");
  assert.equal(rejected.headers.get("cdn-cache-control"), "no-store");

  const env = {};
  Object.defineProperty(env, "GOOGLE_CLIENT_ID", { get() { throw new Error("boom https://secret.example/feed"); } });
  const failed = await onRequest({
    request: new Request("https://desk.example/api/events"),
    env,
  });
  assert.equal(failed.status, 500);
  assert.equal(failed.headers.get("cache-control"), "private, no-store");
  const failedBody = await failed.json();
  assert.equal(JSON.stringify(failedBody).includes("secret.example"), false);
});

function mockKv(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    puts: [],
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value, opts) {
      store.set(key, String(value));
      this.puts.push({ key, value: String(value), opts });
    },
    async delete(key) {
      store.delete(key);
    },
  };
}
