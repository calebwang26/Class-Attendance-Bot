# Testing

Automated tests never touch a real polling service. All interaction tests
run the real bot, in a real (headless) Chromium, against a local mock of the
Poll Everywhere participant page. Live sessions are only for the supervised
validation described at the end.

## Running the tests

```bash
npm test
```

| Command | What runs | Time |
| --- | --- | --- |
| `npm run typecheck` | `tsc --noEmit` over source, mock site and tests | seconds |
| `npm run test:unit` | `tests/unit/`: pure logic, no browser | seconds |
| `npm run test:integration` | `tests/integration/`: bot + browser + mock site | about 2 minutes |
| `npm run test:soak` | `tests/soak/`: a scripted session with faults | about 3 minutes; `SOAK_MINUTES=90` for full length |
| `npm test` | type check + unit + integration | |

## The mock site

`mock-site/` is a small HTTP server bound to 127.0.0.1 (`npm run mock` runs
it by hand on port 4173).

**`/pollev/<presenter>`** is the participant page, reproducing what the real
page does, as read from Poll Everywhere's own scripts:

- **Same structure:** the activity frame, the live/pinned tab buttons, the
  sidebar with "Log in" or "Settings", the cookie notice in its fixed
  top-right position, and `legacy-response-view` >
  `.component-response-activity` with the same class names, attributes and
  status texts.
- **Same behaviour:** a click is a vote, drawn at once; all options are
  disabled while it is sent; on success there is a bubbling `result` event,
  on failure the vote is removed and `notification:show` (error) is raised.
- **Earlier responses fetched after drawing:** when they arrive they replace
  the local list.
- **Free text:** the same form; Enter submits only as a real key press;
  responses are listed; the box is cleared on submit.
- **Push connection:** a `turbo-cable-stream-source` whose `channel.state`
  tracks the connection, while the `connected` attribute stays set during a
  drop, as on the real page.
- **The other activity types**, as non-answerable look-alikes: rank order,
  survey, clickable image, Q&A (which contains a text box that must not be
  typed into), and competition.

**`/generic/<room>`** is a plain page with radio buttons and a Submit button,
or a text box.

**`/pe2/<presenter>`** imitates "Poll Everywhere 2.0" (pe.app): drawn by the
server with the markup read from the live page, each option a button in its own
form posting to `/a/questions/<id>/responses/<choice>` (303 on success, 422 or
500 on failure), and a reload whenever the presenter changes something. After a
free-text response it shows nothing, the harder case.

**`/presenter`** is a control page for playing the presenter.

**For tests**, the server object exposes:

- **Presenter actions:** `activate`, `reactivate`, `deactivate`, `lock`,
  `unlock`, `clearResponses`, `edit`.
- **Faults:** fail the next N submissions; slow submissions; slow restoring
  of earlier responses; no restoring at all; failed restoring; draw only the
  header first; delay mounting; reuse the mount element; silent push
  channel; push channel down; forced reload, redirect or redraw; a stale "no
  responses" push; no response count in the page data; error replies
  without details; equations still loading.
- **Page flags:** signed out; cookie notice; an invisible layer that swallows
  clicks; a screen-name dialog; tab buttons; unrecognised controls.
- **Response another participant made elsewhere:** `respondAs`.
- **A ledger** of every response the server accepted, and of every
  submission attempt. Tests count responses there, server-side, not in the
  bot's own log.

The real waiting page, as captured, is in
`tests/fixtures/pollev-waiting-page.html` and has its own test.

## Unit tests (`tests/unit/`)

