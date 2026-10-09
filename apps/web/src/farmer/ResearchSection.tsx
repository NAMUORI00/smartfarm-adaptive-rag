import { useState } from "react";
import type { ReactNode } from "react";
import { FarmIcon } from "./FarmIcon";
import { L } from "./i18n";
import { MODULES } from "./research-modules";
import type { ModuleId } from "./research-modules";
import { studyDesign } from "./study-refs";

/** One page of a study: a short name for the pager and the flow it draws. */
export type ResearchPage = { key: string; label: string; render: () => ReactNode };

/**
 * One of the three studies on the landing page: its number and name, the role
 * it plays in the farm system in one line, the research modules it runs, and
 * its flows. Several flows turn like pages; only the open one is drawn.
 */
export function ResearchSection({ id, no, title, role, modules, pages, onDemo }: {
  id: string;
  no: 1 | 2 | 3;
  title: string;
  role: string;
  modules: ModuleId[];
  pages: ResearchPage[];
  /** Opens the dashboard where this study is at work. */
  onDemo?: () => void;
}) {
  const [page, setPage] = useState(0);
  const count = pages.length;
  const go = (next: number) => setPage(((next % count) + count) % count);
  const current = pages[Math.min(page, count - 1)];
  return (
    <section id={id} className="fm-rs" aria-labelledby={`${id}-title`}>
      <header className="fm-rs-head">
        <span className="fm-rs-no">{L(`연구 ${no}`, `Study ${no}`)}</span>
        <h2 id={`${id}-title`}>{title}</h2>
        <p className="fm-rs-role">{role}</p>
        <p className="fm-rs-design"><span>{L(`세부 설계 [${no}]`, `Design [${no}]`)}</span> {studyDesign(no)}</p>
        <div className="fm-rs-foot">
          <p className="fm-rs-mods">{modules.map((m) => <b key={m}>{MODULES[m].name}</b>)}</p>
          {onDemo && <button type="button" className="fm-primary fm-rs-demo" onClick={onDemo}>{L("대시보드에서 보기", "Open in the dashboard")}<FarmIcon name="chevron" /></button>}
        </div>
      </header>
      {count > 1 && (
        <nav className="fm-rs-pager" aria-label={L(`${title} 화면 넘기기`, `${title} pages`)}>
          <button type="button" className="fm-rs-arrow is-prev" onClick={() => go(page - 1)} aria-label={L("이전", "Previous")}><FarmIcon name="chevron" /></button>
          <div className="fm-rs-tabs" role="tablist">
            {pages.map((p, i) => (
              <button key={p.key} type="button" role="tab" aria-selected={i === page} onClick={() => go(i)}>
                <b>{i + 1}</b>{p.label}
              </button>
            ))}
          </div>
          <button type="button" className="fm-rs-arrow" onClick={() => go(page + 1)} aria-label={L("다음", "Next")}><FarmIcon name="chevron" /></button>
          <span className="fm-rs-count" aria-hidden="true">{page + 1} / {count}</span>
        </nav>
      )}
      <div role={count > 1 ? "tabpanel" : undefined} key={current.key}>{current.render()}</div>
    </section>
  );
}
