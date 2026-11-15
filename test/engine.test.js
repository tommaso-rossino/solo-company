import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DEFAULTS } from '../src/config.js';
import * as co from '../src/company.js';
import { work } from '../src/engine.js';
import { talk } from '../src/ceo.js';
import { tick, inWindow } from '../src/health.js';
import { extractJson } from '../src/util.js';

process.env.SOLO_COMPANY_HOME = (await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'sc-home-'));

process.env.SOLO_COMPANY_QUIET = '1';
process.env.SOLO_COMPANY_NO_SCHEDULE = '1';
const FAKE = fileURLToPath(new URL('./fake-agent.js', import.meta.url));
const git = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8' });

function project(over = {}) {
  const root = mkdtempSync(join(tmpdir(), 'sc-proj-'));
  git(root, 'init', '-q', '-b', 'main');
  git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
  git(root, 'config', 'user.name', 't'); git(root, 'config', 'user.email', 't@t');
  const cfg = structuredClone(DEFAULTS);
  Object.assign(cfg, {
    agent: { name: 'custom', command: `"${process.execPath}" "${FAKE}"` },
    merge: 'auto', autoPlan: false, checks: [], worktreeDir: mkdtempSync(join(tmpdir(), 'sc-wt-')),
  }, over);
  return co.createCompany(root, cfg, 'A test app');
}
const show = (root, ref) => git(root, 'show', ref);

test('request -> PM -> dev -> merge into dev -> QA -> main', async () => {
  const ctx = project({ checks: ['test -f hello.txt'] });
  co.request(ctx, 'please say hello');
  await work(ctx);
  const t = ctx.store.get('T1');
  assert.equal(t.title, 'Create hello.txt');
  assert.equal(t.state, 'done', JSON.stringify(t.history));
  assert.equal(show(ctx.root, 'main:hello.txt').stdout, 'hello\n');
  assert.ok(existsSync(join(ctx.root, 'hello.txt')), 'main checked out in the project moved forward');
  assert.match(readFileSync(join(ctx.dir, 'REQUESTS.md'), 'utf8'), /- \[x\] please say hello/);
  assert.ok(!existsSync(join(ctx.cfg.worktreeDir, 'T1')), 'worktree cleaned up');
});

test('a ticket that never produces work is retried, then suspended', async () => {
  const ctx = project();
  co.request(ctx, 'something impossible');
  await work(ctx);
  const t = ctx.store.get('T1');
  assert.equal(t.state, 'suspended');
  assert.equal(t.attempts, 2);
  assert.match(t.suspendedFor, /no changes/);
  co.resume(ctx, 'T1', 'try harder');
  assert.equal(t.state, 'todo');
  assert.equal(t.attempts, 0);
});

test('failing checks keep the ticket out of the integration branch', async () => {
  const ctx = project({ checks: ['false'] });
  co.request(ctx, 'hello');
  await work(ctx);
  assert.equal(ctx.store.get('T1').state, 'suspended');
  assert.notEqual(show(ctx.root, 'dev:hello.txt').status, 0);
});

test('QA bug becomes a fix ticket; parent closes when the fix passes', async () => {
  process.env.FAKE_QA_FAIL_ONCE = join(mkdtempSync(join(tmpdir(), 'sc-m-')), 'failed');
  try {
    const ctx = project();
    co.request(ctx, 'hello');
    await work(ctx);
    const [parent, fix] = [ctx.store.get('T1'), ctx.store.get('T2')];
    assert.equal(fix.fixes, 'T1');
    assert.equal(fix.state, 'done');
    assert.equal(parent.state, 'done');
    assert.equal(show(ctx.root, 'main:fixed.txt').stdout, 'fixed\n');
  } finally {
    delete process.env.FAKE_QA_FAIL_ONCE;
  }
});

test('visual work: mockup first, dev tickets only after approval', async () => {
  const ctx = project();
  co.request(ctx, 'a button');
  await work(ctx);
  const ux = ctx.store.get('T1'), draft = ctx.store.get('T2');
  assert.equal(ux.state, 'review');
  assert.equal(draft.state, 'draft');
  assert.ok(existsSync(join(ctx.dir, 'mockups', 'T1', 'index.html')));
  co.approve(ctx, 'T1');
  assert.equal(ux.state, 'done');
  await work(ctx);
  assert.equal(draft.state, 'done');
  assert.equal(show(ctx.root, 'main:button.txt').stdout, 'button\n');
});

test('manual merge policy leaves a tested branch', async () => {
  const ctx = project({ merge: 'manual' });
  co.request(ctx, 'hello');
  await work(ctx);
  const t = ctx.store.get('T1');
  assert.equal(t.state, 'done');
  assert.equal(show(ctx.root, 'feature/T1:hello.txt').stdout, 'hello\n');
  assert.notEqual(show(ctx.root, 'main:hello.txt').status, 0);
});

test('agent limit: tickets wait instead of failing', async () => {
  const ctx = project();
  const t = ctx.store.add({ title: 'Create hello.txt', role: 'dev', task: 'x', criteria: 'y' });
  ctx.store.save();
  process.env.FAKE_LIMIT = '1';
  try {
    const r = await work(ctx);
    assert.equal(r.limited, true);
  } finally {
    delete process.env.FAKE_LIMIT;
  }
  assert.equal(t.state, 'todo');
  assert.equal(t.attempts, 0);
});

test('budget: paid fallback until the daily cap', async () => {
  const ctx = project();
  ctx.cfg.features.budget = { enabled: true, dailyUsd: 1, usdPerRun: 1, fallbackCommand: `"${process.execPath}" "${FAKE}"` };
  ctx.cfg.agent = { name: 'custom', command: 'echo "usage limit reached"; exit 1' };
  co.request(ctx, 'hello');
  const r = await work(ctx);
  assert.equal(r.limited, true);           // first call (PM) used the only paid run
  assert.equal(ctx.store.get('T1').state, 'todo');
});

test('CEO turns words into actions', async () => {
  const ctx = project();
  const r = await talk(ctx, 'can you also do research?');
  assert.equal(r.reply, 'On it.');
  assert.deepEqual(co.pendingRequests(ctx.dir), ['hello from the ceo']);
  assert.equal(co.openCompany(ctx.root).cfg.features.research.enabled, true);
});

test('tick: red build opens one fix ticket, a busy lock is respected', async () => {
  const ctx = project({ checks: ['test -f never'] });
  git(ctx.root, 'branch', 'dev');
  ctx.cfg.features.scheduledChecks.work = 'never';
  await tick(ctx);
  await tick(ctx);
  const build = ctx.store.tickets.filter((t) => t.tag === 'build');
  assert.equal(build.length, 1);
  assert.equal(build[0].priority, 1);
});

test('night window wraps around midnight', () => {
  const at = (h, m = 0) => { const d = new Date(); d.setHours(h, m, 0, 0); return d; };
  assert.ok(inWindow('23:00', '06:00', at(2)));
  assert.ok(!inWindow('23:00', '06:00', at(12)));
  assert.ok(inWindow('09:00', '17:00', at(9, 30)));
});

test('extractJson takes the last JSON block', () => {
  assert.deepEqual(extractJson('a ```json\n{"a":1}\n``` b ```json\n{"a":2}\n```'), { a: 2 });
  assert.deepEqual(extractJson('done. {"x": {"y": 1}}'), { x: { y: 1 } });
  assert.equal(extractJson('nothing'), null);
});
