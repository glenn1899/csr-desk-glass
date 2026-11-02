import {
  TORONTO,
  addDays,
  compareYmd,
  daysBetween,
  daysInMonth,
  formatInTimeZone,
  formatYmd,
  parseYmd,
  zonedParts,
  zonedWallTimeToUtc,
} from "./time.js";

const WEEKDAYS = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
const MAX_OCCURRENCES = 400;

export function parseIcs(icsText, window) {
  const text = unfold(String(icsText || ""));
  if (!/BEGIN:VCALENDAR/i.test(text) && !/BEGIN:VEVENT/i.test(text)) {
    throw new Error("Could not read the calendar feed.");
  }
  const parsed = extractBlocks(text, "VEVENT").map(parseEvent).filter(Boolean);
  const singles = [];
  const masters = [];
  const exceptions = [];
  for (const event of parsed) {
    if (event.recurrenceId) exceptions.push(event);
    else if (event.rrule) masters.push(event);
    else singles.push(event);
  }

  const replaced = new Set();
  for (const exception of exceptions) {
    const key = occurrenceKey(exception, exception.recurrenceId);
    if (key) replaced.add(`${exception.uid}|${key}`);
  }

  const events = [];
  for (const event of singles) {
    if (event.status === "CANCELLED") continue;
    const normalized = materialize(event, event.startParts, window);
    if (normalized) events.push(normalized);
  }
  for (const master of masters) {
    if (master.status === "CANCELLED") continue;
    for (const date of expandDates(master, window)) {
      const key = occurrenceKey(master, stamp(master, date));
      if (!key || master.exdates.has(key) || replaced.has(`${master.uid}|${key}`)) continue;
      const normalized = materialize(master, stamp(master, date), window);
      if (normalized) events.push(normalized);
    }
  }
  for (const exception of exceptions) {
    if (exception.status === "CANCELLED") continue;
    const normalized = materialize(exception, exception.startParts, window);
    if (normalized) events.push(normalized);
  }
  events.sort(compareEvents);
  return events;
}

export async function fetchIcsEvents(url, window, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      redirect: "follow",
      referrerPolicy: "no-referrer",
      headers: { accept: "text/calendar, text/plain;q=0.9, */*;q=0.1" },
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw new Error("Could not read the calendar feed.");
  }
  if (!response || !response.ok) throw new Error("Could not read the calendar feed.");
  const text = await readTextLimited(response, 2_000_000);
  return parseIcs(text, window);
}

