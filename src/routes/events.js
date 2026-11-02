import { loadEvents } from "../lib/schedule.js";

const BASE_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cdn-cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "x-robots-tag": "noindex",
};

export async function onRequest(context) {
  const method = context.request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    return respond({ ok: false, error: "Method not allowed." }, 405, { allow: "GET, HEAD" }, method === "HEAD");
  }
  try {
    const result = await loadEvents(context.env || {}, { now: new Date() });
    return respond(result.body, result.status, {}, method === "HEAD");
  } catch {
    console.log(JSON.stringify({ level: "error", message: "calendar_request_failed" }));
    return respond({
      ok: false,
      source: "unknown",
      timezone: "America/Toronto",
      error: "Could not read the calendar.",
      events: [],
    }, 500, {}, method === "HEAD");
  }
}

function respond(body, status, extra, head) {
  return new Response(head ? null : JSON.stringify(body), {
    status,
    headers: {
      ...BASE_HEADERS,
      "cache-control": status >= 400 ? "private, no-store" : "private, max-age=30",
      ...extra,
    },
  });
}
