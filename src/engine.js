// The work loop: PM plans, teams take tickets, QA tests, merges follow the policy.
import { mkdirSync, writeFileSync, readdirSync, cpSync, unlinkSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { ask } from './agents.js';
import { pmPrompt, workPrompt, qaPrompt } from './prompts.js';
import { pendingRequests, markRequests, addQuestion } from './company.js';
import { journal, extractJson, runChecks, tail, exists, pidAlive, readJson, state } from './util.js';
import * as g from './git.js';

const MAX_FIX_DEPTH = 3;

// ── lock: one runner per project ────────────────────────────────────────────
export function lock(dir) {
  const f = join(dir, 'run.lock');
  for (let i = 0; i < 2; i++) {
    try {
      const fd = openSync(f, 'wx');
      writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      closeSync(fd);
      return () => { try { unlinkSync(f); } catch {} };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const held = readJson(f, {});
      if (held.pid && pidAlive(held.pid)) return null;
      try { unlinkSync(f); } catch {}
      journal(dir, 'stale lock removed');
    }
  }
  return null;
}

function mutex() {
  let last = Promise.resolve();
  return (fn) => {
    const next = last.then(fn, fn);
    last = next.catch(() => {});
    return next;
  };
}

// ── PM ──────────────────────────────────────────────────────────────────────
const text = (v) => (Array.isArray(v) ? v.map((x) => `- ${x}`).join('\n') : String(v ?? '')).trim();

export async function plan(ctx, { fromGoal = false } = {}) {
  const { dir, cfg, store } = ctx;
  const pending = pendingRequests(dir);
  if (!pending.length && !fromGoal) return { added: 0 };
  journal(dir, pending.length ? `PM: planning ${pending.length} request(s)` : 'PM: planning next steps from the goal');
  const r = await ask(ctx, pmPrompt(ctx, pending), { cwd: ctx.root, mode: 'read' });
  if (r.limited) return { limited: true };
  const j = extractJson(r.out);
  if (!r.ok || !j || !Array.isArray(j.tickets)) {
    journal(dir, `PM answer unusable: ${tail(r.err || r.out, 300)}`);
    return { added: 0, failed: true };
  }
  const roles = ['dev', 'ux', ...(cfg.features.research.enabled ? ['research'] : [])];
  const fields = (s) => ({
    title: text(s.title), task: text(s.task), criteria: text(s.criteria), why: text(s.why),
    priority: Number(s.priority) || 3, minutes: Number(s.minutes) || 15,
  });
  const created = [];
  for (const spec of j.tickets) {
    try {
      let after = null;
      if (typeof spec.after === 'string' && /^#\d+$/.test(spec.after)) after = created[Number(spec.after.slice(1)) - 1]?.id ?? null;
      else if (spec.after && store.get(String(spec.after))) after = String(spec.after);
      const t = store.add({ ...fields(spec), role: roles.includes(spec.role) ? spec.role : 'dev', after });
      created.push(t);
      if (t.role === 'ux') for (const d of spec.drafts || []) store.add({ ...fields(d), role: 'dev', draftOf: t.id });
    } catch (e) {
      journal(dir, `PM ticket skipped: ${e.message}`);
    }
  }
  for (const q of j.questions || []) if (String(q).trim()) addQuestion(dir, String(q).trim());
  if (pending.length) markRequests(dir, pending);
  store.save();
  if (fromGoal && !pending.length) {
    const s = state(dir); s.data.lastGoalPlan = { at: new Date().toISOString(), added: created.length }; s.save();
  }
  journal(dir, `PM: ${created.length} new ticket(s)${created.length ? ': ' + created.map((t) => t.id).join(', ') : ''}`);
  return { added: created.length };
}

// ── outcomes ────────────────────────────────────────────────────────────────
function fail(ctx, t, why) {
  t.lastFailure = why;
  if (t.attempts >= ctx.cfg.limits.maxAttempts) {
    suspend(ctx, t, `failed ${t.attempts} times: ${tail(why, 200)}`);
  } else {
    ctx.store.move(t.id, 'todo', `retry: ${tail(why, 200)}`);
    journal(ctx.dir, `${t.id} failed, will retry: ${tail(why, 160)}`);
  }
  ctx.store.save();
  return 'failed';
}

function suspend(ctx, t, why) {
  t.suspendedFor = why;
  ctx.store.move(t.id, 'suspended', why);
  ctx.store.save();
  journal(ctx.dir, `${t.id} suspended: ${why} — "solo-company resume ${t.id} \\"advice\\"" when ready`);
  return 'suspended';
}

// The agent hit its limit: not the ticket's fault, put it back without counting.
function requeue(ctx, t) {
  t.attempts = Math.max(0, t.attempts - 1);
  ctx.store.move(t.id, 'todo', 'agent limit: waiting');
  ctx.store.save();
  return 'limited';
}

function fixDepth(store, t) {
  let d = 0;
  for (let x = t; x?.fixes; x = store.get(x.fixes)) d++;
  return d;
}

function closeParents(ctx, t) {
  const parent = t.fixes && ctx.store.get(t.fixes);
  if (!parent || parent.state !== 'bugs_open') return;
  const fixes = ctx.store.tickets.filter((x) => x.fixes === parent.id);
  if (fixes.every((x) => x.state === 'done' || x.state === 'cancelled')) {
    ctx.store.move(parent.id, 'done', 'all its bugs are fixed');
    journal(ctx.dir, `${parent.id} done: all its bugs are fixed`);
    closeParents(ctx, parent);
  }
}

// ── one ticket ──────────────────────────────────────────────────────────────
async function runTicket(ctx, t, lockGit) {
  const { root, dir, cfg, store } = ctx;
  store.move(t.id, 'in_progress', `attempt ${t.attempts + 1}`);
  store.save();
  journal(dir, `${t.id} [${t.role}] started: ${t.title}`);
  try {
    if (t.role === 'research') {
      const r = await ask(ctx, workPrompt(ctx, t), { cwd: root, mode: 'read' });
      if (r.limited) return requeue(ctx, t);
      const j = extractJson(r.out);
      if (!r.ok || !j?.report) return fail(ctx, t, `research answer unusable: ${tail(r.err || r.out, 500)}`);
      mkdirSync(join(dir, 'research'), { recursive: true });
      writeFileSync(join(dir, 'research', `${t.id}.md`), `# ${t.id}: ${t.title}\n\n${j.report}\n`);
      t.summary = j.summary || '';
      store.move(t.id, 'done', 'report written');
      store.save();
      journal(dir, `${t.id} done: .solo-company/research/${t.id}.md`);
      return 'done';
    }

    let wt = await lockGit(() => g.openTicket(root, cfg, t, { fresh: !!t.fresh }));
    t.fresh = false;
    if (t.role === 'dev' && g.commitsAhead(wt.path, wt.base) > 0) {
      const cu = await lockGit(() => g.catchUp(wt.path, wt.base));
      if (!cu.ok) wt = await lockGit(() => g.openTicket(root, cfg, t, { fresh: true }));
    }
    const mode = cfg.permissions === 'full' ? 'full' : 'edit';
    const r = await ask(ctx, workPrompt(ctx, t), { cwd: wt.path, mode });
    if (r.limited) return requeue(ctx, t);
    const j = extractJson(r.out) || {};
    if (j.blocker && String(j.blocker).trim()) {
      addQuestion(dir, `${t.id}: ${j.blocker}`);
      return suspend(ctx, t, `needs you: ${j.blocker}`);
    }
    if (!r.ok) return fail(ctx, t, `the agent stopped with an error: ${tail(r.err || r.out, 1500)}`);
    t.summary = String(j.summary || tail(r.out, 400));

    if (t.role === 'ux') {
      const src = join(wt.path, 'mockups', t.id);
      if (!exists(src) || !readdirSync(src).length) return fail(ctx, t, `no mockup files in mockups/${t.id}/`);
      const dest = join(dir, 'mockups', t.id);
      mkdirSync(dest, { recursive: true });
      cpSync(src, dest, { recursive: true });
      await lockGit(() => g.closeTicket(root, wt.path, wt.branch, { deleteBranch: true }));
      store.move(t.id, 'review', 'mockup ready for the owner');
      store.save();
      addQuestion(dir, `${t.id} mockup ready in .solo-company/mockups/${t.id}/ — "solo-company approve ${t.id}" or "solo-company reject ${t.id} \\"what to change\\""`);
      return 'review';
    }

    // dev: commit, catch up with the base, run the checks, deliver.
    const pre = await lockGit(() => {
      g.commitAll(wt.path, `${t.id}: ${t.title}`);
      if (!g.commitsAhead(wt.path, wt.base)) return { why: 'no changes were made' };
      const cu = g.catchUp(wt.path, wt.base);
      if (!cu.ok) { t.fresh = true; return { why: `conflicts with ${wt.base}; redo the work on top of the latest code:\n${tail(cu.err, 800)}` }; }
      return {};
    });
    if (pre.why) return fail(ctx, t, pre.why);

    const checks = await runChecks(cfg.checks, wt.path);
    if (!checks.ok) return fail(ctx, t, `checks failed:\n${checks.report}`);
    t.checkReport = tail(checks.report, 2000);

    return await lockGit(() => {
      if (cfg.merge === 'auto') {
        const idir = g.integrationDir(root, cfg);
        const m = g.mergeInto(idir, wt.branch, `Merge ${t.id}: ${t.title}`);
        if (!m.ok) { t.fresh = true; return fail(ctx, t, `merge into ${cfg.integrationBranch} failed:\n${tail(m.err, 800)}`); }
        g.closeTicket(root, wt.path, wt.branch, { deleteBranch: true });
        store.move(t.id, 'review', `merged into ${cfg.integrationBranch}`);
        journal(dir, `${t.id} merged into ${cfg.integrationBranch}, waiting for QA`);
      } else {
        if (cfg.merge === 'pr' && t.pr) g.git(wt.path, 'push');
        else if (cfg.merge === 'pr') {
          const pr = g.openPullRequest(wt.path, cfg, t);
          if (pr.ok) { t.pr = pr.url; journal(dir, `${t.id} pull request: ${pr.url}`); }
          else journal(dir, `${t.id}: could not open a pull request (${tail(pr.why, 200)}); branch ${wt.branch} is ready`);
        }
        t.branch = wt.branch;
        store.move(t.id, 'review', `ready on ${wt.branch}`);
        journal(dir, `${t.id} delivered on ${wt.branch}, waiting for QA`);
      }
      store.save();
      return 'review';
    });
  } catch (e) {
    return fail(ctx, t, `engine error: ${e.message}`);
  }
}

// ── QA ──────────────────────────────────────────────────────────────────────
function bugText(b) {
  return [b.title, b.steps && `Steps: ${b.steps}`, b.expected && `Expected: ${b.expected}`, b.actual && `Actual: ${b.actual}`].filter(Boolean).join('\n');
}

async function runQa(ctx, lockGit) {
  const { root, dir, cfg, store } = ctx;
  const waiting = store.tickets.filter((t) => t.role === 'dev' && t.state === 'review');
  if (!waiting.length || cfg.teams.qa < 1) return { ran: false };
  const auto = cfg.merge === 'auto';
  const batch = auto ? waiting.slice(0, cfg.limits.qaBatch) : waiting.slice(0, 1);
  const cwd = await lockGit(() => (auto ? g.integrationDir(root, cfg) : g.openTicket(root, cfg, batch[0]).path));
  journal(dir, `QA: testing ${batch.map((t) => t.id).join(', ')}`);
  const checks = await runChecks(cfg.checks, cwd);
  const r = await ask(ctx, qaPrompt(ctx, batch, checks.report), { cwd, mode: cfg.permissions === 'full' ? 'full' : 'read' });
  if (r.limited) return { limited: true };
  const j = extractJson(r.out);
  if (!r.ok || !Array.isArray(j?.results)) {
    journal(dir, `QA answer unusable: ${tail(r.err || r.out, 300)}`);
    return { ran: true, failed: true };
  }
  for (const t of batch) {
    const res = j.results.find((x) => String(x.id).toUpperCase() === t.id);
    if (!res) continue;
    t.qa = String(res.evidence || '');
    if (res.pass) {
      store.move(t.id, 'done', 'QA passed');
      journal(dir, `${t.id} passed QA`);
      if (!auto) {
        await lockGit(() => g.closeTicket(root, join(g.worktreeRoot(root, cfg), t.id), t.branch));
        if (cfg.merge === 'manual') addQuestion(dir, `${t.id} is ready on branch ${t.branch}: merge it when you like`);
      }
      closeParents(ctx, t);
      continue;
    }
    const bugs = (res.bugs?.length ? res.bugs : [{ title: `${t.title}: acceptance criteria not met`, actual: res.evidence }]);
    if (auto) {
      if (fixDepth(store, t) >= MAX_FIX_DEPTH) {
        store.move(t.id, 'bugs_open', 'QA failed');
        suspend(ctx, t, `still buggy after ${MAX_FIX_DEPTH} rounds of fixes: ${tail(bugText(bugs[0]), 200)}`);
        continue;
      }
      store.move(t.id, 'bugs_open', `QA found ${bugs.length} bug(s)`);
      for (const b of bugs) {
        const fix = store.add({
          title: `Fix: ${b.title || t.title}`.slice(0, 120), role: 'dev', priority: 1, fixes: t.id,
          task: `QA found a bug in ${t.id} (${t.title}).\n${bugText(b)}`,
          criteria: b.expected || t.criteria,
          why: `${t.id} cannot ship with this bug`,
        });
        journal(dir, `QA bug on ${t.id} -> ${fix.id}: ${b.title || ''}`);
      }
    } else {
      t.lastFailure = `QA failed:\n${bugs.map(bugText).join('\n\n')}`;
      if (t.attempts >= cfg.limits.maxAttempts) suspend(ctx, t, `QA failed ${t.attempts} times`);
      else { store.move(t.id, 'todo', 'QA failed'); journal(dir, `${t.id} failed QA, back to the team`); }
    }
  }
  store.save();
  if (auto && !store.tickets.some((t) => t.role === 'dev' && ['review', 'bugs_open'].includes(t.state))
      && batch.some((t) => t.state === 'done')) {
    const p = await lockGit(() => g.promote(root, cfg));
    journal(dir, p.ok ? `${cfg.mainBranch} updated to ${cfg.integrationBranch}` : `${cfg.mainBranch} not updated: ${p.why}`);
    if (!p.ok) addQuestion(dir, `${cfg.mainBranch} could not be updated: ${p.why}`);
  }
  return { ran: true };
}

// ── the loop ────────────────────────────────────────────────────────────────
function recover(ctx) {
  for (const t of ctx.store.tickets.filter((x) => x.state === 'in_progress')) {
    t.attempts = Math.max(0, t.attempts - 1);
    ctx.store.move(t.id, 'todo', 'interrupted, back in the queue');
    journal(ctx.dir, `${t.id} was interrupted: back in the queue`);
  }
  ctx.store.save();
}

export async function work(ctx, { once = false, teams = null } = {}) {
  const { dir, cfg, store, root } = ctx;
  if (!g.isRepo(root)) throw new Error('this folder is not a git repository with at least one commit');
  const release = lock(dir);
  if (!release) { journal(dir, 'another run is already working here'); return { busy: true }; }
  const stats = { tickets: 0, limited: false };
  try {
    recover(ctx);
    g.ensureIntegration(root, cfg);
    const lockGit = mutex();
    const n = { ...cfg.teams, ...(teams || {}) };
    let goalPlanned = false, pmErrors = 0, qaErrors = 0;

    for (;;) {
      let did = false;
      if (pmErrors < 2 && pendingRequests(dir).length) {
        const p = await plan(ctx);
        if (p.limited) { stats.limited = true; break; }
        if (p.failed) pmErrors++;
        did ||= p.added > 0;
      }

      const picked = [
        ...store.ready('dev').slice(0, n.dev),
        ...store.ready('ux').slice(0, n.ux),
        ...store.ready('research').slice(0, 1),
      ];
      if (picked.length) {
        const out = await Promise.all(picked.map((t) => runTicket(ctx, t, lockGit)));
        stats.tickets += picked.length;
        did = true;
        if (out.includes('limited')) { stats.limited = true; break; }
      }

      const waiting = store.tickets.filter((t) => t.role === 'dev' && t.state === 'review').length;
      const idle = !store.ready('dev').length && !store.ready('ux').length;
      if (waiting && qaErrors < 2 && (waiting >= cfg.limits.qaBatch || idle)) {
        const q = await runQa(ctx, lockGit);
        if (q.limited) { stats.limited = true; break; }
        if (q.failed) qaErrors++;
        did ||= q.ran;
      }

      if (!did) {
        const busy = store.tickets.some((t) => ['todo', 'in_progress', 'review'].includes(t.state) && t.role !== 'ux');
        if (cfg.autoPlan && !goalPlanned && !busy && pmErrors < 2) {
          goalPlanned = true;
          const p = await plan(ctx, { fromGoal: true });
          if (p.limited) { stats.limited = true; break; }
          if (p.added) continue;
        }
        break;
      }
      if (once) break;
    }
  } finally {
    release();
  }
  journal(dir, `run finished: ${stats.tickets} ticket run(s)${stats.limited ? ', stopped at the agent limit' : ''}`);
  return stats;
}
