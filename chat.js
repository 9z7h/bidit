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
입력 — 종목명: 삼성전자 / 매수 가격: 71000원 / 매수 수량: 10주
출력 
- 현재 삼성전자는 반도체 업황 회복 기대로 횡보 중
- 단기 반등 후 재하락 가능성 있어 추가 매수 주의
- 지금은 보유 유지, 65000원 아래로 내려오면 재검토

입력 — 종목명: 카카오 / 매수 가격: 42000원 / 매수 수량: 5주
출력
- 카카오는 규제 이슈로 주가 회복이 더딘 상황
- 플랫폼 규제 리스크 여전히 남아 있어 변동성 주의
- 추가 매수보다 현 보유 유지 후 실적 발표 후 재판단

[06 EDGE CASES]
- 종목명 없음 → "종목명을 입력해주세요"
- 빈 입력 → 버튼 비활성화
- 가격·수량이 0이거나 문자 → "올바른 숫자를 입력해주세요"
- 상장 폐지·존재하지 않는 종목 → "정보를 찾기 어려운 종목이에요"
- 응답 형식 이상(3줄 미만·초과) → 반드시 3줄로만 재구성해서 출력
- 네트워크·타임아웃 오류 → 클라이언트에서 처리 (시스템 프롬프트 범위 밖)
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