import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULTS, dirOf, load } from './config.js';
import { detect } from './agents.js';
import * as co from './company.js';
import { work, plan } from './engine.js';
import { tick, report, checkup } from './health.js';
import { talk } from './ceo.js';
import * as schedule from './schedule.js';
import * as g from './git.js';
import { exists } from './util.js';

const HELP = `solo-company — your local AI coding agent as a small software company

Start
  init                          set up .solo-company/ in this git project
  ceo "message"                 talk to the CEO in plain words ("enable the night shift")
  request "text"                add a request for the PM

Work
  run [--once] [--watch [min]]  PM plans, teams build, QA tests, merges per policy
  plan                          only let the PM turn requests into tickets
  status                        tickets by state
  log [n]                       last n journal lines (default 30)
  questions                     what the company is waiting on you for
  report                        write a report of the last 24 hours

Decide
  approve <id>                  approve a UX mockup: its dev tickets start
  reject <id> "what to change"  send a mockup back
  resume <id> ["advice"]        restart a suspended ticket
  cancel <id>                   cancel a ticket
  priority <id> <1-5>           1 = most urgent

Settings
  enable <feature> [k=v …]      ${Object.keys(DEFAULTS.features).join(', ')}
  disable <feature>
  teams dev=2 ux=1 qa=1         how many teams work in parallel
  config                        show the settings
  schedule install|remove|status
  tick                          what the scheduled job runs: health check, then work
`;

export async function main(argv) {
  const [cmd, ...rest] = argv;
  const flag = (f) => rest.includes(f);
  switch (cmd) {
    case 'init': return init();
    case 'status': return console.log(co.summary(co.openCompany()));
    case 'request': co.request(co.openCompany(), rest.join(' ')); return console.log('Request added. The PM will turn it into tickets.');
    case 'plan': { const r = await plan(co.openCompany()); return console.log(r.limited ? 'The agent is at its limit: try later.' : `${r.added} ticket(s) added.`); }
    case 'run': return run(rest, flag);
    case 'approve': { const r = co.approve(co.openCompany(), rest[0]); return console.log(`${rest[0]} approved: ${r.length} ticket(s) ready for the teams.`); }
    case 'reject': co.reject(co.openCompany(), rest[0], rest.slice(1).join(' ')); return console.log('Sent back to UX.');
    case 'resume': co.resume(co.openCompany(), rest[0], rest.slice(1).join(' ')); return console.log(`${rest[0]} is back in the queue.`);
    case 'cancel': co.cancel(co.openCompany(), rest[0]); return console.log(`${rest[0]} cancelled.`);
    case 'priority': co.setPriority(co.openCompany(), rest[0], rest[1]); return;
    case 'ceo': case 'ask': case 'tell': {
      const r = await talk(co.openCompany(), rest.join(' '));
      console.log(`\n${r.reply}`);
      for (const d of r.done) console.log(`  ✓ ${d}`);
      return;
    }
    case 'enable': case 'disable': {
      const ctx = co.openCompany();
      co.setFeature(ctx, rest[0], cmd === 'enable', parseSettings(rest.slice(1)));
      return console.log(JSON.stringify({ [rest[0]]: ctx.cfg.features[rest[0]] }, null, 2));
    }
    case 'teams': { const ctx = co.openCompany(); co.setTeams(ctx, parseSettings(rest)); return; }
    case 'config': return console.log(JSON.stringify(co.openCompany().cfg, null, 2));
    case 'schedule': {
      const ctx = co.openCompany();
      const sub = rest[0] || 'status';
      if (!['install', 'remove', 'status'].includes(sub)) throw new Error('schedule install | remove | status');
      if (sub !== 'status') { ctx.cfg.features.scheduledChecks.enabled = sub === 'install'; co.saveConfig(ctx); }
      return console.log(schedule[sub](ctx));
    }
    case 'tick': { const r = await tick(co.openCompany()); if (r.busy) console.log('a run is already working'); return; }
    case 'checkup': { const r = await checkup(co.openCompany()); return console.log(r.fixed.join('\n') || 'all good'); }
    case 'report': return console.log(report(co.openCompany()));
    case 'log': {
      const f = join(dirOf(), 'journal.log');
      if (!exists(f)) return console.log('No journal yet.');
      return console.log(readFileSync(f, 'utf8').trim().split('\n').slice(-(Number(rest[0]) || 30)).join('\n'));
    }
    case 'questions': {
      co.openCompany();
      return console.log(readFileSync(join(dirOf(), 'QUESTIONS.md'), 'utf8').trim());
    }
    case undefined: case 'help': case '--help': case '-h': return console.log(HELP);
    case '--version': case '-v': return console.log(JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version);
    default: throw new Error(`unknown command "${cmd}" (try: solo-company help)`);
  }
}