export async function readTextLimited(response, maxBytes) {
  if (!response.body || !response.body.getReader) {
    const text = await response.text();
    if (text.length > maxBytes) throw new Error("Calendar file is too large.");
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch { /* already closed */ }
      throw new Error("Calendar file is too large.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function unfold(text) {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n[ \t]/g, "");
}

function withoutNestedComponents(lines) {
  const kept = [];
  let depth = 0;
  for (const line of lines) {
    if (/^BEGIN:/i.test(line)) {
      depth += 1;
      continue;
    }
    if (/^END:/i.test(line)) {
      if (depth > 0) depth -= 1;
      continue;
    }
    if (depth === 0) kept.push(line);
  }
  return kept;
}

function extractBlocks(text, name) {
  const lines = text.split("\n");
  const blocks = [];
  let current = null;
  for (const line of lines) {
    if (line === `BEGIN:${name}`) {
      current = [];
      continue;
    }
    if (line === `END:${name}`) {
      if (current) blocks.push(current);
      current = null;
      continue;
    }
    if (current) current.push(line);
  }
  return blocks;
}

function parseEvent(lines, index) {
  const props = {};
  const exdateProps = [];
  for (const line of withoutNestedComponents(lines)) {
    const prop = parseLine(line);
    if (!prop) continue;
    if (prop.name === "EXDATE") exdateProps.push(prop);
    else props[prop.name] = prop;
  }
  if (!props.DTSTART) return null;
  const startParts = parseDateTime(props.DTSTART.value, props.DTSTART.params);
  if (!startParts || !validParts(startParts)) return null;
  const allDay = startParts.allDay;
  const zone = allDay ? null : startParts.tz === "UTC" ? "UTC" : (startParts.tz || TORONTO);
  const endParts = endPartsFor(startParts, props.DTEND, props.DURATION, { allDay, zone });
  if (!endParts) return null;
  const recurrenceId = props["RECURRENCE-ID"]
    ? parseDateTime(props["RECURRENCE-ID"].value, props["RECURRENCE-ID"].params)
    : null;
  const rrule = props.RRULE ? parseRrule(props.RRULE.value) : null;
  const draft = {
    uid: cleanText(props.UID && props.UID.value) || `event-${index + 1}`,
    summary: cleanText(props.SUMMARY && props.SUMMARY.value),
    location: cleanText(props.LOCATION && props.LOCATION.value),
    status: String((props.STATUS && props.STATUS.value) || "").toUpperCase(),
    allDay,
    zone,
    startParts,
    endParts,
    rrule,
    recurrenceId,
    exdates: new Set(),
  };
  for (const prop of exdateProps) {
    for (const piece of prop.value.split(",")) {
      const parsed = parseDateTime(piece.trim(), prop.params);
      const key = parsed && occurrenceKey(draft, parsed);
      if (key) draft.exdates.add(key);
    }
  }
  return draft;
}

function endPartsFor(startParts, dtend, duration, holder) {
  if (dtend) {
    const parsed = parseDateTime(dtend.value, dtend.params);
    if (!parsed || !validParts(parsed)) return null;
    return parsed;
  }
  if (duration) {
    const seconds = durationSeconds(duration.value);
    if (seconds == null) return null;
    if (startParts.allDay) {
      const days = Math.max(1, Math.round(seconds / 86400));
      return { ...addDays(startParts, days), hh: 0, mm: 0, ss: 0, allDay: true, tz: null };
    }
    return addSecondsToWall(holder, startParts, seconds);
  }
  if (startParts.allDay) return { ...addDays(startParts, 1), hh: 0, mm: 0, ss: 0, allDay: true, tz: null };
  return null;
}

function expandDates(master, window) {
  const rule = master.rrule;
  if (!rule) return [];
  const span = Math.max(1, daysBetween(master.startParts, master.endParts));
  const rangeStart = addDays(parseYmd(window.startDate), -span - 1);
  const rangeEnd = parseYmd(window.endDate);
  if (rule.freq === "DAILY") return expandDaily(master, rule, rangeStart, rangeEnd);
  if (rule.freq === "WEEKLY") return expandWeekly(master, rule, rangeStart, rangeEnd);
  if (rule.freq === "MONTHLY") return expandMonthly(master, rule, rangeStart, rangeEnd);
  if (rule.freq === "YEARLY") return expandYearly(master, rule, rangeStart, rangeEnd);
  return [];
}

function expandDaily(master, rule, rangeStart, rangeEnd) {
  const start = master.startParts;
  const interval = rule.interval;
  let index = 0;
  if (compareYmd(start, rangeStart) < 0) {
    index = Math.max(0, Math.floor(daysBetween(start, rangeStart) / interval) - 1);
  }
  const out = [];
  for (let guard = 0; guard < 5000; guard++) {
    if (rule.count != null && index >= rule.count) break;
    const date = addDays(start, index * interval);
    index += 1;
    if (pastUntil(master, date)) break;
    if (compareYmd(date, rangeEnd) >= 0) break;
    if (compareYmd(date, rangeStart) < 0) continue;
    out.push(date);
    if (out.length >= MAX_OCCURRENCES) break;
  }
  return out;
}

function expandWeekly(master, rule, rangeStart, rangeEnd) {
  const start = master.startParts;
  const interval = rule.interval;
  const codes = (rule.byday && rule.byday.length ? rule.byday : [dayCodeFromParts(start)])
    .map(dayCode)
    .filter(Boolean);
  const wkst = rule.wkst || "MO";
  const startWeek = startOfWeek(start, wkst);
  let weekIndex = 0;
  if (compareYmd(start, rangeStart) < 0) {
    const diff = Math.floor(daysBetween(startWeek, startOfWeek(rangeStart, wkst)) / 7);
    weekIndex = Math.max(0, Math.floor(diff / interval) * interval - interval);
  }
  let seen = 0;
  for (let week = 0; week < weekIndex; week += interval) {
    seen += datesInWeek(start, codes, wkst, startWeek, week).length;
    if (rule.count != null && seen >= rule.count) return [];
  }
  const out = [];
  for (let guard = 0; guard < 520; guard++) {
    const dates = datesInWeek(start, codes, wkst, startWeek, weekIndex);
    for (const date of dates) {
      if (pastUntil(master, date)) return out;
      if (rule.count != null && seen >= rule.count) return out;
      seen += 1;
      if (compareYmd(date, rangeEnd) >= 0) return out;
      if (compareYmd(date, rangeStart) >= 0) out.push(date);
      if (out.length >= MAX_OCCURRENCES) return out;
    }
    const weekStart = addDays(startWeek, weekIndex * 7);
    if (daysBetween(rangeEnd, weekStart) > 7) return out;
    weekIndex += interval;
  }
  return out;
}

function expandMonthly(master, rule, rangeStart, rangeEnd) {
  const start = master.startParts;
  const interval = rule.interval;
  let year = start.y;
  let month = start.m;
  let produced = 0;
  const out = [];
  for (let index = 0; index < 2400; index++) {
    if (year > rangeEnd.y || (year === rangeEnd.y && month > rangeEnd.m)) break;
    if (index % interval === 0) {
      for (const date of monthDates(year, month, start, rule)) {
        if (compareYmd(date, start) < 0) continue;
        if (pastUntil(master, date)) return out;
        if (rule.count != null && produced >= rule.count) return out;
        produced += 1;
        if (compareYmd(date, rangeEnd) >= 0) return out;
        if (compareYmd(date, rangeStart) >= 0) out.push(date);
        if (out.length >= MAX_OCCURRENCES) return out;
      }
    }
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return out;
}

function expandYearly(master, rule, rangeStart, rangeEnd) {
  const start = master.startParts;
  const out = [];
  let produced = 0;
  for (let step = 0; step < 200; step++) {
    if (rule.count != null && produced >= rule.count) break;
    const year = start.y + step * rule.interval;
    if (year > rangeEnd.y || (year === rangeEnd.y && start.m > rangeEnd.m)) break;
    const date = { y: year, m: start.m, d: start.d };
    // 29 February in a non-leap year is not an occurrence and does not use up COUNT.
    if (date.d > daysInMonth(date.y, date.m)) continue;
    if (pastUntil(master, date)) break;
    produced += 1;
    if (compareYmd(date, rangeEnd) >= 0) break;
    if (compareYmd(date, rangeStart) >= 0) out.push(date);
    if (out.length >= MAX_OCCURRENCES) break;
  }
  return out;
}

function datesInWeek(start, codes, wkst, startWeek, weekIndex) {
  const week = addDays(startWeek, weekIndex * 7);
  const wk = WEEKDAYS[wkst] ?? 1;
  const dates = [];
  for (const code of codes) {
    const delta = (WEEKDAYS[code] - wk + 7) % 7;
    const date = addDays(week, delta);
    if (compareYmd(date, start) >= 0) dates.push(date);
  }
  dates.sort(compareYmd);
  return dates;
}

function monthDates(year, month, start, rule) {
  const ordinals = (rule.byday || []).filter((token) => /^[+-]?\d/.test(token));
  if (ordinals.length) {
    const dates = [];
    for (const token of ordinals) {
      const match = token.match(/^([+-]?\d+)(SU|MO|TU|WE|TH|FR|SA)$/);
      if (!match) continue;
      const date = nthWeekday(year, month, Number(match[1]), WEEKDAYS[match[2]]);
      if (date) dates.push(date);
    }
    dates.sort(compareYmd);
    return dates;
  }
  const days = rule.bymonthday && rule.bymonthday.length ? rule.bymonthday : [start.d];
  const dim = daysInMonth(year, month);
  const dates = [];
  const seen = new Set();
  for (const day of days) {
    const resolved = day > 0 ? day : dim + day + 1;
    if (resolved < 1 || resolved > dim || seen.has(resolved)) continue;
    seen.add(resolved);
    dates.push({ y: year, m: month, d: resolved });
  }
  dates.sort(compareYmd);
  return dates;
}

function nthWeekday(year, month, ordinal, weekday) {
  const dim = daysInMonth(year, month);
  if (ordinal > 0) {
    const first = weekdayOf({ y: year, m: month, d: 1 });
    const day = 1 + ((weekday - first + 7) % 7) + (ordinal - 1) * 7;
    if (day > dim) return null;
    return { y: year, m: month, d: day };
  }
  if (ordinal < 0) {
    const last = weekdayOf({ y: year, m: month, d: dim });
    const day = dim - ((last - weekday + 7) % 7) + (ordinal + 1) * 7;
    if (day < 1) return null;
    return { y: year, m: month, d: day };
  }
  return null;
}

function pastUntil(master, date) {
  const until = master.rrule && master.rrule.until;
  if (!until) return false;
  if (master.allDay || until.allDay) return compareYmd(date, until) > 0;
  const instant = wallToUtc(master, stamp(master, date));
  const limit = wallToUtc({ allDay: false, zone: until.tz || "UTC" }, until);
  if (!instant || !limit) return false;
  return instant.getTime() > limit.getTime();
}

function stamp(master, date) {
  return {
    y: date.y,
    m: date.m,
    d: date.d,
    hh: master.startParts.hh,
    mm: master.startParts.mm,
    ss: master.startParts.ss,
    allDay: master.allDay,
    tz: master.zone,
  };
}

function materialize(event, startParts, window) {
  const title = event.summary || "(No title)";
  if (event.allDay) {
    const span = Math.max(1, daysBetween(event.startParts, event.endParts));
    const startDate = formatYmd(startParts);
    const endDate = formatYmd(addDays(startParts, span));
    if (!(startDate < window.endDate && endDate > window.startDate)) return null;
    return publicEvent(event, { allDay: true, start: null, end: null, startDate, endDate, title });
  }
  const start = wallToUtc(event, startParts);
  const end = wallToUtc(event, endWall(event, startParts));
  if (!start || !end || end <= start) return null;
  if (!(start < window.end && end > window.start)) return null;
  return publicEvent(event, {
    allDay: false,
    start: formatInTimeZone(start, TORONTO),
    end: formatInTimeZone(end, TORONTO),
    startDate: null,
    endDate: null,
    title,
  });
}

function publicEvent(event, fields) {
  return {
    uid: event.uid,
    title: fields.title,
    location: event.location || "",
    allDay: fields.allDay,
    start: fields.start,
    end: fields.end,
    startDate: fields.startDate,
    endDate: fields.endDate,
  };
}

function endWall(event, startParts) {
  const offset = daysBetween(event.startParts, event.endParts);
  const date = addDays(startParts, offset);
  return {
    ...date,
    hh: event.endParts.hh,
    mm: event.endParts.mm,
    ss: event.endParts.ss,
    tz: event.endParts.tz || event.zone,
  };
}

function occurrenceKey(event, parts) {
  if (!parts) return "";
  if (parts.allDay || event.allDay) return formatYmd(parts);
  const instant = wallToUtc(
    { allDay: false, zone: parts.tz === "UTC" ? "UTC" : (parts.tz || event.zone || TORONTO) },
    parts,
  );
  return instant ? instant.toISOString() : "";
}

function wallToUtc(holder, parts) {
  try {
    if (!parts || !validParts(parts)) return null;
    const zone = holder.zone || TORONTO;
    if (zone === "UTC") {
      return new Date(Date.UTC(parts.y, parts.m - 1, parts.d, parts.hh || 0, parts.mm || 0, parts.ss || 0));
    }
    return zonedWallTimeToUtc(
      { y: parts.y, m: parts.m, d: parts.d, hh: parts.hh || 0, mm: parts.mm || 0, ss: parts.ss || 0 },
      zone,
    );
  } catch {
    return null;
  }
}

function addSecondsToWall(holder, parts, seconds) {
  const start = wallToUtc(holder, parts);
  if (!start) return null;
  const end = new Date(start.getTime() + seconds * 1000);
  const zone = holder.zone || TORONTO;
  if (zone === "UTC") {
    return {
      y: end.getUTCFullYear(),
      m: end.getUTCMonth() + 1,
      d: end.getUTCDate(),
      hh: end.getUTCHours(),
      mm: end.getUTCMinutes(),
      ss: end.getUTCSeconds(),
      allDay: false,
      tz: "UTC",
    };
  }
  const zoned = zonedParts(end, zone);
  return { y: zoned.y, m: zoned.m, d: zoned.d, hh: zoned.hh, mm: zoned.mm, ss: zoned.ss, allDay: false, tz: zone };
}

function parseRrule(value) {
  const bag = {};
  for (const piece of String(value).split(";")) {
    const eq = piece.indexOf("=");
    if (eq === -1) continue;
    bag[piece.slice(0, eq).toUpperCase()] = piece.slice(eq + 1);
  }
  const freq = (bag.FREQ || "").toUpperCase();
  if (!["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(freq)) return null;
  const count = bag.COUNT != null && bag.COUNT !== "" ? Number(bag.COUNT) : null;
  return {
    freq,
    interval: Math.max(1, Number(bag.INTERVAL || 1) || 1),
    count: Number.isFinite(count) ? count : null,
    until: bag.UNTIL ? parseDateTime(bag.UNTIL, {}) : null,
    byday: bag.BYDAY ? bag.BYDAY.split(",").map((day) => day.toUpperCase()) : null,
    bymonthday: bag.BYMONTHDAY
      ? bag.BYMONTHDAY.split(",").map(Number).filter((day) => Number.isFinite(day))
      : null,
    wkst: (bag.WKST || "MO").toUpperCase(),
  };
}

function parseDateTime(value, params) {
  const raw = String(value || "").trim();
  const dateOnly = String((params && params.VALUE) || "").toUpperCase() === "DATE" || /^\d{8}$/.test(raw);
  if (dateOnly) {
    const match = raw.match(/^(\d{4})(\d{2})(\d{2})/);
    if (!match) return null;
    return {
      allDay: true,
      y: Number(match[1]),
      m: Number(match[2]),
      d: Number(match[3]),
      hh: 0,
      mm: 0,
      ss: 0,
      tz: null,
    };
  }
  const match = raw.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/);
  if (!match) return null;
  return {
    allDay: false,
    y: Number(match[1]),
    m: Number(match[2]),
    d: Number(match[3]),
    hh: Number(match[4]),
    mm: Number(match[5]),
    ss: Number(match[6]),
    tz: match[7] === "Z" ? "UTC" : ((params && params.TZID) || null),
  };
}

function parseLine(line) {
  if (!line) return null;
  let i = 0;
  while (i < line.length && line[i] !== ";" && line[i] !== ":") i += 1;
  const name = line.slice(0, i).toUpperCase();
  if (!name) return null;
  const params = {};
  while (line[i] === ";") {
    i += 1;
    const keyStart = i;
    while (i < line.length && line[i] !== "=" && line[i] !== ";" && line[i] !== ":") i += 1;
    const key = line.slice(keyStart, i).toUpperCase();
    let value = "";
    if (line[i] === "=") {
      i += 1;
      if (line[i] === '"') {
        i += 1;
        const start = i;
        while (i < line.length && line[i] !== '"') i += 1;
        value = line.slice(start, i);
        if (line[i] === '"') i += 1;
      } else {
        const start = i;
        while (i < line.length && line[i] !== ";" && line[i] !== ":") i += 1;
        value = line.slice(start, i);
      }
    }
    if (key) params[key] = value;
  }
  if (line[i] !== ":") return null;
  return { name, params, value: unescapeText(line.slice(i + 1)) };
}

function unescapeText(value) {
  let out = "";
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] === "\\" && i + 1 < value.length) {
      const next = value[i + 1];
      if (next === "n" || next === "N") out += " ";
      else out += next;
      i += 1;
    } else {
      out += value[i];
    }
  }
  return out;
}

function durationSeconds(value) {
  const match = String(value).match(/^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!match) return null;
  return (
    Number(match[1] || 0) * 7 * 86400
    + Number(match[2] || 0) * 86400
    + Number(match[3] || 0) * 3600
    + Number(match[4] || 0) * 60
    + Number(match[5] || 0)
  );
}

function validParts(parts) {
  if (!parts || parts.m < 1 || parts.m > 12 || parts.d < 1 || parts.d > daysInMonth(parts.y, parts.m)) return false;
  if (parts.hh < 0 || parts.hh > 23 || parts.mm < 0 || parts.mm > 59 || parts.ss < 0 || parts.ss > 59) return false;
  return true;
}

function weekdayOf(parts) {
  return new Date(Date.UTC(parts.y, parts.m - 1, parts.d)).getUTCDay();
}

function dayCodeFromParts(parts) {
  return ["SU", "MO", "TU", "WE", "TH", "FR", "SA"][weekdayOf(parts)];
}

function dayCode(token) {
  const match = String(token || "").toUpperCase().match(/(SU|MO|TU|WE|TH|FR|SA)$/);
  return match ? match[1] : null;
}

function startOfWeek(parts, wkst) {
  const delta = (weekdayOf(parts) - (WEEKDAYS[wkst] ?? 1) + 7) % 7;
  return addDays(parts, -delta);
}

function compareEvents(a, b) {
  const as = a.allDay ? a.startDate : a.start;
  const bs = b.allDay ? b.startDate : b.start;
  if (as < bs) return -1;
  if (as > bs) return 1;
  return String(a.title).localeCompare(String(b.title));
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 300);
}
