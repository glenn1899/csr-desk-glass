import assert from "node:assert/strict";
import test from "node:test";
import { parseIcs } from "../functions/_lib/ics.js";
import { TORONTO, zonedWallTimeToUtc } from "../functions/_lib/time.js";

function windowBetween(startDate, endDate) {
  const [ys, ms, ds] = startDate.split("-").map(Number);
  const [ye, me, de] = endDate.split("-").map(Number);
  return {
    start: zonedWallTimeToUtc({ y: ys, m: ms, d: ds, hh: 0, mm: 0, ss: 0 }, TORONTO),
    end: zonedWallTimeToUtc({ y: ye, m: me, d: de, hh: 0, mm: 0, ss: 0 }, TORONTO),
    startDate,
    endDate,
  };
}

function calendar(body) {
  return `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${body}\r\nEND:VCALENDAR\r\n`;
}

const november = windowBetween("2026-11-02", "2026-11-16");

test("UTC timestamps are shown in Eastern time", () => {
  const events = parseIcs(calendar(`
BEGIN:VEVENT
UID:utc-block
SUMMARY:UTC block
DTSTART:20261102T143000Z
DTEND:20261102T153000Z
END:VEVENT`), november);
  assert.equal(events.length, 1);
  assert.equal(events[0].title, "UTC block");
  assert.equal(events[0].start, "2026-11-02T09:30:00-05:00");
  assert.equal(events[0].end, "2026-11-02T10:30:00-05:00");
  assert.equal(events[0].allDay, false);
});

test("a Toronto wall time stays on the Eastern clock", () => {
  const events = parseIcs(calendar(`
BEGIN:VEVENT
UID:local-block
SUMMARY:Desk block
DTSTART;TZID=America/Toronto:20261102T093000
DTEND;TZID=America/Toronto:20261102T103000
END:VEVENT`), november);
  assert.equal(events[0].start, "2026-11-02T09:30:00-05:00");
  assert.equal(events[0].end, "2026-11-02T10:30:00-05:00");
});

test("a Los Angeles event is converted to Eastern time", () => {
  const winter = parseIcs(calendar(`
BEGIN:VEVENT
UID:la-winter
SUMMARY:West coast
DTSTART;TZID=America/Los_Angeles:20261102T090000
DTEND;TZID=America/Los_Angeles:20261102T100000
END:VEVENT`), november);
  assert.equal(winter[0].start, "2026-11-02T12:00:00-05:00");
  assert.equal(winter[0].end, "2026-11-02T13:00:00-05:00");

  const summer = parseIcs(calendar(`
BEGIN:VEVENT
UID:la-summer
SUMMARY:West coast summer
DTSTART;TZID=America/Los_Angeles:20260701T090000
DTEND;TZID=America/Los_Angeles:20260701T100000
END:VEVENT`), windowBetween("2026-07-01", "2026-07-15"));
  assert.equal(summer[0].start, "2026-07-01T12:00:00-04:00");
  assert.equal(summer[0].end, "2026-07-01T13:00:00-04:00");
});

test("a floating time is read as Eastern time", () => {
  const events = parseIcs(calendar(`
BEGIN:VEVENT
UID:floating
SUMMARY:Floating
DTSTART:20261102T093000
DTEND:20261102T100000
END:VEVENT`), november);
  assert.equal(events[0].start, "2026-11-02T09:30:00-05:00");
});

test("all-day dates stay on the calendar date", () => {
  const events = parseIcs(calendar(`
BEGIN:VEVENT
UID:all-day
SUMMARY:Focus day
DTSTART;VALUE=DATE:20261102
DTEND;VALUE=DATE:20261104
END:VEVENT`), november);
  assert.equal(events.length, 1);
  assert.equal(events[0].allDay, true);
  assert.equal(events[0].startDate, "2026-11-02");
  assert.equal(events[0].endDate, "2026-11-04");
  assert.equal(events[0].start, null);
});

