// 공통: Claude SDK + 3개 외부 도구 (시세·뉴스·공시) + tool use 루프
// server.js (로컬)와 api/chat.js (Vercel)에서 공통으로 사용
require("dotenv").config();
const Anthropic = require("@anthropic-ai/sdk");

const client = new Anthropic();
const MODEL = "claude-haiku-4-5";

/* ============== Tool definitions ============== */
const TOOLS = [
  {
    name: "get_stock_info",
    description: "특정 종목의 실시간 시세·등락률·시장 상태를 조회한다. 수치가 필요한 답변 전에 반드시 호출.",
    input_schema: {
      type: "object",
      properties: {
        ticker: {
          type: "string",
          description: "종목 코드. 한국 6자리 숫자(예: '005930'), 미국 티커(예: 'AAPL.O', 'JPM')"
        }
      },
      required: ["ticker"]
    }
  },
  {
    name: "get_stock_news",
    description: "특정 종목의 최근 뉴스 헤드라인과 요약을 가져온다. 주가 변동의 근거·호재·악재·이슈를 설명해야 할 때 호출. 단순 시세 질문엔 호출하지 말 것.",
    input_schema: {
      type: "object",
      properties: {
        ticker: { type: "string", description: "종목 코드. 한국 6자리 또는 미국 티커" },
        limit: { type: "number", description: "가져올 뉴스 개수 (기본 5, 최대 10)" }
      },
      required: ["ticker"]
    }
  },
  {
    name: "get_recent_disclosures",
    description: "한국 종목의 최근 공시(DART)를 가져온다. 배당·합병·자사주·증자·실적공시 같은 공식 이벤트 확인용. 한국 6자리 종목코드만. 미국 종목엔 호출하지 마라.",
    input_schema: {
      type: "object",
      properties: {
        ticker: { type: "string", description: "한국 6자리 종목코드 (예: '005930')" },
        days: { type: "number", description: "최근 며칠치 (기본 30, 최대 90)" }
      },
      required: ["ticker"]
    }
  }
];

/* ============== Tool implementations ============== */
async function fetchStockBasic(ticker) {
  const isKR = /^\d{6}$/.test(ticker);
  const url = isKR
    ? `https://m.stock.naver.com/api/stock/${ticker}/basic`
    : `https://api.stock.naver.com/stock/${ticker}/basic`;
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": "Mozilla/5.0" }
    });
    if (!res.ok) throw new Error(`HTTP_${res.status}`);
    const data = await res.json();
    const num = (v) => {
      if (v == null) return null;
      const n = Number(String(v).replace(/,/g, ""));
      return Number.isFinite(n) ? n : null;
    };
    const price = num(data.closePrice);
    if (price == null) throw new Error("PRICE_PARSE");
    return {
      ticker,
      market: isKR ? "KR" : "US",
      name: data.stockName || null,
      price,
      currency: data.currencyType?.code || (isKR ? "KRW" : "USD"),
      change_rate_pct: num(data.fluctuationsRatio),
      change_amount: num(data.compareToPreviousClosePrice),
      market_status: data.marketStatus || null,
      fetched_at: new Date().toISOString()
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function getStockInfo(ticker) {
  try {
    return await fetchStockBasic(ticker);
  } catch (e) {
    return { ticker, error: e.message, note: "시세 조회 실패. '확인 필요'로 답하라." };
  }
}

async function getStockNews(ticker, limit = 5) {
  const isKR = /^\d{6}$/.test(ticker);
  const size = Math.min(Math.max(limit, 1), 10);
  const url = isKR
    ? `https://m.stock.naver.com/api/news/stock/${ticker}?pageSize=${size * 2}&page=1`
    : `https://api.stock.naver.com/news/worldStock/${ticker}?pageSize=${size * 2}&page=1`;
  try {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": "Mozilla/5.0" }
    });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`HTTP_${res.status}`);
    const data = await res.json();
    const decode = (s) =>
      String(s || "")
        .replace(/&quot;/g, '"').replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
        .replace(/&#39;/g, "'");
    let items;
    if (isKR) {
      const groups = Array.isArray(data) ? data : [];
      items = groups.flatMap((g) => g.items || []).map((n) => ({
        title: decode(n.title),
        summary: decode(n.body || "").slice(0, 180),
        source: n.officeName,
        datetime: n.datetime
      }));
    } else {
      const arr = Array.isArray(data) ? data : [];
      items = arr.map((n) => ({
        title: decode(n.tit),
        summary: decode(n.subcontent || "").slice(0, 180),
        source: n.ohnm,
        datetime: n.dt
      }));
    }
    return { ticker, count: items.length, news: items.slice(0, size) };
  } catch (e) {
    return { ticker, error: e.message, note: "뉴스 조회 실패." };
  }
}

