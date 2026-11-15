# solo-company

**solo-company** turns the AI coding agent you already run on your machine (Claude Code, Codex, Gemini CLI, or any command that takes a prompt) into a small software company: a CEO you talk to, a PM that writes tickets, and dev, UX and QA teams that build, test and ship. You stay the one who decides.

It grew out of a setup used daily to build a real app with one human in the loop. This is the generic, open version of that engine. It contains no project-specific rules, paths or accounts.

```
        You
         │  ideas, approvals, "enable the night shift"
         ▼
        CEO ──────────────── talks to you, changes settings
         │
         ▼
        PM  ──────────────── turns requests and the goal into small tickets
         │
   ┌─────┼─────────┐
   ▼     ▼         ▼
  Dev   UX        QA  ────── each ticket in its own git worktree
   │               │
   └──► review ◄───┘ ─────── merge per your policy
```

- **No server, no account, no database.** State is plain files in `.solo-company/` inside your project. Zero dependencies.
- **Subscription first.** Agents run through the CLI you are logged into. A paid fallback with a daily cap is optional.
- **You are asked only about money, accounts and real choices.** Everything else is retried, fixed or split by the company.
- **Design before code.** Visual work starts as a UX mockup. The dev tickets for it wait until you approve the mockup.
- **Nothing reaches `main` untested.** Your checks run on every delivery, and QA tests every ticket before it moves to `main`.

## Install

Node ≥ 22 and git are required.

```bash
npm i -g solo-company        # or: npx solo-company <command>
cd your-project              # a git repository with at least one commit
solo-company init
```

`init` asks a few questions:

- what you are building;
- which agent to use (it detects `claude`, `codex` and `gemini`, or you give it any command);
- whether agents may run commands;
- the merge policy;
- your checks (for example `npm test`);
- how many teams to run;
- which optional features to turn on.

At the end the PM can write the first tickets right away.

## Use

```bash
solo-company ceo "what's the plan?"            # talk in plain words; the CEO answers and acts
solo-company request "add a dark mode"         # straight to the PM
solo-company run                               # work until the queue is empty
solo-company run --watch 10                    # keep working, check for new work every 10 min
solo-company status                            # tickets by state
solo-company questions                         # what the company is waiting on you for
```

Decisions:

```bash
solo-company approve T4                        # mockup OK: its dev tickets start
solo-company reject T4 "bigger buttons"        # mockup back to UX
solo-company resume T7 "use the v2 endpoint"   # restart a suspended ticket with advice
solo-company priority T9 1                     # 1 = most urgent … 5 = when there is time
solo-company cancel T9
```

## How a ticket flows

1. **PM**: reads `GOAL.md`, `REQUESTS.md` and the open tickets. It writes small tickets (at most 30 minutes each by default), each with acceptance criteria, a reason and a priority. With `autoPlan` on, the PM plans the next steps from the goal whenever the queue is empty.
2. **Dev**: works in a worktree of its own on `feature/<id>`, outside your project folder. The engine commits the work and brings it up to date with the base branch. Then it runs your checks.
3. **Failures**: the ticket is retried with the error as context. After `maxAttempts` failures (2 by default) it is suspended and you are told why.
4. **Merge policy**:
   - `auto`: merges into `dev`. QA tests in batches. Every bug becomes a priority-1 fix ticket. When everything has passed, `main` fast-forwards to `dev`. Your uncommitted work is never touched.
   - `pr`: pushes the branch and opens a pull request with `gh`. QA tests the branch.
   - `manual`: QA tests the branch and leaves it for you to merge.
5. **Usage limit**: when the agent hits it, tickets go back in the queue without counting as a failed attempt. The teams wait.

## Optional features

Turn a feature on with `solo-company enable <feature> [key=value …]`, or just ask the CEO.

| Feature | What it does | Settings |
|---|---|---|
| `scheduledChecks` | A launchd job (macOS) or cron job (Linux) runs `solo-company tick`: health checks without a model call (leftover worktrees, stale locks, a red `dev` build gets a fix ticket), then work if there is any | `everyMinutes=30`, `work=always\|night\|never` |
| `nightShift` | A reduced team works in a time window and leaves a morning report in `.solo-company/reports/` | `from=01:00 to=06:00 teams=1` |
| `budget` | When the subscription runs out, uses a paid command until a daily cap | `dailyUsd=5 usdPerRun=0.5 fallbackCommand="…"` |
| `research` | The PM may open research tickets (competitors, libraries, prices); reports land in `.solo-company/research/` | — |

```bash
solo-company enable nightShift from=00:30 to=06:30
solo-company ceo "enable the night shift, but only one team"
solo-company teams dev=2
```

The scheduled job runs from wherever solo-company is installed. Use a global install (`npm i -g`) rather than `npx` for it.

## Files

```
.solo-company/
├── config.json     settings (solo-company config)
├── GOAL.md         what you are building — edit any time
├── REQUESTS.md     your inbox to the PM ("- [ ] …" pending, "- [x] …" planned)
├── QUESTIONS.md    what the company needs from you
├── tickets.json    the ticket register
├── roles/*.md      the role prompts (ceo, pm, dev, ux, qa, research) — edit them
├── journal.log     one line per event (solo-company log)
├── mockups/  research/  reports/
```

You can commit `.solo-company/` to share the company with your repository. Its own `.gitignore` keeps the machine-local files out.

## Permissions

- **edit** (default): agents may only edit files in their worktree. The engine runs your checks itself.
- **full**: agents may also run commands in their worktree, for example to run tests while they work. For Claude Code this uses `--dangerously-skip-permissions`. Choose it only if you accept that.

The PM, QA (in edit mode), CEO and research roles never change files.

## Custom agents

Any command works. It reads the prompt on stdin and prints the answer, ending with the JSON object the prompt asks for. The mode is passed as `$SOLO_COMPANY_MODE` (`read`, `edit` or `full`).

```json
{ "agent": { "name": "custom", "command": "my-agent --quiet" } }
```

More detail: [docs/architecture.md](docs/architecture.md).

## License

[MIT](LICENSE)
