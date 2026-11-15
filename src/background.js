// Start the company's work, or its dashboard, as a detached process that outlives the chat.
import { spawn } from 'node:child_process';
import { openSync, closeSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runActive } from './company.js';
import { readJson, writeJson, pidAlive } from './util.js';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'solo-company.js');

function detached(root, args, logName) {
  const log = openSync(join(root, '.solo-company', logName), 'a');
  const child = spawn(process.execPath, [BIN, ...args], {
    cwd: root, detached: true, stdio: ['ignore', log, log],
    env: { ...process.env, SOLO_COMPANY_QUIET: '0' },
  });
  closeSync(log);
  child.unref();
  return child;
}

// Work until the queue is empty. The run lock makes a second start harmless.
export function startWork(root) {
  if (process.env.SOLO_COMPANY_NO_AUTOSTART === '1') return 'work not started (SOLO_COMPANY_NO_AUTOSTART)';
  if (runActive(join(root, '.solo-company'))) return 'the company is already working: it will pick this up';
  detached(root, ['run'], 'run.log');
  return 'the company started working in the background';
}

// One dashboard per company, reused while its process is alive.
export async function startDashboard(root, { tunnel = false } = {}) {
  const f = join(root, '.solo-company', 'dashboard.json');
  const cur = readJson(f, null);
  if (cur?.pid && pidAlive(cur.pid)) {
    if (!tunnel || cur.public) return cur;
    try { process.kill(cur.pid); } catch {} // restart it with a tunnel
  }
  const logName = 'dashboard.log';
  const logFile = join(root, '.solo-company', logName);
  const from = (() => { try { return readFileSync(logFile, 'utf8').length; } catch { return 0; } })();
  const child = detached(root, ['dashboard', '--port', '0', ...(tunnel ? ['--tunnel'] : [])], logName);
  const want = tunnel ? /From your phone: (\S+)/ : /Dashboard: (\S+)/;
  for (let i = 0; i < (tunnel ? 140 : 40); i++) {
    await new Promise((r) => setTimeout(r, 500));
    const text = (() => { try { return readFileSync(logFile, 'utf8').slice(from); } catch { return ''; } })();
    const local = text.match(/Dashboard: (\S+)/)?.[1];
    const pub = text.match(want)?.[1];
    if (local && (!tunnel || pub || /needs cloudflared/.test(text))) {
      const info = { pid: child.pid, local, public: tunnel ? pub || null : null };
      writeJson(f, info);
      return info;
    }
    if (/solo-company: /.test(text)) throw new Error(text.trim().split('\n').pop());
  }
  throw new Error('the dashboard did not start (see .solo-company/dashboard.log)');
}
