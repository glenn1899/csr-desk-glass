import indexHtml from "../public/index.html";
import { verifyAccessJwt } from "./lib/access.js";
import { onRequest as onAuthCallback } from "./routes/auth-callback.js";
import { onRequest as onAuthStart } from "./routes/auth-start.js";
import { onRequest as onEvents } from "./routes/events.js";

const files = {
  "/": { body: indexHtml, type: "text/html; charset=utf-8" },
  "/index.html": { body: indexHtml, type: "text/html; charset=utf-8" },
};

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
  return staticFile(path);
}

function staticFile(path) {
  const file = files[path];
  if (!file) {
    return new Response("Not found.", {
      status: 404,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "private, no-store",
      },
    });
  }
  return new Response(file.body, {
    status: 200,
    headers: {
      "content-type": file.type,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
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
  async fetch(request, env, ctx) {
    return handleRequest(request, env, { ctx });
  },
};
