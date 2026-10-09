export function patrolBriefSections(text: string): { title: string; body: string }[] {
  const cleaned = text.replace(/프레임\s*0[~～–-]2/g, '선택 구간').replace(/프레임\s*1[~～–-]2/g, '이후 장면').replace(/프레임\s*0/g, '첫 장면')
  const parts = cleaned.split(/(?:#{1,4}\s+)?(?:\*\*)?(현재 상황|관측 내용|판단|확인되지 않은 내용|권장 조치|담당자 확인 사항)(?:\*\*)?\s*(?:[:：]\s*|\n+)/)
  if (parts.length < 3) return [{ title: '확인 결과', body: cleaned }]
  const result = []
  for (let i = 1; i + 1 < parts.length; i += 2) {
    const title = ({ '관측 내용': '현재 상황', '확인되지 않은 내용': '판단', '담당자 확인 사항': '권장 조치' } as Record<string, string>)[parts[i]] ?? parts[i]
    result.push({ title, body: parts[i + 1].trim() })
  }
  return result
}

export function patrolBriefLines(body: string): string[] {
  return body.split(/\n+/).map(line => line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim()).flatMap(line => line.split(/(?<=[.!?])\s+(?=[가-힣A-Z])/)).filter(Boolean)
}
