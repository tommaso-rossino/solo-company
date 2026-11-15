import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import * as co from '../src/company.js';
import { list, resolveCompany } from '../src/registry.js';
import { startWork } from '../src/background.js';
import { CLIENTS } from '../src/connect.js';

const HOME = mkdtempSync(join(tmpdir(), 'sc-home-'));
process.env.SOLO_COMPANY_HOME = HOME;
process.env.SOLO_COMPANY_QUIET = '1';
process.env.SOLO_COMPANY_NO_SCHEDULE = '1';
const BIN = fileURLToPath(new URL('../bin/solo-company.js', import.meta.url));
const FAKE = fileURLToPath(new URL('./fake-agent.js', import.meta.url));
const fakeAgent = `"${process.execPath}" "${FAKE}"`;
const wt = () => mkdtempSync(join(tmpdir(), 'sc-wt-'));

function newCompany(name, goal = 'A test app') {
  const ctx = co.quickCreate(join(mkdtempSync(join(tmpdir(), 'sc-mcp-')), name), { goal, agentCommand: fakeAgent });
  ctx.cfg.worktreeDir = wt(); ctx.cfg.autoPlan = false; co.saveConfig(ctx);
  return co.openCompany(ctx.root);
}

// A client that speaks MCP to `solo-company mcp` over stdio.
function client(cwd) {
  const child = spawn(process.execPath, [BIN, 'mcp'], { cwd, env: { ...process.env, SOLO_COMPANY_NO_AUTOSTART: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map();
  let n = 0;
  createInterface({ input: child.stdout }).on('line', (l) => {
    const m = JSON.parse(l);
    waiting.get(m.id)?.(m); waiting.delete(m.id);
  });
  const rpc = (method, params) => new Promise((resolve) => { const id = ++n; waiting.set(id, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  const call = async (name, args = {}) => {
    const r = await rpc('tools/call', { name, arguments: args });
    return { text: r.result.content[0].text, error: Boolean(r.result.isError) };
  };
  return { rpc, call, notify: (method) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n'), close: () => child.stdin.end() };
}

test('quickCreate makes the folder, git and the company, and registers it', () => {
  const ctx = newCompany('Recipes App');
  assert.ok(existsSync(join(ctx.root, '.git')));
  assert.match(readFileSync(join(ctx.dir, 'GOAL.md'), 'utf8'), /A test app/);
  assert.equal(ctx.cfg.agent.name, 'custom');
  assert.ok(list().some((c) => c.name === 'recipes-app' && c.root === realpathSync(ctx.root)));
  assert.equal(resolveCompany('recipes'), realpathSync(ctx.root), 'a name prefix is enough');
  assert.equal(resolveCompany(null, join(ctx.root, '.solo-company')), realpathSync(ctx.root), 'found from inside the project');
  assert.throws(() => co.quickCreate(ctx.root, { goal: 'again', agentCommand: fakeAgent }), /already has a company/);
  assert.throws(() => resolveCompany('nope'), /no company "nope"/);
});

test('MCP: handshake, tools, request, status, decisions, errors', async () => {
  const a = newCompany('alpha');
  newCompany('beta');
  const c = client(a.root);
  try {
    const init = await c.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    assert.equal(init.result.serverInfo.name, 'solo-company');
    assert.match(init.result.instructions, /azienda/);
    c.notify('notifications/initialized');
    assert.deepEqual((await c.rpc('ping')).result, {});

    const tools = (await c.rpc('tools/list')).result.tools.map((t) => t.name);
    for (const t of ['company_request', 'company_status', 'company_decide', 'company_ceo', 'company_create', 'company_dashboard', 'company_list']) assert.ok(tools.includes(t), t);

    const l = await c.call('company_list');
    assert.match(l.text, /alpha/); assert.match(l.text, /beta/);

    // The server runs inside alpha's folder: no company name needed.
    const r = await c.call('company_request', { text: 'please say hello' });
    assert.match(r.text, /Request added to alpha/);
    assert.deepEqual(co.pendingRequests(a.dir), ['please say hello']);

    const s = await c.call('company_status', { company: 'beta' });
    assert.match(s.text, /^beta/);

    a.store.add({ title: 'Fix footer', role: 'dev', task: 'fix', criteria: 'fixed' }); a.store.save();
    const d = await c.call('company_decide', { action: 'priority', id: 'T1', priority: 1 });
    assert.equal(d.error, false, d.text);
    assert.equal(co.openCompany(a.root).store.get('T1').priority, 1);
    assert.equal((await c.call('company_decide', { action: 'reject', id: 'T1' })).error, true);
    assert.match((await c.call('company_status', { company: 'gamma' })).text, /no company "gamma"/);
    const bad = await c.rpc('tools/call', { name: 'nope', arguments: {} });
    assert.equal(bad.error.code, -32602);
    assert.equal((await c.rpc('foo/bar')).error.code, -32601);
  } finally { c.close(); }
});

test('MCP: create a company from a chat', async () => {
  const c = client(tmpdir());
  try {
    await c.rpc('initialize', {});
    const where = join(mkdtempSync(join(tmpdir(), 'sc-new-')), 'todo-app');
    const r = await c.call('company_create', { path: where, goal: 'A to-do list for families', agent: 'claude' });
    assert.equal(r.error, false, r.text);
    assert.match(r.text, /Company "todo-app" created/);
    assert.equal(co.openCompany(where).cfg.agent.name, 'claude');
    assert.equal((await c.call('company_create', { path: where, goal: 'x' })).error, true);
  } finally { c.close(); }
});

test('startWork runs the company in the background until the queue is empty', async () => {
  const ctx = newCompany('gamma');
  co.request(ctx, 'please say hello');
  delete process.env.SOLO_COMPANY_NO_AUTOSTART;
  assert.match(startWork(ctx.root), /started/);
  const log = join(ctx.dir, 'journal.log');
  for (let i = 0; i < 100 && !/run finished/.test(readFileSync(log, 'utf8')); i++) await new Promise((r) => setTimeout(r, 200));
  assert.match(readFileSync(log, 'utf8'), /run finished/);
  assert.equal(co.openCompany(ctx.root).store.get('T1').state, 'done');
  assert.ok(existsSync(join(ctx.dir, 'run.log')));
});

test('connect writes JSON configs without losing what is there', async () => {
  const xdg = mkdtempSync(join(tmpdir(), 'sc-xdg-'));
  process.env.XDG_CONFIG_HOME = xdg;
  const { connect } = await import('../src/connect.js');
  const f = CLIENTS.opencode.file();
  (await import('node:fs')).mkdirSync(join(xdg, 'opencode'), { recursive: true });
  writeFileSync(f, JSON.stringify({ theme: 'dark', mcp: { other: { type: 'local', command: ['x'] } } }));
  assert.match(connect('opencode'), /Connected to OpenCode/);
  const j = JSON.parse(readFileSync(f, 'utf8'));
  assert.equal(j.theme, 'dark');
  assert.ok(j.mcp.other);
  assert.deepEqual(j.mcp['solo-company'].command.slice(-1), ['mcp']);
  assert.ok(existsSync(`${f}.bak-solo-company`));
  assert.match(connect('claude', { dryRun: true }), /claude mcp add --scope user solo-company -- /);
  assert.throws(() => connect('notepad'), /unknown app/);
});

test('Windows: agents start through their npm shim script, not cmd.exe', async () => {
  const { resolveBin, shimTarget } = await import('../src/agents.js');
  assert.deepEqual(resolveBin('claude', { platform: 'darwin' }), ['claude']);
  assert.deepEqual(resolveBin('claude', { platform: 'win32', found: ['C:\\bin\\claude', 'C:\\bin\\claude.exe'] }), ['C:\\bin\\claude.exe']);
  const shim = '@ECHO off\r\nGOTO start\r\n:start\r\n"%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n';
  assert.match(shimTarget(shim, '/npm'), /node_modules[\\/]@openai[\\/]codex[\\/]bin[\\/]codex\.js$/);
  assert.equal(shimTarget('echo hi', '/npm'), null);
  assert.throws(() => resolveBin('gemini', { platform: 'win32', found: [] }), /need an .exe/);
});

test('a company with no folder goes to ~/companies/<name>', () => {
  process.env.SOLO_COMPANY_PROJECTS = mkdtempSync(join(tmpdir(), 'sc-projects-'));
  assert.match(co.defaultProjectDir(null, 'A recipe app for busy families'), /[\\/]recipe-busy-families$/);
  assert.match(co.defaultProjectDir('Ricette', 'x'), /[\\/]ricette$/);
  const ctx = co.quickCreate(null, { goal: 'Un gestionale per la palestra', agentCommand: fakeAgent });
  assert.match(ctx.root, /[\\/]gestionale-palestra$/);
  assert.match(co.defaultProjectDir(null, 'Un gestionale per la palestra'), /gestionale-palestra-2$/);
});