function parseSettings(args) {
  const out = {};
  for (const a of args) {
    const i = a.indexOf('=');
    if (i < 1) throw new Error(`expected key=value, got "${a}"`);
    const k = a.slice(0, i), v = a.slice(i + 1);
    out[k] = v === 'true' ? true : v === 'false' ? false : v !== '' && !isNaN(v) && !/^\d\d:\d\d$/.test(v) ? Number(v) : v;
  }
  return out;
}

async function run(rest, flag) {
  const ctx = co.openCompany();
  if (!flag('--watch')) {
    await work(ctx, { once: flag('--once') });
    return console.log('\n' + co.summary(ctx));
  }
  const n = Number(rest[rest.indexOf('--watch') + 1]) || 10;
  console.log(`Working; checking for new work every ${n} min. Ctrl+C to stop.`);
  for (;;) {
    const fresh = co.openCompany(); // pick up edits made meanwhile
    await work(fresh);
    await new Promise((r) => setTimeout(r, n * 60 * 1000));
  }
}

async function init(root = process.cwd()) {
  if (load(root)) throw new Error('.solo-company/ already exists here');
  if (!g.isRepo(root)) throw new Error('run this inside a git repository with at least one commit (git init && git commit --allow-empty -m init)');
  // Line iterator instead of rl.question(): also works when answers are piped in.
  const rl = createInterface({ input: process.stdin });
  const lines = rl[Symbol.asyncIterator]();
  const ask = async (q, def = '') => {
    process.stdout.write(def ? `${q} (${def}): ` : `${q}: `);
    const r = await lines.next();
    return (r.done ? '' : r.value).trim() || def;
  };
  const yes = async (q, def) => /^y/i.test(await ask(`${q} [y/n]`, def ? 'y' : 'n'));
  let ctx;
  try {
    const cfg = structuredClone(DEFAULTS);
    console.log('solo-company setup — every answer can be changed later (solo-company config / ceo).\n');
    const goal = await ask('What are you building? Describe it in a few sentences');

    const found = detect();
    const choices = [...found.map((a) => a.name), 'custom'];
    console.log(found.length ? `Agents found: ${found.map((a) => `${a.name} (${a.label})`).join(', ')}` : 'No known agent CLI found on PATH (claude, codex, gemini).');
    let pick = await ask(`Agent the company runs on [${choices.join('/')}]`, choices[0]);
    if (!choices.includes(pick)) pick = 'custom';
    cfg.agent = pick === 'custom'
      ? { name: 'custom', command: await ask('Command that reads a prompt on stdin and prints the answer') }
      : { name: pick };

    cfg.permissions = (await yes('Let agents run commands (tests, builds) inside their own worktree? Otherwise they only edit files', false)) ? 'full' : 'edit';

    cfg.mainBranch = g.currentBranch(root) || 'main';
    console.log(`\nMerge policy for finished tickets:\n  auto   — merge into "${cfg.integrationBranch}" after checks, move "${cfg.mainBranch}" forward after QA\n  pr     — push the branch and open a pull request (needs a remote and gh)\n  manual — leave the branch, you merge`);
    const merge = await ask('Merge policy [auto/pr/manual]', 'auto');
    cfg.merge = ['auto', 'pr', 'manual'].includes(merge) ? merge : 'auto';

    const guess = exists(join(root, 'package.json')) && JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts?.test ? 'npm test' : '';
    const checks = await ask('Checks every delivery must pass, comma separated (empty for none)', guess);
    cfg.checks = checks ? checks.split(',').map((s) => s.trim()).filter(Boolean) : [];

    cfg.teams.dev = Math.max(1, Number(await ask('How many dev teams in parallel', '1')) || 1);
    cfg.autoPlan = await yes('When the queue is empty, let the PM plan the next steps from your goal', true);

    ctx = co.createCompany(root, cfg, goal);

    if (await yes('\nOptional: run on a schedule (health check every 30 min, work continues without you)', false)) {
      co.setFeature(ctx, 'scheduledChecks', true);
      if (await yes('Optional: night shift (01:00–06:00, one team, morning report)', false)) co.setFeature(ctx, 'nightShift', true);
    }
    const first = await yes(`\nLet the PM write the first tickets now with ${cfg.agent.name}`, true);
    rl.close();
    if (first) {
      const r = await plan(ctx, { fromGoal: true });
      if (r.added) console.log('\n' + co.summary(ctx));
    }
  } finally {
    rl.close();
  }
  console.log(`\nDone. Next:
  solo-company run                       let the company work
  solo-company ceo "what's the plan?"    talk to it
  Files: .solo-company/GOAL.md, REQUESTS.md, roles/*.md — edit them any time.`);
}
