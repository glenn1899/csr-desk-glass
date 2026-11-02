import {
  TORONTO,
  addDays,
  formatInTimeZone,
  formatYmd,
  zonedParts,
  zonedWallTimeToUtc,
} from "./time.js";

export const SAMPLE_NOTICE = "Sample calendar. No real calendar is connected.";

export function sampleEvents(now) {
  const parts = zonedParts(now, TORONTO);
  const today = formatYmd(parts);
  const tomorrowParts = addDays(parts, 1);
  const tomorrow = formatYmd(tomorrowParts);
  const events = [
    {
      id: "sample-all-day",
      title: "Sample: Focus day",
      allDay: true,
      start: null,
      end: null,
      startDate: today,
      endDate: tomorrow,
      location: "",
    },
    timed("sample-current", "Sample: Current block", now, -20, 40),
    timed("sample-next", "Sample: Up next", now, 70, 115),
  ];
  const laterStart = new Date(now.getTime() + 180 * 60000);
  if (formatYmd(zonedParts(laterStart, TORONTO)) === today) {
    events.push(timed("sample-later", "Sample: Later today", now, 180, 240));
  }
  const morning = zonedWallTimeToUtc({ ...tomorrowParts, hh: 9, mm: 30, ss: 0 }, TORONTO);
  const morningEnd = zonedWallTimeToUtc({ ...tomorrowParts, hh: 10, mm: 0, ss: 0 }, TORONTO);
  if (morning.getTime() - now.getTime() > 4 * 60 * 60 * 1000) {
    events.push({
      id: "sample-tomorrow",
      title: "Sample: Tomorrow morning",
      allDay: false,
      start: formatInTimeZone(morning, TORONTO),
      end: formatInTimeZone(morningEnd, TORONTO),
      startDate: null,
      endDate: null,
      location: "",
    });
  }
  return events;
}

function timed(id, title, now, startOffsetMin, endOffsetMin) {
  const start = new Date(now.getTime() + startOffsetMin * 60000);
  const end = new Date(now.getTime() + endOffsetMin * 60000);
  return {
    id,
    title,
    allDay: false,
    start: formatInTimeZone(start, TORONTO),
    end: formatInTimeZone(end, TORONTO),
    startDate: null,
    endDate: null,
    location: "",
  };
}
