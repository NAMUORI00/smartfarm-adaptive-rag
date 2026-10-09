import test from "node:test";
import assert from "node:assert/strict";
import { L, place, prose, setLang, term } from "./farmer/i18n.ts";

test("Korean is the default and returns the Korean wording", () => {
  assert.equal(L("종합 현황", "Overview"), "종합 현황");
  assert.equal(place("A구역"), "A구역");
});

test("English converts places, farm names and fixed alert sentences", () => {
  setLang("en");
  try {
    assert.equal(L("종합 현황", "Overview"), "Overview");
    assert.equal(place("4번 베드"), "Bed 4");
    assert.equal(place("A구역"), "Zone A");
    assert.equal(term("고추냉이 고설베드 A동"), "Wasabi raised-bed House A");
    assert.equal(prose("근권 온도가 시범 운영 재배 기준 범위를 크게 벗어났습니다."), "Root-zone temperature is far outside the trial range.");
    assert.match(prose("온도 센서 값이 물리 허용 범위를 벗어났습니다. 센서, 배선, 통신 상태를 먼저 점검하세요."), /physically possible range/);
    assert.equal(prose("알 수 없는 문장"), "알 수 없는 문장");
  } finally {
    setLang("ko");
  }
});

test("backend sentences are translated whole or kept whole, never mixed word by word", async () => {
  const { backendText, setLang } = await import("./farmer/i18n.ts");
  setLang("en");
  try {
    assert.equal(backendText("온도 센서 값이 물리 허용 범위를 벗어났습니다. 센서, 배선, 통신 상태를 먼저 점검하세요."), "The temperature sensor reading is outside the physically possible range. Check the sensor, wiring and communication first.");
    assert.equal(backendText("재배실 온도와 근권 온도의 차이가 비정상적으로 큽니다. 작물 위험 판단 전에 센서 상태를 점검하세요."), "The gap between Room temperature and Root-zone temperature is abnormally large. Check the sensors before judging crop risk.");
    assert.equal(backendText("재배실 온도가 시범 운영 recipe 상한을 벗어났습니다."), "Room temperature is above the trial upper limit.");
    // An unknown sentence stays Korean rather than turning into "Temperature sensor 값이 …".
    const unknown = "온도 센서 값이 이상하게 흔들립니다.";
    assert.equal(backendText(unknown), unknown);
    assert.equal(backendText("근권 온도"), "Root-zone temperature");
    // The parts of a structured answer read in English, so a rewritten part is legible.
    assert.equal(backendText("재배실 온도 65°C (관측 확인 필요) · 근권 온도 16°C (기준 범위)"), "Room temperature 65°C (reading needs a check) · Root-zone temperature 16°C (in range)");
    assert.equal(backendText("상태가 달라졌습니다. 필요한 조절을 다시 확인한 뒤 허용해 주세요."), "Conditions changed. Review the needed adjustment again before allowing it.");
  } finally {
    setLang("ko");
  }
  assert.equal(backendText("재배실 온도가 시범 운영 recipe 상한을 벗어났습니다."), "재배실 온도가 시범 운영 재배 기준 상한을 벗어났습니다.");
});
