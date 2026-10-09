---
id: synthetic:wasabi:simulation-policy:v1
title: 고추냉이 시뮬레이터 운영 정책
display_title: 고추냉이 시뮬레이터 운영 정책
scope: synthetic_demo
source_kind: synthetic_demo
version: v1
issuer: 로컬 검증 환경
document_type: 시뮬레이터 정책
summary: 경보 지속시간과 장치 반응을 재현하기 위한 합성 운영 규칙입니다.
crop: wasabi
cultivation_system: perlite_substrate
evidence_class: simulated
growth_stage: leaf_production
---

경보 지속시간, 히스테리시스, 장치 반응 속도는 농학 문헌값이 아니라 반복 가능한 데모를 위한
시뮬레이터 정책이다. 작물 위험과 센서 이상은 별도 경보로 기록하며, 센서 이상이 우선 판정되면
냉각·관수·양액 장치 제어를 추천하지 않는다.
