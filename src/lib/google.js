import { getAccessToken } from "./oauth.js";
import { TORONTO, addDays, formatInTimeZone, formatYmd, parseYmd } from "./time.js";

const MAX_PAGES = 4;

export function mapGoogleItems(items) {
  const events = [];
  for (const item of items || []) {
    const mapped = mapGoogleItem(item);
    if (mapped) events.push(mapped);
  }
  return events;
}

export function mapGoogleItem(item) {
  if (!item || String(item.status || "").toLowerCase() === "cancelled") return null;
  const title = cleanText(item.summary) || "(No title)";
  const location = cleanText(item.location);
  const uid = String(item.id || title);
  if (item.start && item.start.date) {
    const startDate = String(item.start.date);
    const endDate = item.end && item.end.date ? String(item.end.date) : nextDate(startDate);
    if (!parseYmd(startDate) || !parseYmd(endDate)) return null;
    return {
      uid,
      title,
      location,
      allDay: true,
      start: null,
      end: null,
      startDate,
      endDate,
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
    title,
    location,
    allDay: false,
    start: formatInTimeZone(start, TORONTO),
    end: formatInTimeZone(end, TORONTO),
    startDate: null,
    endDate: null,
  };
}

export async function fetchGoogleEvents(env, window, fetchImpl) {
  const accessToken = await getAccessToken(env, fetchImpl);
  const items = [];
  let pageToken = "";
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(String(env.CALENDAR_ID).trim())}/events`,
    );
    url.searchParams.set("singleEvents", "true");
    url.searchParams.set("orderBy", "startTime");
    url.searchParams.set("maxResults", "250");
    url.searchParams.set("timeMin", window.start.toISOString());
    url.searchParams.set("timeMax", window.end.toISOString());
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    let response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        redirect: "follow",
        referrerPolicy: "no-referrer",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${accessToken}`,
        },
        signal: AbortSignal.timeout(8000),
      });
    } catch {
      throw new Error("Could not read the Google calendar.");
    }
    if (!response.ok) throw new Error("Could not read the Google calendar.");
    const payload = await response.json();
    if (payload && Array.isArray(payload.items)) items.push(...payload.items);
    if (!payload || !payload.nextPageToken) break;
    pageToken = String(payload.nextPageToken);
  }
  return mapGoogleItems(items);
}

function nextDate(ymd) {
  const parts = parseYmd(ymd);
  if (!parts) return ymd;
  return formatYmd(addDays(parts, 1));
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 300);
}
