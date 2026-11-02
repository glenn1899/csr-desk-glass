import assert from "node:assert/strict";
import test from "node:test";
import html from "../public/index.html";

function loadGrid() {
  const start = html.indexOf("/* month-grid */");
  const end = html.indexOf("/* month-grid-end */");
  assert.ok(start >= 0 && end > start);
  return new Function(`${html.slice(start, end)}; return { monthCells };`)();
}

const { monthCells } = loadGrid();

function ymds(cells) {
  return cells.map((cell) => cell.ymd);
}

test("every month is a fixed 6 by 7 grid", () => {
  for (let month = 1; month <= 12; month++) {
    const cells = monthCells(2026, month, "2026-01-01");
    assert.equal(cells.length, 42);
    assert.equal(new Set(ymds(cells)).size, 42);
  }
});

test("February 2026 starts on Sunday, so the grid opens on the 1st", () => {
  const cells = monthCells(2026, 2, "2026-02-14");
  assert.equal(cells[0].ymd, "2026-02-01");
  assert.equal(cells[0].inMonth, true);
  assert.equal(cells[27].ymd, "2026-02-28");
  assert.equal(cells[28].ymd, "2026-03-01");
  assert.equal(cells[28].inMonth, false);
  assert.equal(cells[41].ymd, "2026-03-14");
  assert.deepEqual(cells.filter((cell) => cell.today).map((cell) => cell.ymd), ["2026-02-14"]);
});

test("August 2026 starts on Saturday, so six July days lead the grid", () => {
  const cells = monthCells(2026, 8, "2026-08-01");
  assert.deepEqual(ymds(cells).slice(0, 7), [
    "2026-07-26",
    "2026-07-27",
    "2026-07-28",
    "2026-07-29",
    "2026-07-30",
    "2026-07-31",
    "2026-08-01",
  ]);
  assert.equal(cells[6].inMonth, true);
  assert.equal(cells[5].inMonth, false);
  assert.equal(cells[36].ymd, "2026-08-31");
  assert.equal(cells[37].ymd, "2026-09-01");
  assert.equal(cells[37].inMonth, false);
  assert.equal(cells[6].today, true);
  assert.equal(cells.filter((cell) => cell.today).length, 1);
});

test("a month that starts on Monday still keeps Sunday in the first column", () => {
  const cells = monthCells(2026, 6, "2026-06-15");
  assert.equal(cells[0].ymd, "2026-05-31");
  assert.equal(cells[0].inMonth, false);
  assert.equal(cells[1].ymd, "2026-06-01");
  assert.equal(cells[1].inMonth, true);
  assert.equal(cells[15].today, true);
  assert.equal(cells[15].day, 15);
});
