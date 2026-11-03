# 연구 배경과 관련 연구

[README로 돌아가기](../README.md)

## 연구 배경

스마트팜은 센서로 재배 환경을 관측하고 그 정보로 관리 조치를 정하는 데이터 기반 운영 체계입니다[1]. 그런데 온도, 습도, 전기전도도(EC), pH 같은 수치만 보고는 변화의 원인과 대응을 판단하기 어렵습니다. 운영자는 재배 지침과 생육 단계, 설비 상태, 작업 이력을 함께 살펴야 합니다. 검색 증강 생성(RAG)은 외부 문서를 찾아 답변의 근거로 주는 방법이고[2], 농업 분야에서도 재배 관리 지침 제시[3], 센서와 기상 정보를 결합한 관개 추천[4], 상담과 관측 기반 제어의 연결[5]이 연구되었습니다.

냉각 조치를 검토하는 상황을 예로 들면, 먼저 재배 조건에 맞는 문서를 찾아야 하고(적합성), 영상으로 설비 주변을 확인할 때는 질문에 답할 근거가 화면에 있어야 합니다(충분성). 답변을 쓰는 사이 온도가 정상 범위로 돌아왔다면 앞서 낸 권고는 전제가 달라집니다(최신성)[6]–[8]. 문서 상담, 영상 확인, 상태 기반 답변은 필요한 근거와 판단 시점이 서로 다르지만, 운영자는 같은 구역과 설비의 관측, 작업 이력을 두고 이 일들을 이어서 합니다. 이 시스템은 업무마다 맞는 근거를 고르는 방법과 바뀐 상태를 답변에 반영하는 방법을 하나의 운영 구조로 묶습니다.


## 관련 연구

| 영역 | 기존 접근 | 운영 지원에서 남는 문제 | 이 시스템의 접근 |
|---|---|---|---|
| 스마트팜 AI 운영 지원 | 재배 지식 기반 제어 지침[3], 자연어 명령과 장비 제어의 연결[9], 센서와 기상 정보를 결합한 관개 추천[4], 정책을 통과한 조치만 실행하는 에이전트 구조[5] | 검색 근거의 적합성, 영상의 답변 가능성, 설명에 담긴 상태의 유효성을 판단 시점에 맞게 다뤄야 함 | 문서, 영상, 상태 업무의 처리 경로를 나누고 설명 생성과 설비 실행 승인을 분리 |
| 적응형 검색 | 밀집 검색과 희소 검색, 순위 융합[10], [11], 질문 복잡도에 따른 검색 전략 선택[12], [13], 질의별 가중치 조정[14], 질의 유형 프로파일[15] | 질의와 후보 구성에 따라 채널의 쓸모가 달라짐 | 질의 프로파일과 채널별 후보 조건으로 채널 참여를 결정 |
| 영상 근거 응답 | 다중 시점 관측 선택[16], 영상의 답변 가능성 학습[17], [18], 응답 신뢰도에 따른 선택 | 제한된 호출 예산 안에서 답할 근거를 확보하고 생성된 답의 공개 여부를 판단해야 함 | 시점 선택, 근거 조건부 답변과 기권, 공개 판단을 차례로 연결 |
| 상태 기반 답변 갱신 | 생성 중 정보가 부족할 때의 재검색[19], [20], 관측에 따른 행동 계획 수정[21], [22] | 생성하고 확인하는 사이 관측이 바뀌면 답변 일부의 전제만 사라질 수 있음 | 답변 단위마다 기대는 상태를 미리 선언하고 영향받은 단위만 수정 |

검색에서는 기존 연구가 검색을 할지와 결과의 결합 비중을 조정해 왔습니다. 하지만 질의마다 어느 채널의 후보가 확보되었는지, 그 후보를 최종 순위에 넣을지는 따로 정해야 합니다. 영상에서는 관측 선택, 답변 가능성 학습, 응답 선택이 서로 다른 시점에 서로 다른 정보로 이루어집니다. 상태 갱신 연구는 주로 다음 행동이나 도구 호출을 고치는 데 초점이 있어, 운영자에게 보여 줄 설명이 지금 상태와 맞는지는 별도로 다뤄야 합니다.

## 참고문헌

