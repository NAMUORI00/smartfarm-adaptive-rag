import { patrolBriefLines, patrolBriefSections } from './patrol-brief'

function Emphasis({ text }: { text: string }) {
  return <>{text.split(/(\*\*[^*]+\*\*)/g).map((part, i) => part.startsWith('**') && part.endsWith('**') ? <strong key={i}>{part.slice(2, -2)}</strong> : part)}</>
}

export function PatrolBrief({ content, compact = false }: { content: string; compact?: boolean }) {
  return <div className={`patrol-brief ${compact ? 'compact' : ''}`}>{patrolBriefSections(content).map((section, i) => <section key={i}><h4>{section.title}</h4><ul>{patrolBriefLines(section.body).map((line, j) => <li key={j}><Emphasis text={line} /></li>)}</ul></section>)}</div>
}
