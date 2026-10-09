import type { AdvisorTurn } from './types'

export function advisorSuggestions(turns: AdvisorTurn[], zone: string): string[] {
  const scope = zone === 'zone-a' ? '1구역' : zone === 'zone-b' ? '2구역' : '전체 구역'
  const last = turns.at(-1)
  const question = last?.userMessage.content ?? ''
  if (last?.status === 'error') return [question, `${scope}의 현재 센서 상태만 확인해줘`].filter(Boolean)
  if (last?.controlDrafts.length) return [`제안한 조절의 대상과 예상 영향을 설명해줘`, `${scope} 장치의 현재 상태를 다시 확인해줘`, '실행 이후 환경이 개선됐는지 확인해줘']
  if (/관수|펌프|양액|EC|pH|수분/i.test(question)) return [`${scope} 관수·양액 상태를 확인해줘`, '방금 설명에 사용한 자료를 정리해줘', '어떤 조건이면 현장 점검이 필요한지 알려줘']
  if (/온도|냉각|습도|환기/.test(question)) return [`${scope} 온도와 습도의 최근 변화를 확인해줘`, `${scope}에서 조절 가능한 환경 장치를 확인해줘`, '방금 상황과 관련된 재배 자료를 찾아줘']
  if (/자료|지식|근거|논문|검색/.test(question)) return ['현재 선택한 자료의 핵심 내용을 요약해줘', '찾은 자료들의 공통점과 차이를 설명해줘', '답변의 근거가 부족한 부분을 알려줘']
  return [`${scope}에서 지금 확인할 문제를 알려줘`, `${scope}의 조절 가능한 장치를 보여줘`, '재배 관련 지식 자료를 찾아줘']
}
