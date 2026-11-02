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

test("the worker serves the bundled desk page", async () => {
  const page = await worker.fetch(new Request(`${SITE}/`), {});
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type"), /^text\/html/);
  const html = await page.text();
  assert.match(html, /<title>CSR Desk<\/title>/);
  assert.match(html, /Morning batch/);
  assert.match(html, /Office closed/);
  assert.match(html, /Do now/);
  assert.match(html, /Up next on calendar/);
  assert.match(html, /Exit check/);

  const named = await worker.fetch(new Request(`${SITE}/index.html`), {});
  assert.equal(named.status, 200);
  assert.match(named.headers.get("content-type"), /^text\/html/);

  const missing = await worker.fetch(new Request(`${SITE}/missing`), {});
  assert.equal(missing.status, 404);
});
