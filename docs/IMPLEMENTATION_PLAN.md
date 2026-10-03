# Implementation Plan and Status

## Decisions made with the project owner

| Question | Answer |
| --- | --- |
| Points for responding or for correct answers? | For responding. Correctness does not matter. |
| Multiple choice | A random option. |
| Free text | Always the literal text `value`. |
| Which poll page? | Any link the user gives at start: prompted for, or passed on the command line. The last one is remembered. |
| Scheduling | None. The user starts the bot and it runs until they stop it. An optional `--stop-after` exists but is off by default. |
| Interface | Terminal plus the browser window. No separate app. A double-click launcher is provided for macOS. |
| Sign-in | Poll Everywhere account (school email), signed in once in the bot's own browser. |
| Poll types | About 95% multiple choice, the rest free text. |
| Stack | Left to the implementer: TypeScript on Node.js 24 with Playwright. |

## Phases

### Phase 1: Documentation (done)

The first commit: README and design documents.

### Phase 2: Scaffold, page study, mock site (done)

- Project set up with TypeScript (type stripping, no build), Playwright, and
  `node:test`.
- The live participant page was studied read-only as a signed-out guest. Its
  public scripts were analysed, and every finding was checked by a second
  independent reading against the source. Results are in
  [TECHNICAL_DESIGN.md](TECHNICAL_DESIGN.md#2-what-is-known-about-the-poll-everywhere-page).
- The mock site reproduces the page's structure and behaviour, with fault
  switches and a server-side ledger of responses.

**Acceptance (met):**

- The mock site can be driven through waiting, multiple choice, answered,
  free text and closed.
- The real waiting page, as captured, is recognised by the bot (test
  `safety.test.ts`). The bot was also pointed at the real page read-only, in
  its own browser, signed out and in dry run. It recognised the Poll
  Everywhere layout, the signed-out state, the live connection and the cookie
  notice, and clicked nothing.

### Phase 3: Monitoring and recognition (done)

The browser monitor, page agent, recognizer, fingerprinting, answered-polls
file, and dry run.

**Acceptance (met, against the mock):**

- Every activated poll produces exactly one `poll.detected` within 1 s, with
  the correct question, kind and options.
- Reloads and redraws do not produce a second detection.

### Phase 4: Responding and confirmation (done)

Answer selection, submission with mouse and keyboard fallback, confirmation
rules, retries with back-off, and the duplicate-prevention rule with the
reload check.

**Acceptance (met, against the mock):**

- One response per poll per round, counted server-side, across the
  scenarios in [TESTING.md](TESTING.md). These include failed, slow and
  silently rejected submissions, answers made by hand or on another device,
  restarts, and re-votes.

### Phase 5: Recovery and hardening (done)

Recovery from reloads, navigation, crashes, frozen tabs, network loss and
push-connection loss. Periodic resync. Sign-in, dialog and unsupported-type
handling with notifications. Single-copy lock. Keeping the Mac awake.
Session summary.

**Acceptance (met):**

- Each failure scenario in TESTING.md passes as an automated test.
- The scripted soak session passes in its 3-minute form: 12 polls plus a
  re-vote, each answered exactly once, through a failed submission, a
  reload, a network outage and a push-connection drop.

### Independent review (done)

Two separate reviews were run against the code:

- one compared the page-reading code and the mock with Poll Everywhere's own
  scripts;
- one looked for sequences of events that double-submit, miss a poll, hang,
  or misreport.

A third review then went over the rewritten retry and check logic. Every
finding from all three was reproduced, fixed and given a regression test
(`fidelity.test.ts`, `review.test.ts`, `review2.test.ts`). The main fixes
were these:

- **Server check before any duplicate risk.** Before resending after an
  unconfirmed attempt, or answering an answered poll again, the bot reloads
  the page and requires it to have fetched your earlier responses.
- **Doubts are tracked per poll.** The doubt about whether a vote reached
  the server is kept per poll and settled only by evidence from the current
  page.
- **Pending responses don't count.** A response the page is still sending is
  never counted as answered.
- **No reload while sending.** The bot never reloads while the page is
  sending something.
- **Clear rejections retried promptly.** A vote the server explicitly
  rejected is retried after the normal pause, without a check.
- **Redraws mid-attempt.** These are waited out rather than treated as the
  poll disappearing.
- **One more round after giving up,** once a fresh page shows the poll still
  open.
- **Clean shutdown.** The browser is closed properly before the process
  exits.
- **Page details:** hidden titles, equations still loading, and repeated
  option labels.

### Phase 6: Live validation (to do — needs a live session)

1. Sign in with `npm run login -- <link>`.
2. A dry run in a real session, watched (README, "First real session").
   Check that each poll is reported, and check the `page.state` events in
   the log.
3. A normal run, watched for the first polls.
4. An unattended run.

**Acceptance:** the summary count equals the polls shown, and the Poll
Everywhere History page shows one response per poll.

## Open questions

Only a live session can settle these. The bot is built to behave safely
either way.

1. **Does the participant page draw live polls with the interface described
   in the technical design?** The page loads that code, and the owner's
   description matches it. If a different interface appears, the bot
   reports it instead of guessing.
2. **Does a freshly loaded page fetch the participant's earlier responses
   from an address ending in `/results`?** If not, a re-vote is left to the
   user (with a notification) rather than risking a duplicate.
3. **Are some activities handed off to another app, or run as attendance
   check-ins?** If so, the bot notifies instead of answering.
4. **How long do this presenter's polls stay open?** With the default 2–8 s
   delay, a poll that closes within about 10 s could be missed. Shorten
   `response.delayMs` if so.
