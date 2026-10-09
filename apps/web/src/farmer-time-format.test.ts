import test from "node:test";
import assert from "node:assert/strict";
import { shortStamp, stamp } from "./farmer/time-format.ts";

test("one farm-time format for every timestamp", () => {
  assert.equal(stamp("2026-09-23T06:20:44Z"), "2026.09.23 15:20");
  assert.equal(stamp("2026-09-22T15:05:00Z"), "2026.09.23 00:05");
  assert.equal(stamp(null), "-");
  assert.equal(stamp("not a date"), "-");
});

test("today drops the date, other days drop the year", () => {
  const now = new Date("2026-09-23T07:00:00Z");
  assert.equal(shortStamp("2026-09-23T06:20:00Z", now), "15:20");
  assert.equal(shortStamp("2026-09-22T02:43:00Z", now), "09.22 11:43");
});