test("folded lines and escaped commas are joined", () => {
  const events = parseIcs(calendar([
    "BEGIN:VEVENT",
    "UID:folded",
    "SUMMARY:Sample: Planning\\, review ",
    " and notes",
    "DTSTART;TZID=America/Toronto:20261102T110000",
    "DTEND;TZID=America/Toronto:20261102T113000",
    "END:VEVENT",
  ].join("\r\n")), november);
  assert.equal(events[0].title, "Sample: Planning, review and notes");
});

test("cancelled events and attendee lines are omitted", () => {
  const events = parseIcs(calendar(`
BEGIN:VEVENT
UID:kept@example.com
SUMMARY:Kept
DTSTART:20261102T150000Z
DTEND:20261102T160000Z
ATTENDEE:mailto:person@example.com
END:VEVENT
BEGIN:VEVENT
UID:dropped
SUMMARY:Dropped
STATUS:CANCELLED
DTSTART:20261102T160000Z
DTEND:20261102T170000Z
END:VEVENT`), november);
  assert.equal(events.length, 1);
  assert.equal(events[0].title, "Kept");
  assert.equal(events[0].location, "");
  assert.equal(JSON.stringify({ title: events[0].title, location: events[0].location }).includes("person"), false);
});

test("a weekly rule keeps the same wall clock across the spring change", () => {
  const events = parseIcs(calendar(`
BEGIN:VEVENT
UID:dst-weekly
SUMMARY:Weekly at nine
DTSTART;TZID=America/Toronto:20260302T090000
DTEND;TZID=America/Toronto:20260302T100000
RRULE:FREQ=WEEKLY;BYDAY=MO
END:VEVENT`), windowBetween("2026-03-02", "2026-03-16"));
  assert.deepEqual(events.map((event) => event.start), [
    "2026-03-02T09:00:00-05:00",
    "2026-03-09T09:00:00-04:00",
  ]);
  assert.equal(events[1].end, "2026-03-09T10:00:00-04:00");
});

test("EXDATE removes one occurrence", () => {
  const events = parseIcs(calendar(`
BEGIN:VEVENT
UID:weekly-desk
SUMMARY:Weekly desk
DTSTART;TZID=America/Toronto:20261102T090000
DTEND;TZID=America/Toronto:20261102T093000
RRULE:FREQ=WEEKLY;BYDAY=MO,WE
EXDATE;TZID=America/Toronto:20261104T090000
END:VEVENT`), november);
  assert.deepEqual(events.map((event) => event.start), [
    "2026-11-02T09:00:00-05:00",
    "2026-11-09T09:00:00-05:00",
    "2026-11-11T09:00:00-05:00",
  ]);
});

test("COUNT stops a daily series", () => {
  const events = parseIcs(calendar(`
BEGIN:VEVENT
UID:daily-count
SUMMARY:Two days
DTSTART;TZID=America/Toronto:20261102T080000
DTEND;TZID=America/Toronto:20261102T083000
RRULE:FREQ=DAILY;COUNT=2
END:VEVENT`), november);
  assert.deepEqual(events.map((event) => event.start.slice(0, 10)), ["2026-11-02", "2026-11-03"]);
});

test("a monthly last-Friday rule lands on the last Friday", () => {
  const events = parseIcs(calendar(`
BEGIN:VEVENT
UID:last-friday
SUMMARY:Month end
DTSTART;TZID=America/Toronto:20261030T120000
DTEND;TZID=America/Toronto:20261030T130000
RRULE:FREQ=MONTHLY;BYDAY=-1FR
END:VEVENT`), windowBetween("2026-11-01", "2027-01-01"));
  assert.deepEqual(events.map((event) => event.start), [
    "2026-11-27T12:00:00-05:00",
    "2026-12-25T12:00:00-05:00",
  ]);
});

test("an exception replaces one occurrence", () => {
  const events = parseIcs(calendar(`
BEGIN:VEVENT
UID:series
SUMMARY:Standing
DTSTART;TZID=America/Toronto:20261102T140000
DTEND;TZID=America/Toronto:20261102T150000
RRULE:FREQ=WEEKLY;BYDAY=MO
END:VEVENT
BEGIN:VEVENT
UID:series
SUMMARY:Moved
RECURRENCE-ID;TZID=America/Toronto:20261109T140000
DTSTART;TZID=America/Toronto:20261109T160000
DTEND;TZID=America/Toronto:20261109T170000
END:VEVENT`), november);
  assert.deepEqual(events.map((event) => [event.title, event.start]), [
    ["Standing", "2026-11-02T14:00:00-05:00"],
    ["Moved", "2026-11-09T16:00:00-05:00"],
  ]);
});

