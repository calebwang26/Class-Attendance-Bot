# UBGA10X Attendance Bot

A local desktop tool that watches a live web polling page, detects new poll
questions as they appear, and responds to them through the page's normal
interface. Poll Everywhere is the first compatibility target.

> **Status: Phase 1 (documentation only).** No application code exists yet.
> Nothing here is installable or runnable until Phase 2 is approved.

## Goals

- Detect every poll that appears during a session window (typically
  08:00–09:30) without a person watching the tab.
- Extract the question, its options or input field, and the submit control.
- Respond once per poll, confirm the response registered, and never
  double-submit.
- Survive reloads, navigation, slow rendering, and network drops.
- Keep a structured, timestamped record of what happened.
- Run entirely on the user's machine. No data leaves it other than the
  responses sent to the polling site.

## Non-goals

- Answering questions *correctly*. The response selector is pluggable, but the
  default strategies are simple (see
  [TECHNICAL_DESIGN.md](docs/TECHNICAL_DESIGN.md#response-selection)).
- Defeating CAPTCHAs, bot detection, or location/attendance verification.
- Operating multiple accounts or responding on behalf of other people.

## Authorized use

This tool is built for a session whose organizer has explicitly allowed
automated participation, and for testing against the local mock polling site
in this repository. Using it elsewhere may break a course's attendance policy
or the polling provider's terms of service. Check before you point it at a
real session. See [PRIVACY.md](docs/PRIVACY.md).

## Recommended stack

| Concern | Choice |
| --- | --- |
| Language / runtime | TypeScript on Node.js 24 LTS |
| Browser automation | Playwright (Chromium, persistent profile, headed) |
| Detection | In-page `MutationObserver` plus a slow fallback poll |
| Configuration | One YAML file validated with Zod |
| Logs | Pino, JSON Lines on disk |
| State | A JSON file of answered-poll fingerprints |
| Tests | Vitest (unit), Playwright Test against a local mock site |
| UI | Terminal status first; local dashboard later |

Rationale is in [TECHNICAL_DESIGN.md](docs/TECHNICAL_DESIGN.md).

## Prerequisites (for Phase 2 onward)

- macOS, Windows, or Linux
- Node.js 24 or newer and npm
- About 500 MB of disk for Playwright's Chromium build
- A Poll Everywhere participant link (`pollev.com/<presenter>`) for the
  authorized session

## Setup

Not available yet. The intended flow once implemented:

```bash
npm install
```

```bash
npx playwright install chromium
```

```bash
npm run login
```

```bash
npm start
```

`login` opens the bot's own browser profile so you can sign in by hand once.
`start` then monitors during the configured window.

## Documentation

| Document | Contents |
| --- | --- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Components, boundaries, data flow |
| [docs/TECHNICAL_DESIGN.md](docs/TECHNICAL_DESIGN.md) | Options evaluated and the chosen approach |
| [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) | Phases, milestones, acceptance criteria, open questions |
| [docs/TESTING.md](docs/TESTING.md) | Test levels, mock polling site, failure scenarios |
| [docs/PRIVACY.md](docs/PRIVACY.md) | Permissions, local data, credentials, logging |

## Repository state at Phase 1

The repository was empty when this documentation was written: no commits, no
source, no prior technology decisions. Everything in `docs/` is a proposal.
