import type { Farm } from './types'

// Local simulator targets. Operational readings, documents, citations, and audit events never come from this file.
export const farms: Farm[] = [
  {
    id: 'farm-wasabi-a',
    name: '고추냉이 고설베드 A동',
    location: '국내 시설 재배동',
    crop: '고추냉이',
    cultivar: '선발 계통',
    cultivationSystem: '펄라이트 2단 고설베드 양액재배',
    productionGoal: '잎·잎자루 연중 생산',
    profileId: 'perlite_leaf_kr_v1',
    growthStage: '영양생장기 · 정식 47일',
    lotId: 'WASABI-LEAF-2607-A',
    nextHarvest: '8월 02일',
    status: 'stable',
  },
]
