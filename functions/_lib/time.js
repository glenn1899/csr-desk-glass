export const TORONTO = "America/Toronto";
export const WINDOW_DAYS = 14;

export function zonedParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "longOffset",
  }).formatToParts(date);
  const pick = (type) => {
    const found = parts.find((part) => part.type === type);
    return found ? found.value : "";
  };
  let year = Number(pick("year"));
  let month = Number(pick("month"));
  let day = Number(pick("day"));
  let hour = Number(pick("hour"));
  if (hour === 24) {
    hour = 0;
    const rolled = new Date(Date.UTC(year, month - 1, day + 1));
    year = rolled.getUTCFullYear();
    month = rolled.getUTCMonth() + 1;
    day = rolled.getUTCDate();
  }
  return {
    y: year,
    m: month,
    d: day,
    hh: hour,
    mm: Number(pick("minute")),
    ss: Number(pick("second")),
    offsetMinutes: offsetFromTimeZoneName(pick("timeZoneName")),
  };
}

export function offsetFromTimeZoneName(name) {
  const match = String(name || "").match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  if (!match) return 0;
  const sign = match[1] === "-" ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3] || 0));
}

export function formatInTimeZone(date, timeZone) {
  const parts = zonedParts(date, timeZone);
  const sign = parts.offsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(parts.offsetMinutes);
  const hours = String(Math.floor(abs / 60)).padStart(2, "0");
  const minutes = String(abs % 60).padStart(2, "0");
  return `${formatYmd(parts)}T${pad(parts.hh)}:${pad(parts.mm)}:${pad(parts.ss)}${sign}${hours}:${minutes}`;
}

export function formatYmd(parts) {
  return `${parts.y}-${pad(parts.m)}-${pad(parts.d)}`;
}

export function pad(value) {
  return String(value).padStart(2, "0");
}

export function addDays(parts, days) {
  const date = new Date(Date.UTC(parts.y, parts.m - 1, parts.d + days));
  return { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate() };
}

export function compareYmd(a, b) {
  if (a.y !== b.y) return a.y - b.y;
  if (a.m !== b.m) return a.m - b.m;
  return a.d - b.d;
}

export function daysBetween(a, b) {
  const start = Date.UTC(a.y, a.m - 1, a.d);
  const end = Date.UTC(b.y, b.m - 1, b.d);
  return Math.round((end - start) / 86400000);
}

export function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function parseYmd(value) {
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
}

// Wall-clock time in an IANA zone, as a UTC instant. Two passes settle
// daylight-saving differences between the guess and the resulting instant.
export function zonedWallTimeToUtc(parts, timeZone) {
  if (timeZone === "UTC" || timeZone === "Etc/UTC" || timeZone === "Z") {
    return new Date(Date.UTC(parts.y, parts.m - 1, parts.d, parts.hh, parts.mm, parts.ss));
  }
  const wall = Date.UTC(parts.y, parts.m - 1, parts.d, parts.hh, parts.mm, parts.ss);
  let utc = wall;
  for (let pass = 0; pass < 3; pass++) {
    const offset = zonedParts(new Date(utc), timeZone).offsetMinutes;
    const next = wall - offset * 60000;
    if (next === utc) break;
    utc = next;
  }
  return new Date(utc);
}

export function torontoWindow(now) {
  const parts = zonedParts(now, TORONTO);
  const start = zonedWallTimeToUtc({ y: parts.y, m: parts.m, d: parts.d, hh: 0, mm: 0, ss: 0 }, TORONTO);
  const endParts = addDays(parts, WINDOW_DAYS);
  const end = zonedWallTimeToUtc({ y: endParts.y, m: endParts.m, d: endParts.d, hh: 0, mm: 0, ss: 0 }, TORONTO);
  return {
    start,
    end,
    startDate: formatYmd(parts),
    endDate: formatYmd(endParts),
  };
}
