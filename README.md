# CSR Desk

A glass-styled desk page. The clock and the schedule use Eastern time (America/Toronto).

## Calendar data

The page loads `/api/events` and refreshes every 3 minutes. The endpoint returns today’s events and the next two weeks as JSON.

Nothing private is stored in this repository. Until a calendar is connected, the endpoint returns sample events with the word “Sample” in the title, so a preview still has something to show.

The endpoint picks a source from the Pages environment:

1. If `ICS_URL` is set, it downloads that secret iCal address and reads it on the server.
2. Otherwise, if every Google Calendar variable below is set, it uses read-only OAuth and asks the Google Calendar API for events.
3. If neither source is set, it returns sample events.

If `ICS_URL` and the Google variables are both set, the iCal address wins. If only some of the Google variables are set, the endpoint returns an error instead of pretending the sample calendar is real.

Times are converted to Eastern time (America/Toronto). A successful response may be reused by the browser for about a minute (`Cache-Control: private, max-age=60`). A failed response is not cached. `CDN-Cache-Control: no-store` tells Cloudflare not to keep a copy, which matters once Cloudflare Access is in front of the site. Secrets are not written to logs and are not included in the JSON.

### Variables to set in Cloudflare

In the Pages project, open **Settings → Variables and Secrets**. Add these as encrypted secrets for production, and for preview only when that preview is locked to the owner. Set one mode, not a mix of blank and real values.

| Name | Purpose |
| --- | --- |
| `ICS_URL` | Secret iCal address from Google Calendar |
| `GOOGLE_CLIENT_ID` | OAuth client id |
| `GOOGLE_CLIENT_SECRET` | OAuth client secret |
| `GOOGLE_REFRESH_TOKEN` | Refresh token for read-only calendar access |
| `CALENDAR_ID` | Calendar to read. `primary` is allowed |

For local development, copy `.dev.vars.example` to `.dev.vars` and fill in the same names. Leave them blank to keep the sample calendar.

### Before a real calendar is connected

This repository is public. A Pages preview address is public too, unless Cloudflare Access is in front of it. Turn on Cloudflare Access so only the owner’s email can open the site. The policy has to cover the page and `/api/*`. Do that before saving a real `ICS_URL` or Google token. A secret iCal link is a password: anyone who can open `/api/events` can read the calendar.

## Tests

`npm test` checks iCal parsing and Eastern time conversion, including daylight saving. GitHub Actions runs the same tests on pull requests.
