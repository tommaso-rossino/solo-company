// A local web dashboard: tickets by state, journal, questions, spend, and the owner's actions.
// Zero dependencies: node:http on 127.0.0.1, protected by a random key in the URL.
import { createServer } from 'node:http';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, normalize, sep, extname, basename } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import * as co from './company.js';
import { readJson, pidAlive, today, which } from './util.js';

const MAX_BODY = 64 * 1024;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.pdf': 'application/pdf',
};

const read = (f, fallback = '') => { try { return readFileSync(f, 'utf8'); } catch { return fallback; } };

// Everything the page shows, read fresh from disk on every call.
export function snapshot(root) {
  const ctx = co.openCompany(root);
  const { dir, cfg, store } = ctx;
  const held = readJson(join(dir, 'run.lock'), null);
  const s = readJson(join(dir, 'state.json'), {});
  const mockups = (id) => {
    const d = join(dir, 'mockups', id);
    try { return readdirSync(d).filter((f) => statSync(join(d, f)).isFile()); } catch { return []; }
  };
  const tickets = store.tickets.map((t) => ({
    id: t.id, title: t.title, role: t.role, state: t.state, priority: t.priority,
    task: t.task, criteria: t.criteria, why: t.why, attempts: t.attempts, after: t.after,
    draftOf: t.draftOf, fixes: t.fixes, pr: t.pr || null, suspendedFor: t.suspendedFor || null,
    lastFailure: t.lastFailure || null, created: t.created,
    updated: t.history.at(-1)?.at || t.created,
    history: t.history.slice(-12),
    mockups: t.role === 'ux' ? mockups(t.id) : [],
  }));
  const questions = read(join(dir, 'QUESTIONS.md')).split('\n').filter((l) => /^\s*-\s/.test(l)).map((l) => l.replace(/^\s*-\s*/, ''));
  const goal = read(join(dir, 'GOAL.md')).replace(/^# Goal\s*/, '').trim();
  const journal = read(join(dir, 'journal.log')).trim().split('\n').filter(Boolean).slice(-80).reverse()
    .map((l) => { const i = l.indexOf('  '); return { at: l.slice(0, i), text: l.slice(i + 2) }; });
  const f = cfg.features;
  return {
    project: basename(root),
    goal,
    running: Boolean(held?.pid && pidAlive(held.pid)),
    agent: cfg.agent.name,
    merge: cfg.merge,
    teams: cfg.teams,
    features: Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.enabled])),
    spend: f.budget.enabled ? { today: s.spend?.[today()] || 0, cap: f.budget.dailyUsd } : null,
    requests: co.pendingRequests(dir),
    queued: co.queuedActions(dir).map((a) => `${a.id}: ${a.action}`),
    questions,
    tickets,
    journal,
    at: new Date().toISOString(),
  };
}

// The owner's actions, the same ones the CLI offers.
export function act(root, { action, id, text, priority } = {}) {
  const ctx = co.openCompany(root);
  if (action === 'request') { co.request(ctx, text); return { ok: true, message: 'request added for the PM' }; }
  if (action === 'reject' && !String(text || '').trim()) throw new Error('say what to change');
  return { ok: true, ...co.ownerAction(ctx, { action, id, text, priority }) };
}

function sameKey(given, key) {
  const a = Buffer.from(String(given || '')), b = Buffer.from(key);
  return a.length === b.length && timingSafeEqual(a, b);
}

function send(res, code, body, type = 'application/json') {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  res.end(data);
}

function body(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const parts = [];
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); } else parts.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(parts).toString('utf8') || '{}')); } catch { reject(new Error('invalid JSON')); } });
    req.on('error', reject);
  });
}

