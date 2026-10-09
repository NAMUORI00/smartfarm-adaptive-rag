import assert from "node:assert/strict";
import test from "node:test";
import { bookParts, findSpans, reflowText, rememberReading, runningHead, tocLabel, WORD_JOIN } from "./farmer/book-text.ts";
import { setLang } from "./farmer/i18n.ts";

// A printed page as the PDF gives it: a running head, lines broken at the print width, often mid-word.
const PAGE = [
  "제2장 고추냉이  35",
  "재배 적지",
  "가. 물재배 적지",
  "일본에서 물고추냉이 주산지는 해발 400~500m에 경사도가 5~15% 정도이고 산",
  "림이 울창하며 북쪽을 향한 산간계곡이다. 생육 최적 온도는 12~15℃이고, 수온은",
  "12~13℃이다. 물재배 시는 기온이 28~30℃ 이상일 때, 밭재배 시는 24~25℃ 이상",
  "일 때 고온 피해가 나타난다.",
  "나. 밭재배 적지",
].join("\n");

test("a printed page reads as paragraphs, with the text's length kept", () => {
  const flowed = reflowText(PAGE);
  assert.equal(flowed.length, PAGE.length);
  const lines = flowed.split("\n");
  // Headings and the list marks stay on lines of their own.
  assert.deepEqual(lines.slice(0, 3), ["제2장 고추냉이  35", "재배 적지", "가. 물재배 적지"]);
  // A word split at the line end is joined without a space; a number after a word is spaced.
  assert.ok(lines[3].includes(`산${WORD_JOIN}림이 울창하며`));
  assert.ok(lines[3].includes("수온은 12~13℃이다."));
  assert.ok(lines[3].endsWith("고온 피해가 나타난다."));
  assert.equal(lines[4], "나. 밭재배 적지");
  // A line ending in a particle ends a word: "90kg을 시비하고", not "90kg을시비하고".
  const fertiliser = ["기비로는 유기질 비료나 완효성 비료를 포장 전면에 시비하고 경운하여 정식하며,", "복비는 봄가을에 생육을 보아가며 추비한다. 시비량은 보통 10a당 퇴비 2,000kg", "계분 150kg, 소석회 100kg, 용과린 40kg, 유기질 비료 90kg을", "시비하고 봄가을로 복비를 40kg 추비한다."].join("\n");
  assert.ok(reflowText(fertiliser).includes("90kg을 시비하고"));
  // Text with too few lines to judge is left as it is.
  assert.equal(reflowText("한 줄\n두 줄"), "한 줄\n두 줄");
});

test("a page's running head is found and pages are named by their first heading", () => {
  const head = runningHead(PAGE)!;
  assert.equal(PAGE.slice(head.start, head.end), "제2장 고추냉이  35");
  const next = "36\n어 있고 작토";
  assert.equal(next.slice(runningHead(next)!.start, runningHead(next)!.end), "36");
  assert.equal(runningHead("재배 적지\n본문"), null);
  assert.equal(tocLabel(PAGE), "재배 적지");
  assert.equal(tocLabel("36\n어 있고 작토 조성 비용이 많이 들며, 18~24개월 정도의 장기간 재배를 해야 한다.\n나. 밭재배\n물 없이 노지에"), "나. 밭재배");
  // A web section: the menus are skipped, the first real line names it.
  assert.equal(tocLabel("상세보기 < 보도자료 < 새소식 < 농촌진흥청\n서브메뉴\n정책홍보\n농촌진흥청, 이달의 신간_5종\n2024-01-29", false), "농촌진흥청, 이달의 신간_5종");
});

test("a guide's pages come in page or section order with their places", () => {
  const doc = (id: string, sourceLocator: string | null, title = id) => ({ id, title, sourceLocator });
  const parts = bookParts(["p36", "p5", "p34"], [doc("p34", "34쪽"), doc("p5", "5쪽"), doc("p36", "36쪽")]);
  assert.deepEqual(parts.map((p) => [p.id, p.label]), [["p5", "5쪽"], ["p34", "34쪽"], ["p36", "36쪽"]]);
  const sections = bookParts(["s10", "s2"], [doc("s2", "섹션 2"), doc("s10", "섹션 10")]);
  assert.deepEqual(sections.map((p) => p.id), ["s2", "s10"]);
  setLang("en");
  try {
    assert.equal(bookParts(["p5"], [doc("p5", "5쪽")])[0].label, "p. 5");
    assert.equal(bookParts(["x"], [doc("x", null)])[0].label, "Text");
  } finally {
    setLang("ko");
  }
});

test("searched words are found across line breaks and case", () => {
  assert.deepEqual(findSpans(PAGE, "물재배 적지").map((s) => PAGE.slice(s.start, s.end)), ["물재배 적지"]);
  assert.equal(findSpans(PAGE, "수온은 12").length, 1);
  assert.equal(findSpans("Wasabi grows; wasabi is", "WASABI").length, 2);
  assert.deepEqual(findSpans(PAGE, "   "), []);
});

test("the guides read lately keep one mark each, newest first", () => {
  const mark = (entryId: string, at: string) => ({ entryId, documentId: `${entryId}-d`, title: entryId, part: "1쪽", at });
  let history = rememberReading([], mark("a", "1"));
  history = rememberReading(history, mark("b", "2"));
  history = rememberReading(history, mark("a", "3"));
  assert.deepEqual(history.map((h) => [h.entryId, h.at]), [["a", "3"], ["b", "2"]]);
  for (const id of ["c", "d", "e"]) history = rememberReading(history, mark(id, id));
  assert.equal(history.length, 4);
});

test("a contents page keeps each entry on its own line", () => {
  const contents = ["Con t e nts", "오갈피나무", "1. 재배 내력과 특성 _ 12", "2. 성분과 용도 _ 14", "5. 생산과 전망 _ 26", "고추냉이", "1. 원산지와 재배 내력 _ 29", "2. 식물체 생김새 _ 32"].join("\n");
  assert.deepEqual(reflowText(contents).split("\n"), contents.split("\n"));
});
