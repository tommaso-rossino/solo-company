// The company in a project: create/open it, and the owner's actions on it.
import { mkdirSync, writeFileSync, copyFileSync, readdirSync, readFileSync, appendFileSync, renameSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, dirOf, load, save } from './config.js';
import { TicketStore } from './tickets.js';
import { journal, exists, readJson, pidAlive } from './util.js';
import { register } from './registry.js';
import { detect, ADAPTERS } from './agents.js';
import * as g from './git.js';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import * as schedule from './schedule.js';

const TEMPLATES = join(dirname(fileURLToPath(import.meta.url)), '..', 'templates');

export function createCompany(root, cfg, goal) {
  const dir = dirOf(root);
  if (exists(join(dir, 'config.json'))) throw new Error('.solo-company/ already exists here');
  mkdirSync(join(dir, 'roles'), { recursive: true });
  save(cfg, root);
  writeFileSync(join(dir, 'GOAL.md'), `# Goal\n\n${goal || '(describe what you are building)'}\n`);
  writeFileSync(join(dir, 'REQUESTS.md'), '# Requests\n\nOne request per line. The PM turns them into tickets.\n\n');
  writeFileSync(join(dir, 'QUESTIONS.md'), '# Questions for the owner\n\nThe company writes here only about money, accounts and real choices.\n\n');
  writeFileSync(join(dir, 'tickets.json'), '[]\n');
  // Engine-local files never belong in the repository.
  writeFileSync(join(dir, '.gitignore'), 'run.lock\nstate.json\n*.tmp\ntick.log\ninbox.jsonl\nrun.log\ndashboard.json\ndashboard.log\n');
  for (const f of readdirSync(join(TEMPLATES, 'roles'))) copyFileSync(join(TEMPLATES, 'roles', f), join(dir, 'roles', f));
  journal(dir, 'company created');
  if (process.env.SOLO_COMPANY_NO_REGISTRY !== '1') register(root);
  return openCompany(root);
}

// Create a company without questions (from a chat): the folder and git are made if missing.
export function quickCreate(path, { goal, agent, agentCommand, merge = 'auto', checks } = {}) {
  if (!String(goal || '').trim()) throw new Error('say what the project is: the goal becomes GOAL.md');
  const root = resolve(String(path || '').replace(/^~(?=$|\/)/, homedir()));
  if (!path) throw new Error('say where the project lives, e.g. ~/projects/recipes');
  if (exists(join(root, '.solo-company', 'config.json'))) throw new Error(`${root} already has a company`);
  mkdirSync(root, { recursive: true });
  const run = (...a) => spawnSync('git', a, { cwd: root, encoding: 'utf8' });
  if (!g.isRepo(root)) {
    if (run('rev-parse', '--git-dir').status !== 0) run('init', '-q', '-b', 'main');
    const who = run('config', 'user.email').status === 0 ? [] : ['-c', 'user.name=solo-company', '-c', 'user.email=solo-company@localhost'];
    run(...who, 'commit', '-q', '--allow-empty', '-m', 'Start');
    if (!g.isRepo(root)) throw new Error(`could not set up git in ${root}`);
  }
  const cfg = structuredClone(DEFAULTS);
  if (agentCommand) cfg.agent = { name: 'custom', command: agentCommand };
  else {
    const name = agent || detect()[0]?.name;
    if (!name) throw new Error(`no agent CLI found (${Object.keys(ADAPTERS).join(', ')}): install one or pass agentCommand`);
    if (!ADAPTERS[name]) throw new Error(`unknown agent "${name}" (${Object.keys(ADAPTERS).join(', ')})`);
    cfg.agent = { name };
  }
  cfg.merge = ['auto', 'pr', 'manual'].includes(merge) ? merge : 'auto';
  cfg.mainBranch = g.currentBranch(root) || 'main';
  if (checks) cfg.checks = [].concat(checks).filter(Boolean);
  else {
    const pkg = readJson(join(root, 'package.json'), null);
    if (pkg?.scripts?.test && !/no test specified/.test(pkg.scripts.test)) cfg.checks = ['npm test'];
  }
  return createCompany(root, cfg, String(goal).trim());
}

export function openCompany(root = process.cwd()) {
  const cfg = load(root);
  if (!cfg) throw new Error('no company here yet: run "solo-company init"');
  const dir = dirOf(root);
  return { root, dir, cfg, store: new TicketStore(dir) };
}

export const saveConfig = (ctx) => save(ctx.cfg, ctx.root);

// REQUESTS.md: "- [ ] text" is pending, "- [x] text" was handed to the PM.
export function pendingRequests(dir) {
  const f = join(dir, 'REQUESTS.md');
  if (!exists(f)) return [];
  return readFileSync(f, 'utf8').split('\n')
    .map((l) => l.match(/^\s*-\s*\[ \]\s*(.+)$/)?.[1]?.trim())
    .filter(Boolean);
}