export function createDashboard(root, { key = randomBytes(18).toString('base64url') } = {}) {
  co.openCompany(root); // fail early outside a company
  const mockDir = join(co.openCompany(root).dir, 'mockups');
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      // Mockups carry the key in the path, so their relative links (images, css) keep working.
      const m = url.pathname.match(/^\/m\/([^/]+)\/(.+)$/);
      const given = m ? m[1] : url.searchParams.get('k') || req.headers['x-key'];
      if (!sameKey(given, key)) return send(res, 401, 'Add ?k=<key> from the terminal to the address.', 'text/plain; charset=utf-8');
      if (req.method === 'GET' && url.pathname === '/') return send(res, 200, PAGE, 'text/html; charset=utf-8');
      if (req.method === 'GET' && url.pathname === '/api/state') return send(res, 200, snapshot(root));
      if (req.method === 'POST' && url.pathname === '/api/action') {
        // A custom header the browser only sends from our own page: blocks cross-site form posts.
        if (req.headers['x-key'] !== key) return send(res, 403, { ok: false, error: 'missing key header' });
        try { return send(res, 200, act(root, await body(req))); } catch (e) { return send(res, 400, { ok: false, error: e.message }); }
      }
      if (req.method === 'GET' && m) {
        const rel = normalize(decodeURIComponent(m[2]));
        const file = join(mockDir, rel);
        if (rel.startsWith('..') || !file.startsWith(mockDir + sep) || !existsSync(file) || !statSync(file).isFile()) return send(res, 404, 'not found', 'text/plain');
        // Mockups are agent-written: serve them sandboxed, never as same-origin pages.
        res.setHeader('content-security-policy', 'sandbox allow-scripts');
        return send(res, 200, readFileSync(file), TYPES[extname(file).toLowerCase()] || 'application/octet-stream');
      }
      return send(res, 404, 'not found', 'text/plain');
    } catch (e) {
      return send(res, 500, { ok: false, error: e.message });
    }
  });
  return { server, key };
}

// Start a cloudflared quick tunnel; resolves with the public https URL.
function tunnel(port) {
  return new Promise((resolve, reject) => {
    const child = spawn('cloudflared', ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => reject(new Error('cloudflared did not give a URL within 60 s')), 60_000);
    const look = (d) => {
      out += d;
      const m = out.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m) { clearTimeout(timer); resolve({ url: m[0], child }); }
    };
    child.stdout.on('data', look); child.stderr.on('data', look);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    process.on('exit', () => child.kill());
  });
}

