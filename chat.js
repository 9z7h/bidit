require("dotenv").config();
const readline = require("readline");
const Anthropic = require("@anthropic-ai/sdk");

const client = new Anthropic();

const SYSTEM = `
[01 ROLE]
너는 두 사람의 역할을 동시에 한다.

<analyst>
주식 데이터 분석 전담.
추천 요청 시 → 성향 기반 종목 3개 선정, 각 선정 이유 1문장 (20자 이내).
매수 완료 시 → 매수가·현재가·등락률·거래량에서 현재 구간 위치 추출.
</analyst>

<coach>
주린이 눈높이 맞춤 전담.
추천 요청 시 → analyst 결과를 성향 적합도 순 정렬 + 각 종목마다 리스크 1줄 + "지금 할 행동" 3단계.
매수 완료 시 → analyst 추출 결과를 3줄 피드백으로 생성. 각 50자 이내. 대시(—) 시작.
겁주는 표현 금지.
</coach>

최종 출력은 coach 결과만. analyst 초안은 보여주지 않는다.

[02 TASK]
<input>
종목명, 매수 가격, 매수 수량을 보고 투자 피드백 3줄을 만들어줘.
</input>

[03 OUTPUT FORMAT]
<output_format>
- 정확히 3줄. 한 줄씩 대시(—)로 시작
- 1줄: 현재 종목 상태 요약
- 2줄: 리스크 포인트
- 3줄: 추천 액션
- 각 줄은 50자 이내
- 출력 금지 — 인사말·추측·코드블록·이모티콘
- 3줄 외 어떤 텍스트도 출력 금지
</output_format>

[04 RULES]
<rules>
- 확실하지 않은 사실은 만들어 내지 마라. 대신 "확인 필요"로 표기하고, 어떤 정보가 부족한지 한 줄로 적어라
- 모르는 종목은 "정보를 찾기 어려운 종목이에요" 출력
- 추측 금지. 확인된 정보만 사용
- 주린이가 이해할 수 있는 쉬운 말로
- 주린이가 모를 만한 주식 용어는 반드시 "용어*" 형식(뒤에 별표 1개)으로 표기. 예: 횡보*, 변동성*, 분할 매수*, 모멘텀*
- 줄 바꿈 없이 3줄만 출력
</rules>

[05 EXAMPLES]
<example_1>
입력 — 성향: 안정형 / 목적: 경험쌓기 / 업종: IT
출력
— 삼성전자 / KR — 반도체 대형주로 초보자 접근 쉬움
  리스크: 업황 둔화 시 단기 하락 가능
— 애플 / US — 누구나 아는 브랜드, 변동성 낮음
  리스크: 환율 영향 받을 수 있음
— 카카오뱅크 / KR — IT·금융 동시 접근 가능
  리스크: 플랫폼 규제 이슈 잔존

지금 할 행동:
— 종목 하나 골라 현재가 검색해보기
— 가상 매수 금액 정해보기
— 매수 버튼 눌러보기
</example_1>

<example_2>
입력 — 종목명: 삼성전자 / 매수 가격: 71000원 / 매수 수량: 10주
출력
— 현재 삼성전자는 반도체 업황* 회복 기대로 횡보* 중
— 단기 반등* 후 재하락 가능성 있어 추가 매수 주의
— 지금은 보유 유지, 65000원 아래 시 분할 매수* 재검토
</example_2>

<example_3>
입력 — 종목명: 카카오 / 매수 가격: 42000원 / 매수 수량: 5주
출력
— 카카오는 규제 이슈로 주가 회복이 더딘 상황
— 플랫폼 규제 리스크* 남아 있어 변동성* 주의
— 추가 매수보다 보유 유지 후 실적* 발표 후 재판단
</example_3>

<example_4 caption="엣지 — 잘못된 입력">
입력 — 종목명: 삼성전자 / 매수 가격: 0원 / 매수 수량: abc
출력 — 올바른 숫자를 입력해주세요
</example_4>

[06 EDGE CASES]
- 빈 입력 → 버튼 비활성화
- 가격·수량이 0이거나 문자 → "올바른 숫자를 입력해주세요"
- 응답 형식 이상(3줄 미만·초과) → 반드시 3줄로만 재구성해서 출력
- 네트워크·타임아웃 오류 → 클라이언트에서 처리 (시스템 프롬프트 범위 밖)
`.trim();

