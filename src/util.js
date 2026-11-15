import { homedir } from 'node:os';
// Small shared helpers: journal, state file, shell, JSON extraction.
import { appendFileSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';

export function journal(dir, text) {
  const line = `${new Date().toISOString()}  ${text}\n`;
  appendFileSync(join(dir, 'journal.log'), line);
  if (process.env.SOLO_COMPANY_QUIET !== '1') process.stdout.write(`· ${text}\n`);
}

export function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
}

export function writeJson(file, data) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  renameSync(tmp, file);
}

// Misc engine state (budget ledger, last green build, reports written…).
export function state(dir) {
  const file = join(dir, 'state.json');
  const data = readJson(file, {});
  return { data, save: () => writeJson(file, data) };
}

// Run a shell command (user-configured checks). Never throws.
export function shell(command, cwd, timeoutMs = 20 * 60 * 1000) {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, out: String(e) }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, out }); });
  });
}

export async function runChecks(checks, cwd) {
  const report = [];
  for (const c of checks) {
    const r = await shell(c, cwd);
    report.push(`$ ${c}\n${tail(r.out, 3000)}\n=> ${r.ok ? 'ok' : 'FAILED'}`);
    if (!r.ok) return { ok: false, report: report.join('\n\n') };
  }
  return { ok: true, report: report.join('\n\n') || '(no checks configured)' };
}

export function tail(text, max) {
  text = String(text || '').trim();
  return text.length > max ? '…' + text.slice(-max) : text;
}

// Agents are asked to end their answer with a JSON object. Take the last parseable one.
export function extractJson(text) {
  text = String(text || '');
  const fenced = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]);
  for (const c of fenced.reverse()) {
    try { return JSON.parse(c); } catch {}
  }
  // Fall back to the last balanced {...} in the text.
  for (let end = text.lastIndexOf('}'); end >= 0; end = text.lastIndexOf('}', end - 1)) {
    let depth = 0;
    for (let i = end; i >= 0; i--) {
      if (text[i] === '}') depth++;
      else if (text[i] === '{' && --depth === 0) {
        try { return JSON.parse(text.slice(i, end + 1)); } catch { break; }
      }
    }
  }
  return null;
}

export function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

export function which(bin) {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0] || null : null;
}

// Every match on PATH (Windows lists "claude", "claude.cmd", "claude.ps1"…).
export function whichAll(bin) {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', process.platform === 'win32' ? [bin] : ['-a', bin], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : [];
}

// "~/x" and "~\\x" → home folder.
export function expandHome(p) {
  return String(p).replace(/^~(?=$|[\\/])/, homedir());
}

export function today() {
  return new Date().toISOString().slice(0, 10);
}

export function exists(p) {
  return existsSync(p);
}
