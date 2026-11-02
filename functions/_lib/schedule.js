import { fetchGoogleEvents } from "./google.js";
import { fetchIcsEvents } from "./ics.js";
import { SAMPLE_NOTICE, sampleEvents } from "./sample.js";
import { TORONTO, formatInTimeZone, torontoWindow } from "./time.js";

const GOOGLE_KEYS = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN", "CALENDAR_ID"];
const SAFE_ERRORS = new Set([
  "Could not read the calendar feed.",
  "Calendar file is too large.",
  "Could not read the Google calendar.",
  "Google authorization failed.",
  "Google Calendar settings are incomplete.",
]);

export function selectSource(env) {
  const source = env || {};
  if (!blank(source.ICS_URL)) return "ics";
  const present = GOOGLE_KEYS.filter((key) => !blank(source[key]));
  if (present.length === GOOGLE_KEYS.length) return "google";
  if (present.length > 0) return "invalid";
  return "sample";
}

export async function loadEvents(env, options = {}) {
  const sourceEnv = env || {};
  const now = options.now instanceof Date ? options.now : new Date();
  const fetchImpl = options.fetchImpl || fetch;
  const mode = selectSource(sourceEnv);
  const generatedAt = formatInTimeZone(now, TORONTO);
  const window = torontoWindow(now);

  if (mode === "invalid") {
    return {
      status: 400,
      body: envelope({
        ok: false,
        source: "google",
        generatedAt,
        error: "Google Calendar settings are incomplete.",
        events: [],
      }),
    };
  }

  try {
    if (mode === "sample") {
      return {
        status: 200,
        body: envelope({
          ok: true,
          source: "sample",
          generatedAt,
          notice: SAMPLE_NOTICE,
          window,
          events: sampleEvents(now),
        }),
      };
    }
    const raw = mode === "ics"
      ? await fetchIcsEvents(String(sourceEnv.ICS_URL).trim(), window, fetchImpl)
      : await fetchGoogleEvents(sourceEnv, window, fetchImpl);
    const events = (await withIds(raw)).sort(compareEvents).slice(0, 250);
    return {
      status: 200,
      body: envelope({
        ok: true,
        source: mode,
        generatedAt,
        notice: null,
        window,
        events,
      }),
    };
  } catch (err) {
    console.log(JSON.stringify({ level: "error", source: mode, message: "calendar_read_failed" }));
    return {
      status: 502,
      body: envelope({
        ok: false,
        source: mode,
        generatedAt,
        error: safeErrorMessage(err, sourceEnv),
        events: [],
      }),
    };
  }
}

export async function withIds(events) {
  const out = [];
  for (const event of events) {
    const basis = [
      event.uid || "",
      event.title || "",
      event.start || event.startDate || "",
      event.end || event.endDate || "",
    ].join("|");
    out.push({
      id: event.id || await digestId(basis),
      title: event.title || "(No title)",
      allDay: !!event.allDay,
      start: event.allDay ? null : event.start,
      end: event.allDay ? null : event.end,
      startDate: event.allDay ? event.startDate : null,
      endDate: event.allDay ? event.endDate : null,
      location: event.location || "",
    });
  }
  return out;
}

export async function digestId(value) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(hash)].slice(0, 8).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function envelope(fields) {
  return {
    ok: fields.ok,
    source: fields.source,
    timezone: TORONTO,
    generatedAt: fields.generatedAt,
    notice: fields.notice || null,
    error: fields.error || null,
    window: fields.window
      ? {
        from: formatInTimeZone(fields.window.start, TORONTO),
        to: formatInTimeZone(fields.window.end, TORONTO),
      }
      : null,
    events: fields.events || [],
  };
}

function safeErrorMessage(err, env) {
  const message = err && err.message ? String(err.message) : "";
  const allowed = SAFE_ERRORS.has(message) ? message : "Could not read the calendar.";
  return redact(allowed, env);
}

function redact(message, env) {
  let out = message;
  for (const key of ["ICS_URL", ...GOOGLE_KEYS]) {
    const value = env && env[key] != null ? String(env[key]).trim() : "";
    if (value.length > 3) out = out.split(value).join("[redacted]");
  }
  return out;
}

function compareEvents(a, b) {
  const as = a.allDay ? a.startDate : a.start;
  const bs = b.allDay ? b.startDate : b.start;
  if (as < bs) return -1;
  if (as > bs) return 1;
  return String(a.title).localeCompare(String(b.title));
}

function blank(value) {
  return value == null || String(value).trim() === "";
}
