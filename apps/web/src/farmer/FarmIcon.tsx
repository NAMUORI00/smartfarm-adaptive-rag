const paths = {
  home: "M3 10 12 3l9 7M5 9v12h14V9M9 21v-7h6v7",
  map: "m3 5 6-2 6 2 6-2v16l-6 2-6-2-6 2ZM9 3v16M15 5v16",
  records: "M7 4H4v17h16V4h-3M8 3h8v4H8ZM8 12h8M8 16h5",
  crop: "M12 21v-9M12 16C4 16 3 11 3 7c6 0 9 3 9 9ZM12 12c0-6 3-9 9-9 0 6-3 9-9 9",
  bed: "M3 10h18v7H3ZM5 17v4M19 17v4M7 10V6m0 2L4 5m3 1 3-3M16 10V6m0 2-3-3m3 1 3-3",
  fan: "M12 10c-5-6-9-3-7 1 1 2 4 2 5 1M14 12c6-5 3-9-1-7-2 1-2 4-1 5M12 14c5 6 9 3 7-1-1-2-4-2-5-1M10 12c-6 5-3 9 1 7 2-1 2-4 1-5M14 12a2 2 0 1 1-4 0 2 2 0 0 1 4 0",
  temperature: "M9 14V5a3 3 0 0 1 6 0v9a5 5 0 1 1-6 0ZM12 7v10M12 17a1 1 0 1 0 0 2 1 1 0 0 0 0-2",
  sensor: "M4 12h4l3-7 3 14 3-7h3M3 3h18v18H3Z",
  water: "M12 3C10 7 5 11 5 15a7 7 0 0 0 14 0c0-4-5-8-7-12ZM8 15c0 2 1 3 3 3",
  harvest: "M3 11h18l-2 10H5ZM7 11l5-8 5 8M9 15v3M15 15v3",
  book: "M12 5C9 3 5 3 2 4v16c3-1 7-1 10 1 3-2 7-2 10-1V4c-3-1-7-1-10 1Zm0 0v16M5 8h4M15 8h4M5 12h4M15 12h4",
  camera: "M3 7h12v12H3ZM15 11l6-4v12l-6-4M6 4h6",
  settings: "M4 7h16M4 17h16M8 4v6M16 14v6",
  menu: "M4 6h16M4 12h16M4 18h16",
  back: "m10 5-7 7 7 7M3 12h18",
  expand: "M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5",
  advisor: "M3 3h18v14H9l-6 4ZM7 8h10M7 12h7",
  warning: "m12 3 10 18H2ZM12 9v5M12 17v1",
  check: "m4 12 5 5L20 6",
  clock: "M12 8v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0",
  compare: "M3 6h8v12H3ZM13 6h8v12h-8ZM7 10v4M17 10v4",
  refresh: "M20 12a8 8 0 1 1-2.3-5.7M20 4v4h-4",
  trend: "M3 17l5-6 4 4 5-7 4 3M3 21h18",
  // Equipment in general: two sliders. The fan glyph is only for real fans.
  controls: "M4 7h10M18 7h2M14 4v6M4 17h4M12 17h8M8 14v6",
  // Devices on the plan and the stage.
  snow: "M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9M9.6 4.4 12 6.8l2.4-2.4M9.6 19.6 12 17.2l2.4 2.4M17.4 6.1l-.9 3.3 3.3.9M6.6 17.9l.9-3.3-3.3-.9M6.6 6.1l.9 3.3-3.3.9M17.4 17.9l-.9-3.3 3.3-.9",
  flame: "M12 3c1 4 5 5 5 10a5 5 0 0 1-10 0c0-2 1-3 2-4 0 2 1 3 2 3 0-3 1-6 1-9Z",
  window: "M4 4h16v16H4ZM4 12h16M12 4v16",
  curtain: "M4 4h16M5 4v3c0 3 3 4 3 8v5M19 4v3c0 3-3 4-3 8v5M12 4v6M9 20h6",
  sun: "M12 4v2M12 18v2M4 12h2M18 12h2M6.3 6.3l1.4 1.4M16.3 16.3l1.4 1.4M6.3 17.7l1.4-1.4M16.3 7.7l1.4-1.4M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z",
  moon: "M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z",
  chevron: "m9 6 6 6-6 6",
  close: "M6 6l12 12M18 6 6 18",
  help: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM9.6 9.4a2.5 2.5 0 1 1 3.4 2.4c-.6.3-1 .8-1 1.4v.6M12 16.8v.2",
  mic: "M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3ZM5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7",
  sun2: "M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10ZM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4",
  print: "M6 9V3h12v6M6 18H4a1 1 0 0 1-1-1v-6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v6a1 1 0 0 1-1 1h-2M6 14h12v7H6Z",
  copy: "M9 9h11v11H9ZM5 15H4V4h11v1",
  leaf: "M4 20c0-9 6-15 16-15 0 10-6 15-16 15ZM4 20c4-5 8-8 12-10",
  plus: "M12 5v14M5 12h14",
  play: "M8 5v14l11-7Z",
  pause: "M9 5v14M15 5v14",
  send: "M12 20V5M5 11l7-7 7 7",
  // The first page's lanes: the operations server and the farmer's screen.
  server: "M4 4h16v6H4ZM4 14h16v6H4ZM8 7h.01M8 17h.01M12 7h4M12 17h4",
  screen: "M3 4h18v12H3ZM8 20h8M12 16v4",
  // The reader: a document, a way out to the source site, a flag for a passage that did not fit.
  file: "M6 3h8l4 4v14H6ZM14 3v4h4M9 12h6M9 16h6",
  external: "M14 4h6v6M20 4l-9 9M18 14v6H4V6h6",
  flag: "M5 21V4M5 4h11l-2 4 2 4H5",
  more: "M4.5 12h1M11.5 12h1M18.5 12h1",
  search: "M11 18a7 7 0 1 1 0-14 7 7 0 0 1 0 14ZM16 16l5 5",
  list: "M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01",
  up: "m6 15 6-6 6 6",
  down: "m6 9 6 6 6-6",
} as const;

export type IconName = keyof typeof paths;

/** The raw path, for SVG contexts (the plan) that cannot nest a component. */
export function iconPath(name: IconName): string {
  return paths[name];
}

/** Visible labels carry meaning; icons supplement them without duplicate speech. One weight, one size, set in CSS. */
export function FarmIcon({ name }: { name: IconName }) {
  return <svg className="fm-icon" data-icon={name} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d={paths[name]} /></svg>;
}