| File | Covers |
| --- | --- |
| `config.test.ts` | Defaults are the owner's choices; layering; every kind of invalid value reported together; link normalisation; reading settings files. |
| `args.test.ts` | Every flag; mistakes are usage errors; help lists every flag. |
| `decide.test.ts` | Every branch of the duplicate-prevention rule, including the settle-then-reload check before a second response. |
| `recognize.test.ts` | Each page state and its precedence; open / answered / closed for each poll kind on Poll Everywhere and elsewhere; fingerprint stable from open to answered. |
| `fingerprint.test.ts` | Same poll gives the same value; option order, case, whitespace and Unicode form do not matter; any real difference does. |
| `select.test.ts` | Each strategy; disabled options never chosen; random covers the range; text trimmed and cut to length. |
| `store.test.ts` | Survives reopening; time window; pruning; unreadable file moved aside; bad entries skipped; unwritable folder handled; no temp files left. |
| `logger.test.ts` | One JSON line per event; levels; terminal output; credential-like fields dropped; redaction; unwritable log does not stop the bot; pruning. |
| `lock.test.ts` | Single-copy lock; stale lock taken over; a browser still holding the profile detected. |
| `util.test.ts` | Abortable sleep, timeouts, back-off, random integers; the page agent is self-contained; the link prompt (paste, reuse, retry, end of input). |
| `docs.test.ts` | The settings table in the technical design matches the code; the example settings file is valid; README flags exist. |

## Integration tests (`tests/integration/`)

| File | Covers |
| --- | --- |
| `smoke.test.ts` | One poll answered once and confirmed. |
| `detection.test.ts` | Detected within 1 s; free text classified; poll already active at start; a new poll directly replacing an answered one; a new poll drawn into the same element; slow drawing reported once and complete; change events only; periodic reading only; options edited before opening; waiting screen in between. |
| `response.test.ts` | first / last / random (seeded) / skip; fixed text (default `value`); custom text; echo; multi-response polls get one response; dry run sends nothing; the response delay is honoured. |
| `confirmation.test.ts` | Confirmed with page evidence; a server failure is retried, giving one response (multiple choice and free text); attempt limit, then notification and no more attempts; slow server; reply slower than the confirmation time; vote shown then rejected is answered again; poll gone after the click; poll gone before the click. |
| `dedupe.test.ts` | Reload after answering; restart after answering; restart before answering; burst of page changes; answered by hand; answered on another device while the page still loads it; presenter clears responses (one per round); poll shown again without clearing; shown again after clearing; identical wording, different polls; redraws; no click while earlier responses are loading; a page that forgets a standing response triggers a reload check, not a second response (multiple choice and free text). |
| `recovery.test.ts` | Self-reload; navigation away; crashed tab; frozen tab; tab closed stops the bot; network outage; network drop just after a poll appears; silently dead push channel; push channel down; push channel drop and recovery; site unreachable at start; JavaScript alert. |
| `gates.test.ts` | Signed out: asks and answers nothing, then carries on; `--allow-guest`; sign-in page untouched; modal dialog; covered option answered by keyboard; covered free text; cookie notice left alone; tab buttons never taken for a poll; pinned tab recovered; rank order, survey, clickable image and Q&A reported and untouched; competition; locked then unlocked; locked during the delay; unrecognised controls reloaded, then reported. |
| `pe2.test.ts` | Poll Everywhere 2.0: multiple choice answered once and confirmed by the server's reply; free text sent once though not shown; successive polls; server error retried; lost reply checked, not resent; earlier vote left alone; signed out; closed; unsupported type. |
| `generic.test.ts` | Plain page: radio buttons with Submit; text box; a page that says nothing after submitting; failed submission retried; closed poll; identical wording; unrelated buttons never clicked. |
| `fidelity.test.ts` | Uncommon real-page behaviours: a page that never reloads, or fails to reload, your earlier vote (no second vote; you are told); a re-vote the page fails to show, caught by the periodic reload; equations still loading; a hidden title; options with identical labels; a competition question (no delay); a full poll; one vote per option; a rejection without an error event; an option edited while open. |
| `review.test.ts` | Regression tests for an independent review of the control logic: a lost reply (multi-response and single-vote polls, and with a network drop) leads to a server check, not a second vote or a false failure; a poll activated during a reload (with and without replay); a redraw while typing; a silent outage; a slow server whose vote is drawn before it is saved; a vote made by hand after a give-up is not claimed; element references change across reloads. |
| `review2.test.ts` | Regression tests for a second review of the retry and server-check logic: a check that falls during an outage does not stall the bot once the network returns; no reload cuts off a vote the server is still processing (periodic reload, dropped connection, plain page); an explicit server error is retried promptly, without a server check; a doubt survives the poll leaving and returning; a waiting screen flashed on load does not cause a check loop; an in-page address change does not hide a pending fetch; a hand-made response after a give-up is not claimed; a successful second chance corrects the summary; stopping during browser start-up leaves no browser running. |
| `safety.test.ts` | A form on another page is never operated; a page that keeps leaving the link is reported; the captured real waiting page is recognised (signed out, then waiting). |
| `session.test.ts` | Runs until stopped, with a summary matching events; optional time limit; prompt stop during the delay; log format; redaction covers log and answered-polls file; answered-polls file contents. |
| `cli.test.ts` | Help, version, bad flags, bad settings, bad link, no link without a terminal; a full command-line run; Ctrl+C; dry run; a second copy refused at once; sign-in mode. |

