# Architecture

## Starting point

The repository had no commits and no files when this was written. There is no
existing code or stack to adapt to; this document describes a proposed design.

## Overview

One Node.js process drives one Chromium window through Playwright. A small
script injected into the page watches the DOM and reports changes back to the
Node side, where a pipeline turns "the page changed" into "a response was
submitted and confirmed".

```
                        ┌──────────────────────────────────────────┐
                        │              Node.js process             │
                        │                                          │
  config.yaml ─────────▶│  Config ──▶ Session Scheduler            │
                        │                  │ start / stop          │
                        │                  ▼                       │
                        │           ┌─────────────┐                │
                        │           │ Orchestrator│◀── status ──▶ UI
                        │           └──────┬──────┘                │
                        │   ┌──────────────┼───────────────┐       │
                        │   ▼              ▼               ▼       │
                        │ Browser      Recognizer      Dedupe      │
                        │ Monitor      (adapter)       Store       │
                        │   │              │               │       │
                        │   │              ▼               │       │
                        │   │        Response Selector     │       │
                        │   │              │               │       │
                        │   │              ▼               │       │
                        │   └────────▶ Submitter ──────────┘       │
                        │                  │                       │
                        │               Logger ──▶ logs/*.jsonl    │
                        └──────────────────┼───────────────────────┘
                                           │ Playwright (CDP)
                        ┌──────────────────▼───────────────────────┐
                        │ Chromium, persistent profile             │
                        │  poll page + injected MutationObserver   │
                        └──────────────────────────────────────────┘
```

## Components

Each component is a module with a narrow interface. Only the Browser Monitor
and the Submitter touch Playwright; only the site adapter knows selectors.

| Module | Responsibility | Depends on |
| --- | --- | --- |
| `config` | Load and validate YAML; supply defaults | Zod |
| `session` | Decide whether now is inside the session window; emit start/stop | `config` |
| `browser` | Launch the persistent context, open the poll URL, inject the observer, detect reloads/navigation/disconnects, re-arm | Playwright |
| `adapters/<site>` | Site-specific knowledge: how to tell a poll is active, how to read it, how to tell it was answered | none (pure functions over a page snapshot, plus locators) |
| `recognizer` | Turn a page snapshot into a `Poll` or `null` using the adapter | adapter |
| `dedupe` | Fingerprint polls; record and look up answered ones; persist to disk | fs |
| `selector` | Choose a `Response` for a `Poll` from the configured strategy | `config` |
| `submitter` | Perform the clicks/typing, then wait for the adapter's confirmation signal | Playwright, adapter |
| `orchestrator` | The state machine tying the above together; retries and backoff | all of the above |
| `logger` | Structured events to file and console | Pino |
| `ui` | Show status and recent events; pause/resume | orchestrator events |

### Site adapter boundary

Poll Everywhere specifics live in `adapters/pollev`. The mock site gets its own
adapter (or reuses the same one if the mock mirrors the real markup closely
enough). Adding another provider means adding an adapter, not editing the
pipeline.

```ts
interface SiteAdapter {
  matches(url: string): boolean;
  // Runs in the page. Cheap; called on every debounced mutation.
  snapshot(): PageSnapshot;
  // Runs in Node. Pure.
  recognize(snapshot: PageSnapshot): Poll | null;
  // Returns Playwright locators for a response.
  locate(page: Page, poll: Poll, response: Response): ResponseTargets;
  // Resolves when the page shows the response was accepted.
  confirm(page: Page, poll: Poll, response: Response): Promise<Confirmation>;
}
```

## Core data types

```ts
type PollKind = 'multiple_choice' | 'free_text' | 'unsupported';

interface Poll {
  fingerprint: string;       // stable hash, see TECHNICAL_DESIGN
  siteId?: string;           // provider's own id if one can be read
  kind: PollKind;
  question: string;
  options: { id: string; label: string }[];   // empty for free_text
  alreadyAnswered: boolean;  // page shows a prior response
  detectedAt: string;        // ISO 8601
}

type Response =
  | { kind: 'choice'; optionId: string }
  | { kind: 'text'; value: string }
  | { kind: 'skip'; reason: string };

interface Confirmation {
  ok: boolean;
  evidence: string;          // what on the page showed success
  at: string;
}
```

## Data flow

1. **Start.** The scheduler fires at the window start (or immediately if
   already inside it). The orchestrator asks `browser` for a ready page.
2. **Arm.** `browser` navigates to the poll URL and injects the observer. The
   observer debounces DOM mutations and calls back into Node with a
   `PageSnapshot`. A slow timer also requests a snapshot, in case mutation
   events are missed.
3. **Recognize.** The adapter turns the snapshot into a `Poll`, or `null` when
   the page is in a waiting state.
4. **Dedupe.** The fingerprint is checked against the store. Known and
   answered: stop. `alreadyAnswered` on the page: record it and stop.
5. **Select.** The configured strategy produces a `Response`, or `skip`.
6. **Submit.** The submitter acts on the locators from the adapter through
   ordinary clicks and typing.
7. **Confirm.** The submitter waits for the adapter's confirmation signal. On
   success the fingerprint is written to the store. On timeout the page is
   re-snapshotted before any retry, so a response that did land is not
   repeated.
8. **Log.** Every transition emits an event with a timestamp.
9. **Stop.** At window end the orchestrator disarms the observer, flushes
   logs, writes a session summary, and closes the browser (or leaves it open,
   per config).

## Orchestrator state machine

```
IDLE ──window opens──▶ CONNECTING ──page ready──▶ WATCHING
                           ▲                         │ poll recognized
                           │ nav/reload/crash        ▼
                       RECOVERING ◀──error──── RESPONDING
                           │                         │ confirmed / skipped
                           └──────ready──────▶ WATCHING ◀──┘
WATCHING ──window closes──▶ STOPPED
```

`RECOVERING` uses capped exponential backoff. Entering it never clears the
dedupe store.

## Proposed layout

```
src/
  config/        session/      browser/      recognizer/
  adapters/pollev/   adapters/mock/
  dedupe/        selector/     submitter/    orchestrator/
  logger/        ui/
  index.ts
mock-site/       # local polling page used by tests
tests/unit/      tests/integration/
docs/
```

## Runtime files (all git-ignored)

| Path | Contents |
| --- | --- |
| `.data/profile/` | Chromium user data, including session cookies |
| `.data/answered.json` | Fingerprints of answered polls |
| `logs/session-<date>.jsonl` | Event log |
| `traces/` | Optional Playwright traces captured on failure |
