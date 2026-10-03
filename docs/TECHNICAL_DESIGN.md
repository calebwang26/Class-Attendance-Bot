# Technical Design

This records how the bot reads the polling page, when it answers and when it
does not, and how it recovers. Where a behaviour depends on how Poll
Everywhere's page works, the source of that knowledge is given, and anything
not yet observed on a live poll is marked as such.

## 1. Choices made

| Concern | Choice | Why |
| --- | --- | --- |
| Language / runtime | TypeScript, run directly by Node.js 24 (type stripping; no build step) | One toolchain; type-checked with `tsc --noEmit`. |
| Browser | Playwright with its bundled Chromium, persistent profile, visible window | Real browser behaviour, locators with built-in waiting, `exposeBinding` / `addInitScript` for the page agent, one dependency. Installed Chrome is an option (`--chrome`). |
| Reading the page | DOM, from a script inside the page | Exact text and real controls. OCR and screenshots were not needed: every state the bot acts on is present in the DOM. |
| Noticing changes | `MutationObserver` in the page, plus a read every 5 s, plus a full reload every 60 s | Mutation callbacks are immediate and are not throttled in background tabs. The periodic read and reload cover anything the observer or the page's own push connection misses. |
| Operating controls | Playwright clicks and typing; keyboard if a control is covered; the element's own `click()` last | Uses the page's normal interface. The keyboard fallback exists because Poll Everywhere's cookie notice sits over the top right of the page. |
| Tests | `node:test`, against a local mock that reproduces the real page | No test framework dependency; the bot runs in a real browser in tests. |
| Settings, logs | JSON settings file with validation; JSON Lines log written by a small built-in logger | No further dependencies. |

## 2. What is known about the Poll Everywhere page

### Sources

- **The live participant page**, read as a signed-out guest with no poll
  active on 2026-10-02: its DOM, its import map, and the list of scripts it
  loads. A scrubbed copy of that page is kept as
  `tests/fixtures/pollev-waiting-page.html` and tested against.
- **The page's public JavaScript**: the "legacy activity response" webpack
  bundle, which draws polls, and the Stimulus, Turbo and AnyCable modules.
  These were read statically, and each claim below was cross-checked by a
  second independent reading against the source text.
- **The project owner's description** of the page during a poll: options
  shown as bars; free text as a box; after answering, the options grey out
  with a check and "Response recorded"; the page stays on that poll until the
  next one replaces it.

**Not observed: the page with a poll actually active.** The server-rendered
HTML around an active poll has not been seen. The code shows how polls are
drawn once mounted, and the participant page does load and define that code,
but which element mounts them, and whether some activity types use a newer
interface, are not visible.

### Page structure

| Part | Selector / property | Source |
| --- | --- | --- |
| Activity area | `turbo-frame#active_tab_content` (contains `turbo-frame#participate_presenter_<name>`) | live page |
| Waiting screen | No activity inside the frame; heading "Waiting for <name>'s presentation to begin..." | live page |
| Live / pinned tab buttons | `[role=tab][data-tab=current|pinned]` in `form`s, outside the frame; must not be taken for a poll | live page |
| Signed out | `nav#navigation a[href="/login"]` ("Log in"); signed in shows "Settings" instead | live page; owner's screenshot |
| Cookie notice | `#cookie-consent-banner` in a fixed region at the top right (z-index 1060) | live page |
| Screen-name prompt | `[role=dialog][aria-modal=true][aria-label="Screen name configuration"]`, hidden unless opened | live page; Stimulus module |
| Push connection | `turbo-cable-stream-source[channel=ActivationChannel]`; its `.channel.state` (`connected` / `connecting` / …). The `connected` attribute can stay set while the socket is down, so it is only a fallback | live page; AnyCable module |
| Mounted poll | `legacy-response-view` > `.component-response-activity[data-activity-type=<type>]` | bundle |
| Poll types | `multiple_choice_poll`, `free_text_poll` (word clouds too), `discourse` (Q&A), `ranking_poll`, `clickable_image`, `survey`, `competition` | bundle |
| Title / status | `.component-response-header__title` (h1) / `.component-response-header__status` | bundle |
| Option | `.component-response-multiple-choice__option` > `button.…__option__vote` > `.…__option__value` | bundle |
| Voted option | the option element gets `data-vote-count="<n>"` and class `…__option--vote` | bundle |
| Free text | `textarea[name=response]`, `input[type=submit][value=Submit]` in the same form; own responses in `.component-response-open-ended__result__value` | bundle |
| Status texts | "Response recorded", "You have responded …", "You have N responses remaining", "You can respond once / N times", "You have not responded", "This poll is locked.", "Poll is full. …", "Web Voting has not been turned on for this poll." | bundle |
| Saved signal | bubbling `result` event on `.component-response-activity`, raised only after the server accepted a response | bundle |
| Error signal | bubbling `notification:show` event with `detail.type === "error"` | bundle |
| Poll id | `legacy-response-view`.`responseView.model.get('permalink')` (or `shared_key`, or `id`) | bundle |
| Saved responses | `responseView.model.results.models`: saved entries have an `id` and no `isPending` | bundle |

