import type React from 'react'
import { isMarkdownTableDivider, markdownTableAlignment, parseMarkdownTableRow } from './advisor-markdown'

/** Renders the source numbers written together in the answer ("[7][8]"); without it the numbers stay as written. */
export type CiteRenderer = (sources: number[], key: string) => React.ReactNode

function withCitations(text: string, cite: CiteRenderer | undefined, key: string): React.ReactNode {
  if (!cite || !/\[\d{1,2}\]/.test(text)) return text
  const out: React.ReactNode[] = []
  let last = 0
  // Numbers written side by side are one mark: two passages of one guide show its number once.
  for (const match of text.matchAll(/(?:\s*\[\d{1,2}\](?!\())+/g)) {
    const at = match.index ?? 0
    if (at > last) out.push(text.slice(last, at))
    out.push(cite([...match[0].matchAll(/\[(\d{1,2})\]/g)].map((m) => Number(m[1])), `${key}-${at}`))
    last = at + match[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

function InlineMarkdown({ text, cite }: { text: string; cite?: CiteRenderer }) {
  return <>{text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean).map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={index}>{withCitations(part.slice(2, -2), cite, `b${index}`)}</strong>
    if (part.startsWith('`') && part.endsWith('`')) return <code key={index}>{part.slice(1, -1)}</code>
    return <span key={index}>{withCitations(part, cite, `t${index}`)}</span>
  })}</>
}

export function AdvisorMarkdown({ content, cite }: { content: string; cite?: CiteRenderer }) {
  const lines = content
    .replace(/\r/g, '')
    .replace(/(\*\*[^*\n]+\*\*)\s+(?=[-•]\s+)/g, '$1\n')
    .split('\n')
  const blocks: React.ReactNode[] = []
  let index = 0
  const isBlockStart = (line: string) => /^(#{1,4})\s+/.test(line) || /^\*\*[^*]+\*\*:?$/.test(line) || /^[-*•]\s+/.test(line) || /^\d+[.)]\s+/.test(line) || parseMarkdownTableRow(line) !== null

  while (index < lines.length) {
    const line = lines[index].trim()
    if (!line) {
      index += 1
      continue
    }
    const heading = line.match(/^(#{1,4})\s+(.+)$/)
    if (heading) {
      blocks.push(heading[1].length >= 3
        ? <h4 key={`heading-${index}`}><InlineMarkdown text={heading[2]} cite={cite} /></h4>
        : <h3 key={`heading-${index}`}><InlineMarkdown text={heading[2]} cite={cite} /></h3>)
      index += 1
      continue
    }
    const strongHeading = line.match(/^\*\*([^*]+)\*\*:?$/)
    if (strongHeading) {
      blocks.push(<h4 key={`strong-heading-${index}`}>{strongHeading[1]}</h4>)
      index += 1
      continue
    }
    const bullet = line.match(/^[-*•]\s+(.+)$/)
    if (bullet) {
      const items: string[] = []
      while (index < lines.length) {
        const match = lines[index].trim().match(/^[-*•]\s+(.+)$/)
        if (!match) break
        items.push(match[1])
        index += 1
      }
      blocks.push(<ul key={`list-${index}`}>{items.map((item, itemIndex) => <li key={itemIndex}><InlineMarkdown text={item} cite={cite} /></li>)}</ul>)
      continue
    }
    const numbered = line.match(/^\d+[.)]\s+(.+)$/)
    if (numbered) {
      const items: string[] = []
      while (index < lines.length) {
        const match = lines[index].trim().match(/^\d+[.)]\s+(.+)$/)
        if (!match) break
        items.push(match[1])
        index += 1
      }
      blocks.push(<ol key={`steps-${index}`}>{items.map((item, itemIndex) => <li key={itemIndex}><InlineMarkdown text={item} cite={cite} /></li>)}</ol>)
      continue
    }
    const tableHeader = parseMarkdownTableRow(line)
    const tableDivider = tableHeader && index + 1 < lines.length
      ? parseMarkdownTableRow(lines[index + 1])
      : null
    if (tableHeader && tableDivider && isMarkdownTableDivider(lines[index + 1], tableHeader.length)) {
      const alignments = tableDivider.map(markdownTableAlignment)
      const rows: string[][] = []
      index += 2
      while (index < lines.length) {
        const row = parseMarkdownTableRow(lines[index])
        if (!row || row.length !== tableHeader.length) break
        rows.push(row)
        index += 1
      }
      blocks.push(
        <div className="assistant-table-scroll" key={`table-${index}`}>
          <table>
            <thead><tr>{tableHeader.map((cell, cellIndex) => <th key={cellIndex} style={{ textAlign: alignments[cellIndex] }}><InlineMarkdown text={cell} cite={cite} /></th>)}</tr></thead>
            <tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex} style={{ textAlign: alignments[cellIndex] }}><InlineMarkdown text={cell} cite={cite} /></td>)}</tr>)}</tbody>
          </table>
        </div>,
      )
      continue
    }
    const paragraph = [line]
    index += 1
    while (index < lines.length && lines[index].trim() && !isBlockStart(lines[index].trim())) {
      paragraph.push(lines[index].trim())
      index += 1
    }
    blocks.push(<p key={`paragraph-${index}`}><InlineMarkdown text={paragraph.join(' ')} cite={cite} /></p>)
  }

  return <div className="assistant-report">{blocks}</div>
}
