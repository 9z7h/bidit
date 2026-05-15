// Vercel Serverless Function: POST /api/chat
// 브라우저(chat.html)에서 호출 → Claude + 도구 호출 루프 처리
const { captureAndFlush } = require("../lib/sentry.js"); // Sentry init 먼저
const { callWithTools } = require("../lib/tools.js");

// trailing slash·대소문자 차이를 흡수
function normalizeOrigin(o) {
  if (!o) return "";
  return o.trim().toLowerCase().replace(/\/+$/, "");
}

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map(normalizeOrigin)
  .filter(Boolean);

function isSameHost(origin, reqHost) {
  if (!origin || !reqHost) return false;
  try {
    return new URL(origin).host.toLowerCase() === String(reqHost).toLowerCase();
  } catch (e) { return false; }
}

function isAllowed(origin, reqHost) {
  if (!ALLOWED_ORIGINS.length) return true; // 화이트리스트 미설정 = 모두 허용
  if (ALLOWED_ORIGINS.includes(normalizeOrigin(origin))) return true;
  if (isSameHost(origin, reqHost)) return true; // 같은 도메인끼리는 항상 허용
  return false;
}

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (!origin || isAllowed(origin, req.headers.host)) {
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

module.exports = async function handler(req, res) {
  applyCors(req, res);

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }
  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }

  // Origin 화이트리스트 (있을 때만 검사)
  const origin = req.headers.origin;
  if (origin && !isAllowed(origin, req.headers.host)) {
    return res.status(403).json({ error: "origin_not_allowed", got: origin });
  }

  try {
    const body = req.body || {};
    const { system, userMessage, useTools = true } = body;
    if (!system || !userMessage) {
      return res.status(400).json({ error: "system, userMessage 필수" });
    }
    const text = await callWithTools({
      system,
      messages: [{ role: "user", content: userMessage }],
      useTools
    });
    return res.status(200).json({ text });
  } catch (e) {
    console.error("[/api/chat] error:", e);
    await captureAndFlush(e, {
      route: "/api/chat",
      body_preview: typeof req.body === "object" ? Object.keys(req.body || {}) : null
    });
    return res.status(500).json({ error: e.message || "server_error" });
  }
};

// Vercel 함수 설정 (Pro 플랜에서 60초까지 허용; Hobby는 자동 10초 캡)
module.exports.config = {
  maxDuration: 30
};
