// Scheduled job: launchd on macOS, crontab elsewhere. Runs "solo-company tick".
import { writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { exists } from './util.js';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'solo-company.js');

const slug = (root) => `${basename(root).replace(/[^\w.-]/g, '-')}-${createHash('sha1').update(root).digest('hex').slice(0, 8)}`;
const label = (root) => `dev.solo-company.${slug(root)}`;
const plist = (root) => join(homedir(), 'Library', 'LaunchAgents', `${label(root)}.plist`);
const marker = (root) => `# solo-company ${root}`;

const disabled = () => process.env.SOLO_COMPANY_NO_SCHEDULE === '1';
const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function warnNpx() {
  return BIN.includes('/_npx/') ? ' (warning: running from the npx cache — install with "npm i -g solo-company" so the job keeps working)' : '';
}

export function install(ctx) {
  if (disabled()) return 'schedule skipped (SOLO_COMPANY_NO_SCHEDULE=1)';
  const { root, dir, cfg } = ctx;
  const every = Math.max(5, Number(cfg.features.scheduledChecks.everyMinutes) || 30);
  const log = join(dir, 'tick.log');
  if (process.platform === 'darwin') {
    const file = plist(root);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label(root)}</string>
  <key>ProgramArguments</key><array>
    <string>${xml(process.execPath)}</string><string>${xml(BIN)}</string><string>tick</string>
  </array>
  <key>WorkingDirectory</key><string>${xml(root)}</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(process.env.PATH)}</string></dict>
  <key>StartInterval</key><integer>${every * 60}</integer>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict></plist>
`);
    const uid = process.getuid();
    spawnSync('launchctl', ['bootout', `gui/${uid}`, file]);
    const r = spawnSync('launchctl', ['bootstrap', `gui/${uid}`, file], { encoding: 'utf8' });
    return r.status === 0 ? `scheduled every ${every} min (launchd ${label(root)})${warnNpx()}` : `launchd refused the job: ${r.stderr.trim()}`;
  }
  if (process.platform === 'win32') return 'scheduled checks are not supported on Windows yet: run "solo-company tick" from Task Scheduler';
  const line = `*/${every} * * * * cd ${JSON.stringify(root)} && PATH=${JSON.stringify(process.env.PATH)} ${JSON.stringify(process.execPath)} ${JSON.stringify(BIN)} tick >> ${JSON.stringify(log)} 2>&1 ${marker(root)}`;
  const r = setCrontab((lines) => [...lines.filter((l) => !l.endsWith(marker(root))), line]);
  return r ? `scheduled every ${every} min (crontab)${warnNpx()}` : 'could not write the crontab';
}

export function remove(ctx) {
  if (disabled()) return 'schedule skipped (SOLO_COMPANY_NO_SCHEDULE=1)';
  const { root } = ctx;
  if (process.platform === 'darwin') {
    const file = plist(root);
    if (!exists(file)) return 'no scheduled job';
    spawnSync('launchctl', ['bootout', `gui/${process.getuid()}`, file]);
    unlinkSync(file);
    return 'scheduled job removed';
  }
  if (process.platform === 'win32') return 'no scheduled job';
  return setCrontab((lines) => lines.filter((l) => !l.endsWith(marker(root)))) ? 'scheduled job removed' : 'could not write the crontab';
}

export function status(ctx) {
  const { root } = ctx;
  if (process.platform === 'darwin') return exists(plist(root)) ? `installed: ${plist(root)}` : 'not installed';
  const cur = spawnSync('crontab', ['-l'], { encoding: 'utf8' });
  return (cur.stdout || '').split('\n').some((l) => l.endsWith(marker(root))) ? 'installed (crontab)' : 'not installed';
}

function setCrontab(edit) {
  const cur = spawnSync('crontab', ['-l'], { encoding: 'utf8' });
  const lines = cur.status === 0 ? cur.stdout.split('\n').filter((l) => l.trim()) : [];
  const r = spawnSync('crontab', ['-'], { input: edit(lines).join('\n') + '\n', encoding: 'utf8' });
  return r.status === 0;
}
