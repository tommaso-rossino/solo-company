# solo-company

> 🚧 **Work in progress.** Nothing here is usable yet. This README describes where the project is going, not what exists today.

**solo-company** turns the AI coding agent you already run on your machine (Claude Code, Codex, Gemini CLI, …) into a small software company: a CEO you talk to, a PM that writes tickets, and teams that build, test and ship — while you stay the one who decides.

It grew out of a setup used daily to build a real app with a single human in the loop. This repository is the generic, open version of that engine: no project-specific rules, paths or accounts.

## The idea

```
        You
         │  ideas, approvals, "enable the night shift"
         ▼
        CEO ──────────────── decides priorities, talks to you
         │
         ▼
        PM  ──────────────── turns requests into tickets
         │
   ┌─────┼─────────┐
   ▼     ▼         ▼
  Dev   UX        QA  ────── each ticket in its own git worktree
   │               │
   └──► review ◄───┘ ─────── merge per your policy
```

- **You only get asked about money, accounts and real choices.** Everything else the company tries to fix on its own, and every manual fix becomes an automatic one.
- **Design before code.** Visual changes start as a UX mockup; dev tickets are written only after you approve it.
- **QA before merge.** Nothing reaches the main branch untested.
- **Budget aware.** Teams use your subscription first, can fall back to paid API credits with a daily cap, otherwise they wait.

## Planned features

| Feature | Default | Notes |
|---|---|---|
| Setup wizard | on | Asks what you're building and configures the company together with your local agent |
| Agent detection | on | Finds `claude`, `codex`, `gemini`, … and offers sensible defaults (or "other") |
| CEO → PM → teams hierarchy | on | Number of parallel teams is configurable |
| Ticket per git worktree | on | Isolated branches, no stepping on each other |
| Merge policy | ask | Auto-merge after QA · open PR only · manual |
| Scheduled health checks | optional | cron / launchd; cheap checks, the model is called only when something is wrong |
| Night shift | optional | A reduced team working while you sleep, with a morning report |
| Budget limits | optional | Daily spend cap on API credits |

Every optional feature can be turned on later just by asking the CEO, e.g. *"enable the night shift to work on tests"*.

## Install (planned)

```bash
npx solo-company init
```

Not on npm yet. To try the current state from a clone (Node ≥ 22):

```bash
node bin/solo-company.js init
node bin/solo-company.js request "add dark mode"
node bin/solo-company.js status
```

## Status

- [x] Repository created
- [x] Design draft: [docs/architecture.md](docs/architecture.md)
- [x] Ticket register (states, priorities, dependencies, mockup approval) with tests
- [x] Setup wizard + agent detection (first version: `init`, `status`, `request`, `approve`)
- [ ] PM loop: requests → tickets via your agent
- [ ] Ticket flow (PM → team → QA → merge)
- [ ] Scheduled checks
- [ ] Night shift
- [ ] Docs and examples
- [ ] First npm release

## License

[MIT](LICENSE)
