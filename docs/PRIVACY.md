# Privacy, Permissions, and Data Handling

## Summary

The tool runs locally, acts as one person on that person's own account, and
sends nothing anywhere except the poll responses it submits to the polling
site through the page. It has no telemetry and no remote backend.

## Authorized use

- Use it only in sessions where the organizer permits automated
  participation, and against the local mock site.
- Polling providers' terms of service may restrict automated access. The user
  is responsible for checking that their use is allowed.
- Where a poll response is used as proof of physical presence, an automated
  response says something untrue unless the organizer has allowed it. That
  permission is the user's to confirm.
- One user, one account. The tool does not manage multiple identities or
  respond for other people.
- The tool does not attempt to get around CAPTCHAs, bot detection, location
  checks, or rate limits. When it meets one it stops and tells the user.

## Permissions

| Permission | Why | Scope |
| --- | --- | --- |
| Launch a browser | To load and operate the poll page | A dedicated Chromium profile under `.data/profile/`, separate from the user's everyday browser |
| Network | To reach the configured poll URL | Only the target site and what it loads; the mock server binds to `127.0.0.1` |
| File system | Config, logs, dedupe store, profile | The project directory only |
| Notifications (optional) | Alert the user to failures | OS notification permission |
| Prevent sleep (optional) | Keep running through the session window | Only during the window |

Not requested: screen recording, accessibility control of other apps,
microphone, camera, location, or access to the user's main browser profile,
history, or saved passwords.

## Credentials

- The tool never asks for, stores, logs, or types a password.
- Sign-in is done by the user, by hand, in the tool's browser window. The
  resulting session cookies live in `.data/profile/`, which Chromium manages.
- `.data/` is git-ignored. Anyone with read access to that directory can act
  as the signed-in user on the polling site, so it should be treated like a
  password: not synced to cloud storage, not shared, not attached to bug
  reports.
- A `logout` command will delete the profile directory.
- No API keys are needed. If a later feature needs one, it goes in `.env`
  (git-ignored) and is never written to logs.

## Data stored locally

| Data | Location | Contents | Retention |
| --- | --- | --- | --- |
| Browser profile | `.data/profile/` | Cookies, local storage, cache | Until `logout` |
| Dedupe store | `.data/answered.json` | Fingerprint hash, timestamp, outcome | Pruned after a configurable number of days (default 30) |
| Event logs | `logs/*.jsonl` | Timestamps, states, question text, chosen option, errors | Rotated daily; default 30 days |
| Failure evidence | `traces/`, `screenshots/` | Page screenshots and Playwright traces on error | Default 7 days |
| Config | `config.yaml` | Target URL, schedule, strategy | User-managed |

All of these are excluded by `.gitignore`.

## Logging practices

- Structured JSON Lines, one event per line, each with an ISO 8601 timestamp,
  session id, and event name.
- **Never logged:** cookies, tokens, request headers, passwords, full page
  HTML at `info` level.
- **Logged by default:** question text and the response chosen, because they
  are what makes the log useful. `logging.redactQuestionText: true` replaces
  question and option text with their hashes.
- Other participants' content that appears on the page (names, free-text
  answers shown on a results view) is not extracted or logged. The recognizer
  reads only the question, the options, and the user's own response state.
- Screenshots can contain whatever is on the page, including the user's name.
  They are taken only on `unknown` states and failures, can be turned off, and
  expire quickly.
- Playwright traces include network payloads and are therefore off by default
  outside tests.
- `debug` level may include DOM excerpts. It is opt-in and should not be
  shared without review.

## Data leaving the machine

| Destination | What | When |
| --- | --- | --- |
| The polling site | Normal page traffic and the user's responses | During a session |
| Playwright's download host | Browser download request | Once, at `playwright install` |
| npm registry | Package downloads | At install |

Nothing else. If phone notifications are added later, that would introduce a
third-party service; it will be opt-in and documented here before it ships.

## Local dashboard (if built)

Bound to `127.0.0.1` only, on a random or configured port, with no remote
access. It displays status and recent events and offers pause/resume. It does
not expose the profile or raw logs for download.

## Deleting everything

Removing `.data/`, `logs/`, `traces/`, and `screenshots/` removes all runtime
data the tool has created.
