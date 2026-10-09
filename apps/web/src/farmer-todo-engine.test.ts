import test from "node:test";
import assert from "node:assert/strict";
import { buildTodos, shortAlertTitle } from "./farmer/todo-engine.ts";
import type { TodoInput } from "./farmer/todo-engine.ts";
import { setLang } from "./farmer/i18n.ts";

const zoneLabel = (id?: string | null) => (id === "zone-a" ? "A구역" : id === "zone-b" ? "B구역" : "농장");
const quiet: TodoInput = {
  connected: true, alerts: [], observationProblem: false, pendingControls: 0,
  activeCases: 0, patrolOpen: 0, adviceStale: false, plannedHarvests: 0, zoneLabel,
};
const alert = (severity: "critical" | "warning" | "info", zoneId: string | null, title = "근권 온도 경보") =>
  ({ occurrenceId: `${zoneId}:${title}:${severity}`, severity, title, zoneId });

test("a lost connection outranks every other item", () => {
  const todos = buildTodos({ ...quiet, connected: false, alerts: [alert("critical", "zone-a")], pendingControls: 2 });
  assert.equal(todos[0].kind, "reconnect");
  assert.equal(todos[0].action, "다시 연결");
  assert.equal(todos[0].tone, "attention");
});

test("a critical zone comes before an unconfirmed control, which comes before warnings", () => {
  const todos = buildTodos({ ...quiet, alerts: [alert("warning", "zone-b"), alert("critical", "zone-a")], pendingControls: 1 });
  assert.deepEqual(todos.map((t) => t.kind), ["zone", "pending", "zone", "crop"].slice(0, 3));
  assert.equal(todos[0].zoneId, "zone-a");
  assert.equal(todos[2].zoneId, "zone-b");
});

test("alerts of one zone collapse into a single item that names the count", () => {
  const todos = buildTodos({ ...quiet, alerts: [alert("warning", "zone-a", "습도 경보"), alert("critical", "zone-a"), alert("info", "zone-a", "장치 점검")] });
  const zone = todos.filter((t) => t.kind === "zone");
  assert.equal(zone.length, 1);
  assert.equal(zone[0].title, "A구역 / 근권 온도 외 2건");
  assert.equal(zone[0].action, "A구역 보기");
  assert.equal(zone[0].icon, "warning");
  assert.equal(zone[0].tone, "danger");
});

test("the first line names the place and the thing to check, not the operator alert title", () => {
  assert.equal(shortAlertTitle("재배실 온도 센서 건전성 경보"), "재배실 온도 센서 확인");
  assert.equal(shortAlertTitle("근권 온도 경보"), "근권 온도");
  const todos = buildTodos({ ...quiet, alerts: [{ ...alert("warning", "zone-a", "재배실 온도 센서 건전성 경보"), kind: "sensor_health" }] });
  assert.equal(todos[0].title, "A구역 / 재배실 온도 센서 확인");
  assert.match(todos[0].detail, /센서와 배선/);
});

test("two notices with the same title count as one problem", () => {
  const todos = buildTodos({ ...quiet, alerts: [alert("warning", "zone-a", "재배실 온도 센서 건전성 경보"), { ...alert("warning", "zone-a", "재배실 온도 센서 건전성 경보"), occurrenceId: "second" }] });
  assert.equal(todos[0].title, "A구역 / 재배실 온도 센서 확인");
});

test("open patrol records become the primary action when nothing else is wrong", () => {
  const todos = buildTodos({ ...quiet, patrolOpen: 2 });
  assert.equal(todos[0].kind, "camera");
  assert.match(todos[0].title, /카메라 확인 기록 2건/);
});

test("stale advice and active cases are listed after observation problems", () => {
  const todos = buildTodos({ ...quiet, observationProblem: true, adviceStale: true, activeCases: 1 });
  assert.deepEqual(todos.map((t) => t.kind), ["state", "advisor", "records"]);
});

test("a quiet farm offers exactly one calm item pointing at the harvest schedule", () => {
  const todos = buildTodos({ ...quiet, plannedHarvests: 3 });
  assert.equal(todos.length, 1);
  assert.equal(todos[0].kind, "crop");
  assert.equal(todos[0].tone, "ok");
  assert.equal(todos[0].title, "이상 없음");
  assert.match(todos[0].detail, /3건/);
});

test("observation problems are not repeated while the connection itself is down", () => {
  const todos = buildTodos({ ...quiet, connected: false, observationProblem: true });
  assert.deepEqual(todos.map((t) => t.kind), ["reconnect"]);
});

test("before the first reply the list says it is connecting, not lost or fine", () => {
  const items = buildTodos({ connected: false, connecting: true, alerts: [], observationProblem: false, pendingControls: 0, activeCases: 0, patrolOpen: 0, adviceStale: false, plannedHarvests: 2, zoneLabel: () => "" });
  assert.equal(items.length, 1);
  assert.equal(items[0].id, "connecting");
  assert.doesNotMatch(items[0].title, /끊김|이상 없음/);
});

test("in English the list uses English wording and English place names", () => {
  setLang("en");
  try {
    const lost = buildTodos({ ...quiet, connected: false });
    assert.equal(lost[0].title, "Farm data disconnected");
    assert.equal(lost[0].action, "Reconnect");
    const zone = buildTodos({ ...quiet, alerts: [alert("warning", "zone-a", "습도 경보"), alert("critical", "zone-a")] });
    assert.equal(zone[0].title, "Zone A / Root-zone temperature and 1 more");
    assert.equal(zone[0].action, "Open Zone A");
    assert.equal(buildTodos(quiet)[0].title, "No issues");
    assert.equal(buildTodos({ ...quiet, pendingControls: 1 })[0].title, "1 equipment change awaiting response");
  } finally {
    setLang("ko");
  }
});
