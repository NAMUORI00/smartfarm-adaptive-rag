import test from 'node:test'
import assert from 'node:assert/strict'
import { patrolBriefLines, patrolBriefSections } from './patrol-brief.ts'
test('operator briefing separates situation assessment and action', () => {
  assert.deepEqual(patrolBriefSections('현재 상황: 사람이 보입니다.\n판단: 권한 미확인.\n권장 조치: 기록 대조.'), [
    { title: '현재 상황', body: '사람이 보입니다.' }, { title: '판단', body: '권한 미확인.' }, { title: '권장 조치', body: '기록 대조.' },
  ])
})
test('legacy briefing stays readable without changing observations', () => {
  assert.equal(patrolBriefSections('관측 내용: 프레임 0에서 사람이 보임. 확인되지 않은 내용: 신원 미확인. 담당자 확인 사항: 기록 확인.')[0].body, '첫 장면에서 사람이 보임.')
  assert.equal(patrolBriefSections('확인할 수 없습니다.')[0].body, '확인할 수 없습니다.')
})
test('markdown headings and lists render without their raw markers', () => {
  const sections = patrolBriefSections('### 현재 상황\n- **사람 두 명**이 보입니다.\n### 판단\n권한 미확인.\n### 권장 조치\n1. 기록 확인.\n2. 담당자 연락.')
  assert.equal(sections.length, 3)
  assert.deepEqual(patrolBriefLines(sections[2].body), ['기록 확인.', '담당자 연락.'])
  assert.deepEqual(patrolBriefLines('사람이 보입니다. 출입 기록을 확인하세요.'), ['사람이 보입니다.', '출입 기록을 확인하세요.'])
})
