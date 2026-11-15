# Architecture (draft)

> Work in progress — this document is the design the code is being built towards.

## Goals

- Runs on your machine, on top of the coding agent you already use (Claude Code, Codex, Gemini CLI, …).
- No server, no database, no account: state is plain files inside your project.
- One human (you) decides; the company does everything else and only asks about money, accounts and real choices.
- Every feature beyond the core is optional and can be switched on later.
- Zero runtime dependencies (Node ≥ 22 built-ins only).

## Roles

| Role | Job | Touches code |
|---|---|---|
| **CEO** | Talks to you, keeps the goal and priorities, turns features on/off | no |
| **PM** | Turns goal, requests and bug reports into small tickets with acceptance criteria; hands ready tickets to free teams | no |
| **Dev** | Implements a ticket on its own branch/worktree | yes |
| **UX** | Mockups and visual proposals; visual changes start here | no (design files only) |
| **QA** | Tests delivered work in batches, files bugs as new tickets | read-only |

Roles are defined in `templates/roles/*.md` and copied into the project on `init`, so you can edit them.

## Project layout

```
your-project/
└── .solo-company/
    ├── config.json      # agent, teams, merge policy, optional features
    ├── GOAL.md          # what you are building, in your words
    ├── REQUESTS.md      # your inbox to the PM: one request per line
    ├── tickets.json     # the ticket register (source of truth)
    ├── roles/           # editable role prompts
    └── journal.log      # what happened, one line per event
```

## Ticket lifecycle

```
            ┌──────────── split ───────────┐
            │                              ▼
 todo ──► in_progress ──► review ──► done        (QA passed, merged per policy)
  ▲           │              │
  │           │              └──► bugs_open ──► done   (once the bug tickets are done)
  │           └──► suspended  (needs the human: decision, permission, external thing)
  └── retry (with advice) ◄── diagnosis
 cancelled  (any time, by the human or the PM)
```

- A ticket is small: the PM estimates minutes and splits anything over the limit (default 30).
- Visual tickets: the PM writes only the **UX mockup** ticket; the dev tickets wait as drafts until you approve the mockup.
- After `maxAttempts` (default 2) failed rounds a ticket is suspended and you are told.

## Git flow

- Each dev ticket gets branch `feature/<id>` in its own `git worktree`, so teams never share a folder.
- On delivery the engine runs your checks (typecheck/tests, configured in `config.json`) without any model call.
- Merge policy (asked at setup):
  - `auto` — merge to the integration branch after checks, promote to `main` after QA;
  - `pr` — open a pull request and stop;
  - `manual` — leave the branch, tell you.

## Agent adapters

An adapter knows how to run one non-interactive prompt with a given agent CLI and return its output:

| Adapter | Command (detected on PATH) |
|---|---|
| `claude` | `claude -p` |
| `codex` | `codex exec` |
| `gemini` | `gemini -p` |
| `custom` | any command you give; prompt on stdin |

Subscription first: adapters use the CLI you are logged into. Paid API fallback and a daily spending cap are an optional feature.

## Optional features

| Feature | What it adds |
|---|---|
| `scheduledChecks` | cron/launchd job: cheap health check every N minutes; the model is called only if something is wrong |
| `nightShift` | a reduced team working in a time window, with a morning report |
| `budget` | daily cap on paid API credits |
| `research` | a research team (competitors, similar projects) on PM request |

## Decisions log

- 2026-11-15: own small runtime in Node, not built on an external orchestration platform — keeps install to one `npx` command and no extra service.
