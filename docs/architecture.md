# Architecture

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
    ├── QUESTIONS.md     # what the company needs from the owner
    ├── roles/           # editable role prompts
    ├── mockups/ research/ reports/
    ├── journal.log      # what happened, one line per event

~/.solo-company/worktrees/<project>-<hash>/   # one worktree per ticket + _integration
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
| `opencode` | `opencode run` (read-only roles use its `plan` agent) |
| `hermes` | `hermes -z` with toolsets per mode (`file,web`, plus `terminal,code_execution` for full) |
| `custom` | any command you give; prompt on stdin |

Hermes has no strictly read-only mode: its `file` toolset can also write, so for read-only roles it relies on the role prompt.

Subscription first: adapters use the CLI you are logged into. Paid API fallback and a daily spending cap are an optional feature.

## Optional features

| Feature | What it adds |
|---|---|
| `scheduledChecks` | cron/launchd job: cheap health check every N minutes; the model is called only if something is wrong |
| `nightShift` | a reduced team working in a time window, with a morning report |
| `budget` | daily cap on paid API credits |
| `research` | a research team (competitors, similar projects) on PM request |

## Modules

| File | Job |
|---|---|
| `src/cli.js` | commands and the setup wizard |
| `src/company.js` | create/open a company, owner actions (request, approve, resume, features…) |
| `src/engine.js` | the work loop: PM → teams (in parallel) → QA → merge/promote |
| `src/git.js` | worktrees, catch-up merges, integration branch, promotion, pull requests |
| `src/agents.js` | adapters, limit detection, paid fallback with daily cap |
| `src/prompts.js` | role file + context + the JSON answer contract per role |
| `src/health.js` | scheduled tick: deterministic repairs, shifts, morning report |
| `src/schedule.js` | launchd / crontab install |
| `src/ceo.js` | owner messages → reply + actions |
| `src/mcp.js` | MCP server on stdio (JSON-RPC, no SDK): the `company_*` tools for chat apps |
| `src/connect.js` | registers the MCP server in Claude Code, Codex, Gemini, Hermes, OpenCode, Cursor, Claude Desktop |
| `src/registry.js` | `~/.solo-company/companies.json`: every company on the machine, resolved by name, path or current folder |
| `src/background.js` | detached work runs and dashboards that outlive the chat |
| `src/dashboard.js` | local web page (node:http, key in the URL): snapshot API, owner actions, sandboxed mockups, optional cloudflared tunnel |

Agents answer in free text that ends with one JSON object; the engine takes the last parseable one. Anything unusable counts as a failed attempt, never as success.

## Decisions log

- 2026-11-15: own small runtime in Node, not built on an external orchestration platform — keeps install to one `npx` command and no extra service.
- 2026-11-15: owner actions taken while a run holds the lock go to `inbox.jsonl` and the run applies them between steps. The run keeps the register in memory and saves it often, so writing to `tickets.json` behind its back would lose the change.
- 2026-11-15: chat apps talk to the company through MCP instead of a plugin per app. One stdio server, written without the SDK to keep zero dependencies, works in every app that speaks MCP. Work started from a chat runs in a detached process, so closing the chat does not stop it.
