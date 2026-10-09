export function parseMarkdownTableRow(line: string): string[] | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return null
  const cells = trimmed.slice(1, -1).split('|').map((cell) => cell.trim())
  return cells.length >= 2 ? cells : null
}

export function isMarkdownTableDivider(line: string, columnCount: number): boolean {
  const cells = parseMarkdownTableRow(line)
  return cells?.length === columnCount && cells.every((cell) => /^:?-{3,}:?$/.test(cell))
}

export function markdownTableAlignment(dividerCell: string): 'left' | 'center' | 'right' {
  const cell = dividerCell.trim()
  if (cell.startsWith(':') && cell.endsWith(':')) return 'center'
  if (cell.endsWith(':')) return 'right'
  return 'left'
}
