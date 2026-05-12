require("dotenv").config();
const http = require("http");
const fs = require("fs");
const path = require("path");
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
      setup: "https://opendart.fss.or.kr 가입 후 .env에 추가"
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

/* ============== HTTP server ============== */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

/* ============== Security ============== */
// ALLOWED_ORIGINS: 콤마로 구분된 허용 출처. 미설정 시 localhost만 허용.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "http://localhost:3000,http://127.0.0.1:3000")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  // origin이 없으면 same-origin 요청이므로 CORS 헤더 없어도 통과
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

// IP별 슬라이딩 윈도우 레이트 리밋
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = Number(process.env.RATE_LIMIT_PER_MIN) || 20;
const _rateBuckets = new Map();

function getClientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (xff) return String(xff).split(",")[0].trim();
  return req.socket?.remoteAddress || "unknown";
}

function checkRateLimit(ip) {
  const now = Date.now();
  const arr = _rateBuckets.get(ip) || [];
  const recent = arr.filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_LIMIT) {
    return { ok: false, retryAfter: Math.ceil((RATE_WINDOW_MS - (now - recent[0])) / 1000) };
  }
  recent.push(now);
  _rateBuckets.set(ip, recent);
  // 가끔 메모리 청소
  if (_rateBuckets.size > 5000) {
    for (const [k, v] of _rateBuckets) {
      const fresh = v.filter((t) => now - t < RATE_WINDOW_MS);
      if (fresh.length === 0) _rateBuckets.delete(k);
      else _rateBuckets.set(k, fresh);
    }
  }
  return { ok: true };
}

const server = http.createServer(async (req, res) => {
  applyCors(req, res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  // 정적 — chat.html
  if (req.method === "GET" && (req.url === "/" || req.url === "/chat.html")) {
    fs.readFile(path.join(__dirname, "chat.html"), (err, data) => {
      if (err) {
        res.writeHead(500);
        return res.end("error");
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(data);
    });
    return;
  }

  // 도구 호출 가능한 Claude 프록시
  if (req.method === "POST" && req.url === "/api/chat") {
    // Origin 화이트리스트 검사 (cross-origin 요청에 한해)
    const origin = req.headers.origin;
    if (origin && !ALLOWED_ORIGINS.includes(origin)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "origin_not_allowed" }));
    }

    // 레이트 리밋
    const ip = getClientIp(req);
    const rl = checkRateLimit(ip);
    if (!rl.ok) {
      res.setHeader("Retry-After", String(rl.retryAfter));
      res.writeHead(429, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({
        error: "too_many_requests",
        retry_after_seconds: rl.retryAfter
      }));
    }

    try {
      const body = await readBody(req);
      const { system, userMessage, useTools = true } = JSON.parse(body || "{}");
      if (!system || !userMessage) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "system, userMessage 필수" }));
      }
      const text = await callWithTools({
        system,
        messages: [{ role: "user", content: userMessage }],
        useTools
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ text }));
    } catch (e) {
      console.error(e);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message || "server_error" }));
    }
    return;
  }

  res.writeHead(404);
  res.end("not found");
});

const PORT = Number(process.env.PORT) || 3000;
server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
