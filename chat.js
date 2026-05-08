require("dotenv").config();
const readline = require("readline");
const Anthropic = require("@anthropic-ai/sdk");

const client = new Anthropic();

const SYSTEM = `
[01 ROLE]
너는 주린이를 위한 주식 투자 피드백 가이드야.

[02 TASK]
<input> 안의 종목명, 매수 가격, 매수 수량을 보고
투자 피드백 3줄을 만들어줘.

[03 OUTPUT FORMAT]
- 정확히 3줄. 한 줄씩 대시(-)로 시작
- 1줄: 현재 종목 상태 요약
- 2줄: 리스크 포인트
- 3줄: 추천 액션
- 각 줄은 50자 이내
- 출력 금지 — 인사말·추측·코드블록·이모티콘
- 3줄 외 어떤 텍스트도 출력 금지

[04 RULES]
- 모르는 종목은 "정보를 찾기 어려운 종목이에요" 출력
- 추측 금지. 확인된 정보만 사용
- 주린이가 이해할 수 있는 쉬운 말로
- 줄 바꿈 없이 3줄만 출력

[05 EXAMPLES]
입력 — 종목명: 삼성전자 / 매수 가격: 270,000원 / 매수 수량: 10주
출력 
- 현재 종목 상태 요약: 현재 삼성전자는 반도체 업황 회복 기대로 횡보 중
- 리스크 포인트: 단기 반등 후 재하락 가능성 있어 추가 매수 주의
- 추천 액션: 지금은 보유 유지, 250,000원 아래로 내려오면 재검토

입력 — 종목명: 카카오 / 매수 가격: 42,000원 / 매수 수량: 5주
출력
- 현재 종목 상태 요약: 카카오는 규제 이슈로 주가 회복이 더딘 상황
- 리스크 포인트: 플랫폼 규제 리스크 여전히 남아 있어 변동성 주의
- 추천 액션: 추가 매수보다 현 보유 유지 후 실적 발표 후 재판단

입력 — 종목명: 애플 / 매수 가격: $250 / 매수 수량: 3주
출력
- 현재 종목 상태 요약: 애플은 AI 기능 확대와 서비스 매출 호조로 견조
- 리스크 포인트: 고평가 부담과 원달러 환율 변동성 함께 점검 필요
- 추천 액션: 보유 유지, $230 아래 하락 시 분할 매수 검토

입력 — 종목명: 엔비디아 / 매수 가격: $210 / 매수 수량: 2주
출력
- 현재 종목 상태 요약: 엔비디아는 AI 칩 수요 강세로 실적 모멘텀 지속
- 리스크 포인트: 변동성이 크고 고평가 부담 있어 단기 조정 가능성
- 추천 액션: 분할 매수 권장, 급락 구간에서 추가 진입 고려

입력 — 종목명: 코카콜라 / 매수 가격: $78 / 매수 수량: 5주
출력
- 현재 종목 상태 요약: 코카콜라는 안정적 배당과 꾸준한 실적의 대표주
- 리스크 포인트: 환율 약세 시 원화 환산 수익률이 줄어들 수 있음
- 추천 액션: 장기 보유 적합, 분기 배당락 전후 매수 시점 검토

[06 EDGE CASES]
- 빈 입력 → 버튼 비활성화
- 가격·수량이 0이거나 문자 → "올바른 숫자를 입력해주세요"
- 응답 형식 이상(3줄 미만·초과) → 반드시 3줄로만 재구성해서 출력
- 네트워크·타임아웃 오류 → 클라이언트에서 처리 (시스템 프롬프트 범위 밖)
- 입력값이 비현실적으로 클 때(매수 가격이 실제 시장가 대비 10배 이상이거나, 총 매수 금액이 수십억 원/달러 이상으로 명백히 정상 범위를 벗어난 경우)
  → 3줄 형식 사용 금지. 다음 단일 문장만 출력 (대시 없이): 비정상적인 수치로 투자 분석이 불가능합니다. 다시 시도해주세요
`.trim();

let userProfile = {
  step: 1, // 1: 성향, 2: 목적, 3: 업종
  성향: null,
  목적: null,
  업종: null
};

let conversationHistory = [];

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

const getOnboardingQuestion = () => {
  if (userProfile.step === 1) {
    return "투자 성향이 어떤가요? 다음 중 골라줄래요?\n1) 안정형 - 손실이 무서워서 안정적인 종목\n2) 성장형 - 수익을 노리고 변동성 있는 종목\n3) 학습형 - 일단 배워보고 싶어요";
  } else if (userProfile.step === 2) {
    return "어떤 목표로 시작해보고 싶으신가요?\n1) 여유 자금으로 경험 쌓기\n2) 목돈 마련을 위해\n3) 그냥 관심이 생겨서";
  } else if (userProfile.step === 3) {
    return "특별히 관심 있는 분야가 있나요?\n1) 기술/IT 관련\n2) 금융/은행\n3) 특정 분야 없이 추천받고 싶어요";
  }
};

const parseOnboardingAnswer = (text) => {
  const num = text.trim()[0];
  
  if (userProfile.step === 1) {
    const answers = { "1": "안정형", "2": "성장형", "3": "학습형" };
    if (answers[num]) {
      userProfile.성향 = answers[num];
      userProfile.step = 2;
      return true;
    }
  } else if (userProfile.step === 2) {
    const answers = { "1": "경험쌓기", "2": "목돈마련", "3": "관심" };
    if (answers[num]) {
      userProfile.목적 = answers[num];
      userProfile.step = 3;
      return true;
    }
  } else if (userProfile.step === 3) {
    const answers = { "1": "IT", "2": "금융", "3": "상관없음" };
    if (answers[num]) {
      userProfile.업종 = answers[num];
      userProfile.step = "complete";
      return true;
    }
  }
  return false;
};

const ask = () =>
  rl.question("나: ", async (input) => {
    const text = input.trim();
    if (text === "q") {
      rl.close();
      return;
    }

    try {
      // 온보딩 진행 중
      if (userProfile.step !== "complete") {
        if (parseOnboardingAnswer(text)) {
          if (userProfile.step === "complete") {
            console.log(`\n✓ 온보딩 완료!\n당신의 프로필: ${userProfile.성향} | 목표: ${userProfile.목적} | 업종: ${userProfile.업종}\n`);
          } else {
            console.log(`\n가이드: ${getOnboardingQuestion()}\n`);
          }
        } else {
          console.log(`\n가이드: 1, 2, 3 중 하나를 골라줄래요!\n`);
          console.log(`가이드: ${getOnboardingQuestion()}\n`);
        }
      } else {
        // 온보딩 완료 후 추천
        const profileContext = `사용자 프로필 - 성향: ${userProfile.성향}, 목적: ${userProfile.목적}, 관심 업종: ${userProfile.업종}`;
        
        const res = await client.messages.create({
          model: "claude-haiku-4-5",
          max_tokens: 1024,
          system: `${SYSTEM}\n\n${profileContext}`,
          messages: [
            ...conversationHistory,
            { role: "user", content: text }
          ],
        });

        const responseText = res.content[0].text;
        console.log("가이드:", responseText, "\n");
        conversationHistory.push({ role: "user", content: text });
        conversationHistory.push({ role: "assistant", content: responseText });
      }
    } catch (e) {
      console.error("에러:", e.message, "\n");
    }

    ask();
  });

// 첫 질문 출력
console.log(`가이드: ${getOnboardingQuestion()}\n`);
ask();