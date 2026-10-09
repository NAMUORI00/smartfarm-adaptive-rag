import { L } from "./i18n.ts";

/**
 * The system and the papers behind it. The landing page names the whole system
 * once, and each of its three AI functions carries one study's detailed design
 * as a contribution to it, cited under Figure 1 like a figure's sources. Thesis
 * chapter numbers stay off the screen.
 */
export type StudyNo = 1 | 2 | 3;
export const STUDIES: readonly StudyNo[] = [1, 2, 3];

/** The system's fixed name. It supports the people running the farm: nothing is grown or operated on its own. */
export const systemName = () => L("스마트팜 AI 운영 지원 시스템", "Smart Farm AI Operations Support System");

/** The detailed design each function takes from its study. */
export function studyDesign(no: StudyNo): string {
  return [
    L("질의 적응형 검색 채널 제어", "Query-adaptive channel control"),
    L("근거 조건부 응답과 기권", "Evidence-conditioned answer or abstain"),
    L("센서 변화 기반 선택적 답변 수정", "Selective revision on sensor change"),
  ][no - 1];
}

export type StudyReference = {
  no: StudyNo;
  authors: string;
  title: string;
  /** A Korean title stays in Korean on the English screen, as a citation does. */
  titleLang?: "ko";
  venue: string;
  doi?: string;
};

export function studyReference(no: StudyNo): StudyReference {
  const authors = L("김유석, 김용운, 변영철", "Y.-S. Kim, Y.-W. Kim, and Y.-C. Byun");
  switch (no) {
    case 1:
      return {
        no,
        authors,
        title: "스마트팜 RAG를 위한 질의 적응형 검색 채널 제어",
        titleLang: "ko",
        venue: L("한국정보기술학회논문지, 제24권 제6호, 99–108쪽, 2026", "Journal of KIIT, vol. 24, no. 6, pp. 99–108, 2026 (in Korean)"),
        doi: "10.14801/jkiit.2026.24.6.99",
      };
    case 2:
      return {
        no,
        authors,
        title: "Role-Separated Selective Response for Question Answering in Multi-View Video Surveillance",
        venue: L("IEEE Access, 심사 중", "IEEE Access, under review"),
      };
    default:
      return {
        no,
        authors: L("김유석", "Y.-S. Kim"),
        title: "근거 기반 선택적 제어를 적용한 스마트팜 RAG 운영 지원 시스템",
        titleLang: "ko",
        venue: L("제주대학교 석사학위논문, 작성 중", "M.S. thesis in preparation, Jeju National University (in Korean)"),
      };
  }
}
