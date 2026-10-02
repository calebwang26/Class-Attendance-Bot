# Implementation Plan

Phases are sequential. Each ends with acceptance criteria that must pass
before the next begins. Sizes are relative effort, not calendar estimates.

## Phase 1 — Repository preparation (this phase)

Deliverables: `README.md`, `.gitignore`, and the five documents under `docs/`.

Acceptance:
- [x] Repository inspected and its state recorded (empty, no commits).
- [x] Stack recommended with reasons.
- [x] Architecture, data flow, test strategy, and privacy practices written.
- [ ] Open decisions below answered by the project owner.

## Phase 2 — Scaffold and mock polling site (small)

- Initialize the TypeScript project, lint, format, Vitest, Playwright Test.
- Config loader with Zod schema and defaults.
- Logger writing JSON Lines.
- `mock-site/`: a local server with a presenter control page and a participant
  page, covering every state in
  [TECHNICAL_DESIGN.md](TECHNICAL_DESIGN.md#recognition-rules).
- Read-only inspection of the real participant page during an authorized
  session: record the DOM structure, URL behavior, and network messages for
  each state. Save sanitized fixtures under `tests/fixtures/`.

Dependencies: Node 24, Playwright, Vitest, Zod, Pino, a YAML parser.

Acceptance:
- `npm test` runs and passes with at least the config tests.
- The mock site can be driven through waiting → multiple choice → answered →
  free text → closed from its control page.
- A written note of what the real page looks like, resolving the assumptions
  flagged in the technical design.

## Phase 3 — Monitoring and recognition, read-only (medium)

- `browser`: persistent context, `login` command, navigation, observer
  injection, fallback poll, liveness check.
- `adapters/mock` and `adapters/pollev`: snapshot and recognize.
- `dedupe`: fingerprinting and the persisted store.
- `session`: window scheduling.
- Orchestrator in `skip` (dry-run) mode: detects and logs, never clicks.

Acceptance:
- Against the mock site, every activated poll produces exactly one
  `poll.detected` event within 1 s, with correct question, kind, and options.
- Reloading the mock page mid-poll produces no second detection event.
- Unit tests cover the recognizer for each fixture state.
- A dry run against one real authorized session logs every poll shown, with
  no interaction and no missed or duplicated polls (checked against a manual
  count).

## Phase 4 — Response and confirmation (medium)

- `selector`: `first`, `random`, `fixed_text`, `rules`, `skip`.
- `submitter`: multiple choice and free text, confirmation, single retry.
- Orchestrator: full state machine with the single-flight lock.

Acceptance:
- Against the mock site: 100 consecutive polls of mixed type answered, 100
  confirmations, 0 duplicate submissions (counted server-side by the mock).
- Submission that fails server-side is retried once, then marked `failed`.
- A poll answered by hand before the bot acts is recorded as answered and not
  touched.
- Restarting the process mid-poll does not produce a second submission.

## Phase 5 — Recovery and hardening (medium)

- Backoff recovery for reload, navigation away, tab crash, network loss.
- `auth_required` and `unknown` handling with screenshot and notification.
- Sleep prevention during the window; background-throttling flags.
- Session summary at stop.
- Status UI: terminal first, then the local dashboard if approved.
- `ask` strategy and desktop notifications if approved.

Acceptance:
- Each failure scenario in [TESTING.md](TESTING.md#failure-scenarios) passes
  as an automated test against the mock site.
- A 90-minute soak run against the mock site with a poll every 3–10 minutes
  and injected faults: all polls answered once, memory stable, idle CPU under
  2% on the development machine.

## Phase 6 — Live validation and packaging (small)

- One supervised run in a real authorized session with the user watching.
- One unattended run.
- Document OS-level scheduling for the morning start.
- Optional: package as a double-clickable app.

Acceptance:
- Supervised run: every poll answered and confirmed; log matches what the
  presenter's view shows.
- Unattended run: same, with no intervention.

## Milestones

| Milestone | Reached when |
| --- | --- |
| M1 Docs approved | Phase 1 decisions answered |
| M2 Mock loop | Phase 2 done; mock site drives all states |
| M3 It sees | Phase 3 dry run on a real session is accurate |
| M4 It answers | Phase 4 passes on the mock site |
| M5 It survives | Phase 5 soak test passes |
| M6 It ships | Phase 6 unattended run succeeds |

## Open questions and decisions needing approval

### Decisions

1. **Stack.** TypeScript + Node 24 + Playwright, as recommended? (Python +
   Playwright is a workable alternative if preferred.)
2. **Response strategy.** Do points depend on participating only, or on
   answering correctly? This picks the default: `first`/`random` for the
   former, `ask` or `rules` for the latter.
3. **Free-text default.** What string should be sent to open-ended polls?
4. **UI scope.** Terminal status only, a local dashboard, or a packaged
   desktop app?
5. **Notifications.** Desktop notification only, or also something that
   reaches a phone (which would add a third-party service)?
6. **Headed window.** Is a visible browser window during the session
   acceptable?
7. **Morning start.** Start by hand each day, or set up OS scheduling and
   wake-from-sleep?

### Facts to supply or confirm

8. The participant URL, and whether it requires a signed-in Poll Everywhere
   account, a guest name, or SSO.
9. Which poll types the presenter uses (multiple choice, open-ended, word
   cloud, Q&A, ranking, clickable image, competitions).
10. Whether responses can be changed after submission, and whether polls are
    timed.
11. Session days and time zone.
12. Confirmation that the organizer's permission for automated participation
    covers this tool, and that a read-only inspection run in Phase 2 is fine.

### Technical unknowns (resolved by the Phase 2 inspection)

13. Is a stable poll identifier available in the DOM, URL, or network
    messages?
14. What does the page show after a response is accepted?
15. Does the page keep a live connection in a background tab for 90 minutes,
    or does it need a periodic reload?
16. How does the page behave when the same question is reactivated?