export function markRequests(dir, done) {
  const f = join(dir, 'REQUESTS.md');
  const set = new Set(done);
  const text = readFileSync(f, 'utf8').split('\n').map((l) => {
    const m = l.match(/^(\s*-\s*)\[ \](\s*)(.+)$/);
    return m && set.has(m[3].trim()) ? `${m[1]}[x]${m[2]}${m[3]}` : l;
  }).join('\n');
  writeFileSync(f, text);
}

export function addQuestion(dir, text) {
  appendFileSync(join(dir, 'QUESTIONS.md'), `- ${new Date().toISOString().slice(0, 10)}: ${text}\n`);
  journal(dir, `question for you: ${text}`);
}

export function request(ctx, text) {
  text = String(text || '').trim().replace(/\s*\n\s*/g, ' ');
  if (!text) throw new Error('write the request, e.g. solo-company request "add dark mode"');
  appendFileSync(join(ctx.dir, 'REQUESTS.md'), `- [ ] ${text}\n`);
  journal(ctx.dir, `request: ${text}`);
}

function need(ctx, id) {
  const t = ctx.store.get(String(id || '').toUpperCase());
  if (!t) throw new Error(`no ticket ${id}`);
  return t;
}

// Approve a UX mockup: the ticket is done and its dev drafts become real tickets.
export function approve(ctx, id) {
  const t = need(ctx, id);
  if (t.role !== 'ux') throw new Error(`${t.id} is not a UX ticket`);
  if (t.state === 'review') ctx.store.move(t.id, 'done', 'mockup approved by the owner');
  const released = ctx.store.approveMockup(t.id);
  ctx.store.save();
  journal(ctx.dir, `mockup ${t.id} approved, ${released.length} dev ticket(s) released`);
  return released;
}

// Send a mockup back with the owner's feedback.
export function reject(ctx, id, feedback) {
  const t = need(ctx, id);
  if (t.role !== 'ux' || t.state !== 'review') throw new Error(`${t.id} is not a mockup waiting for approval`);
  t.lastFailure = `The owner asked for changes: ${feedback || '(no details)'}`;
  t.attempts = 0;
  ctx.store.move(t.id, 'todo', 'mockup sent back by the owner');
  ctx.store.save();
  journal(ctx.dir, `mockup ${t.id} sent back`);
}

export function resume(ctx, id, advice = '') {
  const t = need(ctx, id);
  if (t.state !== 'suspended') throw new Error(`${t.id} is not suspended (it is ${t.state})`);
  t.attempts = 0;
  if (advice) t.lastFailure = `Advice from the owner: ${advice}\n\n${t.lastFailure || ''}`;
  ctx.store.move(t.id, 'todo', 'resumed by the owner');
  ctx.store.save();
  journal(ctx.dir, `${t.id} resumed`);
}

export function cancel(ctx, id) {
  const t = need(ctx, id);
  ctx.store.move(t.id, 'cancelled', 'cancelled by the owner');
  for (const d of ctx.store.tickets.filter((x) => x.draftOf === t.id && x.state === 'draft')) ctx.store.move(d.id, 'cancelled', `${t.id} cancelled`);
  ctx.store.save();
  journal(ctx.dir, `${t.id} cancelled`);
}

export function setPriority(ctx, id, p) {
  const t = need(ctx, id);
  t.priority = Math.min(5, Math.max(1, Number(p) || 3));
  ctx.store.log(t, `priority ${t.priority}`);
  ctx.store.save();
  journal(ctx.dir, `${t.id} priority ${t.priority}`);
}

// ── owner actions while a run is working ────────────────────────────────────
// A run keeps the ticket register in memory and saves it often: a change written
// to disk meanwhile would be lost. So, while another process holds the run lock,
// owner actions wait in inbox.jsonl and the run applies them between steps.
const ACTIONS = {
  approve: (ctx, a) => `${a.id} approved: ${approve(ctx, a.id).length} ticket(s) released`,
  reject: (ctx, a) => { reject(ctx, a.id, a.text); return `${a.id} sent back to UX`; },
  resume: (ctx, a) => { resume(ctx, a.id, a.text || ''); return `${a.id} is back in the queue`; },
  cancel: (ctx, a) => { cancel(ctx, a.id); return `${a.id} cancelled`; },
  priority: (ctx, a) => { setPriority(ctx, a.id, a.priority); return `${a.id} priority ${need(ctx, a.id).priority}`; },
};

export function runActive(dir) {
  const held = readJson(join(dir, 'run.lock'), null);
  return Boolean(held?.pid && held.pid !== process.pid && pidAlive(held.pid));
}

