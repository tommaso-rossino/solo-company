// MCP server (stdio, JSON-RPC 2.0, one message per line): talk to your companies from any chat.
// Claude Code, Claude Desktop, Codex, Gemini CLI, OpenCode, Cursor, Hermes… connect with one line of config.
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as co from './company.js';
import { talk } from './ceo.js';
import { report } from './health.js';
import { list, resolveCompany, nameOf } from './registry.js';
import { startWork, startDashboard } from './background.js';
import { exists } from './util.js';
import { ADAPTERS } from './agents.js';

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version;

const INSTRUCTIONS = `solo-company runs a small AI software company inside a project: a PM writes tickets, dev/UX/QA teams build and test them in git worktrees, and the work merges per the owner's policy. The user is the owner.

Use these tools whenever the user talks to "the company" in any language ("company, let's add…", "azienda facciamo…", "empresa, …"), asks what the company is doing, or wants to decide on its work.
- A new idea, feature or bug → company_request with the user's words. The company plans and works on its own; do not do the work yourself.
- "How is it going?", "what is it doing?" → company_status.
- Approving or sending back a mockup, resuming a suspended ticket, priorities, cancelling → company_decide.
- Settings (night shift, teams, budget, research), the goal, or anything else → company_ceo with the user's words.
- A new project → company_create. If the owner gives no folder, leave path out and tell them where it went.
- "Show me" / "open the dashboard" → company_dashboard.
When there are several companies and the user does not say which, call company_list and ask. Answer the user in their language, briefly.`;

