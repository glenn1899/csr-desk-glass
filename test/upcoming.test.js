import assert from "node:assert/strict";
import test from "node:test";
import html from "../public/index.html";

function loadUpcoming() {
  const start = html.indexOf("/* upcoming */");
  const end = html.indexOf("/* upcoming-end */");
  assert.ok(start >= 0 && end > start);
  return new Function(`${html.slice(start, end)}; return { nextYmd, dayHeading, nextThree };`)();
}

const { nextYmd, dayHeading, nextThree } = loadUpcoming();

const NOW = Date.parse("2026-11-02T16:00:00Z");
const TODAY = "2026-11-02";

function timed(title, start, end, extra) {
  return { title, allDay: false, start, end, day: start.slice(0, 10), ...extra };
}

test("the card keeps the next three events from either calendar", () => {
  const picked = nextThree([
    timed("Already over", "2026-11-02T09:00:00-05:00", "2026-11-02T09:30:00-05:00", { calendar: "Primary" }),
    timed("Client call", "2026-11-02T11:30:00-05:00", "2026-11-02T12:00:00-05:00", { calendar: "Primary" }),
    timed("Team standup", "2026-11-03T09:00:00-05:00", "2026-11-03T09:30:00-05:00", { calendar: "Broker Support Team", team: true }),
    timed("Renewals", "2026-11-03T11:00:00-05:00", "2026-11-03T11:30:00-05:00", { calendar: "Broker Support Team", team: true }),
    timed("Thursday review", "2026-11-05T15:00:00-05:00", "2026-11-05T15:30:00-05:00", { calendar: "Primary" }),
  ], NOW, TODAY);
  assert.deepEqual(picked.map((item) => item.ev.title), ["Client call", "Team standup", "Renewals"]);
  assert.deepEqual(picked.map((item) => item.day), [TODAY, "2026-11-03", "2026-11-03"]);
});

test("an event in progress counts, and an empty list stays empty", () => {
  const picked = nextThree([
    timed("In progress", "2026-11-02T10:00:00-05:00", "2026-11-02T12:00:00-05:00"),
    timed("Later", "2026-11-02T13:00:00-05:00", "2026-11-02T13:30:00-05:00"),
  ], NOW, TODAY);
  assert.deepEqual(picked.map((item) => item.ev.title), ["In progress", "Later"]);
  assert.deepEqual(nextThree([], NOW, TODAY), []);
});

test("later days are labelled TOMORROW or a short weekday", () => {
  assert.equal(nextYmd(TODAY), "2026-11-03");
  assert.equal(dayHeading(TODAY, TODAY), "");
  assert.equal(dayHeading("2026-11-03", TODAY), "TOMORROW");
  assert.equal(dayHeading("2026-11-05", TODAY), "THU 5");
});
