# Poll Bot

A tool that runs on your own computer, watches a live Poll Everywhere page in
its own browser window, and answers each poll that appears, once. You start it
before class and stop it when class ends.

- **Multiple choice:** it clicks a random option.
- **Free text:** it types `value` and submits.
- **Confirmation:** it waits for the page to confirm each response, never
  answers the same poll twice, and recovers from reloads, crashes and network
  drops.

**Status: built and tested against a local copy of the Poll Everywhere page.
Not yet tested against a real live poll.** The bot's handling of polls was
written from Poll Everywhere's own page scripts and checked against a local
mock of that page (see [docs/TECHNICAL_DESIGN.md](docs/TECHNICAL_DESIGN.md)).
Do the first real session as a dry run; see
[First real session](#first-real-session).

## Setup (once)

You need macOS, Windows or Linux and [Node.js](https://nodejs.org) 24 or newer.
In a terminal, in this folder:

```bash
npm install
```

```bash
npx playwright install chromium
```

Then sign in to Poll Everywhere in the bot's own browser. The bot does not use
your everyday browser, so it is not signed in yet:

```bash
npm run login -- pollev.com/yourpresenter
```

A browser window opens. Click **Log in** in the sidebar and sign in with your
school account. You can also close the cookie notice there. Then close the
window. The sign-in is kept for next time.

## Every class

On a Mac, double-click **Start Poll Bot.command** in this folder. On any
system, run:

```bash
npm start
```

It asks for the poll link. Paste it, or press Enter to reuse the last one. You
can also give the link directly:

```bash
npm start -- pollev.com/yourpresenter
```

A browser window opens on the poll page and the terminal shows what the bot
is doing:

```
08:01:12  Watching — no poll is showing right now.
08:14:03  New poll: "Which of these is a prime number?" (4 options)
08:14:08  Answered "7" — confirmed (the page announced the response was saved; "7" is marked as your vote (status: "Response recorded")).
```

**The bot runs until you stop it.** There is no timer. To stop it, either:

- press **Ctrl+C** in the terminal, or
- close the bot's browser window.

When it stops it prints a summary: polls seen, answered, already answered,
not answered, and the log file it wrote.

Keep the laptop open and awake while the bot runs. On a Mac the bot stops the
computer from going to sleep by itself, but closing the lid still puts it to
sleep. Leave the bot's browser window open somewhere on screen, even behind
other windows. Don't minimise it: macOS may slow down apps whose windows are
all minimised.

## When the bot needs you

It shows a desktop notification and a message in the terminal when:

- **You are not signed in.** It will not answer while signed out, because the
  responses would not be credited to you. Sign in in the bot's window and it
  carries on by itself.
- **A dialog or sign-in page is in the way.** Deal with it in the bot's window.
- **A poll is of a type it does not answer:** rank order, survey, clickable
  image, Q&A, or attendance check-in. Answer that one yourself in the bot's
  window.
- **A poll could not be answered** after several tries.
- **The page shows something it does not recognise.** It first reloads the
  poll page once, then tells you. A screenshot is saved next to the log.

You can always click in the bot's window yourself. If you answer a poll by
hand, the bot sees that and leaves it alone.

## Options

Flags go after `--`, for example `npm start -- pollev.com/x --dry-run`.

| Flag | What it does |
| --- | --- |
| `--dry-run` | Watch and log polls, but never click or type. |
| `--choice <how>` | Multiple choice: `random` (default), `first`, `last`, `skip`. |
| `--free-text <how>` | Free text: `fixed_text` (default), `echo_question`, `skip`. |
| `--text <string>` | What to type for free text. Default: `value`. |
| `--stop-after <minutes>` | Stop by itself after this long. Default: never. |
| `--chrome` | Use your installed Google Chrome instead of the bundled browser. |
| `--headless` | Run the browser without a window. |
| `--allow-guest` | Answer even when not signed in. Responses will be anonymous. |
| `--no-keep-awake` | Let the computer sleep as it normally would. |
| `--config <file>` | Read settings from this file. |
| `--login` | Open the bot's browser for signing in, and do nothing else. |

For lasting changes, copy `pollbot.config.example.json` to
`pollbot.config.json` and edit it. Every setting, with its default and
meaning, is listed in [docs/TECHNICAL_DESIGN.md](docs/TECHNICAL_DESIGN.md#settings).

## First real session

Detection of a real active poll has only been checked against Poll
Everywhere's code and a faithful mock, not against a live poll. So:

1. Run a dry run during a real session and watch both the bot's window and
   the terminal:

   ```bash
   npm run dry-run -- pollev.com/yourpresenter
   ```

   Each poll should produce a `New poll:` line and a
   `Dry run: would answer ...` line. Answer the polls yourself as usual.
2. If that looks right, run normally next time and watch the first poll or
   two. Afterwards, compare the summary with what the presenter showed, and
   with your **History** page on Poll Everywhere.
3. If something looks wrong, the log file in `logs/` records every page state
   the bot saw (`page.state` events). It contains the questions and options
   unless you turned on `logging.redactQuestionText`.

## Trying it without a real session

A local mock of the Poll Everywhere page comes with the project:

```bash
npm run mock
```

Open the presenter controls it prints (http://127.0.0.1:4173/presenter). In
another terminal, point the bot at the mock:

```bash
npm start -- http://127.0.0.1:4173/pollev/demo
```

From the controls page you can show polls, lock them, clear responses, reload
the participant page, drop the connection and make responses fail.

## Files the bot creates

All of these stay on your computer and are excluded from git.

| Path | Contents |
| --- | --- |
| `.data/profile/` | The bot's browser profile, including your Poll Everywhere sign-in. Treat it like a password. |
| `.data/answered.json` | Fingerprints of polls answered, so a restart does not answer twice. |
| `.data/state.json` | The last link you used. |
| `logs/session-*.jsonl` | One file per session: every event, timestamped. |
| `logs/screenshots/` | Screenshots of pages the bot did not recognise. |

Delete `.data/` to sign out and forget everything. Logs older than 30 days are
removed automatically. See [docs/PRIVACY.md](docs/PRIVACY.md).

## Development

```bash
npm test
```

That runs the type check, the unit tests and the integration tests. The
integration tests drive the bot in a real (headless) browser against the mock
site. A longer scripted session with faults runs with `npm run test:soak`. It
takes about 3 minutes; set `SOAK_MINUTES=90` for a full-length run.

| Document | Contents |
| --- | --- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Components and how a poll flows through them |
| [docs/TECHNICAL_DESIGN.md](docs/TECHNICAL_DESIGN.md) | How the page is read, the rules for answering and not answering twice, recovery, settings |
| [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) | What is done, what remains, open questions |
| [docs/TESTING.md](docs/TESTING.md) | The tests, the mock site, failure scenarios |
| [docs/PRIVACY.md](docs/PRIVACY.md) | Permissions, local data, credentials, logging |

Stack: TypeScript run directly by Node.js 24 (no build step), and Playwright
for the browser. Playwright is the only runtime dependency.
