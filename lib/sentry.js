// Sentry Node 초기화 — server.js / api/chat.js 양쪽에서 공통 사용.
// SENTRY_DSN_SERVER 환경변수 없으면 조용히 비활성 (no-op).
const Sentry = require("@sentry/node");

let _initialized = false;

function initSentry() {
  if (_initialized) return;
  const dsn = process.env.SENTRY_DSN_SERVER;
  if (!dsn) return; // 로컬에서 DSN 안 줬으면 그냥 패스
  Sentry.init({
    dsn,
    environment:
      process.env.VERCEL_ENV ||
      (process.env.NODE_ENV === "production" ? "production" : "development"),
    release: process.env.VERCEL_GIT_COMMIT_SHA || undefined,
    sendDefaultPii: true,
    tracesSampleRate: 0,
    beforeSend(event, hint) {
      const err = hint && hint.originalException;
      const msg = (err && err.message) || event.message || "";
      // Claude API 일시적 과부하·레이트리밋은 알림 노이즈 → 드롭
      if (/overloaded_error|rate_limit_error|529|429/i.test(msg)) return null;
      // 클라이언트가 끊은 경우
      if (/aborted|ECONNRESET|socket hang up/i.test(msg)) return null;
      return event;
    }
    // Vercel serverless에선 functions terminate가 빠르니 flush 명시적으로 호출
  });
  _initialized = true;
}

initSentry();

async function captureAndFlush(err, context = {}) {
  if (!_initialized) {
    console.error("[sentry-disabled]", err);
    return;
  }
  try {
    Sentry.captureException(err, { extra: context });
    await Sentry.flush(2000);
  } catch (e) {
    console.error("[sentry-flush-error]", e);
  }
}

module.exports = { Sentry, captureAndFlush };
