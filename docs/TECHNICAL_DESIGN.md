# Technical Design

This document evaluates the options named in the project brief and records
the recommended choice for each. Nothing here has been verified against the
live Poll Everywhere participant page yet. Claims about that page are marked
as assumptions and are resolved in implementation Phase 2
(see [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md)).

## 1. Browser automation framework

| Option | For | Against |
| --- | --- | --- |
| **Playwright** | Auto-waiting locators; role/text selectors that survive class-name churn; persistent contexts; `exposeBinding` and `addInitScript` for in-page observers; tracing; first-class test runner; TypeScript-native | Ships its own Chromium (~500 MB) |
| Puppeteer | Lighter; same CDP foundation | No built-in test runner; weaker locators; less auto-waiting |
| Selenium / WebDriver | Mature; any browser | Slower; push-from-page callbacks are awkward; more flake handling by hand |
| Browser extension (MV3) | Runs in the user's own browser and profile; no separate window | Service-worker lifetime limits; harder to test and to log to disk; install friction |
| Attach to the user's Chrome over CDP | Reuses existing login | Requires launching Chrome with a debug port; fragile; exposes the whole profile |

**Recommendation: Playwright with bundled Chromium and a dedicated persistent
profile.** It covers monitoring, interaction, and testing with one dependency,
and its locators are the most tolerant of markup changes.

## 2. Detecting new questions

### Mutation observers vs periodic polling

| | MutationObserver (event-driven) | Periodic polling |
| --- | --- | --- |
| Latency | Milliseconds after the DOM changes | Up to one interval |
| Idle cost | Near zero | One snapshot per interval, forever |
| Failure mode | Silently stops if the observed root is replaced, or the page reloads | Keeps working as long as the page exists |
| Complexity | Needs re-arming and debouncing | Trivial |

**Recommendation: both.** The observer is the primary trigger. A slow poll
(default every 5 s, configurable) is a safety net that also acts as a liveness
check: if the page cannot produce a snapshot, the monitor is broken and
recovery starts.

Details:

- Inject with `context.addInitScript` so the observer is re-installed on every
  navigation and reload without Node-side bookkeeping.
- Observe `document.body` with `childList`, `subtree`, and `characterData`.
  Observing a narrower root is cheaper but breaks when a single-page app
  swaps that root.
- Debounce (default 250 ms) so a burst of mutations from one render yields one
  snapshot.
- Report through `page.exposeBinding`. The page sends a small snapshot, not
  the DOM.

### A third signal: network traffic

Live polling pages are typically pushed updates over a WebSocket or
long-polling. Playwright can observe both (`page.on('websocket')`,
`page.on('response')`) without modifying anything. If the messages turn out to
carry a poll identifier, that is a better dedupe key than anything derived
from visible text. This is read-only observation; responses still go through
the UI.

*Assumption to verify:* whether the participant page exposes a stable poll id
in the DOM, the URL, or the network messages.

## 3. Extraction: DOM vs OCR and computer vision

| | DOM / accessibility tree | OCR / screenshots |
| --- | --- | --- |
| Accuracy | Exact text | Error-prone on small text, math, non-Latin scripts |
| Speed | Microseconds | Hundreds of ms per frame |
| CPU | Negligible | Continuous capture and recognition |
| Finds controls | Yes, with handles to click | Only coordinates; breaks on resize or scroll |
| Robust to restyling | Role/label based: high | Theme changes can break it |
| Works on canvas/image-only content | No | Yes |

**Recommendation: DOM only, accessibility-first.** Prefer
`getByRole('radio' | 'button' | 'textbox')`, labels, and visible text over CSS
classes, which are usually generated and unstable. OCR is not built. If a poll
type renders into an image or canvas (clickable-image polls, for example), the
recognizer returns `kind: 'unsupported'`, the tool logs it, saves a
screenshot, and notifies the user rather than guessing.

### Recognition rules

The adapter classifies each snapshot into one of:

| State | Typical evidence |
| --- | --- |
| `waiting` | No form controls; a "waiting for the presenter" style message |
| `active:multiple_choice` | A group of radio/option buttons with labels |
| `active:free_text` | A text input or textarea with a submit button |
| `answered` | A response is shown as selected/recorded, or controls are disabled |
| `closed` | Poll visible but locked |
| `auth_required` | A login or name-entry form |
| `unknown` | Anything else |

`unknown` persisting beyond a threshold is logged with a DOM excerpt and a
screenshot so the adapter can be extended.

## 4. Response selection

The selector is a strategy chosen in config:

| Strategy | Behavior |
| --- | --- |
| `first` | Choose the first option |
| `random` | Choose uniformly at random |
| `fixed_text` | For free-text polls, send a configured string |
| `rules` | Ordered regex rules on question text mapping to an option label or text |
| `ask` | Notify the user and wait up to N seconds for a choice; fall back to another strategy |
| `skip` | Detect and log only (dry run) |

Multiple-choice and free-text polls each get a default strategy. Whether
participation alone earns the points, or correctness matters too, is an open
question for the user and decides which default makes sense.

A configurable random delay before responding (default 2–8 s) avoids
submitting before a question has fully rendered and before the presenter has
finished activating it.

## 5. Interaction and submission