### Behaviours the bot relies on (from the bundle)

- **A click is a vote.** There is no submit step for multiple choice. The
  vote is drawn at once (optimistically); all options are disabled while it
  is being sent; on failure it is removed again and an error is raised.
- **After a poll is drawn, earlier responses arrive later.** The page fetches
  the participant's responses after drawing the poll. Until that arrives an
  already-answered poll looks unanswered. When the fetch lands it replaces
  the local list, including a vote clicked in the meantime.
- **Free text** is cleared on submit and listed under "Your responses" at
  once (optimistic). Enter in the box submits, but only as a real key press.
- **Responses can be cleared** by the presenter while the poll stays on
  screen. The page then shows it as open again.
- **The page reloads itself** about half a second after the tab returns to
  the foreground from the background (more than 3 s hidden).

### Things the bot does not handle

| Situation | What the bot does |
| --- | --- |
| Rank order, survey, clickable image, Q&A | Notifies you to answer by hand; never clicks or types. |
| Attendance check-in (asks for location) | Notifies you; never grants or fakes location. |
| Competition, between questions | Nothing to answer. A competition's multiple-choice question uses the same controls and is answered. |
| A newer interface the bot does not recognise in the activity area | Reloads once, then notifies you with a screenshot. |
| The page navigating away (e.g. a hand-off to another app) | Returns to the link. If that keeps happening, notifies you. |

## 3. Recognition

`recognize()` turns a snapshot into one state, in this order of precedence:

1. `loading`: the document is still loading.
2. `needs_user`: a password field or a sign-in or registration path, a modal
   dialog, or (on Poll Everywhere, by default) signed out.
3. `unknown`: on Poll Everywhere, no activity area, or the pinned tab
   selected.
4. `waiting`: no poll, and no unrecognised controls in the activity area.
5. `unknown`: no poll, but controls the extractor did not recognise.
6. `loading`: a poll whose controls are not drawn yet.
7. `poll` with a status:
   - **Multiple choice on Poll Everywhere.** `answered` if any option is
     marked as voted, or the status says a response was recorded. `closed`
     if locked, full, or no option can be selected. Otherwise `open`.
   - **Multiple choice elsewhere.** A ticked radio button is not enough.
     `answered` needs a confirmation message, or disabled options with a
     choice kept.
   - **Free text.** `answered` if your response is listed or the status says
     so. `closed` if the box is disabled or missing. Otherwise `open`.

The **fingerprint** of a poll is a hash of its kind, normalised question,
sorted normalised option labels, and the site's poll id when available. It
does not change when the poll goes from open to answered.

## 4. Answering

A poll is answered once all of these hold:

1. **The decision is "respond".** See section 5.
2. **The response delay has passed.** It is random, 2–8 s by default, chosen
   when the poll first appears.
3. **The poll has been open for the settling period**, unbroken and in the
   same page element (1.5 s). A redraw restarts it.
4. **The page is not fetching earlier responses.** Requests whose path ends
   in `/results` are tracked, and the bot waits up to 6 s for them.
5. **The browser reports a network connection.**

The page is read again and the response chosen from that reading:

- **Multiple choice.** `random` (default), `first` or `last`, among the
  options that can be selected.
- **Free text.** `fixed_text` (default `"value"`) or `echo_question`, cut to
  the box's length limit.

**Operating the control.**

