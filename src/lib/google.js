import { getAccessToken } from "./oauth.js";
import { TORONTO, addDays, formatInTimeZone, formatYmd, parseYmd } from "./time.js";

const MAX_PAGES = 4;
const CALENDAR_LIST_URL = "https://www.googleapis.com/calendar/v3/users/me/calendarList";

export function splitList(value) {
  if (value == null) return [];
  const seen = [];
  for (const part of String(value).split(",")) {
    const item = part.trim();
    if (item && !seen.includes(item)) seen.push(item);
  }
  return seen;
}

export function configuredCalendars(env) {
  const source = env || {};
  const ids = splitList(source.CALENDAR_IDS);
  const fallback = blank(source.CALENDAR_ID) ? [] : [String(source.CALENDAR_ID).trim()];
  return {
    ids: ids.length ? ids : fallback,
    names: splitList(source.CALENDAR_NAMES),
  };
}

export function mapGoogleItems(items, source = {}) {
  const events = [];
  for (const item of items || []) {
    const mapped = mapGoogleItem(item, source);
    if (mapped) events.push(mapped);
  }
  return events;
}

export function mapGoogleItem(item, source = {}) {
  if (!item || String(item.status || "").toLowerCase() === "cancelled") return null;
  const title = cleanText(item.summary) || "(No title)";
  const location = cleanText(item.location);
  const uid = String(item.id || title);
  const icalUid = cleanText(item.iCalUID);
  const calendar = safeLabel(source.name, source.team, source.id);
  const team = !!source.team;
  if (item.start && item.start.date) {
    const startDate = String(item.start.date);
    const endDate = item.end && item.end.date ? String(item.end.date) : nextDate(startDate);
    if (!parseYmd(startDate) || !parseYmd(endDate)) return null;
    return {
      uid,
      icalUid,
      title,
      location,
      allDay: true,
      start: null,
      end: null,
      startDate,
      endDate,
      calendar,
      team,
    };
  }
  const startRaw = item.start && item.start.dateTime;
  const endRaw = item.end && item.end.dateTime;
  if (!startRaw || !endRaw) return null;
  const start = new Date(startRaw);
  const end = new Date(endRaw);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) return null;
  return {
    uid,
    icalUid,
    title,
    location,
    allDay: false,
    start: formatInTimeZone(start, TORONTO),
    end: formatInTimeZone(end, TORONTO),
    startDate: null,
    endDate: null,
    calendar,
    team,
  };
}

export function mergeCalendarEvents(lists) {
  const byKey = new Map();
  for (const list of lists || []) {
    for (const event of list || []) {
      const when = event.allDay ? event.startDate : event.start;
      const key = `${event.icalUid || event.uid}|${when || ""}`;
      const prev = byKey.get(key);
      if (!prev || (!prev.team && event.team)) byKey.set(key, event);
    }
  }
  return [...byKey.values()];
}

export async function fetchGoogleEvents(env, window, fetchImpl) {
  const accessToken = await getAccessToken(env, fetchImpl);
  const config = configuredCalendars(env);
  if (!config.ids.length && !config.names.length) {
    throw new Error("Google Calendar settings are incomplete.");
  }
  const failures = [];
  let named = [];
  if (config.names.length) {
    try {
      named = await resolveCalendarNames(accessToken, config.names, fetchImpl);
    } catch {
      failures.push(...config.names);
      named = [];
    }
  }
  const sources = [];
  const seen = new Set();
  for (const id of config.ids) {
    sources.push({ id, name: id === "primary" ? "Primary" : "Calendar", team: false });
    seen.add(id);
  }
  for (const item of named) {
    if (!item.id) {
      failures.push(item.name);
      continue;
    }
    const existing = sources.find((source) => source.id === item.id);
    if (existing) {
      existing.team = true;
      existing.name = safeLabel(item.name, true, item.id);
      continue;
    }
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    sources.push({ id: item.id, name: safeLabel(item.name, true, item.id), team: true });
  }
  const groups = await Promise.all(sources.map(async (source) => {
    try {
      const items = await fetchCalendarItems(accessToken, source.id, window, fetchImpl);
      return { ok: true, events: mapGoogleItems(items, source) };
    } catch {
      return { ok: false, events: [] };
    }
  }));
  const failedCount = failures.length + groups.filter((group) => !group.ok).length;
  const loaded = groups.filter((group) => group.ok);
  if (!loaded.length) throw new Error("Could not read the Google calendar.");
  if (failedCount) {
    console.log(JSON.stringify({ level: "error", message: "calendar_partial_failed", failed: failedCount }));
  }
  return {
    events: mergeCalendarEvents(loaded.map((group) => group.events)),
    notice: failedCount === 0
      ? null
      : (failedCount === 1 ? "One calendar could not be read." : "Some calendars could not be read."),
  };
}

async function resolveCalendarNames(accessToken, names, fetchImpl) {
  const wanted = new Set(names);
  const found = new Map();
  let pageToken = "";
  for (let page = 0; page < MAX_PAGES && found.size < names.length; page += 1) {
    const url = new URL(CALENDAR_LIST_URL);
    url.searchParams.set("maxResults", "250");
    url.searchParams.set("showHidden", "true");
    url.searchParams.set("showDeleted", "false");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const payload = await readJson(await calendarFetch(accessToken, url, fetchImpl));
    const items = payload && Array.isArray(payload.items) ? payload.items : [];
    for (const item of items) {
      const summary = item && item.summary != null ? String(item.summary) : "";
      if (!wanted.has(summary) || found.has(summary) || !item.id) continue;
      found.set(summary, { name: summary, id: String(item.id) });
    }
    if (!payload || !payload.nextPageToken) break;
    pageToken = String(payload.nextPageToken);
  }
  return names.map((name) => found.get(name) || { name, id: "" });
}

async function fetchCalendarItems(accessToken, calendarId, window, fetchImpl) {
  const items = [];
  let pageToken = "";
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url = new URL(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
    );
    url.searchParams.set("singleEvents", "true");
    url.searchParams.set("orderBy", "startTime");
    url.searchParams.set("maxResults", "250");
    url.searchParams.set("timeMin", window.start.toISOString());
    url.searchParams.set("timeMax", window.end.toISOString());
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const payload = await readJson(await calendarFetch(accessToken, url, fetchImpl));
    if (payload && Array.isArray(payload.items)) items.push(...payload.items);
    if (!payload || !payload.nextPageToken) break;
    pageToken = String(payload.nextPageToken);
  }
  return items;
}

async function calendarFetch(accessToken, url, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      redirect: "manual",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${accessToken}`,
      },
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw new Error("Could not read the Google calendar.");
  }
  return response;
}

async function readJson(response) {
  if (!response || response.status < 200 || response.status >= 300) {
    try {
      if (response && typeof response.text === "function") await response.text();
    } catch {
      // The error body is not used.
    }
    throw new Error("Could not read the Google calendar.");
  }
  return response.json();
}

function safeLabel(name, team, id) {
  const label = cleanText(name);
  if (!label || label.includes("@") || /https?:/i.test(label)) {
    return team ? "Team" : (id === "primary" ? "Primary" : "Calendar");
  }
  return label.slice(0, 80);
}

function nextDate(ymd) {
  const parts = parseYmd(ymd);
  if (!parts) return ymd;
  return formatYmd(addDays(parts, 1));
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 300);
}

function blank(value) {
  return value == null || String(value).trim() === "";
}
