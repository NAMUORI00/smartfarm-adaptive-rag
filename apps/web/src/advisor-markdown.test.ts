import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isMarkdownTableDivider,
  markdownTableAlignment,
  parseMarkdownTableRow,
} from './advisor-markdown.ts'

test('parses a GFM pipe table without exposing its separator as content', () => {
  assert.deepEqual(
    parseMarkdownTableRow('| 구역 | 장치 | 현재 상태 |'),
    ['구역', '장치', '현재 상태'],
  )
  assert.equal(isMarkdownTableDivider('| :--- | --- | ---: |', 3), true)
  assert.equal(isMarkdownTableDivider('| 구역 | 장치 | 상태 |', 3), false)
})

test('rejects incomplete table rows and preserves column alignment', () => {
  assert.equal(parseMarkdownTableRow('구역 | 장치'), null)
  assert.equal(isMarkdownTableDivider('| --- | --- |', 3), false)
  assert.equal(markdownTableAlignment(':---'), 'left')
  assert.equal(markdownTableAlignment(':---:'), 'center')
  assert.equal(markdownTableAlignment('---:'), 'right')
})