## Soak test (`tests/soak/`)

A scripted session over 3 minutes by default:

- **Polls:** 12, at irregular intervals, mostly multiple choice with 2–4
  options, some free text.
- **Between polls:** some go back to the waiting screen, others are replaced
  directly by the next poll.
- **Faults:** one failed submission, one forced reload, one 3-second network
  outage, one push-connection drop, and one re-vote (responses cleared).

To pass:

- every poll gets exactly one response per round, counted server-side;
- nothing is marked failed;
- the page's JavaScript heap does not keep growing.

Run with `SOAK_MINUTES=90` for a full-length session.

## Failure scenarios and where they are tested

| Scenario | Expected | Test |
| --- | --- | --- |
| Page reloads mid-watch | Next poll still detected | recovery: self-reload |
| Page navigates away | Back to the link after 20 s | recovery: navigation |
| Tab crashes | New tab, monitoring resumes | recovery: crash |
| Page frozen | New tab after 3 failed reads | recovery: frozen |
| Browser window closed | Bot stops, with the reason | recovery: tab closed |
| Network drops for a while | Waits; reloads when back; poll answered | recovery: outage, drop after poll |
| Push channel silently dead | Covered by the periodic reload | recovery: silent |
| Push channel down or flapping | Reload, poll found | recovery: push down / drop and back |
| Site unreachable at start | Back-off retries, connects later | recovery: unreachable |
| Server rejects a submission | Retry; one response; limit then notify | confirmation |
| Server slow | Waits; one response | confirmation |
| Poll closes between detection and click | Nothing clicked, no loop | confirmation; gates: locked during delay |
| Option covered by another element | Keyboard instead of mouse | gates: covered |
| Signed out / dialog / sign-in page | Notify, touch nothing, resume afterwards | gates |
| Unsupported activity | Notify, touch nothing | gates |
| Unrecognised layout | Reload once, then notify with screenshot | gates: unrecognised |
| Answered elsewhere | Left alone | dedupe |
| Page forgets a standing response | Reload check, no duplicate | dedupe |
| Page cannot or does not reload your earlier vote | No second vote; you are told | fidelity |
| Reply to a submission lost | Server check before resending; no duplicate, no false failure | review, review2 |
| Server still processing a vote when a reload is due | Reload held until the reply arrives | review2 |
| Server rejects a vote outright | Retried after the normal pause, no check needed | review2 |
| Outage while the computer reports a connection | No attempts wasted; answered after | review |
| Poll redrawn mid-attempt | Waited out; answered | review |
| Ctrl+C | Browser closed cleanly; summary printed | cli |
| Bot restarted mid-session | No duplicate | dedupe |
| Second copy started | Refused at once | cli |
| Answered-polls file unreadable / unwritable | Moved aside / kept in memory with a warning | store |

## Live validation (with a real session)

- [ ] Signed in once with `npm run login -- <link>`.
- [ ] Session 1: `npm run dry-run -- <link>`, watched. Each poll produced
      `New poll:` and `Dry run: would answer …`. Answered by hand as usual.
- [ ] Checked the log's `page.state` events: `siteType` is
      `multiple_choice_poll` / `free_text_poll` for polls, and `siteId` is
      filled in.
- [ ] Session 2: normal run, watched for the first polls. Each answered
      once, confirmed with "the page announced the response was saved".
- [ ] Afterwards: summary count equals the number of polls shown, and the
      Poll Everywhere History page shows one response per poll.
