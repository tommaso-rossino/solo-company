// Project config: .solo-company/config.json
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const DIR = '.solo-company';

export const DEFAULTS = {
  agent: { name: 'claude' },
  permissions: 'edit',         // edit: agents may edit files in their worktree | full: may also run commands
  teams: { dev: 1, ux: 1, qa: 1 },
  merge: 'pr',                 // auto | pr | manual
  mainBranch: 'main',
  integrationBranch: 'dev',
  worktreeDir: null,           // default: ~/.solo-company/worktrees/<project>
  checks: [],                  // shell commands run on a delivered branch, e.g. ["npm test"]
  autoPlan: true,              // when idle, the PM plans the next steps from GOAL.md
  limits: { ticketMinutes: 30, maxAttempts: 2, qaBatch: 5, agentMinutes: 30 },
  features: {
    scheduledChecks: { enabled: false, everyMinutes: 30, work: 'always' }, // work: always | night | never
    nightShift: { enabled: false, from: '01:00', to: '06:00', teams: 1 },
    budget: { enabled: false, dailyUsd: 5, usdPerRun: 0.5, fallbackCommand: '' }, // paid fallback, prompt on stdin
    research: { enabled: false },
  },
};

export function dirOf(root = process.cwd()) {
  return join(root, DIR);
}

export function load(root = process.cwd()) {
  const f = join(dirOf(root), 'config.json');
  if (!existsSync(f)) return null;
  return merge(structuredClone(DEFAULTS), JSON.parse(readFileSync(f, 'utf8')));
}

export function save(cfg, root = process.cwd()) {
  writeFileSync(join(dirOf(root), 'config.json'), JSON.stringify(cfg, null, 2) + '\n');
}

function merge(base, over) {
  for (const [k, v] of Object.entries(over)) {
    base[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object'
      ? merge(base[k], v)
      : v;
  }
  return base;
}
