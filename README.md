# solo-company

**solo-company** turns the AI coding agent you already run on your machine (Claude Code, Codex, Gemini CLI, OpenCode, Hermes Agent, or any command that takes a prompt) into a small software company: a CEO you talk to, a PM that writes tickets, and dev, UX and QA teams that build, test and ship. You stay the one who decides.

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

Node ≥ 22 and git are required. Works on macOS, Linux and Windows; the tests run on all three on every push.

```bash
npm i -g solo-company        # or: npx solo-company <command>
cd your-project              # a git repository with at least one commit
solo-company init
```

`init` asks a few questions:

- what you are building;
- which agent to use (it detects `claude`, `codex`, `gemini`, `opencode` and `hermes`, or you give it any command);
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
solo-company dashboard --open                  # the same in a web page, with buttons
```

## Dashboard

`solo-company dashboard` serves a local web page at `http://127.0.0.1:4321`. The address it prints carries a random key; without the key the page refuses to load.

- Tickets in columns: to do, in progress, review / QA, needs you, done.
- What is waiting on you: mockups to approve, suspended tickets, questions.
- The journal, the pending requests, the goal, the agent, the teams and today's spend.
- Buttons: approve or send back a mockup, resume a suspended ticket with advice, change priority, cancel, add a request.
- It refreshes every 5 seconds and works on a phone screen.

Options: `--open` opens the browser, `--port <n>` changes the port, `--tunnel` gives a public link through [cloudflared](https://github.com/cloudflare/cloudflared) so you can follow the company from your phone. Anyone with that link can act on the company, so keep it private.

While a run is working, an action from the dashboard, the CLI or the CEO waits in `.solo-company/inbox.jsonl`. The run applies it as soon as its current step ends, so nothing it saves can overwrite your decision.

Decisions:

```bash
solo-company approve T4                        # mockup OK: its dev tickets start
solo-company reject T4 "bigger buttons"        # mockup back to UX
solo-company resume T7 "use the v2 endpoint"   # restart a suspended ticket with advice
solo-company priority T9 1                     # 1 = most urgent … 5 = when there is time
solo-company cancel T9
```

## Talk to it from any chat

The company runs as an MCP server, so the chat app you already use can drive it. Connect once:

```bash
solo-company connect claude          # Claude Code
solo-company connect codex           # Codex CLI
solo-company connect gemini          # Gemini CLI
solo-company connect opencode        # OpenCode
solo-company connect hermes          # Hermes Agent
solo-company connect cursor          # Cursor
solo-company connect claude-desktop  # Claude Desktop
solo-company connect                 # list, plus the command for any other MCP app
```

Then, in any chat, in any language:

> company, let's add a dark mode
> azienda, a che punto sei?
> company, approve T4 — the mockup is fine
> start a company in ~/projects/recipes: a recipe app for families
> start a company for a habit tracker (no folder: it goes in `~/companies/habit-tracker`)

The chat passes requests and decisions to the company. It does not build the feature itself. After a request or a decision the company starts working in a background process that outlives the chat. You can close the window.

| Tool | What it does |
|---|---|
| `company_request` | a new idea, feature or bug, in your words |
| `company_status` | tickets, what waits on you, the last events |
| `company_decide` | approve / reject a mockup, resume, priority, cancel |
| `company_ceo` | anything else: settings, the goal, questions |
| `company_create` | a new company (creates the folder and git repo if missing) |
| `company_dashboard` | starts the dashboard and returns its private link (`tunnel: true` for a phone) |
| `company_report`, `company_work`, `company_list` | 24-hour report, start working now, all companies |

Every company you create is listed in `~/.solo-company/companies.json`, so one chat can run several. When the chat is opened inside a project, that project's company is used. Otherwise you name it ("the recipes company"), or the chat asks you which one. `solo-company companies add` registers a company created before 0.3. `SOLO_COMPANY_PROJECTS` changes the default folder for new companies.

Scheduled checks use launchd on macOS, crontab on Linux and Task Scheduler on Windows.

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