- Use Playwright locator actions (`click`, `fill`, `press`). They wait for the
  element to be visible, enabled, and stable. No synthetic events or direct
  API calls: the brief specifies the normal interface, and it keeps behavior
  identical to a person's.
- Multiple choice: click the option. Some poll types submit on click; others
  need a separate submit button. The adapter decides.
- Free text: `fill` the field, then click submit or press Enter.
- One action attempt per poll, then confirm. Never click twice blindly.

### Confirmation

Success means the page itself shows the response was accepted. In preference
order:

1. A visible "response recorded" state for the chosen option.
2. A network response to the submit request with a success status.
3. Controls becoming disabled with the chosen value retained.

If no signal arrives within the timeout (default 10 s), re-snapshot. If the
page now shows `answered`, treat it as success. Only if it still shows
`active` with nothing selected is one retry allowed. After that the poll is
marked `failed` and the user is notified.

## 6. Duplicate prevention

Three layers:

1. **Fingerprint store.** `siteId` when available; otherwise a SHA-256 of the
   normalized question text plus sorted option labels plus the session date.
   Persisted to `.data/answered.json` so a restart mid-session does not
   re-answer.
2. **Page truth.** If the adapter sees `answered`, do nothing, whatever the
   store says. This covers responses made by hand or from another device.
3. **Single-flight lock.** The orchestrator handles one poll at a time, and
   mutation events arriving during `RESPONDING` are coalesced.

Known edge: a presenter may reactivate the same question, or ask two questions
with identical text. With a `siteId` these are distinguishable. Without one,
the page-truth check decides: if the page shows an unanswered active poll
whose fingerprint is in the store, and enough time has passed since the last
confirmation, it is treated as new. This rule needs validation on the real
site.

## 7. Session persistence, authentication, reconnect

- `chromium.launchPersistentContext('.data/profile')` keeps cookies and local
  storage between runs.
- **Login is manual.** A `login` command opens the profile in a headed window;
  the user signs in (including any SSO or 2FA) and closes it. The tool never
  sees, stores, or types a password.
- If the adapter reports `auth_required` during a session, monitoring pauses
  and the user is notified. The tool does not try to log in.
- Reload, navigation, and crash are detected through `framenavigated`,
  `crash`, `close`, and failed liveness snapshots. Recovery: reopen the poll
  URL with backoff of 1, 2, 4, … up to 30 s.
- Network loss: `navigator.onLine` and failed requests move the orchestrator
  to `RECOVERING`. On return, the page is reloaded once to resynchronize.
- Preventing system sleep during the window is needed for an unattended run.
  On macOS `caffeinate` does this; cross-platform handling is a Phase 5 item.

## 8. Headed vs headless

Headed by default. It lets the user see and intervene, makes manual login
possible, and avoids the differences headless mode introduces. A minimized or
background window can have its timers throttled by Chromium; the flags
`--disable-background-timer-throttling` and
`--disable-renderer-backgrounding` address this and will be tested.

## 9. Scheduling

The process can be started any time; it idles until the window opens and exits
after it closes. Launching the process each morning is left to the OS
(`launchd`, Task Scheduler, `cron`) and documented rather than built, at least
initially.

## 10. Configuration sketch

```yaml
target:
  url: https://pollev.com/<presenter>
session:
  start: "08:00"
  end: "09:30"
  timezone: America/New_York
  days: [mon, wed, fri]
monitor:
  debounceMs: 250
  fallbackPollMs: 5000
  recovery: { initialMs: 1000, maxMs: 30000 }
response:
  multipleChoice: first        # first | random | rules | ask | skip
  freeText: fixed_text
  fixedText: "Present"
  delayMs: { min: 2000, max: 8000 }
  confirmTimeoutMs: 10000
logging:
  level: info
  redactQuestionText: false
  screenshotOnUnknown: true
```

## 11. Resource usage, reliability, maintainability

| Concern | Approach |
| --- | --- |
| CPU when idle | Event-driven; one cheap snapshot every 5 s as fallback |
| Memory | One Chromium tab (roughly 200–400 MB); the Node process is small |
| Reliability | Two detection signals, page-truth dedupe, confirm-before-record, backoff recovery |
| Markup changes | Selectors isolated in one adapter; role/text locators; `unknown` state captured with evidence |
| Maintainability | Adapter and selector are pure and unit-testable; mock site reproduces each state |

## 12. Desktop UI options

| Option | Notes |
| --- | --- |
| Terminal status line + log tail | Zero extra dependencies; enough for early phases |
| Local web dashboard on `127.0.0.1` | Small; reuses web skills; opens in any browser |
| Electron / Tauri shell | A real app window and tray icon; adds packaging and a second Chromium |

**Recommendation:** terminal first, local dashboard in Phase 5, packaged shell
only if a double-clickable app is actually wanted.

## 13. Risks

| Risk | Mitigation |
| --- | --- |
| Real markup differs from assumptions | Phase 2 starts with a read-only inspection of a real session |
| Bot detection or CAPTCHA | Out of scope to bypass; pause and notify |
| Session requires location or in-room code | Cannot be automated; surfaced as `auth_required`/`unknown` |
| Machine sleeps at 08:00 | Document wake scheduling; prevent sleep during window |
| Provider terms of service | See [PRIVACY.md](PRIVACY.md); user confirms authorization |
