// Connect the MCP server to the chat apps people already use.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { which, exists } from './util.js';

// How a chat app starts the server. Absolute paths: desktop apps do not see the shell's PATH.
export function serverCommand() {
  const bin = fileURLToPath(new URL('../bin/solo-company.js', import.meta.url));
  if (bin.includes(`${sep}_npx${sep}`)) return [which('npx') || 'npx', '-y', 'solo-company@latest', 'mcp'];
  return [which('node') || process.execPath, bin, 'mcp'];
}

const appSupport = () => process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support')
  : process.platform === 'win32' ? process.env.APPDATA || join(homedir(), 'AppData', 'Roaming') : join(homedir(), '.config');

// cli: the client's own "mcp add" command. file: a JSON config we merge into.
export const CLIENTS = {
  claude: { label: 'Claude Code', bin: 'claude', cli: ([c, ...a]) => ['claude', 'mcp', 'add', '--scope', 'user', 'solo-company', '--', c, ...a], remove: ['claude', 'mcp', 'remove', '--scope', 'user', 'solo-company'] },
  codex: { label: 'Codex CLI', bin: 'codex', cli: ([c, ...a]) => ['codex', 'mcp', 'add', 'solo-company', '--', c, ...a], remove: ['codex', 'mcp', 'remove', 'solo-company'] },
  gemini: { label: 'Gemini CLI', bin: 'gemini', cli: ([c, ...a]) => ['gemini', 'mcp', 'add', '--scope', 'user', 'solo-company', c, ...a], remove: ['gemini', 'mcp', 'remove', '--scope', 'user', 'solo-company'] },
  hermes: { label: 'Hermes Agent', bin: 'hermes', cli: ([c, ...a]) => ['hermes', 'mcp', 'add', 'solo-company', '--command', c, '--args', ...a], remove: ['hermes', 'mcp', 'remove', 'solo-company'] },
  opencode: {
    label: 'OpenCode', bin: 'opencode',
    file: () => join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'opencode', 'opencode.json'),
    put: (j, cmd) => { j.$schema ??= 'https://opencode.ai/config.json'; (j.mcp ??= {})['solo-company'] = { type: 'local', command: cmd, enabled: true }; },
  },
  cursor: {
    label: 'Cursor', bin: null,
    file: () => join(homedir(), '.cursor', 'mcp.json'),
    put: (j, [c, ...a]) => { (j.mcpServers ??= {})['solo-company'] = { command: c, args: a }; },
  },
  'claude-desktop': {
    label: 'Claude Desktop', bin: null,
    file: () => join(appSupport(), 'Claude', 'claude_desktop_config.json'),
    put: (j, [c, ...a]) => { (j.mcpServers ??= {})['solo-company'] = { command: c, args: a }; },
  },
};

const quote = (a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);

export function connect(name, { dryRun = false } = {}) {
  const cl = CLIENTS[name];
  if (!cl) throw new Error(`unknown app "${name}". Apps: ${Object.keys(CLIENTS).join(', ')}`);
  const cmd = serverCommand();
  if (cl.cli) {
    const argv = cl.cli(cmd);
    if (dryRun) return `would run: ${argv.map(quote).join(' ')}`;
    if (!which(cl.bin)) throw new Error(`${cl.label} (${cl.bin}) is not installed here`);
    spawnSync(cl.remove[0], cl.remove.slice(1), { stdio: 'ignore' }); // replace an older entry
    const r = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (r.status !== 0) throw new Error(`${argv.slice(0, 3).join(' ')} failed: ${(r.stderr || r.stdout || '').trim().split('\n').pop()}\nRun it yourself: ${argv.map(quote).join(' ')}`);
    return `Connected to ${cl.label}. Open a new chat there and say: "company, what are you working on?"`;
  }
  const file = cl.file();
  let j = {};
  if (exists(file)) {
    try { j = JSON.parse(readFileSync(file, 'utf8')); } catch {
      const x = {}; cl.put(x, cmd);
      throw new Error(`${file} is not plain JSON (comments?). Add this yourself:\n${JSON.stringify(x, null, 2)}`);
    }
  }
  cl.put(j, cmd);
  if (dryRun) return `would write ${file}:\n${JSON.stringify(j, null, 2)}`;
  mkdirSync(dirname(file), { recursive: true });
  if (exists(file)) copyFileSync(file, `${file}.bak-solo-company`);
  writeFileSync(file, JSON.stringify(j, null, 2) + '\n');
  return `Connected to ${cl.label} (${file}${exists(`${file}.bak-solo-company`) ? `, backup in ${file}.bak-solo-company` : ''}). Restart it, then say: "company, what are you working on?"`;
}

export function overview() {
  const cmd = serverCommand();
  const rows = Object.entries(CLIENTS).map(([k, c]) => `  ${k.padEnd(15)} ${c.label}${c.bin && which(c.bin) ? '  (installed)' : ''}`);
  return `Talk to your companies from a chat app: solo-company connect <app>

${rows.join('\n')}

Any other MCP app: add a stdio server named "solo-company" with this command:
  ${cmd.map(quote).join(' ')}`;
}