export async function serve(root, { port = 4321, open = false, tunnel: useTunnel = false } = {}) {
  const { server, key } = createDashboard(root);
  await new Promise((resolve, reject) => {
    server.once('error', (e) => reject(e.code === 'EADDRINUSE' ? new Error(`port ${port} is busy: try --port <n>`) : e));
    server.listen(port, '127.0.0.1', resolve);
  });
  const local = `http://127.0.0.1:${server.address().port}/?k=${key}`;
  console.log(`Dashboard: ${local}`);
  if (useTunnel) {
    if (!which('cloudflared')) console.log('--tunnel needs cloudflared on PATH (brew install cloudflared).');
    else {
      const t = await tunnel(server.address().port);
      console.log(`From your phone: ${t.url}/?k=${key}\nAnyone with this link can see and act on the company: keep it private.`);
    }
  }
  if (open) {
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
    spawn(cmd, [local], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  }
  console.log('Ctrl+C to stop.');
  return server;
}

const PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>solo-company</title>
<style>
:root{--bg:#f6f6f4;--card:#fff;--ink:#1b1b1a;--muted:#6b6b66;--line:#e2e2dc;--accent:#2f6fde;--ok:#1f8a4c;--warn:#b7791f;--bad:#c53030;--chip:#efefea}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--card:#1e1e1c;--ink:#ecece8;--muted:#9a9a93;--line:#2e2e2b;--accent:#6ea0ff;--ok:#4cc38a;--warn:#e0a84a;--bad:#ff6b6b;--chip:#2a2a27}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
header{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center;padding:14px 16px;border-bottom:1px solid var(--line);background:var(--card);position:sticky;top:0;z-index:2}
h1{font-size:16px;margin:0}
.dot{width:9px;height:9px;border-radius:50%;display:inline-block;margin-right:6px;background:var(--muted)}
.dot.on{background:var(--ok);box-shadow:0 0 0 3px color-mix(in srgb,var(--ok) 25%,transparent)}
.meta{color:var(--muted);font-size:13px}
.chip{background:var(--chip);border-radius:999px;padding:1px 8px;font-size:12px;color:var(--muted);white-space:nowrap}
main{padding:16px;display:grid;gap:16px}
.row{display:grid;gap:16px;grid-template-columns:2fr 1fr}
@media (max-width:900px){.row{grid-template-columns:1fr}}
section{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px;min-width:0}
h2{font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin:0 0 8px}
.board{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px}
@media (max-width:1100px){.board{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:560px){.board{grid-template-columns:1fr}}
.col{background:var(--bg);border-radius:8px;padding:8px;min-height:60px}
.col h3{font-size:12px;margin:2px 4px 8px;color:var(--muted);display:flex;justify-content:space-between}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:8px 10px;margin-bottom:8px;cursor:pointer}
.card:hover{border-color:var(--accent)}
.card .t{font-weight:500;overflow-wrap:anywhere}
.card .m{display:flex;gap:6px;flex-wrap:wrap;margin-top:4px}
.p1{color:var(--bad)}.p2{color:var(--warn)}
.need{border-left:3px solid var(--warn)}
ul.plain{list-style:none;margin:0;padding:0}
ul.plain li{padding:5px 0;border-bottom:1px solid var(--line);overflow-wrap:anywhere}
ul.plain li:last-child{border:0}
.log{max-height:340px;overflow:auto;font-size:13px}
.log time{color:var(--muted);font-variant-numeric:tabular-nums;margin-right:8px}
form.req{display:flex;gap:8px}
input,textarea,select{font:inherit;color:inherit;background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:7px 9px;width:100%}
button{font:inherit;border:1px solid var(--line);background:var(--chip);color:var(--ink);border-radius:6px;padding:7px 12px;cursor:pointer;white-space:nowrap}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
button.danger{color:var(--bad)}
dialog{border:1px solid var(--line);border-radius:12px;background:var(--card);color:var(--ink);width:min(680px,calc(100vw - 32px));padding:0}
dialog::backdrop{background:rgba(0,0,0,.45)}
.dlg{padding:16px;display:grid;gap:10px;max-height:85vh;overflow:auto}
.dlg pre{white-space:pre-wrap;margin:0;background:var(--bg);padding:8px;border-radius:6px;font:13px/1.4 ui-monospace,Menlo,monospace}
.actions{display:flex;gap:8px;flex-wrap:wrap}
.toast{position:fixed;bottom:16px;left:50%;transform:translateX(-50%);background:var(--ink);color:var(--bg);padding:8px 14px;border-radius:8px;opacity:0;transition:opacity .2s;pointer-events:none}
.toast.show{opacity:1}
.empty{color:var(--muted);font-size:13px;padding:4px}
a{color:var(--accent)}
</style>
</head>
<body>
<header>
  <h1><span id="dot" class="dot"></span><span id="name">solo-company</span></h1>
  <span id="status" class="meta"></span>
  <span id="chips" class="m" style="display:flex;gap:6px;flex-wrap:wrap"></span>
  <span id="updated" class="meta" style="margin-left:auto"></span>
</header>
<main>
  <section id="needs" hidden><h2>Waiting on you</h2><ul class="plain" id="needlist"></ul></section>
  <section><h2>Tickets</h2><div class="board" id="board"></div></section>
  <div class="row">
    <section><h2>Journal</h2><ul class="plain log" id="log"></ul></section>
    <div style="display:grid;gap:16px;align-content:start">
      <section><h2>New request for the PM</h2>
        <form class="req" id="reqform"><input id="reqtext" placeholder="e.g. add a dark mode" autocomplete="off"><button class="primary">Add</button></form>
        <ul class="plain" id="reqs" style="margin-top:8px"></ul>
      </section>
      <section><h2>Goal</h2><div id="goal" class="meta" style="white-space:pre-wrap"></div></section>
    </div>
  </div>
</main>
<dialog id="dlg"><div class="dlg" id="dlgbody"></div></dialog>
<div class="toast" id="toast"></div>
<script>
const KEY = new URLSearchParams(location.search).get('k') || '';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const ago = (iso) => { const s = (Date.now() - new Date(iso)) / 1000; return s < 60 ? 'now' : s < 3600 ? Math.round(s/60)+' min ago' : s < 86400 ? Math.round(s/3600)+' h ago' : Math.round(s/86400)+' d ago'; };
const COLS = [
  ['To do', (t) => t.state === 'todo' || t.state === 'draft'],
  ['In progress', (t) => t.state === 'in_progress'],
  ['Review / QA', (t) => t.state === 'review' && t.role !== 'ux' || t.state === 'bugs_open'],
  ['Needs you', (t) => t.state === 'suspended' || (t.state === 'review' && t.role === 'ux')],
  ['Done', (t) => t.state === 'done'],
];
let data = null, openId = null;

async function load() {
  try {
    const r = await fetch('/api/state?k=' + encodeURIComponent(KEY), { cache: 'no-store' });
    if (!r.ok) throw new Error(await r.text());
    data = await r.json();
    render();
  } catch (e) { $('updated').textContent = 'cannot reach the dashboard: ' + e.message; }
}

async function act(body) {
  const r = await fetch('/api/action', { method: 'POST', headers: { 'content-type': 'application/json', 'x-key': KEY }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({ ok: false, error: 'bad answer' }));
  toast(j.ok ? j.message : 'Error: ' + j.error);
  await load();
  return j.ok;
}

function toast(text) { const t = $('toast'); t.textContent = text; t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 3000); }

function card(t) {
  const need = t.state === 'suspended' || (t.state === 'review' && t.role === 'ux');
  return '<div class="card' + (need ? ' need' : '') + '" data-id="' + esc(t.id) + '">' +
    '<div class="t">' + esc(t.title) + '</div>' +
    '<div class="m"><span class="chip">' + esc(t.id) + '</span><span class="chip">' + esc(t.role) + '</span>' +
    '<span class="chip p' + t.priority + '">P' + t.priority + '</span>' +
    (t.state === 'draft' ? '<span class="chip">waits for ' + esc(t.draftOf) + '</span>' : '') +
    (t.state === 'bugs_open' ? '<span class="chip p1">bugs</span>' : '') +
    (t.attempts > 1 ? '<span class="chip">try ' + t.attempts + '</span>' : '') +
    '</div></div>';
}

function render() {
  const d = data;
  document.title = d.project + ' · solo-company';
  $('name').textContent = d.project;
  $('dot').className = 'dot' + (d.running ? ' on' : '');
  const busy = d.tickets.filter((t) => t.state === 'in_progress').length;
  $('status').textContent = d.running ? 'working' + (busy ? ' on ' + busy + ' ticket' + (busy > 1 ? 's' : '') : '') : 'idle';
  const on = Object.entries(d.features).filter(([, v]) => v).map(([k]) => k);
  $('chips').innerHTML = ['agent: ' + d.agent, 'merge: ' + d.merge, 'teams dev ' + d.teams.dev + ' · ux ' + d.teams.ux + ' · qa ' + d.teams.qa]
    .concat(on).concat(d.spend ? ['spent $' + d.spend.today.toFixed(2) + ' / ' + d.spend.cap] : [])
    .map((c) => '<span class="chip">' + esc(c) + '</span>').join('');
  $('updated').textContent = 'updated ' + new Date(d.at).toLocaleTimeString();

  $('board').innerHTML = COLS.map(([name, f]) => {
    let list = d.tickets.filter(f);
    if (name === 'Done') list = list.sort((a, b) => b.updated.localeCompare(a.updated)).slice(0, 15);
    else list = list.sort((a, b) => a.priority - b.priority || a.created.localeCompare(b.created));
    const total = d.tickets.filter(f).length;
    return '<div class="col"><h3><span>' + name + '</span><span>' + total + '</span></h3>' +
      (list.map(card).join('') || '<div class="empty">—</div>') + '</div>';
  }).join('');

  const needs = d.tickets.filter((t) => t.state === 'suspended' || (t.state === 'review' && t.role === 'ux'));
  $('needs').hidden = !needs.length && !d.questions.length;
  $('needlist').innerHTML = needs.map((t) => '<li><a href="#" data-id="' + esc(t.id) + '">' + esc(t.id) + ' ' + esc(t.title) + '</a> — ' +
      (t.state === 'suspended' ? 'suspended: ' + esc(t.suspendedFor || '') : 'mockup ready: approve or send back') + '</li>').join('') +
    d.questions.slice(-8).reverse().map((q) => '<li class="meta">' + esc(q) + '</li>').join('');

  $('log').innerHTML = d.journal.map((l) => '<li><time title="' + esc(l.at) + '">' + esc(new Date(l.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })) + '</time>' + esc(l.text) + '</li>').join('') || '<li class="empty">nothing yet</li>';
  $('reqs').innerHTML = d.requests.map((r) => '<li class="meta">waiting for the PM: ' + esc(r) + '</li>').join('') +
    d.queued.map((q) => '<li class="meta">queued until the current step ends: ' + esc(q) + '</li>').join('');
  $('goal').textContent = d.goal;
  if (openId && $('dlg').open) detail(openId, true);
}

function detail(id, refresh) {
  const t = data.tickets.find((x) => x.id === id);
  if (!t) return;
  if (refresh && document.activeElement && $('dlgbody').contains(document.activeElement) && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
  openId = id;
  const mock = t.mockups.map((f) => '<a target="_blank" rel="noopener" href="/m/' + encodeURIComponent(KEY) + '/' + encodeURIComponent(t.id) + '/' + encodeURIComponent(f) + '">' + esc(f) + '</a>').join(' · ');
  const isMock = t.state === 'review' && t.role === 'ux';
  const open = !['done', 'cancelled', 'split'].includes(t.state);
  $('dlgbody').innerHTML =
    '<div style="display:flex;justify-content:space-between;gap:8px"><strong>' + esc(t.id) + ' · ' + esc(t.title) + '</strong><button id="x">Close</button></div>' +
    '<div class="m" style="display:flex;gap:6px;flex-wrap:wrap"><span class="chip">' + esc(t.state) + '</span><span class="chip">' + esc(t.role) + '</span><span class="chip">P' + t.priority + '</span>' +
      (t.after ? '<span class="chip">after ' + esc(t.after) + '</span>' : '') + (t.fixes ? '<span class="chip">fixes ' + esc(t.fixes) + '</span>' : '') +
      (t.pr ? '<a class="chip" target="_blank" rel="noopener" href="' + esc(t.pr) + '">pull request</a>' : '') + '</div>' +
    (t.why ? '<div class="meta">' + esc(t.why) + '</div>' : '') +
    '<div><h2>Task</h2><pre>' + esc(t.task) + '</pre></div>' +
    '<div><h2>Done when</h2><pre>' + esc(t.criteria) + '</pre></div>' +
    (mock ? '<div><h2>Mockup</h2>' + mock + '</div>' : '') +
    (t.suspendedFor ? '<div><h2>Suspended because</h2><pre>' + esc(t.suspendedFor) + '</pre></div>' : '') +
    (t.lastFailure && open ? '<div><h2>Last problem</h2><pre>' + esc(t.lastFailure.slice(0, 2000)) + '</pre></div>' : '') +
    (isMock ? '<div class="actions"><button class="primary" data-a="approve">Approve mockup</button></div><div class="actions"><input id="txt" placeholder="What to change"><button data-a="reject">Send back</button></div>' : '') +
    (t.state === 'suspended' ? '<div class="actions"><input id="txt" placeholder="Advice for the next try (optional)"><button class="primary" data-a="resume">Resume</button></div>' : '') +
    (open ? '<div class="actions"><select id="prio">' + [1,2,3,4,5].map((p) => '<option' + (p === t.priority ? ' selected' : '') + '>' + p + '</option>').join('') + '</select><button data-a="priority">Set priority</button><button class="danger" data-a="cancel">Cancel ticket</button></div>' : '') +
    '<div><h2>History</h2><ul class="plain">' + t.history.slice().reverse().map((h) => '<li><span class="meta">' + esc(ago(h.at)) + '</span> ' + esc(h.text) + '</li>').join('') + '</ul></div>';
  if (!$('dlg').open) $('dlg').showModal();
}

document.addEventListener('click', async (e) => {
  const c = e.target.closest('[data-id]');
  if (c) { e.preventDefault(); detail(c.dataset.id); return; }
  if (e.target.id === 'x') { $('dlg').close(); openId = null; return; }
  const b = e.target.closest('button[data-a]');
  if (!b) return;
  const a = b.dataset.a, body = { action: a, id: openId };
  if (a === 'cancel' && !confirm('Cancel ' + openId + '?')) return;
  if (a === 'reject' || a === 'resume') body.text = ($('txt') || {}).value || '';
  if (a === 'reject' && !body.text) { toast('Write what to change'); return; }
  if (a === 'priority') body.priority = Number($('prio').value);
  b.disabled = true;
  if (await act(body) && a !== 'priority') { $('dlg').close(); openId = null; }
  b.disabled = false;
});
$('dlg').addEventListener('close', () => { openId = null; });
$('reqform').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('reqtext').value.trim();
  if (!text) return;
  if (await act({ action: 'request', text })) $('reqtext').value = '';
});
load();
setInterval(() => { if (!document.hidden) load(); }, 5000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
</script>
</body>
</html>`;
