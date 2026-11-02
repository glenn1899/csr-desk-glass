import assert from "node:assert/strict";
import test from "node:test";
import {
  TORONTO,
  formatInTimeZone,
  torontoWindow,
  zonedWallTimeToUtc,
} from "../functions/_lib/time.js";

test("winter wall time in Toronto is UTC-5", () => {
  const instant = zonedWallTimeToUtc({ y: 2026, m: 1, d: 15, hh: 12, mm: 0, ss: 0 }, TORONTO);
  assert.equal(instant.toISOString(), "2026-01-15T17:00:00.000Z");
  assert.equal(formatInTimeZone(instant, TORONTO), "2026-01-15T12:00:00-05:00");
});

test("summer wall time in Toronto is UTC-4", () => {
  const instant = zonedWallTimeToUtc({ y: 2026, m: 7, d: 1, hh: 11, mm: 0, ss: 0 }, TORONTO);
  assert.equal(instant.toISOString(), "2026-07-01T15:00:00.000Z");
  assert.equal(formatInTimeZone(instant, TORONTO), "2026-07-01T11:00:00-04:00");
});

test("a UTC instant formats as Eastern, including midnight", () => {
  assert.equal(formatInTimeZone(new Date("2026-11-02T14:30:00Z"), TORONTO), "2026-11-02T09:30:00-05:00");
  assert.equal(formatInTimeZone(new Date("2026-07-01T15:00:00Z"), TORONTO), "2026-07-01T11:00:00-04:00");
  assert.equal(formatInTimeZone(new Date("2026-11-02T05:00:00Z"), TORONTO), "2026-11-02T00:00:00-05:00");
});

test("the hour after the autumn clock change is standard time", () => {
  const instant = zonedWallTimeToUtc({ y: 2026, m: 11, d: 1, hh: 3, mm: 0, ss: 0 }, TORONTO);
  assert.equal(instant.toISOString(), "2026-11-01T08:00:00.000Z");
  assert.equal(formatInTimeZone(instant, TORONTO), "2026-11-01T03:00:00-05:00");
});

test("the hour before the spring clock change is still standard time", () => {
  const before = zonedWallTimeToUtc({ y: 2026, m: 3, d: 8, hh: 1, mm: 30, ss: 0 }, TORONTO);
  const after = zonedWallTimeToUtc({ y: 2026, m: 3, d: 8, hh: 3, mm: 30, ss: 0 }, TORONTO);
  assert.equal(before.toISOString(), "2026-03-08T06:30:00.000Z");
  assert.equal(after.toISOString(), "2026-03-08T07:30:00.000Z");
});

test("a clock time in the spring-forward gap is not invented", () => {
  assert.equal(zonedWallTimeToUtc({ y: 2026, m: 3, d: 8, hh: 2, mm: 30, ss: 0 }, TORONTO), null);
  assert.equal(zonedWallTimeToUtc({ y: 2026, m: 3, d: 8, hh: 2, mm: 0, ss: 0 }, TORONTO), null);
});

test("the repeated autumn hour keeps the earlier instant", () => {
  const instant = zonedWallTimeToUtc({ y: 2026, m: 11, d: 1, hh: 1, mm: 30, ss: 0 }, TORONTO);
  assert.equal(instant.toISOString(), "2026-11-01T05:30:00.000Z");
  assert.equal(formatInTimeZone(instant, TORONTO), "2026-11-01T01:30:00-04:00");
});

test("the schedule window starts at Toronto midnight and runs 14 days", () => {
  const window = torontoWindow(new Date("2026-11-02T14:30:00Z"));
  assert.equal(window.startDate, "2026-11-02");
  assert.equal(window.endDate, "2026-11-16");
  assert.equal(window.start.toISOString(), "2026-11-02T05:00:00.000Z");
  assert.equal(window.end.toISOString(), "2026-11-16T05:00:00.000Z");
});