- **Option:** a Playwright click.
- **If the click cannot land** (something covers the option): the page is
  read again, and if the poll is still open, the option is focused and Enter
  (or Space, for a radio button) is pressed.
- **Last resort:** the element's own `click()`.
- **Free text:** typed with `fill()`, which raises the same input events as
  typing. It is then sent with the form's Submit button, or with Enter if
  there is none.
- **Never clicked:** undo, "Clear response" and other buttons.

**Confirmation.** The evidence that counts, strongest first:

1. **The page's "saved" announcement** (`result` event).
2. **A new saved entry in the page's record of your responses.**
3. **The poll showing as answered, steadily.** On Poll Everywhere it must
   hold for the whole confirmation time (10 s), because the page draws a
   vote before the server accepts it. It also must not still be waiting for
   the server. Elsewhere it must hold for 1 s.
4. **On a plain page that never lists responses:** the text box was emptied
   after submitting, with no error.

While the page still shows a response it is sending (drawn, but the server
has not answered), nothing is counted either way. The bot waits for the
outcome.

**During an attempt** a momentary redraw, an unreadable page or a loading
state is waited out for up to 2.5 s. Only a different poll or the waiting
screen, held for a second, means the poll has gone.

**Failure and retries.** An error event from the page, or no confirmation in
time, means the attempt failed. The bot watches the requests the page sends
(method, address and reply status only) to tell what happened.

- **Retry schedule:** after 5 s, 10 s, 20 s, then 30 s, up to 5 attempts in
  all.
- **Clear rejection:** every request the attempt sent was answered with an
  error status. Nothing reached the server, so the bot simply retries after
  the pause.
- **Uncertain outcome:** no reply, a lost connection, a reply that arrived
  but was never confirmed, or a request still going out. The response may
  be on the server, so the bot records a *doubt* about that poll (see
  section 5). It waits at least one more confirmation period. It then
  reloads the page, and resends only if the fresh page, having fetched your
  earlier responses, still shows the poll open. If the fresh page shows your
  response, the attempt is counted as answered.
- **Never cut off a request:** the bot never reloads the page while it is
  sending something (up to 30 s). That covers its own checks, the periodic
  reload and reloads after a dropped connection.
- **Not while offline:** no check reload starts while the browser reports no
  network.
- **Network down:** an attempt that fails while the browser reports no
  network does not count.
- **After the last attempt:** you are notified. If the page is later loaded
  afresh and the poll is still open, the bot gets one more round of
  attempts. If that succeeds, the summary counts the poll as answered and you
  get a second notification saying so.
- **Your own vote after a give-up:** a response that appears after the bot
  gave up is credited to the bot only if it is the one the bot tried to
  send. Otherwise it is yours.

## 5. Never twice, never missed

The rule (`src/dedupe/decide.ts`), in order:

1. **Unsupported activity:** never answered.
2. **The page shows the poll as answered:** left alone. If the bot had no
   record of it, it is logged as "already answered" (answered by hand,
   elsewhere, or earlier).
3. **Closed:** wait.
4. **A response may already be on the server** (a *doubt*). This covers two
   cases:
   - the poll was answered earlier, the page showed that response, and it
     now shows the poll open again for 3 s;
   - an attempt's outcome is uncertain.

   The doubt is kept per poll, so it survives the poll leaving the screen
   and coming back, and only one thing can settle it: a page load that
   started after the doubt arose, and that itself fetched your earlier
   responses successfully. The page records this from its own resource
   timing, so a request made before a reload never counts for the page
   after it. If that fresh page shows the poll answered, the doubt is
   settled without sending anything. If it still shows the poll open, the
   poll is answered again. If it never fetched your earlier responses
   (within 6 s), its "open" proves nothing: the poll is left alone and you
   are told.

   This is how a re-vote (responses cleared, or the poll run again) gets an
   answer. A page that has merely lost track of a response, or a lost reply,
   gets a reload instead of a duplicate.
5. **Answered earlier on a page that cannot show responses:** answered again
   only if the poll went away and came back, meaning the page showed
   something else steadily for 3 s in between. Otherwise you are told and it
   is left alone.
6. **Otherwise:** answered, subject to the attempt limit and back-off.

Supporting mechanisms:

- **Single-pass loop.** One pass of the loop at a time, so a burst of change
  notices cannot produce two responses.
