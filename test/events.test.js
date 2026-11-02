import assert from "node:assert/strict";
import test from "node:test";
import { onRequest } from "../functions/api/events.js";
import { mapGoogleItems } from "../functions/_lib/google.js";
import { loadEvents } from "../functions/_lib/schedule.js";

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

test("ICS failures do not echo the secret address", async () => {
  const secret = "https://calendar.google.com/calendar/ical/SECRETTOKEN/basic.ics";
  const result = await loadEvents({ ICS_URL: secret }, {
    now: NOW,
    fetchImpl: async () => {
      throw new Error(`network down ${secret}`);
    },
  });
  const body = JSON.stringify(result);
  assert.equal(result.status, 502);
  assert.equal(body.includes("SECRETTOKEN"), false);
  assert.equal(body.includes(secret), false);
  assert.equal(result.body.error, "Could not read the calendar feed.");
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
        assert.equal(String(options.body).includes(refreshToken), true);
        return new Response(JSON.stringify({ access_token: "ya29.test-access" }), { status: 200 });
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

test("attendee addresses and calendar ids are not returned", async () => {
  const result = await loadEvents({ ICS_URL: "https://calendar.example/secret-feed.ics" }, {
    now: NOW,
    fetchImpl: async () => new Response(`BEGIN:VCALENDAR
BEGIN:VEVENT
UID:kept@example.com
SUMMARY:Kept
DTSTART:20261102T150000Z
DTEND:20261102T160000Z
ATTENDEE:mailto:person@example.com
END:VEVENT
END:VCALENDAR`, { status: 200 }),
  });
  const body = JSON.stringify(result.body);
  assert.equal(result.body.events[0].title, "Kept");
  assert.equal(body.includes("@"), false);
  assert.equal(body.includes("person"), false);
  assert.equal(body.includes("secret-feed"), false);
});

test("an iCal address wins when Google variables are also present", async () => {
  let calls = 0;
  const result = await loadEvents({
    ICS_URL: "https://calendar.example/feed.ics",
    GOOGLE_CLIENT_ID: "id",
    GOOGLE_CLIENT_SECRET: "secret",
    GOOGLE_REFRESH_TOKEN: "refresh",
    CALENDAR_ID: "primary",
  }, {
    now: NOW,
    fetchImpl: async () => {
      calls += 1;
      return new Response(`BEGIN:VCALENDAR
BEGIN:VEVENT
UID:one
SUMMARY:From the feed
DTSTART:20261102T150000Z
DTEND:20261102T160000Z
END:VEVENT
END:VCALENDAR`, { status: 200 });
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.body.source, "ics");
  assert.equal(result.body.events[0].title, "From the feed");
  assert.equal(result.body.events[0].start, "2026-11-02T10:00:00-05:00");
  assert.match(result.body.events[0].id, /^[0-9a-f]{16}$/);
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

test("the Pages function serves sample JSON with a one-minute private cache", async () => {
  const response = await onRequest({
    request: new Request("https://desk.example/api/events?ICS_URL=https://evil.example/secret.ics"),
    env: {},
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, max-age=60");
  assert.match(response.headers.get("content-type"), /^application\/json/);
  const body = await response.json();
  assert.equal(body.source, "sample");
  assert.equal(body.ok, true);
  assert.equal(JSON.stringify(body).includes("evil.example"), false);
});

test("other methods are rejected", async () => {
  const response = await onRequest({
    request: new Request("https://desk.example/api/events", { method: "POST" }),
    env: {},
  });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET, HEAD");
});
