# CSR Desk

A glass-styled desk page. The clock and the schedule use Eastern time (America/Toronto).

## Calendar data

The page loads `/api/events` and refreshes about once a minute. The endpoint returns today’s events and the next two weeks as JSON.

Nothing private is stored in this repository. Until Google sign-in is set up, the endpoint returns sample events. Every sample title starts with “Sample,” and the page says no real calendar is connected.

When the Google settings below are filled in, the endpoint uses read-only access and asks the Google Calendar API for events. The sign-in scope is only `https://www.googleapis.com/auth/calendar.readonly`. The refresh token is saved in the `CAL_KV` binding by the one-time connect flow. If that binding is empty, `GOOGLE_REFRESH_TOKEN` is used instead. If the Google settings are missing entirely, the sample events stay. If only some of them are set, the endpoint returns an error instead of pretending the sample calendar is real.

Times are converted to Eastern time (America/Toronto). A successful `/api/events` response may be reused by the browser for about 30 seconds (`Cache-Control: private, max-age=30`). A failed response is not cached. `CDN-Cache-Control: no-store` tells Cloudflare not to keep a copy, which matters once Cloudflare Access is in front of the site. An access token is kept in `CAL_KV` for at most 15 minutes and is not shown on the page. Secrets are not written to logs and are not included in the JSON.

### One-time setup

1. In Google Cloud, create a project and enable the Google Calendar API.
2. On the OAuth consent screen, choose External (or Internal if this is a Workspace account) and set the publishing status to **Testing**. Add the owner as a test user. The app only needs the read-only calendar scope.
3. Create an OAuth client of type **Web application**. Under authorized redirect URIs, add exactly `https://<site-domain>/auth/callback`. Replace `<site-domain>` with the real site address, such as `desk.example.com`. The path is `/auth/callback`.
4. In the Cloudflare Pages project, add these names. Use encrypted secrets for the client secret and for a refresh token if you set one by hand.

| Name | What it is |
| --- | --- |
| `GOOGLE_CLIENT_ID` | OAuth client id |
| `GOOGLE_CLIENT_SECRET` | OAuth client secret |
| `CALENDAR_ID` | Calendar to read. `primary` is allowed |
| `CAL_KV` | KV binding. Create a KV namespace and bind it with this name |
| `GOOGLE_REFRESH_TOKEN` | Optional secret. Used only when `CAL_KV` has no refresh token |

5. Turn on Cloudflare Access so only the owner’s email can open the site. The policy has to cover the page, `/api/*`, and `/auth/*`. The connect routes also refuse to run unless Access has identified the visitor.
6. While signed in through Access, open `https://<site-domain>/auth/start` once. Google asks for offline read-only access. After you agree, the site saves the refresh token in `CAL_KV` and sends you back to the desk. The token is not shown.

For local development, copy `.dev.vars.example` to `.dev.vars`. Leave the values blank to keep the sample calendar. `CAL_KV` is a binding, not a line in that file.

## Tests

`npm test` checks Eastern time conversion and the Google sign-in flow. GitHub Actions runs the same tests on pull requests.
