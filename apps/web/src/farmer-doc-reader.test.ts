import test from "node:test";
import assert from "node:assert/strict";
import { bookKey, findSpan, isFileUrl, pageNumber, passagePlaces, segments, splitMarkers, textFragmentUrl } from "./farmer/doc-reader.ts";
import { isTelemetryPassage, parseTelemetryPassages, readableLocator } from "./farmer/readable-excerpt.ts";
import { setLang, term } from "./farmer/i18n.ts";

const CHUNK = "제2장 고추냉이  35\n재배 적지\n가. 물재배 적지\n일본에서 물고추냉이 주산지는 해발 400~500m에 경사도가 5~15% 정도이고 산\n림이 울창하며 북쪽을 향한 산간계곡이다. 생육 최적 온도는 12~15℃이고, 수온은\n12~13℃이다.";

test("the passage the advisor read is found again in its chunk, line breaks aside", () => {
  // The excerpt is the chunk's head with whitespace collapsed and a mark at the cut.
  const excerpt = "제2장 고추냉이 35 재배 적지 가. 물재배 적지 일본에서 물고추냉이 주산지는…";
  const span = findSpan(CHUNK, excerpt)!;
  assert.equal(span.start, 0);
  assert.equal(CHUNK.slice(span.start, span.end), "제2장 고추냉이  35\n재배 적지\n가. 물재배 적지\n일본에서 물고추냉이 주산지는");
});

test("a quoted sentence is found even when the server added a full stop or cut a page header", () => {
  const span = findSpan(CHUNK, "생육 최적 온도는 12~15℃이고, 수온은 12~13℃이다.")!;
  assert.equal(CHUNK.slice(span.start, span.end), "생육 최적 온도는 12~15℃이고, 수온은\n12~13℃이다.");
  const cut = findSpan(CHUNK, "…림이 울창하며 북쪽을 향한 산간계곡이다.")!;
  assert.equal(CHUNK.slice(cut.start, cut.end), "림이 울창하며 북쪽을 향한 산간계곡이다.");
  assert.equal(findSpan(CHUNK, "없는 문장입니다."), null);
  assert.equal(findSpan(CHUNK, ""), null);
});

test("marks cut the text into plain, read, retrieved and quoted pieces; the quote wins inside the read part", () => {
  const text = "가나다라마바사아자차";
  const parts = segments(text, [
    { start: 0, end: 10, kind: "retrieved" },
    { start: 0, end: 6, kind: "read" },
    { start: 2, end: 4, kind: "quote" },
  ]);
  assert.deepEqual(parts, [
    { text: "가나", kind: "read", start: 0, end: 2 },
    { text: "다라", kind: "quote", start: 2, end: 4 },
    { text: "마바", kind: "read", start: 4, end: 6 },
    { text: "사아자차", kind: "retrieved", start: 6, end: 10 },
  ]);
  assert.deepEqual(segments("abc", []), [{ text: "abc", kind: null, start: 0, end: 3 }]);
  // In the library's reader a searched word shows over a quoted sentence, and the current one over the rest.
  assert.deepEqual(segments("가나다라", [
    { start: 0, end: 4, kind: "quote" },
    { start: 1, end: 2, kind: "find" },
    { start: 2, end: 3, kind: "findnow" },
  ]).map((s) => s.kind), ["quote", "find", "findnow", "quote"]);
});

test("a web source opens with the passage highlighted; a file download opens as it is", () => {
  assert.equal(
    textFragmentUrl("https://rda.go.kr/a?x=1#top", "생육 최적 온도는 12~15℃이다."),
    "https://rda.go.kr/a?x=1#:~:text=" + encodeURIComponent("생육 최적 온도는 12~15℃이다"),
  );
  const long = textFragmentUrl("https://example.test/p", "one two three four five six seven eight nine ten");
  assert.equal(long, "https://example.test/p#:~:text=one%20two%20three%20four,seven%20eight%20nine%20ten");
  assert.equal(textFragmentUrl("https://example.test/p", "12-15 degrees, and more"), "https://example.test/p#:~:text=12%2D15%20degrees%2C%20and%20more");
  const pdf = "https://www.nongsaro.go.kr/portal/ps/psb/psbx/cropsEbookWonFileDownload.do?ebookCode=57&pageNumber=34";
  assert.equal(isFileUrl(pdf), true);
  assert.equal(textFragmentUrl(pdf, "생육 최적 온도"), pdf);
  assert.equal(textFragmentUrl(null, "x"), null);
  assert.equal(textFragmentUrl("javascript:alert(1)", "x"), null);
});

