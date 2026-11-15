// Agent adapters: run one non-interactive prompt with the CLI the user already has.
// Modes: "read" (look only), "edit" (may edit files in cwd), "full" (may also run commands).
import { spawn } from 'node:child_process';
import { which, state, today, journal } from './util.js';

export const ADAPTERS = {
  claude: {
    bin: 'claude', label: 'Claude Code',
    args: (p, mode) => ['-p', p, ...({ read: [], edit: ['--permission-mode', 'acceptEdits'], full: ['--dangerously-skip-permissions'] }[mode])],
  },
  codex: {
    bin: 'codex', label: 'OpenAI Codex CLI',
    args: (p, mode) => ['exec', ...({ read: ['--sandbox', 'read-only'], edit: ['--full-auto'], full: ['--dangerously-bypass-approvals-and-sandbox'] }[mode]), p],
  },
  gemini: {
    bin: 'gemini', label: 'Gemini CLI',
    args: (p, mode) => ['-p', p, ...({ read: [], edit: ['--approval-mode', 'auto_edit'], full: ['--yolo'] }[mode])],
  },
  // OpenCode: "plan" is its read-only agent; "build" edits and runs commands as its own config allows.
  opencode: {
    bin: 'opencode', label: 'OpenCode',
    args: (p, mode) => ['run', ...(mode === 'read' ? ['--agent', 'plan'] : []), p],
  },
  // Hermes Agent: one-shot mode; the toolsets decide what it can touch.
  // Its "file" toolset can also write, so read mode relies on the role prompt.
  hermes: {
    bin: 'hermes', label: 'Hermes Agent',
    args: (p, mode) => ['-z', p, '-t', { read: 'file,web', edit: 'file,web', full: 'file,web,terminal,code_execution' }[mode], ...(mode === 'full' ? ['--yolo'] : [])],
  },
};

export const onPath = which;

// Which supported agents are installed here.
export function detect() {
  return Object.entries(ADAPTERS)
    .map(([name, a]) => ({ name, label: a.label, path: which(a.bin) }))
    .filter((a) => a.path);
}

// Run a prompt. `custom` = { command: "my-agent --flag" }: run through the shell,
// prompt on stdin, mode in $SOLO_COMPANY_MODE.
export function run(agent, prompt, { cwd = process.cwd(), timeoutMs = 30 * 60 * 1000, mode = 'read' } = {}) {
  let child;
  const env = { ...process.env, SOLO_COMPANY_MODE: mode };
  if (agent.name === 'custom') {
    if (!agent.command) throw new Error('custom agent needs a command');
    child = spawn(agent.command, { cwd, shell: true, env, stdio: ['pipe', 'pipe', 'pipe'] });
  } else {
    const a = ADAPTERS[agent.name];
    if (!a) throw new Error(`unknown agent: ${agent.name}`);
    child = spawn(a.bin, a.args(prompt, mode), { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  }
  return new Promise((resolve) => {
    let out = '', err = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, out, err: String(e) }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, code, out, err }); });
    child.stdin.on('error', () => {});
    if (agent.name === 'custom') child.stdin.write(prompt);
    child.stdin.end();
  });
}

const LIMIT = /usage limit|rate limit|rate-limit|quota|too many requests|\b429\b|limit reached|credit balance|insufficient credits/i;

export function isLimited(r) {
  return !r.ok && LIMIT.test(`${r.out}\n${r.err}`);
}

// Subscription first. If the main agent hits its limit and the budget feature is on,
// use the paid fallback until the daily cap. Otherwise report `limited` so the
// teams wait instead of failing tickets.
export async function ask(ctx, prompt, opts = {}) {
  const { cfg, dir } = ctx;
  const timeoutMs = (cfg.limits.agentMinutes || 30) * 60 * 1000;
  const r = await run(cfg.agent, prompt, { timeoutMs, ...opts });
  if (!isLimited(r)) return r;

  const b = cfg.features.budget;
  if (!b.enabled || !b.fallbackCommand) {
    journal(dir, 'agent limit reached: teams wait');
    return { ...r, limited: true };
  }
  const s = state(dir);
  const day = today();
  s.data.spend ??= {};
  const spent = s.data.spend[day] || 0;
  const cost = Number(b.usdPerRun) || 0.5;
  if (spent + cost > b.dailyUsd) {
    journal(dir, `daily budget reached (${spent.toFixed(2)}/${b.dailyUsd} USD): teams wait`);
    return { ...r, limited: true };
  }
  s.data.spend[day] = spent + cost;
  s.save();
  journal(dir, `agent limit reached: using paid fallback (${(spent + cost).toFixed(2)}/${b.dailyUsd} USD today)`);
  const f = await run({ name: 'custom', command: b.fallbackCommand }, prompt, { timeoutMs, ...opts });
  return isLimited(f) ? { ...f, limited: true } : f;
}
