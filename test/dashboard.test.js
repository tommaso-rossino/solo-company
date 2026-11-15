import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DEFAULTS } from '../src/config.js';
import * as co from '../src/company.js';
import { createDashboard } from '../src/dashboard.js';

process.env.SOLO_COMPANY_QUIET = '1';
process.env.SOLO_COMPANY_NO_SCHEDULE = '1';

function project() {
  const root = mkdtempSync(join(tmpdir(), 'sc-dash-'));
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: root });
  const ctx = co.createCompany(root, structuredClone(DEFAULTS), 'A test app');
  ctx.store.add({ title: 'Login screen mockup', role: 'ux', task: 'draw it', criteria: 'a mockup' });
  ctx.store.add({ title: 'Build login', role: 'dev', task: 'code it', criteria: 'works', draftOf: 'T1' });
  ctx.store.add({ title: 'Fix footer', role: 'dev', task: 'fix', criteria: 'fixed' });
  ctx.store.move('T1', 'in_progress'); ctx.store.move('T1', 'review', 'mockup ready');
  ctx.store.save();
  mkdirSync(join(ctx.dir, 'mockups', 'T1'), { recursive: true });
  writeFileSync(join(ctx.dir, 'mockups', 'T1', 'index.html'), '<h1>mock</h1>');
  return ctx;
}

async function start(root) {
  const { server, key } = createDashboard(root, { key: 'secret-key' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, key, base };
}

test('dashboard: key required, state, actions, mockups', async () => {
  const ctx = project();
  const { server, key, base } = await start(ctx.root);
  try {
    assert.equal((await fetch(`${base}/`)).status, 401);
    assert.equal((await fetch(`${base}/?k=wrong`)).status, 401);
    const page = await fetch(`${base}/?k=${key}`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<title>solo-company<\/title>/);

    const s = await (await fetch(`${base}/api/state?k=${key}`)).json();
    assert.equal(s.tickets.length, 3);
    assert.deepEqual(s.tickets[0].mockups, ['index.html']);
    assert.equal(s.running, false);

    const post = (body, headers = { 'x-key': key }) => fetch(`${base}/api/action?k=${key}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    assert.equal((await post({ action: 'cancel', id: 'T3' }, {})).status, 403, 'a cross-site form cannot act');

    const r1 = await (await post({ action: 'approve', id: 'T1' })).json();
    assert.equal(r1.ok, true, JSON.stringify(r1));
    assert.equal(co.openCompany(ctx.root).store.get('T2').state, 'todo');
    assert.equal((await (await post({ action: 'priority', id: 'T3', priority: 1 })).json()).ok, true);
    assert.equal(co.openCompany(ctx.root).store.get('T3').priority, 1);
    assert.equal((await (await post({ action: 'request', text: 'add dark mode' })).json()).ok, true);
    assert.deepEqual(co.pendingRequests(ctx.dir), ['add dark mode']);
    const bad = await post({ action: 'resume', id: 'T3' });
    assert.equal(bad.status, 400);

    const mock = await fetch(`${base}/m/${key}/T1/index.html`);
    assert.equal(mock.status, 200);
    assert.match(mock.headers.get('content-security-policy'), /sandbox/);
    assert.equal((await fetch(`${base}/m/wrong/T1/index.html`)).status, 401);
    assert.equal((await fetch(`${base}/m/${key}/..%2F..%2Fconfig.json`)).status, 404);
    assert.equal((await fetch(`${base}/m/${key}/T1/..%2F..%2Ftickets.json`)).status, 404);
  } finally {
    server.close();
  }
});

test('owner actions wait in the inbox while a run is working', () => {
  const ctx = project();
  // Another live process holds the run lock.
  writeFileSync(join(ctx.dir, 'run.lock'), JSON.stringify({ pid: process.ppid }));
  const r = co.ownerAction(ctx, { action: 'priority', id: 't3', priority: 1 });
  assert.equal(r.queued, true);
  assert.equal(co.openCompany(ctx.root).store.get('T3').priority, 3, 'not written behind the run');
  assert.deepEqual(co.queuedActions(ctx.dir).map((a) => a.id), ['T3']);

  // The run applies it on its own register.
  assert.equal(co.applyInbox(ctx), 1);
  assert.equal(ctx.store.get('T3').priority, 1);
  assert.equal(existsSync(join(ctx.dir, 'inbox.jsonl')), false);

  // Without a run, actions apply at once.
  writeFileSync(join(ctx.dir, 'run.lock'), JSON.stringify({ pid: 999999 }));
  assert.equal(co.ownerAction(ctx, { action: 'cancel', id: 'T3' }).queued, false);
  assert.equal(co.openCompany(ctx.root).store.get('T3').state, 'cancelled');
  assert.throws(() => co.ownerAction(ctx, { action: 'cancel', id: 'T99' }), /no ticket/);
});
