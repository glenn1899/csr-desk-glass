import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/index.js";

const SITE = "https://csr-desk-glass.glenn-889.workers.dev";

test("the worker routes the calendar API and the connect paths", async () => {
  const events = await worker.fetch(new Request(`${SITE}/api/events`), {});
  assert.equal(events.status, 200);
  assert.equal(events.headers.get("cache-control"), "private, max-age=30");
  const body = await events.json();
  assert.equal(body.source, "sample");
  assert.equal(body.ok, true);

  const start = await worker.fetch(new Request(`${SITE}/auth/start`), {
    GOOGLE_CLIENT_ID: "client-id",
    GOOGLE_CLIENT_SECRET: "client-secret",
  });
  assert.equal(start.status, 401);
  assert.equal((await start.json()).error, "Cloudflare Access is required.");

  const callback = await worker.fetch(new Request(`${SITE}/auth/callback?code=x&state=y`), {});
  assert.equal(callback.status, 401);
});

test("the worker serves the desk page through the assets binding", async () => {
  let seen = "";
  const response = await worker.fetch(new Request(`${SITE}/`), {
    ASSETS: {
      fetch(request) {
        seen = request instanceof Request ? request.url : String(request);
        return new Response("<!doctype html><title>CSR Desk</title>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      },
    },
  });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /CSR Desk/);
  assert.equal(seen, `${SITE}/`);
});
