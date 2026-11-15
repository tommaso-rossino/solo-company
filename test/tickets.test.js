import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { TicketStore } from '../src/tickets.js';

process.env.SOLO_COMPANY_HOME = (await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'sc-home-'));

const fresh = () => new TicketStore(mkdtempSync(join(tmpdir(), 'sc-')));
const base = { title: 'x', role: 'dev', task: 'do x', criteria: 'x works' };

test('ids grow and the register survives a reload', () => {
  const s = fresh();
  assert.equal(s.add(base).id, 'T1');
  assert.equal(s.add(base).id, 'T2');
  s.save();
  const again = new TicketStore(dirname(s.file));
  assert.equal(again.tickets.length, 2);
  assert.equal(again.nextId(), 'T3');
});

test('illegal moves are refused', () => {
  const s = fresh();
  const t = s.add(base);
  assert.throws(() => s.move(t.id, 'done'), /cannot go from todo to done/);
  s.move(t.id, 'in_progress');
  s.move(t.id, 'review');
  s.move(t.id, 'done');
  assert.equal(t.attempts, 1);
});

test('ready: priority first, dependencies respected', () => {
  const s = fresh();
  const a = s.add({ ...base, priority: 3 });
  const b = s.add({ ...base, priority: 1, after: a.id });
  const c = s.add({ ...base, priority: 2 });
  assert.deepEqual(s.ready('dev').map((t) => t.id), [c.id, a.id]);
  s.move(a.id, 'in_progress'); s.move(a.id, 'review'); s.move(a.id, 'done');
  assert.deepEqual(s.ready('dev').map((t) => t.id), [b.id, c.id]);
});

test('dev drafts wait for the mockup approval', () => {
  const s = fresh();
  const ux = s.add({ ...base, role: 'ux' });
  const d = s.add({ ...base, draftOf: ux.id });
  assert.equal(d.state, 'draft');
  assert.deepEqual(s.ready('dev'), []);
  s.approveMockup(ux.id);
  assert.deepEqual(s.ready('dev').map((t) => t.id), [d.id]);
});
