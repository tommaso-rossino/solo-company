// Agent adapters: run one non-interactive prompt with the CLI the user already has.
import { spawn, spawnSync } from 'node:child_process';

export const ADAPTERS = {
  claude: { bin: 'claude', args: (p) => ['-p', p], label: 'Claude Code' },
  codex: { bin: 'codex', args: (p) => ['exec', p], label: 'OpenAI Codex CLI' },
  gemini: { bin: 'gemini', args: (p) => ['-p', p], label: 'Gemini CLI' },
};

export function onPath(bin) {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim().split('\n')[0] : null;
}

// Which supported agents are installed here.
export function detect() {
  return Object.entries(ADAPTERS)
    .map(([name, a]) => ({ name, label: a.label, path: onPath(a.bin) }))
    .filter((a) => a.path);
}

// Run a prompt. `custom` = { command: "my-agent --flag" }, prompt goes to stdin.
export function run(agent, prompt, { cwd = process.cwd(), timeoutMs = 30 * 60 * 1000 } = {}) {
  let bin, args, stdin = null;
  if (agent.name === 'custom') {
    [bin, ...args] = agent.command.split(' ').filter(Boolean);
    stdin = prompt;
  } else {
    const a = ADAPTERS[agent.name];
    if (!a) throw new Error(`unknown agent: ${agent.name}`);
    bin = a.bin;
    args = a.args(prompt);
  }
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, out, err: String(e) }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, code, out, err }); });
    if (stdin) child.stdin.write(stdin);
    child.stdin.end();
  });
}
