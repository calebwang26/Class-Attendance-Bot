# Architecture

## Overview

One Node.js process drives one Chromium window through Playwright. A small
script injected into every page (the *page agent*) reports what the page
shows and tells Node when the page changes. A single serialised loop turns
those reports into decisions and, when a poll should be answered, operates
the page's own controls and waits for the page to confirm.

```
  you ── link ──▶ CLI (index.ts) ── settings ──▶ Orchestrator (main loop)
                     │                              │   ▲
                     │ lock, logger,                │   │ change notices
                     │ answered-polls file          ▼   │
                     │                        BrowserMonitor ── Playwright ──▶ Chromium
                     │                              │                          (own profile)
                     │                              │ snapshot / element         │
                     │                              ▼                            │
                     │                     page agent (in the page) ◀────────────┘
                     │
                     └─ notify (desktop), keep-awake (macOS)

  Orchestrator per pass:  snapshot → recognize → decide → (select → submit → confirm) → record → log
```

## Modules

| Module | Responsibility |
| --- | --- |
| `src/index.ts` | Command line: reads flags and settings, asks for the link, takes the single-copy lock, starts the bot or the sign-in window, prints the summary, handles Ctrl+C. |
| `src/cli/` | Flag parsing (`args.ts`) and the link prompt plus last-link memory (`prompt.ts`). |
| `src/config/config.ts` | Settings: defaults, validation (unknown keys and bad values are errors), link normalisation. |
| `src/browser/pageAgent.ts` | Runs inside the page. Watches for DOM changes and the page's own "saved" and "error" events, and builds a `PageSnapshot`: whether a poll is showing, its question, options, text box, status line, the participant's own responses, sign-in state, dialogs, connection state. Three readers: the older Poll Everywhere page, Poll Everywhere 2.0 (pe.app), and plain pages. Changes nothing on the page. |
| `src/browser/monitor.ts` | Owns the browser: launches the persistent profile, injects the agent, relays change notices, takes snapshots, and hands out elements by reference. It watches the page's requests: those that load earlier responses, and those that send something, with how they ended (method, address, status only). It also replaces crashed tabs and reports closed windows. |
| `src/recognizer/` | Pure functions. `recognize.ts` turns a snapshot into one state (`loading`, `waiting`, `needs_user`, `unknown`, `poll` with status `open` / `answered` / `closed`). `fingerprint.ts` gives each poll a stable identity. |
| `src/dedupe/decide.ts` | The duplicate-prevention rule as a pure function: respond, wait, check by reloading, or leave alone. |
| `src/dedupe/store.ts` | The answered-polls file (`.data/answered.json`): written atomically, pruned by age, an unreadable file is moved aside. |
| `src/selector/select.ts` | Chooses what to send: an option (random / first / last) or the text. |
| `src/submitter/submit.ts` | One response attempt through the page's controls (mouse first; keyboard if something covers the control; the element's own click as a last resort), then waits for confirmation. Never retries by itself. |
| `src/orchestrator/orchestrator.ts` | The main loop and the state that spans passes: the current poll appearance, earlier answers, recovery and back-off, network and connection health, periodic reloads, alerts to the user, counters for the summary. |
| `src/logger/logger.ts` | JSON Lines event log plus short terminal messages; drops credential-like fields; optional hashing of poll text. |
| `src/system/` | Desktop notifications (macOS `osascript`), keeping the Mac awake (`caffeinate`), the single-copy lock. |
| `mock-site/` | The local mock of the Poll Everywhere participant page and a plain-form page, with a presenter control page and fault switches. Used by the tests and for trying the bot. |

Poll Everywhere specifics are confined to the page agent (selectors, status
texts) and one rule in the recognizer: on that site, an option marked as
voted counts as a response. Everything else is site-independent. For other
sites the page agent has a conservative generic extractor: a group of radio
buttons with a submit button, or a single text box.

## Data flow for one poll

1. **Change.** The page agent's `MutationObserver` (or the page's "saved"
   event) calls into Node. The loop is woken after a short debounce (250 ms).
   It also wakes every 5 s regardless, as a safety net.
2. **Snapshot.** The page agent reports the page. If that fails three times
   in a row the tab is replaced and the poll link reloaded.
3. **Recognize.** The snapshot becomes one state. A poll gets a fingerprint
   from its kind, question, sorted option labels and, on Poll Everywhere, the
   poll's own id.
4. **Track the appearance.** A poll seen continuously, including across
   reloads and redraws, is one appearance. It is logged as `poll.detected`
   once it has held still for a moment, so a half-drawn poll is never
   reported.
5. **Decide.** If the page shows the poll as answered: record it and do
   nothing. If closed: wait. If answered earlier but showing open again:
   settle, reload to check, and only then answer again. Otherwise respond.
6. **Hold.** It waits for the random response delay (default 2–8 s) and for
   the poll to have been steadily open in the same page element for the
   settling period (1.5 s). It also waits while the page is still fetching
   the participant's earlier responses, and while the network is down.
7. **Select and submit.** The page is read again, an option or the text is
   chosen, and the control is operated.
8. **Confirm.** Success is any of:
   - the page's own "saved" announcement;
   - a saved entry appearing in the page's record of responses;
   - the poll displaying as answered for the whole confirmation period, with
     nothing still waiting on the server and no error.

   An error raised by the page is a failure. A failure is retried with
   back-off (5 s, 10 s, 20 s, capped at 30 s), up to 5 attempts, each gated
   on the page still showing the poll unanswered. If the failed attempt had
   operated the page, the page is first reloaded to check with the server
   that the response did not get through.
9. **Record.** The fingerprint goes into the answered-polls file and the
   result into the log.

## Loop states

```
CONNECTING ──page opened──▶ WATCHING ──poll to answer──▶ RESPONDING ──done──▶ WATCHING
                              │  ▲
              crash, hang,    │  │ page loaded again
              wrong address,  ▼  │
              network back ─▶ RECOVERING (back-off 1 s … 30 s, new tab if needed)

any state ──Ctrl+C, window closed, optional time limit──▶ STOPPED
```

Only one pass of the loop runs at a time. A poll can therefore never be
handled twice at once, however many change notices arrive while a response
is in progress.

## Runtime files

| Path | Contents |
| --- | --- |
| `.data/profile/` | Chromium profile (sign-in cookies). |
| `.data/profile.lock` | Single-copy lock, holds the running process id. |
| `.data/answered.json` | Answered-poll fingerprints with time and outcome. |
| `.data/state.json` | Last link used. |
| `logs/session-<date>_<time>.jsonl` | Event log. |
| `logs/screenshots/` | Screenshots of unrecognised pages. |

All are excluded from git.
