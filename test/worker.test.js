import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/index.js";

const SITE = "https://csr-desk-glass.glenn-889.workers.dev";

test("the worker refuses calendar and connect routes without an Access JWT", async () => {
  const events = await worker.fetch(new Request(`${SITE}/api/events`), {
    ACCESS_TEAM_DOMAIN: "dry-mud-91ba.cloudflareaccess.com",
    ACCESS_AUD: "f3e04809e143ccb2737c5becfe83dd36c5852415051eb808ff95e638974bdec5",
  });
  assert.equal(events.status, 401);
  assert.equal(events.headers.get("cache-control"), "private, no-store");
  assert.equal((await events.json()).error, "Cloudflare Access is required.");

  const start = await worker.fetch(new Request(`${SITE}/auth/start`), {
    GOOGLE_CLIENT_ID: "client-id",
    GOOGLE_CLIENT_SECRET: "client-secret",
    ACCESS_TEAM_DOMAIN: "dry-mud-91ba.cloudflareaccess.com",
    ACCESS_AUD: "f3e04809e143ccb2737c5becfe83dd36c5852415051eb808ff95e638974bdec5",
  });
  assert.equal(start.status, 401);

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
