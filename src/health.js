// The scheduled tick: cheap health checks without any model call, then work if
// there is work and the shift allows it. Also writes the morning report.
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { journal, runChecks, state, exists, readJson, pidAlive, today } from './util.js';
import { pendingRequests } from './company.js';
import { work } from './engine.js';
import * as g from './git.js';

const minutes = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + (m || 0); };

export function inWindow(from, to, now = new Date()) {
  const m = now.getHours() * 60 + now.getMinutes(), a = minutes(from), b = minutes(to);
  return a <= b ? m >= a && m < b : m >= a || m < b;
}

// Deterministic repairs. Returns a list of what was fixed.
export async function checkup(ctx) {
  const { root, dir, cfg, store } = ctx;
  const fixed = [];

  const lockFile = join(dir, 'run.lock');
  if (exists(lockFile)) {
    const held = readJson(lockFile, {});
    if (held.pid && pidAlive(held.pid)) return { busy: true, fixed };
  }

  // Worktrees left behind by finished or cancelled tickets.
  const wroot = g.worktreeRoot(root, cfg);
  if (exists(wroot)) {
    for (const name of readdirSync(wroot)) {
      if (name === '_integration') continue;
      const t = store.get(name);
      if (!t || ['done', 'cancelled', 'split'].includes(t.state)) {
        g.closeTicket(root, join(wroot, name), null);
        fixed.push(`removed leftover worktree ${name}`);
      }
    }
  }

  // Is the integration build still green? Only re-run when it moved.
  if (cfg.merge === 'auto' && cfg.checks.length && g.branchExists(root, cfg.integrationBranch)) {
    const s = state(dir);
    const sha = g.head(root, cfg.integrationBranch);
    if (s.data.lastCheckedSha !== sha) {
      const res = await runChecks(cfg.checks, g.integrationDir(root, cfg));
      s.data.lastCheckedSha = sha;
      s.data.buildOk = res.ok;
      s.save();
      const open = store.open().some((t) => t.tag === 'build');
      if (!res.ok && !open) {
        const t = store.add({
          title: `Fix the failing checks on ${cfg.integrationBranch}`, role: 'dev', priority: 1, tag: 'build',
          task: `The configured checks fail on ${cfg.integrationBranch}. Find the cause and fix it. Do not delete or skip tests.`,
          criteria: `All checks pass: ${cfg.checks.join(' && ')}`,
          why: 'nothing can be delivered while the build is red',
        });
        t.lastFailure = res.report;
        store.save();
        fixed.push(`build is red: opened ${t.id}`);
      }
    }
  }
  for (const f of fixed) journal(dir, `health: ${f}`);
  return { busy: false, fixed };
}

export async function tick(ctx, now = new Date()) {
  const { dir, cfg, store } = ctx;
  const up = await checkup(ctx);
  if (up.busy) return { busy: true };

  const ns = cfg.features.nightShift;
  const night = ns.enabled && inWindow(ns.from, ns.to, now);
  const s = state(dir);
  if (night && !s.data.night?.start) { s.data.night = { start: now.toISOString() }; s.save(); }

  const policy = cfg.features.scheduledChecks.work || 'always'; // always | night | never
  const allowed = night || policy === 'always';
  const last = s.data.lastGoalPlan;
  const goalDue = cfg.autoPlan && (!last || last.added > 0 || now - new Date(last.at) > 6 * 3600 * 1000);
  const hasWork = pendingRequests(dir).length || store.ready('dev').length || store.ready('ux').length
    || store.ready('research').length || store.tickets.some((t) => t.role === 'dev' && t.state === 'review') || goalDue;

  let result = { worked: false };
  if (allowed && hasWork) {
    const teams = night ? { dev: ns.teams, ux: Math.min(cfg.teams.ux, ns.teams) } : null;
    result = { worked: true, ...(await work(ctx, { teams })) };
  }

  if (!night && s.data.night?.start) {
    const s2 = state(dir);
    const file = report(ctx, s2.data.night.start);
    s2.data.night = null;
    s2.save();
    journal(dir, `morning report: ${file}`);
  }
  return result;
}

// What happened since `since`, from the journal and the register. No model call.
export function report(ctx, since) {
  const { dir, store } = ctx;
  const from = since ? new Date(since) : new Date(Date.now() - 24 * 3600 * 1000);
  const lines = exists(join(dir, 'journal.log')) ? readFileSync(join(dir, 'journal.log'), 'utf8').split('\n') : [];
  const recent = lines.filter((l) => { const at = new Date(l.slice(0, 24)); return !isNaN(at) && at >= from; });
  const touched = (state) => store.tickets.filter((t) => t.state === state && t.history.some((h) => new Date(h.at) >= from));
  const list = (ts) => ts.map((t) => `- ${t.id}: ${t.title}${t.suspendedFor ? ` — ${t.suspendedFor}` : ''}`).join('\n') || '- none';
  const qfile = join(dir, 'QUESTIONS.md');
  const questions = exists(qfile) ? readFileSync(qfile, 'utf8').split('\n').filter((l) => l.startsWith('- ') && new Date(l.slice(2, 12)) >= new Date(from.toISOString().slice(0, 10))) : [];
  const text = `# Report ${today()}

Since ${from.toISOString()}.

## Done
${list(touched('done'))}

## Waiting for you
${list([...touched('suspended'), ...store.tickets.filter((t) => t.role === 'ux' && t.state === 'review')])}
${questions.length ? '\n' + questions.join('\n') + '\n' : ''}
## Still open
${list(store.open().filter((t) => ['todo', 'review', 'bugs_open'].includes(t.state)))}

## Journal
\`\`\`
${recent.join('\n') || '(nothing)'}
\`\`\`
`;
  mkdirSync(join(dir, 'reports'), { recursive: true });
  const file = join(dir, 'reports', `${today()}.md`);
  writeFileSync(file, text);
  return file;
}