1. S. Wolfert, L. Ge, C. Verdouw, and M.-J. Bogaardt, "Big data in smart farming—a review," *Agricultural Systems*, vol. 153, pp. 69–80, 2017. doi:10.1016/j.agsy.2017.01.023
2. P. Lewis et al., "Retrieval-augmented generation for knowledge-intensive NLP tasks," *NeurIPS*, vol. 33, pp. 9459–9474, 2020.
3. 이현병, 최인찬, 임동혁 외, 「LLM과 RAG를 활용한 스마트팜 제어 및 관리 지원 시스템 설계 및 구현」, *한국콘텐츠학회논문지*, 24(12), pp. 65–76, 2024. doi:10.5392/JKCA.2024.24.12.065
4. D. F. Kandamali et al., "CottonBot: An AI-driven cotton farming assistant and irrigation advisor using LLM-RAG and agentic AI tools," *Smart Agricultural Technology*, vol. 12, 101640, 2025. doi:10.1016/j.atech.2025.101640
5. S. Pardo-Pina et al., "An agent-based service architecture for smart greenhouses: Telemetry analytics and decision support with RAG-grounded LLM agents," *Smart Agricultural Technology*, vol. 13, 101872, 2026. doi:10.1016/j.atech.2026.101872
6. S. Robertson and H. Zaragoza, "The probabilistic relevance framework: BM25 and beyond," *Foundations and Trends in Information Retrieval*, 3(4), pp. 333–389, 2009. doi:10.1561/1500000019
7. H. Joren et al., "Sufficient context: A new lens on retrieval augmented generation systems," *ICLR*, 2025.
8. M. Mansoor, T. Ahmad, and Y.-C. Yoon, "Risk-constrained freshness-aware semantic caching for open-web retrieval-augmented LLMs," arXiv:2607.04281, 2026.
9. 강태욱, 신창선, 박장우, 박철영, 「인공지능 모델 통합 제어를 위한 LLM 기반 지능형 스마트팜 에이전트 시스템 구현」, *스마트미디어저널*, 14(12), pp. 66–73, 2025.
10. V. Karpukhin et al., "Dense passage retrieval for open-domain question answering," *EMNLP*, pp. 6769–6781, 2020. doi:10.18653/v1/2020.emnlp-main.550
11. G. V. Cormack, C. L. A. Clarke, and S. Büttcher, "Reciprocal rank fusion outperforms Condorcet and individual rank learning methods," *SIGIR*, pp. 758–759, 2009. doi:10.1145/1571941.1572114
12. S. Jeong et al., "Adaptive-RAG: Learning to adapt retrieval-augmented large language models through question complexity," *NAACL*, 2024.
13. A. Asai et al., "Self-RAG: Learning to retrieve, generate, and critique through self-reflection," *ICLR*, 2024.
14. H.-L. Hsu and J. Tzeng, "DAT: Dynamic alpha tuning for hybrid retrieval in retrieval-augmented generation," arXiv:2503.23013, 2025.
15. 김유석, 김용운, 변영철, 「스마트팜 RAG를 위한 질의 적응형 검색 채널 제어」, *한국정보기술학회논문지*, 24(6), pp. 99–108, 2026. doi:10.14801/jkiit.2026.24.6.99
16. Y. Hou, S. Gould, and L. Zheng, "Learning to select views for efficient multi-view understanding," *CVPR*, pp. 20135–20144, 2024. doi:10.1109/CVPR52733.2024.01903
17. E. Yoon et al., "Can video LLMs refuse to answer? Alignment for answerability in video large language models," *ICLR*, 2025.
18. B. Vardi, O. Nir, and A. Shamir, "CLIP-UP: CLIP-based unanswerable problem detection for visual question answering," *WACV*, pp. 5898–5908, 2026.
19. Z. Jiang et al., "Active retrieval augmented generation," *EMNLP*, pp. 7969–7992, 2023. doi:10.18653/v1/2023.emnlp-main.495
20. W. Su et al., "DRAGIN: Dynamic retrieval augmented generation based on the real-time information needs of large language models," *ACL*, pp. 12991–13013, 2024. doi:10.18653/v1/2024.acl-long.702
21. W. Huang et al., "Inner monologue: Embodied reasoning through planning with language models," *CoRL*, PMLR vol. 205, pp. 1769–1782, 2023.
22. J. Kim, C. Min, B. Kim, and J. Choi, "Pre-emptive action revision by environmental feedback for embodied instruction following agents," *CoRL*, PMLR vol. 270, pp. 2396–2428, 2025.