const company = { type: 'string', description: 'Company name or project path. Optional when there is only one company or the chat runs inside the project.' };
const TOOLS = [
  {
    name: 'company_list',
    description: 'List the companies on this machine with what each is doing.',
    inputSchema: { type: 'object', properties: {} },
    run: () => {
      const all = list();
      if (!all.length) return 'No company yet. Create one with company_create.';
      return all.map((c) => {
        const ctx = co.openCompany(c.root);
        const open = ctx.store.open().length;
        return `${c.name} — ${c.root} — ${co.runActive(ctx.dir) ? 'working' : 'idle'}, ${open} open ticket(s)`;
      }).join('\n');
    },
  },
  {
    name: 'company_request',
    description: 'Give the company something to do: a feature, a fix, an idea, in the owner\'s words. The PM turns it into tickets and the teams start working in the background.',
    inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'What to do, in the owner\'s words' }, company }, required: ['text'] },
    run: ({ text, company: c }) => {
      const ctx = co.openCompany(resolveCompany(c));
      co.request(ctx, text);
      return `Request added to ${nameOf(ctx.root)}. ${startWork(ctx.root)}.`;
    },
  },
  {
    name: 'company_status',
    description: 'What the company is doing: tickets by state, what waits on the owner, the last events.',
    inputSchema: { type: 'object', properties: { company } },
    run: ({ company: c }) => {
      const ctx = co.openCompany(resolveCompany(c));
      const qs = readFileSync(join(ctx.dir, 'QUESTIONS.md'), 'utf8').split('\n').filter((l) => /^\s*-\s/.test(l)).slice(-5);
      const queued = co.queuedActions(ctx.dir);
      const log = exists(join(ctx.dir, 'journal.log')) ? readFileSync(join(ctx.dir, 'journal.log'), 'utf8').trim().split('\n').slice(-8) : [];
      return [
        `${nameOf(ctx.root)} (${ctx.root}) — ${co.runActive(ctx.dir) ? 'working now' : 'idle'}`,
        '', co.summary(ctx),
        qs.length ? `\nWaiting on the owner:\n${qs.join('\n')}` : '',
        queued.length ? `\nQueued owner actions: ${queued.map((a) => `${a.id} ${a.action}`).join(', ')}` : '',
        log.length ? `\nLast events:\n${log.map((l) => l.replace(/^(\S{16})\S*\s+/, '$1  ')).join('\n')}` : '',
      ].filter(Boolean).join('\n');
    },
  },
  {
    name: 'company_decide',
    description: 'An owner decision on a ticket: approve or reject a UX mockup, resume a suspended ticket (with advice), set priority 1-5, or cancel.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['approve', 'reject', 'resume', 'priority', 'cancel'] },
        id: { type: 'string', description: 'Ticket id, e.g. T4' },
        text: { type: 'string', description: 'For reject: what to change. For resume: advice for the next try.' },
        priority: { type: 'integer', minimum: 1, maximum: 5, description: 'For priority: 1 = most urgent' },
        company,
      },
      required: ['action', 'id'],
    },
    run: ({ action, id, text, priority, company: c }) => {
      const ctx = co.openCompany(resolveCompany(c));
      if (action === 'reject' && !String(text || '').trim()) throw new Error('say what to change in the mockup');
      const r = co.ownerAction(ctx, { action, id, text, priority });
      const go = ['approve', 'reject', 'resume'].includes(action) ? ` ${startWork(ctx.root)}.` : '';
      return r.message + '.' + go;
    },
  },
  {
    name: 'company_ceo',
    description: 'Talk to the company\'s CEO in plain words for anything else: settings (night shift, teams, budget, research, schedule), changing the goal, or questions about the plan. The CEO answers and acts.',
    inputSchema: { type: 'object', properties: { message: { type: 'string' }, company }, required: ['message'] },
    run: async ({ message, company: c }) => {
      const ctx = co.openCompany(resolveCompany(c));
      const r = await talk(ctx, message);
      const acted = r.done.some((d) => /request added|approved|resumed|goal updated/.test(d));
      return [r.reply, ...r.done.map((d) => `✓ ${d}`), acted ? startWork(ctx.root) : ''].filter(Boolean).join('\n');
    },
  },
  {
    name: 'company_create',
    description: 'Start a new company for a project. Creates the folder and git repository if missing, writes the goal, and the PM plans the first tickets in the background.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Project folder, e.g. ~/projects/recipes (created if missing). Leave it out when the owner names no folder: it goes in ~/companies/<name>.' },
        name: { type: 'string', description: 'Short project name for the default folder, e.g. "recipes"' },
        goal: { type: 'string', description: 'What the owner is building, in a few sentences' },
        agent: { type: 'string', enum: Object.keys(ADAPTERS), description: 'Agent CLI the company runs on. Default: the first one installed.' },
        merge: { type: 'string', enum: ['auto', 'pr', 'manual'], description: 'auto (default): merge after checks and QA. pr: open pull requests. manual: leave branches.' },
      },
      required: ['goal'],
    },
    run: ({ path, name, goal, agent, merge }) => {
      const ctx = co.quickCreate(path, { goal, name, agent, merge });
      return `Company "${nameOf(ctx.root)}" created in ${ctx.root}, running on ${ctx.cfg.agent.name}, merge policy ${ctx.cfg.merge}. ${startWork(ctx.root)}: the PM plans the first tickets from the goal.`;
    },
  },
  {
    name: 'company_dashboard',
    description: 'Open the company\'s web dashboard (tickets, journal, buttons). Returns a private link. tunnel=true gives a public link for a phone (needs cloudflared).',
    inputSchema: { type: 'object', properties: { company, tunnel: { type: 'boolean' } } },
    run: async ({ company: c, tunnel = false }) => {
      const root = resolveCompany(c);
      const d = await startDashboard(root, { tunnel });
      return [`Dashboard of ${nameOf(root)}: ${d.local}`, d.public ? `From a phone: ${d.public}` : tunnel ? 'No public link: install cloudflared for that.' : '',
        'The link contains a private key: share it only with people who may act on the company.'].filter(Boolean).join('\n');
    },
  },
  {
    name: 'company_report',
    description: 'A report of the last 24 hours: what was done, what failed, what waits on the owner.',
    inputSchema: { type: 'object', properties: { company } },
    run: ({ company: c }) => readFileSync(report(co.openCompany(resolveCompany(c))), 'utf8'),
  },
  {
    name: 'company_work',
    description: 'Make the company work now (normally it starts by itself after a request or a decision).',
    inputSchema: { type: 'object', properties: { company } },
    run: ({ company: c }) => startWork(resolveCompany(c)) + '.',
  },
];

export async function handle(msg) {
  const { id, method, params = {} } = msg;
  const ok = (result) => ({ jsonrpc: '2.0', id, result });
  switch (method) {
    case 'initialize':
      return ok({
        protocolVersion: params.protocolVersion || '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'solo-company', version: VERSION },
        instructions: INSTRUCTIONS,
      });
    case 'ping': return ok({});
    case 'tools/list':
      return ok({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === params.name);
      if (!tool) return { jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool ${params.name}` } };
      try {
        const text = String(await tool.run(params.arguments || {}));
        return ok({ content: [{ type: 'text', text }] });
      } catch (e) {
        return ok({ content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });
      }
    }
    default:
      if (id === undefined) return null; // a notification: nothing to answer
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } };
  }
}

export function serveMcp() {
  // stdout is the protocol channel: nothing else may print there.
  process.env.SOLO_COMPANY_QUIET = '1';
  console.log = (...a) => console.error(...a);
  const rl = createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch {
      return process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }) + '\n');
    }
    const out = await handle(msg);
    if (out) process.stdout.write(JSON.stringify(out) + '\n');
  });
  return new Promise((resolve) => rl.on('close', resolve));
}
