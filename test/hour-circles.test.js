import assert from "node:assert/strict";
import test from "node:test";
import html from "../public/index.html";

function loadCircles() {
  const start = html.indexOf("/* hour-circles */");
  const end = html.indexOf("/* hour-circles-end */");
  assert.ok(start >= 0 && end > start);
  return new Function(`${html.slice(start, end)}; return { blockSpanMinutes, hourCircles };`)();
}

const { blockSpanMinutes, hourCircles } = loadCircles();

test("a one hour block is one circle, half full at 30 minutes left", () => {
  const marks = hourCircles(60, 30 * 60);
  assert.deepEqual(marks, [{ size: 1, fill: 0.5 }]);
});

test("a four hour block at 3.5 hours left is three full circles and one half", () => {
  const marks = hourCircles(240, 3.5 * 3600);
  assert.equal(marks.length, 4);
  assert.ok(marks.every((mark) => mark.size === 1));
  assert.equal(marks[0].fill, 0.5);
  assert.deepEqual(marks.slice(1).map((mark) => mark.fill), [1, 1, 1]);
});

test("a 90 minute block adds a half-size circle for the extra 30 minutes", () => {
  const full = hourCircles(90, 90 * 60);
  assert.deepEqual(full.map((mark) => mark.size), [1, 0.5]);
  assert.deepEqual(full.map((mark) => mark.fill), [1, 1]);

  const halfHourLeft = hourCircles(90, 30 * 60);
  assert.deepEqual(halfHourLeft.map((mark) => mark.fill), [0, 1]);

  const quarter = hourCircles(90, 15 * 60);
  assert.equal(quarter[0].fill, 0);
  assert.equal(quarter[1].fill, 0.5);
});

test("time left is clamped to the block, and a finished block is empty", () => {
  assert.deepEqual(hourCircles(60, 5 * 3600), [{ size: 1, fill: 1 }]);
  assert.deepEqual(hourCircles(60, 0), [{ size: 1, fill: 0 }]);
  assert.equal(hourCircles(10, 10 * 60)[0].size, 10 / 60);
});

test("planner blocks use their scheduled length, including a partial last hour", () => {
  assert.equal(blockSpanMinutes({ start: 570, end: 630 }), 60);
  assert.equal(blockSpanMinutes({ start: 630, end: 870 }), 240);
  assert.equal(blockSpanMinutes({ start: 0, end: 570, from: 480 }), 90);
});