test("an unknown time zone is skipped and the rest of the feed remains", () => {
  const events = parseIcs(calendar(`
BEGIN:VEVENT
UID:bad-zone
SUMMARY:Broken
DTSTART;TZID=Not/AZone:20261102T090000
DTEND;TZID=Not/AZone:20261102T100000
END:VEVENT
BEGIN:VEVENT
UID:good
SUMMARY:Kept
DTSTART:20261102T150000Z
DTEND:20261102T160000Z
END:VEVENT`), november);
  assert.deepEqual(events.map((event) => event.title), ["Kept"]);
});

test("a file that is not a calendar is rejected", () => {
  assert.throws(() => parseIcs("<html>not a calendar</html>", november), /Could not read the calendar feed/);
});

test("a meeting in the spring-forward gap is skipped", () => {
  const events = parseIcs(calendar(`
BEGIN:VEVENT
UID:gap-day
SUMMARY:Does not exist
DTSTART;TZID=America/Toronto:20260308T023000
DTEND;TZID=America/Toronto:20260308T024500
RRULE:FREQ=DAILY
END:VEVENT`), windowBetween("2026-03-08", "2026-03-11"));
  assert.deepEqual(events.map((event) => event.start), [
    "2026-03-09T02:30:00-04:00",
    "2026-03-10T02:30:00-04:00",
  ]);
});

test("monthly on the last day follows the short months", () => {
  const events = parseIcs(calendar(`
BEGIN:VEVENT
UID:month-end
SUMMARY:Last day
DTSTART;TZID=America/Toronto:20261031T090000
DTEND;TZID=America/Toronto:20261031T100000
RRULE:FREQ=MONTHLY;BYMONTHDAY=-1
END:VEVENT`), windowBetween("2026-11-01", "2027-03-01"));
  assert.deepEqual(events.map((event) => event.start.slice(0, 10)), [
    "2026-11-30",
    "2026-12-31",
    "2027-01-31",
    "2027-02-28",
  ]);
});

test("a leap-day birthday does not use up COUNT on missing years", () => {
  const events = parseIcs(calendar(`
BEGIN:VEVENT
UID:leap
SUMMARY:Leap birthday
DTSTART;VALUE=DATE:20200229
DTEND;VALUE=DATE:20200301
RRULE:FREQ=YEARLY;COUNT=2
END:VEVENT`), windowBetween("2020-01-01", "2030-01-01"));
  assert.deepEqual(events.map((event) => event.startDate), ["2020-02-29", "2024-02-29"]);
});

test("a reminder block cannot rename the event", () => {
  const events = parseIcs(calendar(`
BEGIN:VEVENT
UID:dentist
SUMMARY:Dentist
DESCRIPTION:Bring card
LOCATION:Clinic
DTSTART;TZID=America/Toronto:20261102T090000
DTEND;TZID=America/Toronto:20261102T100000
BEGIN:VALARM
ACTION:DISPLAY
DESCRIPTION:This is an event reminder
SUMMARY:Alarm title
TRIGGER:-PT30M
END:VALARM
END:VEVENT`), november);
  assert.equal(events.length, 1);
  assert.equal(events[0].title, "Dentist");
  assert.equal(events[0].location, "Clinic");
});

test("DURATION sets the end from the start", () => {
  const events = parseIcs(calendar(`
BEGIN:VEVENT
UID:duration
SUMMARY:Half hour
DTSTART;TZID=America/Toronto:20261102T130000
DURATION:PT30M
END:VEVENT`), november);
  assert.equal(events[0].start, "2026-11-02T13:00:00-05:00");
  assert.equal(events[0].end, "2026-11-02T13:30:00-05:00");
});
