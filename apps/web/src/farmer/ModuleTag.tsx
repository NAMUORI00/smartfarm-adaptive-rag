import { FarmIcon } from "./FarmIcon";
import { L } from "./i18n";
import { ModuleDiagram } from "./ModuleDiagram";
import type { DiagramLive } from "./ModuleDiagram";
import { MODULES } from "./research-modules";
import type { ModuleId } from "./research-modules";

/**
 * A small tag on the exact spot a research module runs, visible only while
 * "연구 모듈 표시" is on (CSS hides it otherwise). Opening it shows how the
 * module works, what it just did here, and which code runs.
 */
export function ModuleTag({ id, live, diagram }: { id: ModuleId; live?: string; diagram?: DiagramLive }) {
  const m = MODULES[id];
  return (
    <details className="fm-module-tag" data-module={id}>
      <summary><FarmIcon name="controls" /><span>{m.name}</span></summary>
      <div>
        <ModuleDiagram id={id} live={diagram} />
        <p><strong>{L("현장 문제", "Field problem")}</strong>{m.problem}</p>
        {live && <p className="fm-module-live"><strong>{L("방금 한 일", "What it just did")}</strong>{live}</p>}
        <p className="fm-module-code"><strong>{L("실행 코드", "Code that runs")}</strong>{m.code.map((c) => <code key={c}>{c}</code>)}</p>
      </div>
    </details>
  );
}