- **Persistent record.** Answers are written to `.data/answered.json` within
  a 12-hour window, so a restart mid-session neither answers twice nor
  forgets.
- **Appearance tracking.** A poll that stays on screen across reloads and
  redraws is one appearance: it is reported once and answered once. A
  waiting screen ends an appearance only when it lasts 3 s, so a waiting
  screen flashed while a page loads does not.

## 6. Staying healthy

| Problem | Detection | Response |
| --- | --- | --- |
| Page reloads itself or navigates | page events | Agent re-injected automatically; settling restarts. |
| Wrong address (followed a link, redirect) | not on the link for 20 s | Load the link again. Three times in 5 minutes: notify. |
| Signing in on another site (SSO) | sign-in page seen, now on another origin | Left alone until back on the poll site; then back to the link after 5 s. |
| Tab crashed | Playwright `crash` | New tab, link reloaded. |
| Tab frozen | three page reads fail (5 s timeout each) | New tab, link reloaded. |
| Push connection down | `channel.state` not `connected` for 10 s | Reload. A connection that drops and recovers is followed by one reload, in case an activation was missed. |
| Push silently dead | — | Full reload every 60 s while nothing is owed. |
| Poll activated while the page is reloading | — | The page asks its push service for what was sent since it was rendered (the `action-cable-history-timestamp` it carries). If the service does not honour that, the next periodic reload catches the poll. |
| Network down | `navigator.onLine` false | Wait; reload when it returns. Attempts are not spent meanwhile. |
| Page cannot be loaded | navigation error | Back-off 1 s, 2 s, 4 s, then every 5 s; a new tab every third failure. |
| Something unrecognised in the activity area | `unknown` / `loading` for 20 s | Reload once; at 60 s notify, with a screenshot. |
| Signed out, dialog, sign-in page | `needs_user` | Notify, and remind every 2 minutes. Nothing is clicked or typed. |
| Bot's tab or window closed | Playwright `close` | Bot stops (closing the window is a way to stop it). |
| Second copy started | lock file / Chromium's profile lock | Refused at once with a message. |
| A JavaScript `alert`/`confirm` | Playwright `dialog` | Dismissed (leave-page prompts accepted) and logged. |
| Ctrl+C, terminal closed, terminate signal | process signals | The bot stops itself, closes the browser cleanly (so a fresh sign-in is saved), then prints the summary. A second Ctrl+C exits at once. Stopping while the browser is still starting closes it too. |
| Page sending a request | request tracking | No reload of any kind until the reply arrives (at most 30 s). |

Playwright's default browser flags already turn off throttling of background
and hidden windows. On macOS the bot keeps the computer awake with
`caffeinate -i` for as long as it runs.

## 7. Plain pages (other sites)

The generic extractor is deliberately narrow:

- **Multiple choice:** the largest group of two or more visible radio buttons
  with the same name. The question is the fieldset legend or the nearest
  heading before the buttons. The submit control is a `type=submit` button,
  or a button labelled submit, send, vote, respond, answer, confirm or save,
  in the same form.
- **Free text:** exactly one visible text box, plus its submit control.
- **On-page guard:** polls are acted on only at the exact link given. Pages
  elsewhere, such as a sign-in provider, are never operated.

## 8. Settings

Settings come from the defaults, then `pollbot.config.json` (or
`--config <file>`), then command-line flags. Unknown keys and bad values are
rejected with a list of every problem. Paths are relative to the project
folder.

