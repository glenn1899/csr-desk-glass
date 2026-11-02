import { onRequest as onAuthCallback } from "./routes/auth-callback.js";
import { onRequest as onAuthStart } from "./routes/auth-start.js";
import { onRequest as onEvents } from "./routes/events.js";

const routes = {
  "/api/events": onEvents,
  "/auth/start": onAuthStart,
  "/auth/callback": onAuthCallback,
};

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    const handler = routes[path];
    if (handler) return handler({ request, env: env || {} });
    if (!env || !env.ASSETS || typeof env.ASSETS.fetch !== "function") {
      return new Response("Page unavailable.", {
        status: 500,
        headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" },
      });
    }
    return env.ASSETS.fetch(request);
  },
};
