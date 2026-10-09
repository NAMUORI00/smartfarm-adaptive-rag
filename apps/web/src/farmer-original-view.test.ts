import assert from "node:assert/strict";
import test from "node:test";
import { charsetOf, decodeText, findInPieces, locateInPieces, mainRun, markdownDocument, rangeParts, similarInPieces } from "./farmer/original-view.ts";

// A web page's text nodes: the library's passage was extracted from them with other line breaks.
const NODES = ["고추냉이 재배 적지", "\n  ", "일본에서 물고추냉이 주산지는 해발 400~500m에 경사도가 5~15% 정도이고 ", "산림이 울창하며", " 북쪽을 향한 산간계곡이다."];

test("a passage is found across the text nodes it spans, spaces aside", () => {
  const found = locateInPieces(NODES, "물고추냉이 주산지는 해발 400~500m에 경사도가\n5~15% 정도이고 산림이 울창하며")!;
  assert.deepEqual(found.start, { piece: 2, offset: NODES[2].indexOf("물고추냉이") });
  assert.deepEqual(found.end, { piece: 3, offset: NODES[3].length });
  assert.deepEqual(rangeParts(NODES, found).map((p) => NODES[p.piece].slice(p.from, p.to)), [NODES[2].slice(NODES[2].indexOf("물고추냉이")).trimEnd() + " ", "산림이 울창하며"]);
  assert.equal(locateInPieces(NODES, "딸기 재배"), null);
  assert.equal(locateInPieces(NODES, ""), null);
});

test("a long passage extracted a little differently is anchored on its head and tail, or marked by its head", () => {
  const passage = "일본에서 물고추냉이 주산지는 해발 400-500m에 경사도가 5~15% 정도이고 산림이 울창하며 북쪽을 향한 산간계곡이다.";
  const found = locateInPieces(NODES, passage)!;
  assert.equal(found.start.piece, 2);
  assert.equal(found.end.piece, 4);
  // The tail is not on the page at all: only the beginning is marked.
  const head = locateInPieces(NODES, "일본에서 물고추냉이 주산지는 해발 400~500m에 경사도가 5~15% 정도이고 그 밖의 다른 문장이 이어진다고 가정한 긴 구절입니다.")!;
  assert.equal(head.start.piece, 2);
  assert.ok(head.end.piece === 2);
});

test("searched words are found everywhere, across nodes and case", () => {
  const pieces = ["Wasabi grows in cold ", "water; wasa", "bi likes shade."];
  assert.equal(findInPieces(pieces, "wasabi").length, 2);
  assert.deepEqual(findInPieces(pieces, "cold water")[0], { start: { piece: 0, offset: 16 }, end: { piece: 1, offset: 5 } });
  assert.deepEqual(findInPieces(pieces, "  "), []);
});

// "고추냉이" in EUC-KR, as older Korean public pages are written.
const EUCKR = [0xb0, 0xed, 0xc3, 0xdf, 0xb3, 0xc3, 0xc0, 0xcc];
const bytes = (...parts: (string | number[])[]) => {
  const out: number[] = [];
  for (const part of parts) out.push(...(typeof part === "string" ? new TextEncoder().encode(part) : part));
  return new Uint8Array(out);
};

test("a page is read in the character set it declares, and an undeclared Korean page as EUC-KR", () => {
  assert.equal(charsetOf(bytes('<html><head><meta http-equiv="Content-Type" content="text/html; charset=euc-kr">')), "euc-kr");
  assert.equal(charsetOf(bytes('<?xml version="1.0" encoding="UTF-8"?><article/>')), "utf-8");
  assert.equal(charsetOf(bytes([0xef, 0xbb, 0xbf], "<p>")), "utf-8");
  assert.equal(charsetOf(bytes("<p>no declaration</p>")), "utf-8");
  const declared = bytes('<meta charset="euc-kr"><p>', EUCKR, "</p>");
  assert.ok(decodeText(declared.buffer as ArrayBuffer).includes("고추냉이"));
  const undeclared = bytes("<p>", ...Array.from({ length: 12 }, () => EUCKR), "</p>");
  assert.ok(decodeText(undeclared.buffer as ArrayBuffer).includes("고추냉이고추냉이"));
  assert.equal(decodeText(bytes("<p>고추냉이</p>").buffer as ArrayBuffer), "<p>고추냉이</p>");
});

