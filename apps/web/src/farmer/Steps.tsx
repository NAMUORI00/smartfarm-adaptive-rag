import { L } from "./i18n";

/**
 * Where a process stands, said twice: one plain line ("2/5 변경 내용 확인")
 * a farmer reads first, then the numbered strip a demo audience follows
 * (search → read → answer → partial recheck; pick camera → evidence frames →
 * answer, abstain or hold; check → confirm → allow → device reply → recovery).
 * Steps before `completed` are done; `active` is the current one. `now`
 * replaces the headline before anything has started ("분석 전").
 */
export function Steps({ items, completed, active = null, label, now }: {
  items: readonly string[];
  completed: number;
  active?: number | null;
  label: string;
  now?: string;
}) {
  const headline =
    now ??
    (active !== null && active < items.length
      ? `${active + 1}/${items.length} ${items[active]}`
      : completed >= items.length
        ? `${items.length}/${items.length} ${L("완료", "Done")}`
        : null);
  return (
    <div className="fm-steps-block">
      {headline && <p className="fm-steps-now">{headline}</p>}
      <ol className="fm-steps" aria-label={label}>
        {items.map((text, index) => (
          <li
            key={text}
            className={index === active ? "is-current" : index < completed ? "is-done" : ""}
            aria-current={index === active ? "step" : undefined}
          >
            <span className="fm-step-index">{index + 1}</span>
            {text}
          </li>
        ))}
      </ol>
    </div>
  );
}