async function getRecentDisclosures(ticker, days = 30) {
  if (!process.env.DART_API_KEY) {
    return {
      ticker,
      error: "DART_API_KEY 미설정",
      setup: "https://opendart.fss.or.kr 가입 후 환경변수 추가"
    };
  }
  if (!/^\d{6}$/.test(ticker)) {
    return { ticker, error: "DART는 한국 6자리 종목코드만 지원" };
  }
  const span = Math.min(Math.max(days, 1), 90);
  const today = new Date();
  const past = new Date(today.getTime() - span * 86400000);
  const fmt = (d) => d.toISOString().slice(0, 10).replace(/-/g, "");
  const url = new URL("https://opendart.fss.or.kr/api/list.json");
  url.searchParams.set("crtfc_key", process.env.DART_API_KEY);
  url.searchParams.set("stock_code", ticker);
  url.searchParams.set("bgn_de", fmt(past));
  url.searchParams.set("end_de", fmt(today));
  url.searchParams.set("page_count", "10");
  try {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`HTTP_${res.status}`);
    const data = await res.json();
    if (data.status === "013") {
      return { ticker, count: 0, disclosures: [], note: "최근 공시 없음" };
    }
    if (data.status !== "000") {
      return { ticker, error: data.message || `DART_${data.status}` };
    }
    const items = (data.list || []).map((d) => ({
      title: d.report_nm,
      date: d.rcept_dt,
      submitter: d.flr_nm,
      receipt_no: d.rcept_no
    }));
    return { ticker, count: items.length, disclosures: items };
  } catch (e) {
    return { ticker, error: e.message };
  }
}

const TOOL_HANDLERS = {
  get_stock_info: (i) => getStockInfo(i.ticker),
  get_stock_news: (i) => getStockNews(i.ticker, i.limit || 5),
  get_recent_disclosures: (i) => getRecentDisclosures(i.ticker, i.days || 30)
};

/* ============== Claude call with tool-use loop ============== */
async function callWithTools({ system, messages, useTools = true, maxIterations = 4 }) {
  let msgs = [...messages];
  for (let i = 0; i < maxIterations; i++) {
    const params = {
      model: MODEL,
      max_tokens: 1024,
      system,
      messages: msgs
    };
    if (useTools) params.tools = TOOLS;
    const res = await client.messages.create(params);
    if (res.stop_reason !== "tool_use") {
      return res.content.find((c) => c.type === "text")?.text || "";
    }
    const toolUses = res.content.filter((c) => c.type === "tool_use");
    const toolResults = await Promise.all(toolUses.map(async (tu) => {
      const handler = TOOL_HANDLERS[tu.name];
      const result = handler ? await handler(tu.input) : { error: `unknown tool: ${tu.name}` };
      return {
        type: "tool_result",
        tool_use_id: tu.id,
        content: JSON.stringify(result)
      };
    }));
    msgs.push({ role: "assistant", content: res.content });
    msgs.push({ role: "user", content: toolResults });
  }
  return "[도구 호출 한도 초과]";
}

module.exports = { client, MODEL, TOOLS, TOOL_HANDLERS, callWithTools };