test("cited passages name their pages once, and pages of one guide share a key", () => {
  assert.equal(passagePlaces(["34쪽", "36쪽", "34쪽"]), "34, 36쪽");
  assert.equal(passagePlaces(["섹션 2"]), "섹션 2");
  assert.equal(passagePlaces(["telemetry snapshot"]), null);
  assert.equal(pageNumber("고추냉이 재배 기술 자료 · 34쪽"), 34);
  const page34 = { id: "p34", sourceGroupId: "source-group:public:reference:url:https://nongsaro.go.kr/down.do#pages:34-34" };
  const page36 = { id: "p36", sourceGroupId: "source-group:public:reference:url:https://nongsaro.go.kr/down.do#pages:36-36" };
  assert.equal(bookKey(page34), bookKey(page36));
  assert.equal(bookKey({ id: "x", sourceUrl: "https://a.test/f.do?ebookCode=57&pageNumber=3" }), bookKey({ id: "y", sourceUrl: "https://a.test/f.do?ebookCode=57&pageNumber=9" }));
  // One download address, two books: the address's own book code tells them apart.
  const group = "source-group:public:reference:url:https://a.test/f.do#pages:3-3";
  assert.notEqual(bookKey({ id: "x", sourceGroupId: group, sourceUrl: "https://a.test/f.do?ebookCode=57&pageNumber=3" }), bookKey({ id: "y", sourceGroupId: group, sourceUrl: "https://a.test/f.do?ebookCode=58&pageNumber=3" }));
  setLang("en");
  try {
    assert.equal(passagePlaces(["34쪽", "36쪽"]), "p. 34, 36");
  } finally {
    setLang("ko");
  }
});

test("an answer's source numbers are split out and sit against the word they support", () => {
  assert.deepEqual(splitMarkers("적온은 12~15℃입니다 [1]. 고온 피해 [2][3]가 납니다."), ["적온은 12~15℃입니다", 1, ". 고온 피해", 2, 3, "가 납니다."]);
  assert.deepEqual(splitMarkers("링크 [3](https://x.test) 그대로"), ["링크 [3](https://x.test) 그대로"]);
});

test("live readings cited one by one read as one table with the reading named by its title", () => {
  const passages = [
    { source: "고추냉이 고설베드 A동 · 1구역 최신 재배실 온도", excerpt: "1구역 (zone-a), 2026-09-29T03:11:59+00:00 관측값: 64.9992 °C (상태: 확인 필요). 센서 품질 의심: 이 값은 실제 환경으로 해석하지 말고 판단 근거에서 제외하세요." },
    { source: "고추냉이 고설베드 A동 · 1구역 최신 상대 습도", excerpt: "1구역 (zone-a), 2026-09-29T03:11:59+00:00 관측값: 72 % (상태: 기준 범위)." },
    { source: "고추냉이 고설베드 A동 · 2구역 최신 상대 습도", excerpt: "2구역 (zone-b), 2026-09-29T03:12:01+00:00 관측값: 65 % (상태: 기준 범위). 관측 지연: 마지막 수신값입니다." },
  ];
  assert.equal(isTelemetryPassage(passages[1].excerpt), true);
  assert.equal(isTelemetryPassage("현재 활성 경보 1건: 재배실 온도 센서 확인"), false);
  const table = parseTelemetryPassages(passages)!;
  assert.deepEqual(table.zones, ["zone-a", "zone-b"]);
  assert.equal(table.observedAt, "2026-09-29T03:12:01+00:00");
  const room = table.rows.find((r) => r.label === "재배실 온도")!;
  assert.deepEqual(room.cells["zone-a"], { value: "65 °C", status: "warning", note: "판단 제외" });
  const humidity = table.rows.find((r) => r.label === "상대 습도")!;
  assert.deepEqual(humidity.cells["zone-a"], { value: "72 %", status: "normal" });
  // A late value is not shown as a plain normal one.
  assert.deepEqual(humidity.cells["zone-b"], { value: "65 %", status: "warning", note: "지연" });
  assert.equal(parseTelemetryPassages([{ source: "자료", excerpt: "생육 최적 온도는 12~15℃입니다." }]), null);
});

test("the server's own source names read as places a person knows", () => {
  assert.equal(readableLocator("telemetry snapshot"), "실시간 관측");
  assert.equal(readableLocator("본문 구간 3"), "본문 3번째 구간");
  setLang("en");
  try {
    assert.equal(readableLocator("telemetry snapshot"), "Live readings");
    assert.equal(readableLocator("34쪽"), "p. 34");
    assert.equal(readableLocator("섹션 2"), "Section 2");
  } finally {
    setLang("ko");
  }
});

test("a guide's page range and kind read in English on the English screen", () => {
  setLang("en");
  try {
    assert.equal(readableLocator("5–46쪽"), "pp. 5–46");
    assert.equal(readableLocator("34쪽"), "p. 34");
    assert.equal(readableLocator("섹션 7"), "Section 7");
    assert.equal(term("PDF 문서"), "PDF document");
    assert.equal(term("웹 문서"), "Web page");
  } finally {
    setLang("ko");
  }
  assert.equal(readableLocator("5–46쪽"), "5–46쪽");
  assert.equal(term("PDF 문서"), "PDF 문서");
});
