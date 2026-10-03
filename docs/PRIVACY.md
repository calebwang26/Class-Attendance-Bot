# Privacy, Permissions and Data Handling

## Summary

The bot runs on your computer, acts only as you, on your own account, in its
own browser, and sends nothing anywhere except what the poll page itself
sends when a response is submitted. It has no telemetry, no server of its
own, and needs no API keys.

## Use it only where it is allowed

- Use it only in sessions whose organiser permits automated participation,
  and against the local mock site.
- Polling services' terms may restrict automated access. Checking that your
  use is allowed is up to you.
- Where a poll response counts as attendance, an automated response says you
  were there. That permission is yours to confirm.
- One person, one account. The bot does not manage other identities or
  respond for anyone else.
- It does not get around CAPTCHAs, sign-in, registration, location check-ins
  or rate limits. When it meets one it stops and tells you.

## Permissions it uses

| Permission | Why | Scope |
| --- | --- | --- |
| Start a browser | Load and operate the poll page | A separate Chromium profile in `.data/profile/`, not your everyday browser |
| Network | Reach the poll link | Only what the poll page itself loads |
| Files | Settings, logs, answered-polls record, profile | This project folder only (unless you point settings elsewhere) |
| Notifications (macOS) | Tell you when it needs you | Through the built-in `osascript` |
| Prevent idle sleep (macOS) | Keep running through class | The built-in `caffeinate`, only while the bot runs |

It does not use screen recording, accessibility control of other apps,
microphone, camera, or location. It never reads your everyday browser's
profile, history or saved passwords. It never grants a site permission to
your location.

## Credentials

- The bot never asks for, stores, logs or types a password. You sign in
  yourself, in the bot's browser window (`npm run login`).
- The sign-in lives as cookies in `.data/profile/`, managed by the browser.
  Anyone who can read that folder can act as you on the poll site, so treat
  it like a password: do not share it, sync it, or attach it to a bug report.
- To sign out and remove it, delete `.data/`.

## What is stored, and for how long

| Data | Where | Contents | Kept |
| --- | --- | --- | --- |
| Browser profile | `.data/profile/` | Cookies, local storage, cache of the poll site | Until you delete it |
| Answered polls | `.data/answered.json` | Per poll: fingerprint, time, outcome, page address, question and response (question and response left out when redaction is on) | Entries older than 30 days are deleted |
| Last link | `.data/state.json` | The poll link you last used | Until replaced |
| Lock | `.data/profile.lock` | The running bot's process id | Removed when the bot stops |
| Session logs | `logs/session-*.jsonl` | Timestamped events: states seen, polls detected (question and options), responses, errors, recoveries | Deleted after 30 days |
| Screenshots | `logs/screenshots/` | Only of pages the bot did not recognise. May show your name if the page does. | Deleted after 7 days |

Everything above is excluded from git by `.gitignore`.

## Logging rules

- **Never logged, even if passed in by mistake:** cookies, tokens,
  passwords, authorisation headers, request headers. Fields with those names
  are dropped.
- **Logged by default:** question text, option labels and the response sent,
  because that is what makes the log useful for checking a session.
- **With `logging.redactQuestionText: true`:** question text, option labels,
  responses, page text and the evidence quotes are stored as short SHA-256
  hashes, and the human-readable message is left out of the file. The
  answered-polls file then omits question and response. The terminal still
  shows the text.
- **Other participants' content is not read.** That includes their names and
  their answers, if shown. The bot reads only the question, the options, the
  status line and your own responses.
- **The page's text** is logged only when the page is unrecognised, and is
  limited to 300 characters of the activity area.
- **The page's own requests** are watched in memory, to know when the page
  is sending a response and how it ended. Only the method, address and
  reply status are used. Request and reply contents are never read, stored
  or logged.

## Data leaving your computer

| Destination | What | When |
| --- | --- | --- |
| The poll site | Normal page traffic, and your responses through the page's own controls | While the bot runs |
| Playwright's download server | The browser download | Once, at `npx playwright install chromium` |
| npm registry | Packages | At `npm install` |

Nothing else. In particular, poll questions are not sent to any AI or other
service.

## Removing everything

Delete `.data/` and `logs/`. That removes the sign-in, the answered-polls
record, the last link and all logs and screenshots.
