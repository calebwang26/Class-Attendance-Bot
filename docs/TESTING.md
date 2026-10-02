# Testing Strategy

Automated tests never touch a real polling service. All interaction and
submission tests run against a mock polling site served from this repository.
Live sessions are used only for the read-only inspection in Phase 2 and the
supervised validation in Phase 6.

## Levels

| Level | Tool | Scope | Runs |
| --- | --- | --- | --- |
| Unit | Vitest | Pure logic: config, recognizer, fingerprinting, selector, scheduler, state machine | Every change |
| Integration | Playwright Test | Full pipeline against the mock site in real Chromium | Every change |
| Soak | Playwright Test, long timeout | 90-minute scripted session with injected faults | Before a live run |
| Live | Manual, supervised | One authorized session | Phase 6 |

## Mock polling site

A small local server (`mock-site/`) bound to `127.0.0.1` with:

- **Participant page** that mirrors the structure of the real participant
  page for each state: waiting, multiple choice, free text, answered, closed,
  login required, and an unrecognized layout.
- **Control API** used by tests to act as the presenter:
  `activate(poll)`, `deactivate()`, `lock()`, `reactivate(pollId)`.
- **Push channel** (WebSocket) so questions appear without a page reload, as
  they do on a real polling page.
- **Response ledger**: every submission received, with a timestamp. Tests
  assert on this ledger, so "exactly one response" is checked server-side and
  not inferred from the bot's own log.
- **Fault switches**: delay rendering by N ms, fail the next submit with a
  500, drop the push channel, force a reload, redirect to another URL, swap
  the root element, change class names.

The mock is built from the fixtures captured in Phase 2 so its markup stays
close to the real page. When the real page changes, a new fixture is captured
and the mock is updated.

## Unit tests

| Module | Cases |
| --- | --- |
| `config` | Valid file; missing required field; bad time format; end before start; defaults applied |
| `session` | Before/inside/after the window; time-zone and DST boundaries; non-session weekday |
| `recognizer` | One fixture per state yields the expected `Poll` or `null`; whitespace and Unicode normalization; options in order; zero options |
| `dedupe` | Same poll gives same fingerprint; reordered options give same fingerprint; different question differs; store survives reload from disk; corrupt store file is quarantined and recreated |
| `selector` | Each strategy; `rules` precedence; no rule match falls back; free text over a length limit is truncated or skipped per config |
| `orchestrator` | Each transition with fake collaborators; mutation events during `RESPONDING` are coalesced; retry budget respected |

## Integration tests

### Question detection
- A multiple-choice poll activated on a waiting page is detected within 1 s.
- A free-text poll is detected and classified as such.
- A poll already active when the page first loads is detected.
- Two polls activated back to back are both detected, in order.
- Detection works with the observer disabled (fallback poll only) and with
  the fallback disabled (observer only).
- A poll rendered slowly, with options arriving after the question, is not
  reported until complete.

### Response selection and interaction
- `first` selects the first option; the ledger shows that option.
- `random` with a seeded generator selects the expected option.
- `fixed_text` sends the configured string.
- A poll with a separate submit button and one that submits on click are both
  handled.
- `skip` produces a detection event and no ledger entry.

### Submission confirmation
- Success: the confirmation event carries evidence, and the ledger has one
  entry.
- Server returns 500 once: one retry, then success, one ledger entry.
- Server returns 500 twice: marked `failed`, user notified, no further
  attempts.
- Server accepts but the confirmation render is delayed past the timeout:
  re-snapshot finds `answered`, no retry, one ledger entry.

### Duplicate prevention
- Page reload after answering: no second ledger entry.
- Process restart after answering: no second ledger entry.
- Burst of DOM mutations during an active poll: one ledger entry.
- Poll answered by hand before the bot acts: zero bot submissions, recorded as
  answered.
- Presenter reactivates the same poll after clearing responses: handled per
  the rule chosen in the technical design, with a test pinning that behavior.
- Two different polls with identical text and distinct ids: both answered.

### Failure scenarios
| Scenario | Expected |
| --- | --- |
| Page reloads mid-watch | Observer re-armed; next poll detected |
| Page navigates to another URL | Returns to the poll URL with backoff |
| Tab crashes | New page opened; monitoring resumes |
| Browser window closed by the user | Logged; relaunch or stop per config |
| Network drops for 30 s | `RECOVERING`, then resync; a poll activated during the outage is answered on return if still open |
| Push channel dies silently | Liveness or fallback poll notices; page reloaded |
| Root element replaced | Observer on `body` still fires |
| Class names changed | Role/text locators still match |
| Unrecognized layout | `unknown` logged with screenshot; no clicks |
| Login required mid-session | Monitoring paused; user notified; no credentials typed |
| Poll closes between detection and click | Logged as `missed`; no error loop |
| Option disappears before click | Action times out; re-snapshot; no blind retry |
| Session window ends during `RESPONDING` | In-flight response completes, then stop |
| Dedupe store unwritable | Fails closed: no submission without a recordable outcome |

## Soak test

A scripted 90-minute mock session with 15–25 polls at irregular intervals, one
reload, one network drop, and one failed submit. Pass criteria: ledger count
equals poll count, no duplicates, resident memory at the end within 20% of
the 10-minute mark, average idle CPU under 2%.

A time-compressed variant (same events in about 3 minutes) runs with the
regular integration suite.

## Test data and hygiene

- Fixtures contain no real names, emails, or tokens. Captured markup is
  scrubbed before commit.
- Integration tests use a temporary profile directory and a temporary dedupe
  store, removed afterwards.
- Playwright traces are kept only for failed tests and are git-ignored.

## Live validation checklist (Phase 6)

- [ ] Authorization for the session confirmed.
- [ ] Dry-run (`skip`) log from an earlier session matched a manual count.
- [ ] User present and watching the headed window.
- [ ] After the session: bot log count equals the number of polls shown, and
      the account's response history shows one response per poll.
