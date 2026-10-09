/** A passage to mark in an original: the text the AI used, the page it came from (a PDF), and whether it is the one opened at. */
export type Highlight = { text: string; page?: number | null; kind: "cited" | "quote" };
/** A request to bring a page or a passage into view; a new nonce asks again. */
export type Jump = { page?: number | null; text?: string | null; nonce: number };
