# CSR Desk

A glass-styled desk page. The weekday plan is six time blocks, with the weekend closed. The clock and the blocks use Eastern time (America/Toronto). Calendar events sit beside that plan.

## Calendar data

The page loads `/api/events` and refreshes about once a minute. The endpoint returns today’s events and the next two weeks as JSON.

Nothing private is stored in this repository. Until Google sign-in is set up, the endpoint returns sample events. Every sample title starts with “Sample,” and the page says no real calendar is connected.

When the Google settings below are filled in, the endpoint uses read-only access and asks the Google Calendar API for events. The sign-in request asks only for `https://www.googleapis.com/auth/calendar.readonly`. A returned scope may also include `openid`, `email`, `profile`, or a `userinfo` scope. Any broader calendar scope, or any other API, is refused. The refresh token is saved in the `CAL_KV` binding by the one-time connect flow. If that binding is empty, `GOOGLE_REFRESH_TOKEN` is used instead. If the Google settings are missing entirely, the sample events stay. If only some of them are set, the endpoint returns an error instead of pretending the sample calendar is real.

Times are converted to Eastern time (America/Toronto). A successful `/api/events` response may be reused by the browser for about 30 seconds (`Cache-Control: private, max-age=30`). A failed response is not cached. `CDN-Cache-Control: no-store` tells Cloudflare not to keep a copy, which matters once Cloudflare Access is in front of the site. An access token is kept in `CAL_KV` for at most 15 minutes and is not shown on the page. Secrets are not written to logs and are not included in the JSON.

### One-time setup

1. In Google Cloud, create a project and enable the Google Calendar API.
2. On the OAuth consent screen, choose External (or Internal if this is a Workspace account) and set the publishing status to **Testing**. Add the owner as a test user. The app only needs the read-only calendar scope.
3. Create an OAuth client of type **Web application**. Under authorized redirect URIs, add exactly `https://csr-desk-glass.glenn-889.workers.dev/auth/callback`.
4. This site is the Cloudflare Worker named `csr-desk-glass`, not a Pages project. `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `CALENDAR_ID` are already set on that Worker. To also read the team calendar, set `CALENDAR_NAMES` to `Broker Support Team` (exact name, no id). `CALENDAR_ID=primary` is still used when `CALENDAR_IDS` is empty. Use an encrypted secret only if you also set `GOOGLE_REFRESH_TOKEN` by hand. `wrangler.jsonc` binds `CAL_KV` to the namespace `csr-desk-glass-cal`.

| Name | What it is |
| --- | --- |
| `GOOGLE_CLIENT_ID` | OAuth client id |
| `GOOGLE_CLIENT_SECRET` | OAuth client secret |
| `CALENDAR_ID` | One calendar. Used when `CALENDAR_IDS` is empty. `primary` is allowed |
| `CALENDAR_IDS` | Optional. Comma-separated calendar ids. When set, this replaces `CALENDAR_ID` |
| `CALENDAR_NAMES` | Optional. Comma-separated calendar names. Each name must match the calendar’s summary exactly, for example `Broker Support Team` |
| `CAL_KV` | KV binding for the namespace `csr-desk-glass-cal` |
| `GOOGLE_REFRESH_TOKEN` | Optional secret. Used only when `CAL_KV` has no refresh token |

5. Cloudflare Access already protects this Worker for the team `dry-mud-91ba.cloudflareaccess.com`. The policy has to keep covering the page, `/api/*`, and `/auth/*`. `/api/events` and `/auth/*` accept the signed-in person from Worker Access (`ctx.access`) when that is present. Otherwise they verify the Access JWT from the `Cf-Access-Jwt-Assertion` header or the `CF_Authorization` cookie. Either way the email has to be `ALLOWED_EMAIL` (glenn@oibc.ca), the audience has to match, and a token with no email is refused. A copied email header is ignored. Preview builds do not receive the production `CAL_KV` binding. On a preview, connecting the calendar returns “Calendar storage is not configured.”
6. While signed in through Access, open `https://csr-desk-glass.glenn-889.workers.dev/auth/start` once. Google asks for offline read-only access. After you agree, the site saves the refresh token in `CAL_KV` and sends you back to the desk. The token is not shown. If Google turns the connection down, the desk names the reason, such as `invalid_client` or `redirect_uri_mismatch`. If the call to Google never leaves the Worker, the desk says `fetch_failed`.

The Worker script handles every request. `/api/events`, `/auth/start`, and `/auth/callback` are the calendar routes. `/` and `/index.html` return the desk page, which is bundled into the Worker from `public/index.html`. There is no static-asset router, because that router does not pass the Access identity through to this Worker.

For local development, copy `.dev.vars.example` to `.dev.vars` and run `npx wrangler dev`. Leave the values blank to keep the sample calendar. `CAL_KV` is a binding, not a line in that file. Local dev uses a simulated KV store and does not touch the live namespace.

## Tests

`npm test` checks Eastern time conversion and the Google sign-in flow. GitHub Actions runs the same tests on pull requests.