let userProfile = {
  step: 1,
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
    return "특별히 관심 있는 분야가 있나요?\n1) 기술/IT 관련\n2) 금융/은행\n3) 의료/바이오\n4) 엔터/미디어\n5) 특정 분야 없이 추천받고 싶어요";
  }
};

const parseOnboardingAnswer = (text) => {
  const num = text.trim()[0];

  if (userProfile.step === 1) {
    const answers = { "1": "안정형", "2": "성장형", "3": "학습형" };
    if (answers[num]) { userProfile.성향 = answers[num]; userProfile.step = 2; return true; }
  } else if (userProfile.step === 2) {
    const answers = { "1": "경험쌓기", "2": "목돈마련", "3": "관심" };
    if (answers[num]) { userProfile.목적 = answers[num]; userProfile.step = 3; return true; }
  } else if (userProfile.step === 3) {
    const answers = { "1": "IT", "2": "금융", "3": "의료", "4": "엔터", "5": "상관없음" };
    if (answers[num]) { userProfile.업종 = answers[num]; userProfile.step = "complete"; return true; }
  }
  return false;
};

const ask = () =>
  rl.question("나: ", async (input) => {
    const text = input.trim();
    if (text === "q") { rl.close(); return; }

    try {
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
        const profileContext = `사용자 프로필 - 성향: ${userProfile.성향}, 목적: ${userProfile.목적}, 관심 업종: ${userProfile.업종}`;
        const isFeedback = text.includes("매수 가격") && text.includes("매수 수량");

        if (isFeedback) {
          // ✅ 체인 CALL 1 — EXTRACT (SYSTEM 연결)
          const extracted = await client.messages.create({
            model: "claude-haiku-4-5",
            max_tokens: 1024,
            system: `${SYSTEM}\n\nCALL 1 역할: analyst로서 매수가·현재가·등락률·거래량에서 핵심 수치만 추출. 3줄 이내. 인사말 금지.`,
            messages: [{ role: "user", content: `<input>${text}</input>` }]
          });
          const extractedData = extracted.content[0].text;

          // ✅ 체인 CALL 2 — GENERATE (SYSTEM 연결)
          const feedback = await client.messages.create({
            model: "claude-haiku-4-5",
            max_tokens: 1024,
            system: `${SYSTEM}\n\n${profileContext}\n\nCALL 2 역할: coach로서 추출된 수치를 받아 3줄 피드백 생성. 각 50자 이내, 대시(—) 시작. 겁주는 표현 금지.`,
            messages: [{ role: "user", content: `<draft>${extractedData}</draft>` }]
          });

          const responseText = feedback.content[0].text;
          console.log("\n가이드:", responseText, "\n");
          conversationHistory.push({ role: "user", content: text });
          conversationHistory.push({ role: "assistant", content: responseText });

        } else {
          // 추천 요청 — 단일 호출
          const res = await client.messages.create({
            model: "claude-haiku-4-5",
            max_tokens: 1024,
            system: `${SYSTEM}\n\n${profileContext}`,
            messages: [...conversationHistory, { role: "user", content: text }],
          });

          const responseText = res.content[0].text;
          console.log("\n가이드:", responseText, "\n");
          conversationHistory.push({ role: "user", content: text });
          conversationHistory.push({ role: "assistant", content: responseText });
        }
      }
    } catch (e) {
      console.error("에러:", e.message, "\n");
    }

    ask();
  });

console.log(`가이드: ${getOnboardingQuestion()}\n`);
ask();