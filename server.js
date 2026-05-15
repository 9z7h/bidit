// 로컬 개발용 HTTP 서버. Vercel 배포 시엔 api/chat.js 가 같은 역할 수행.
require("dotenv").config();
const http = require("http");
const fs = require("fs");
const path = require("path");
const { captureAndFlush } = require("./lib/sentry.js"); // Sentry init 먼저
const { callWithTools } = require("./lib/tools.js");

/* ============== Security ============== */
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "http://localhost:3000,http://127.0.0.1:3000")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function isOriginAllowed(origin) {
  if (!origin) return true; // same-origin or non-browser
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  // dev 편의: 로컬 호스트 변종(다른 포트, 0.0.0.0, [::1] 등) 허용
  try {
    const u = new URL(origin);
    if (["localhost", "127.0.0.1", "0.0.0.0", "[::1]"].includes(u.hostname)) return true;
  } catch (e) {}
  return false;
}

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (origin && isOriginAllowed(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
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
  if (_rateBuckets.size > 5000) {
    for (const [k, v] of _rateBuckets) {
      const fresh = v.filter((t) => now - t < RATE_WINDOW_MS);
      if (fresh.length === 0) _rateBuckets.delete(k);
      else _rateBuckets.set(k, fresh);
    }
  }
  return { ok: true };
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
    const origin = req.headers.origin;
    if (!isOriginAllowed(origin)) {
      console.warn("[origin_not_allowed]", origin);
      res.writeHead(403, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "origin_not_allowed", origin: origin || null }));
    }

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
      await captureAndFlush(e, { route: "/api/chat" });
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