export function ownerAction(ctx, a) {
  if (!ACTIONS[a.action]) throw new Error(`unknown action "${a.action}"`);
  const t = need(ctx, a.id);
  if (runActive(ctx.dir)) {
    appendFileSync(join(ctx.dir, 'inbox.jsonl'), JSON.stringify({ ...a, id: t.id, at: new Date().toISOString() }) + '\n');
    journal(ctx.dir, `${t.id}: ${a.action} queued for the running company`);
    return { queued: true, message: `${t.id}: ${a.action} queued — the company applies it when its current step ends` };
  }
  return { queued: false, message: ACTIONS[a.action](ctx, { ...a, id: t.id }) };
}

export function queuedActions(dir) {
  const f = join(dir, 'inbox.jsonl');
  if (!exists(f)) return [];
  return readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

// Called by the run that holds the lock, on its own in-memory register.
export function applyInbox(ctx) {
  const f = join(ctx.dir, 'inbox.jsonl');
  if (!exists(f)) return 0;
  const taken = `${f}.${process.pid}.tmp`;
  try { renameSync(f, taken); } catch { return 0; }
  const list = readFileSync(taken, 'utf8').split('\n').filter(Boolean);
  unlinkSync(taken);
  for (const line of list) {
    try {
      const a = JSON.parse(line);
      journal(ctx.dir, ACTIONS[a.action](ctx, a));
    } catch (e) {
      journal(ctx.dir, `owner action skipped: ${e.message}`);
    }
  }
  return list.length;
}

export function setTeams(ctx, teams) {
  for (const k of ['dev', 'ux', 'qa']) if (teams[k] !== undefined) ctx.cfg.teams[k] = Math.max(0, Math.min(8, Number(teams[k]) || 0));
  saveConfig(ctx);
  journal(ctx.dir, `teams: ${JSON.stringify(ctx.cfg.teams)}`);
}

export function setGoal(ctx, text) {
  writeFileSync(join(ctx.dir, 'GOAL.md'), `# Goal\n\n${String(text).trim()}\n`);
  journal(ctx.dir, 'goal updated');
}

// Turn an optional feature on or off. Settings are merged into the feature.
export function setFeature(ctx, name, enabled, settings = {}) {
  const f = ctx.cfg.features;
  if (!(name in DEFAULTS.features)) throw new Error(`unknown feature "${name}" (features: ${Object.keys(DEFAULTS.features).join(', ')})`);
  const allowed = Object.keys(DEFAULTS.features[name]);
  for (const [k, v] of Object.entries(settings || {})) {
    if (!allowed.includes(k)) throw new Error(`${name} has no setting "${k}" (settings: ${allowed.filter((x) => x !== 'enabled').join(', ')})`);
    f[name][k] = v;
  }
  f[name].enabled = enabled;
  // The night shift and the budget run inside the scheduled job.
  if (enabled && name === 'nightShift') f.scheduledChecks.enabled = true;
  saveConfig(ctx);
  journal(ctx.dir, `${name} ${enabled ? 'enabled' : 'disabled'}${Object.keys(settings || {}).length ? ' ' + JSON.stringify(settings) : ''}`);
  if (name === 'scheduledChecks' || (name === 'nightShift' && enabled)) {
    const r = f.scheduledChecks.enabled ? schedule.install(ctx) : schedule.remove(ctx);
    journal(ctx.dir, r);
  }
}

export function summary(ctx) {
  const { store, dir } = ctx;
  const by = Object.groupBy(store.tickets, (t) => t.state);
  const lines = [];
  for (const state of ['in_progress', 'todo', 'review', 'bugs_open', 'suspended', 'draft', 'done', 'cancelled', 'split']) {
    const list = by[state];
    if (!list?.length) continue;
    lines.push(`${state} (${list.length})`);
    const shown = state === 'done' || state === 'cancelled' ? list.slice(-5) : list;
    for (const t of shown) {
      let note = '';
      if (state === 'suspended') note = `  — ${t.suspendedFor || ''}`;
      if (state === 'review' && t.role === 'ux') note = `  — mockup: .solo-company/mockups/${t.id}/ (approve or reject)`;
      if (t.pr) note += `  — ${t.pr}`;
      lines.push(`  ${t.id}  [${t.role}] P${t.priority}  ${t.title}${note}`);
    }
    if (shown.length < list.length) lines.push(`  … and ${list.length - shown.length} more`);
  }
  const pending = pendingRequests(dir);
  if (pending.length) lines.push(`requests waiting for the PM (${pending.length})`, ...pending.map((r) => `  - ${r}`));
  return lines.join('\n') || 'No tickets yet.';
}