test("a passage on a printed page opens at its body, not at a banner or running head it also covers", () => {
  // Page 34 of the wasabi handbook: a chapter banner at the top, the body, the running head at the foot.
  const banner = [{ top: 236, height: 30 }, { top: 250, height: 30 }];
  const body = Array.from({ length: 12 }, (_, i) => ({ top: 480 + i * 40 + (i >= 6 ? 40 : 0), height: 24 }));
  const head = [{ top: 1354, height: 17 }];
  const boxes = [...head, ...body, ...banner];
  const run = mainRun(boxes)!;
  assert.equal(boxes[run.index].top, 480);
  assert.ok(run.bottom >= 480 + 11 * 40 + 40);
  // A single sentence is its own run; nothing marked gives nothing.
  assert.deepEqual(mainRun([{ top: 700, height: 24 }]), { index: 0, top: 700, bottom: 724 });
  assert.equal(mainRun([]), null);
});

test("a farm's own Markdown procedure reads as its front matter and blocks, a paragraph's lines joined", () => {
  const source = [
    "---",
    "id: private:farm-wasabi-a:operations-sop:v1",
    "title: 고추냉이 A동 근권·관수 대응 SOP",
    "issuer: 고추냉이 고설베드 A동",
    "---",
    "",
    "근권 온도 경보에서는 냉각기 출력을",
    "순서대로 확인한다.",
    "",
    "## 관수 점검",
    "- 펌프가 켜져 있지만 **유량**이 감소하면",
    "  관수 라인을 점검한다.",
    "1. 센서 교정 기록",
    "> 모든 설정 변경은 승인 후 적용한다.",
  ].join("\n");
  const { meta, blocks } = markdownDocument(source);
  assert.equal(meta.id, "private:farm-wasabi-a:operations-sop:v1");
  assert.equal(meta.title, "고추냉이 A동 근권·관수 대응 SOP");
  assert.deepEqual(blocks, [
    { kind: "paragraph", text: "근권 온도 경보에서는 냉각기 출력을 순서대로 확인한다." },
    { kind: "heading", level: 2, text: "관수 점검" },
    { kind: "list", ordered: false, items: ["펌프가 켜져 있지만 유량이 감소하면 관수 라인을 점검한다."] },
    { kind: "list", ordered: true, items: ["센서 교정 기록"] },
    { kind: "quote", text: "모든 설정 변경은 승인 후 적용한다." },
  ]);
  // The passage the library cut from it is found again in its blocks.
  assert.ok(locateInPieces(blocks.map((b) => ("text" in b ? b.text : b.items.join(" "))), "냉각기 출력을\n순서대로 확인한다"));
  // Without front matter it is all body.
  assert.deepEqual(markdownDocument("한 줄").meta, {});
});

test("a guide kept as a summary is marked on the source sentences that say the same, and nothing unrelated is", () => {
  // A news article's text nodes and the library's summary of it (its words differ).
  const article = [
    "현재 그는 660㎡ 비닐하우스에서 약 1만 포기의 고추냉이를 양액재배하고 있다. ",
    "또 측창·천창과 다겹보온커튼 자동 개폐 시스템, 유동·환기팬을 비롯해 ",
    "온습도·전기전도도(EC)·산도(pH)·이산화탄소 센서를 기반으로 한 통합환경제어 설비를 구축해 안정적인 생육 환경을 조성했다. ",
    "적정 EC 농도는 1.8~2.4ds/m, pH는 6.2로, 겨울철에는 하루 3회, 1회당 1~2분씩 양액을 공급해준다.",
  ];
  const summary = "통합환경 제어에는 온도, 상대습도, 전기전도도, pH, 이산화탄소 센서와 천·측창, 보온커튼,\n유동·환기팬, LED, 양액 설비가 사용된다.\n\n현장 운영값은 양액 EC 1.8~2.4 dS/m, pH 6.2이며, 겨울철 관수 사례는 하루 3회 각 1~2분이다.\n이 값은 특정 농장의 recipe이므로 다른 품종에 보편적 최적값으로 적용하지 않는다.";
  assert.equal(locateInPieces(article, summary), null);
  const like = similarInPieces(article, summary);
  const read = (r: (typeof like)[number]) => rangeParts(article, r).map((p) => article[p.piece].slice(p.from, p.to)).join("");
  assert.equal(like.length, 2);
  assert.match(read(like[0]), /^또 측창·천창과.*조성했다\.$/s);
  assert.match(read(like[1]), /^적정 EC 농도는 1\.8~2\.4ds\/m.*공급해준다\.$/);
  // A sentence that shares words but not its numbers is not taken for it; unrelated text marks nothing.
  assert.deepEqual(similarInPieces(article, "적정 EC 농도는 3.5~4.0ds/m, pH는 5.5로 겨울철에는 하루 5회 양액을 공급한다."), []);
  assert.deepEqual(similarInPieces(article, "근권 온도 경보에서는 냉각기 출력, 공급수 온도, 관수 유량과 최근 작업을 순서대로 확인한다."), []);
});
