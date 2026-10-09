import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')
const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')

function cssBlock(marker: string, requiredContent?: string) {
  let searchFrom = 0
  while (searchFrom < styles.length) {
    const start = styles.indexOf(marker, searchFrom)
    if (start === -1) break
    const openingBrace = styles.indexOf('{', start)
    assert.notEqual(openingBrace, -1, `missing opening brace: ${marker}`)
    let depth = 0
    for (let index = openingBrace; index < styles.length; index += 1) {
      if (styles[index] === '{') depth += 1
      if (styles[index] === '}') depth -= 1
      if (depth === 0) {
        const block = styles.slice(openingBrace + 1, index)
        if (!requiredContent || block.includes(requiredContent)) return block
        searchFrom = index + 1
        break
      }
    }
  }
  assert.fail(`missing CSS block: ${marker}${requiredContent ? ` containing ${requiredContent}` : ''}`)
}

test('keeps every derived zone in the same full-width card column', () => {
  assert.match(app, /<div className="derived-zone-list">\{indicators\.map/)
  assert.match(styles, /\.derived-zone-list \{[^}]*min-width: 0;[^}]*display: grid;[^}]*gap: 10px;/)
  assert.match(styles, /\.derived-indicator-strip dt span \{[^}]*min-width: 0;[^}]*text-overflow: ellipsis;/)
  assert.match(styles, /\.derived-indicator-strip dt em \{[^}]*flex: 0 0 auto;/)
})

test('keeps zone controls and focused metrics readable at tablet widths', () => {
  assert.match(styles, /\.zone-switcher button \{[^}]*white-space: nowrap;/)
  assert.match(styles, /\.sensor-trend-grid \{[^}]*grid-template-columns: repeat\(3,minmax\(0,1fr\)\);/)
  assert.match(styles, /\.sensor-trend-row \{[^}]*grid-template-columns: minmax\(105px,\.9fr\) minmax\(120px,1\.1fr\);/)

  const zoneRuleStart = styles.indexOf('@media (max-width: 900px) {')
  const tabletShellStart = styles.indexOf('@media (min-width: 781px) and (max-width: 900px) {')
  assert.notEqual(zoneRuleStart, -1)
  assert.notEqual(tabletShellStart, -1)

  const zoneRules = styles.slice(zoneRuleStart, tabletShellStart)
  assert.match(zoneRules, /\.zone-management-head, \.operations-zone-context \{[^}]*flex-direction: column;/)
  assert.match(zoneRules, /\.zone-switcher \{[^}]*grid-template-columns: repeat\(3,minmax\(0,1fr\)\);/)
  assert.match(zoneRules, /\.zone-overview-grid \{ grid-template-columns: 1fr; \}/)
  assert.match(zoneRules, /\.derived-indicator-strip dl \{ grid-template-columns: repeat\(2,minmax\(0,1fr\)\);/)

  const narrowRules = cssBlock('@media (max-width: 1100px)')
  assert.match(narrowRules, /\.sensor-trend-grid \{ grid-template-columns: 1fr; \}/)
  const tabletTrendRules = cssBlock('@media (min-width: 781px) and (max-width: 1100px)')
  assert.match(tabletTrendRules, /\.sensor-trend-group-body \{[^}]*grid-template-columns: repeat\(2,minmax\(0,1fr\)\);/)
  assert.match(tabletTrendRules, /\.sensor-trend-row:nth-child\(2\) \{ border-top: 0; \}/)
})

test('keeps each current value paired with a compact trend and stacks sensor groups on mobile', () => {
  assert.match(app, /<div className="sensor-trend-reading">[\s\S]*?<SensorMiniTrend metric=\{metric\}/)
  assert.match(app, /<svg viewBox="0 0 120 36"[^>]*role="img"/)

  const mobileRules = cssBlock('@media (max-width: 780px)', '.sensor-trend-grid')
  assert.match(mobileRules, /\.sensor-trend-grid \{ grid-template-columns: 1fr; \}/)
  assert.match(mobileRules, /\.sensor-trend-group-body \{ display: grid; grid-template-columns: 1fr; \}/)
})

test('switches the tablet shell before the fixed sidebar can squeeze content', () => {
  const tabletShellStart = styles.indexOf('@media (min-width: 781px) and (max-width: 900px) {')
  const mobileRuleStart = styles.indexOf('@media (max-width: 780px) {', tabletShellStart)
  assert.notEqual(tabletShellStart, -1)
  assert.notEqual(mobileRuleStart, -1)

  const tabletShellRules = styles.slice(tabletShellStart, mobileRuleStart)
  assert.match(tabletShellRules, /\.sidebar \{ display: none; \}/)
  assert.match(tabletShellRules, /\.main-area \{ width: 100%; margin-left: 0; \}/)
  assert.match(tabletShellRules, /\.mobile-nav \{[^}]*display: flex;/)
})

test('keeps dynamic device, chat, evidence, and knowledge text inside its card', () => {
  assert.match(styles, /\.device-control-card header \{[^}]*grid-template-columns: 36px minmax\(0,1fr\);/)
  assert.match(styles, /\.device-current-state \{[^}]*grid-column: 2;[^}]*flex-wrap: wrap;/)
  assert.match(styles, /\.device-current-state span b \{[^}]*display: inline;[^}]*white-space: normal;/)
  assert.match(styles, /\.chat-user > div,[\s\S]*?\.knowledge-applicability span \{[^}]*overflow-wrap: anywhere;/)
  assert.match(styles, /\.inline-citations button \{[^}]*min-width: 0;[^}]*max-width: 100%;[^}]*overflow-wrap: anywhere;/)
  assert.match(styles, /\.evidence-item > div \{ min-width: 0; \}/)
  assert.match(styles, /\.scenario-runtime-row \.scenario-profile-detail \{[^}]*grid-template-columns: repeat\(3,minmax\(0,1fr\)\);/)
  assert.match(styles, /\.log-operations-grid > \* \{ min-width: 0; \}/)
  assert.match(styles, /\.history-event > div \{ min-width: 0; \}/)
})