<!-- settings-table:start -->
| Setting | Default | Meaning |
| --- | --- | --- |
| `url` | `null` | Poll link. Normally given at start instead. |
| `dryRun` | `false` | Watch and log, never click or type. |
| `stopAfterMinutes` | `null` | Optional automatic stop; `null` runs until stopped. |
| `keepAwake` | `true` | Keep the Mac from idle-sleeping while running. |
| `requireSignIn` | `true` | On Poll Everywhere, do not answer while signed out. |
| `response.multipleChoice` | `"random"` | `random`, `first`, `last` or `skip`. |
| `response.freeText` | `"fixed_text"` | `fixed_text`, `echo_question` or `skip`. |
| `response.fixedText` | `"value"` | Text sent to free-text polls. |
| `response.delayMs.min` | `2000` | Shortest pause before answering (ms). |
| `response.delayMs.max` | `8000` | Longest pause before answering (ms). |
| `response.confirmTimeoutMs` | `10000` | How long to wait for confirmation (ms). |
| `response.maxAttempts` | `5` | Attempts per poll appearance. |
| `response.retryDelayMs` | `5000` | Pause before the second attempt; doubles, capped at 30 s. |
| `monitor.eventDriven` | `true` | React to page changes as they happen. |
| `monitor.debounceMs` | `250` | Pause after a change before reading the page (ms). |
| `monitor.fallbackPollMs` | `5000` | Read the page at least this often (ms). |
| `monitor.snapshotTimeoutMs` | `5000` | A page read taking longer counts as a failure (ms). |
| `monitor.navigationTimeoutMs` | `30000` | Time allowed for loading the poll link (ms). |
| `monitor.unknownAlertMs` | `60000` | Unrecognised page for this long: notify (ms). |
| `monitor.awayGraceMs` | `20000` | Off the poll link this long: go back (ms). Also when an unrecognised page is reloaded. |
| `monitor.settleMs` | `1500` | A poll must be steadily open this long before it is answered (ms). |
| `monitor.resyncMs` | `60000` | Reload the page this often while nothing is owed; `0` turns it off (ms). |
| `monitor.pushDownMs` | `10000` | Reload when the page's live connection has been down this long (ms). |
| `monitor.recovery.initialMs` | `1000` | First retry delay when the page cannot be loaded (ms). |
| `monitor.recovery.maxMs` | `5000` | Longest retry delay when the page cannot be loaded (ms). Kept short so a returning network is noticed quickly. |
| `browser.headless` | `false` | Run without a window. |
| `browser.channel` | `null` | `null` for the bundled Chromium, `"chrome"` for installed Chrome. |
| `browser.profileDir` | `".data/profile"` | The bot's browser profile (holds the sign-in). |
| `dedupe.file` | `".data/answered.json"` | Record of answered polls. |
| `dedupe.windowHours` | `12` | Earlier answers older than this are not considered. |
| `dedupe.retainDays` | `30` | Entries older than this are deleted. |
| `dedupe.reanswerSettleMs` | `3000` | An answered poll must look open this long before the reload check (ms). |
| `dedupe.separationMs` | `3000` | How long something else must show for a returning poll to count as asked again (ms). |
| `logging.dir` | `"logs"` | Where session logs go. |
| `logging.level` | `"info"` | `debug`, `info`, `warn` or `error`. |
| `logging.redactQuestionText` | `false` | Store hashes instead of question and option text. |
| `logging.screenshotOnUnknown` | `true` | Save a screenshot of an unrecognised page. |
| `logging.retainDays` | `30` | Logs older than this are deleted (screenshots after 7 days). |
| `notify.desktop` | `true` | macOS desktop notifications. |
| `notify.sound` | `true` | Terminal bell with notifications. |
| `notify.remindMs` | `120000` | Repeat a "needs you" notification this often; `0` = once (ms). |
<!-- settings-table:end -->

## 9. Known limits and open risks

- **No live poll has been observed.** The first real session should be a
  dry run (see the README). The `page.state` events in the log record what
  the bot saw.
- **Newer interfaces.** The participant page also ships code for a
  server-rendered attendance check-in and a hand-off to another app. If the
  presenter's polls use an interface other than the one described above, the
  bot reports "unrecognised" or "keeps leaving" rather than answering.
- **Server responses are unseen.** Server error messages, and whether the
  save response includes an id, have not been seen. The confirmation rules
  do not depend on either.
- **Re-votes depend on the page fetching earlier responses.** Re-votes, and
  resending after a lost reply, rely on the freshly loaded page fetching
  your earlier responses from an address ending in `/results` (inferred from
  the page's code). If that does not hold on the live site, the bot leaves
  those polls to you, with a notification, rather than risk a duplicate.
- **Missed pushes during a reload.** A poll activated in the second or two
  while the page is reloading relies on the push service replaying what the
  page missed. If it does not, the poll is found at the next periodic reload
  (within 60 s).
- **The bot can only act while it runs.** The computer must stay on, awake
  and online. A closed laptop lid stops it.
