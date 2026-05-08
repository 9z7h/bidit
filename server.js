require("dotenv").config();
const http = require("http");
const fs = require("fs");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk");

const client = new Anthropic();

const SYSTEM = `
<role>
너는 주식을 처음 시작하는 초보자(주린이) 전용 투자 가이드야.
복잡한 공부 없이 "나도 할 수 있다"는 감각을 만들어주는 게 목표야.
</role>

<rules>
- 실제 투자 권유 및 수익 보장 발언 금지
- 이모지 금지
- 존댓말로 친근하고 쉬운 말투로 대화해
- 한 번에 선택지 3개 이상 제시 금지
</rules>

<steps>
1. 사용자의 성향(목적·손실 감수·관심 업종)에 맞춰 종목 추천해
2. 추천 이유를 1문장으로 설명해
3. "지금 할 행동"을 단계별로 안내해
4. 매수 후 피드백 요청이 오면 현재 구간을 쉽게 해석해줘
</steps>

<format>
- 추천 응답: 종목명 / 현재가 / 이유 1문장 형식으로
- 피드백 응답: 3줄 이내로
- 전문 용어 사용 시: 바로 다음 문장에 쉬운 말로 풀어서
</format>
`.trim();

const ONBOARDING = {
  1: {
    q: "투자 성향이 어떤가요? 다음 중 골라주세요.\n1) 안정형 - 손실이 무서워서 안정적인 종목\n2) 성장형 - 수익을 노리고 변동성 있는 종목\n3) 학습형 - 일단 배워보고 싶어요",
    key: "성향",
    map: { "1": "안정형", "2": "성장형", "3": "학습형" }
  },
  2: {
    q: "어떤 목표로 시작해보고 싶으신가요?\n1) 여유 자금으로 경험 쌓기\n2) 목돈 마련을 위해\n3) 그냥 관심이 생겨서",
    key: "목적",
    map: { "1": "경험쌓기", "2": "목돈마련", "3": "관심" }
  },
  3: {
    q: "특별히 관심 있는 분야가 있나요?\n1) 기술/IT 관련\n2) 금융/은행\n3) 특정 분야 없이 추천받고 싶어요",
    key: "업종",
    map: { "1": "IT", "2": "금융", "3": "상관없음" }
  }
};

const sessions = {};

function getSession(id) {
  if (!sessions[id]) {
    sessions[id] = {
      step: 1,
      profile: { 성향: null, 목적: null, 업종: null },
      history: []
    };
  }
  return sessions[id];
}

async function handleMessage(session, text) {
  if (session.step !== "complete") {
    const stage = ONBOARDING[session.step];
    const num = text.trim()[0];
    if (stage.map[num]) {
      session.profile[stage.key] = stage.map[num];
      session.step = session.step + 1;
      if (session.step > 3) {
        session.step = "complete";
        const p = session.profile;
        return `온보딩 완료!\n프로필: ${p.성향} | 목표: ${p.목적} | 업종: ${p.업종}\n\n이제 궁금한 걸 편하게 물어봐 주세요.`;
      }
      return ONBOARDING[session.step].q;
    }
    return `1, 2, 3 중 하나를 골라주세요.\n\n${stage.q}`;
  }

  const p = session.profile;
  const profileContext = `사용자 프로필 - 성향: ${p.성향}, 목적: ${p.목적}, 관심 업종: ${p.업종}`;
  const res = await client.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 1024,
    system: `${SYSTEM}\n\n${profileContext}`,
    messages: [...session.history, { role: "user", content: text }]
  });
  const reply = res.content[0].text;
  session.history.push({ role: "user", content: text });
  session.history.push({ role: "assistant", content: reply });
  return reply;
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && (req.url === "/" || req.url === "/chat.html")) {
    fs.readFile(path.join(__dirname, "chat.html"), (err, data) => {
      if (err) { res.writeHead(500); return res.end("error"); }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(data);
    });
    return;
  }

  if (req.method === "GET" && req.url === "/init") {
    const id = Math.random().toString(36).slice(2);
    const session = getSession(id);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ sessionId: id, message: ONBOARDING[session.step].q }));
    return;
  }

  if (req.method === "POST" && req.url === "/chat") {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", async () => {
      try {
        const { sessionId, text } = JSON.parse(body);
        const session = getSession(sessionId);
        const reply = await handleMessage(session, text);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ reply }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end("not found");
});

const PORT = 3000;
server.listen(PORT, () => {
  console.log(`http://localhost:${PORT}`);
});
