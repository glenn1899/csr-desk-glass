import { verifyAccessJwt } from "./lib/access.js";
import { onRequest as onAuthCallback } from "./routes/auth-callback.js";
import { onRequest as onAuthStart } from "./routes/auth-start.js";
import { onRequest as onEvents } from "./routes/events.js";

const routes = {
  "/api/events": onEvents,
  "/auth/start": onAuthStart,
  "/auth/callback": onAuthCallback,
};

export async function handleRequest(request, env, options = {}) {
  const path = new URL(request.url).pathname;
  const handler = routes[path];
  if (handler) {
    const allowed = await gate(request, env, options);
    if (!allowed) return accessDenied();
    return handler({ request, env: env || {} });
  }
  if (!env || !env.ASSETS || typeof env.ASSETS.fetch !== "function") {
    return new Response("Page unavailable.", {
      status: 500,
      headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" },
    });
  }
  return env.ASSETS.fetch(request);
}

async function gate(request, env, options) {
  try {
    return await verifyAccessJwt(request, env || {}, options);
  } catch {
    console.log(JSON.stringify({ level: "error", message: "access_jwt_failed" }));
    return false;
  }
}

function accessDenied() {
  return new Response(JSON.stringify({ ok: false, error: "Cloudflare Access is required." }), {
    status: 401,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "private, no-store",
      "cdn-cache-control": "no-store",
    },
  });
}

export default {
  async fetch(request, env) {
    return handleRequest(request, env);
  },
};
