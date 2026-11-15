// Git flow: one worktree per ticket, an integration branch, merge policy.
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { exists } from './util.js';

export function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

function must(r, what) {
  if (!r.ok) throw new Error(`${what}: ${r.err || r.out}`);
  return r.out;
}

export const isRepo = (root) => git(root, 'rev-parse', 'HEAD').ok;
export const currentBranch = (cwd) => git(cwd, 'branch', '--show-current').out;
export const branchExists = (root, b) => git(root, 'rev-parse', '--verify', '--quiet', `refs/heads/${b}`).ok;
export const isClean = (cwd) => git(cwd, 'status', '--porcelain', '--untracked-files=no').out === '';
export const head = (cwd, ref = 'HEAD') => git(cwd, 'rev-parse', ref).out;

// Worktrees live outside the project so test runners and watchers never see them.
export function worktreeRoot(root, cfg) {
  if (cfg.worktreeDir) return cfg.worktreeDir;
  const id = createHash('sha1').update(root).digest('hex').slice(0, 8);
  return join(homedir(), '.solo-company', 'worktrees', `${basename(root)}-${id}`);
}

// Commit identity: the user's own if set, a neutral one otherwise.
function identity(cwd) {
  return git(cwd, 'config', 'user.email').ok ? [] : ['-c', 'user.name=solo-company', '-c', 'user.email=solo-company@localhost'];
}

export function baseBranch(cfg) {
  return cfg.merge === 'auto' ? cfg.integrationBranch : cfg.mainBranch;
}

export function ensureIntegration(root, cfg) {
  if (cfg.merge === 'auto' && !branchExists(root, cfg.integrationBranch)) {
    must(git(root, 'branch', cfg.integrationBranch, cfg.mainBranch), `create ${cfg.integrationBranch}`);
  }
}

// Folder where the integration branch is checked out (the project itself if it is on it).
export function integrationDir(root, cfg) {
  if (currentBranch(root) === cfg.integrationBranch) return root;
  const path = join(worktreeRoot(root, cfg), '_integration');
  if (!exists(path)) {
    mkdirSync(worktreeRoot(root, cfg), { recursive: true });
    git(root, 'worktree', 'prune');
    must(git(root, 'worktree', 'add', path, cfg.integrationBranch), 'integration worktree');
  }
  return path;
}

// Ticket worktree on feature/<id>. A retry reuses it and catches up with the base.
export function openTicket(root, cfg, t, { fresh = false } = {}) {
  const path = join(worktreeRoot(root, cfg), t.id);
  const branch = `feature/${t.id}`;
  const base = baseBranch(cfg);
  if (fresh) closeTicket(root, path, branch, { deleteBranch: true });
  mkdirSync(worktreeRoot(root, cfg), { recursive: true });
  git(root, 'worktree', 'prune');
  if (!exists(path)) {
    const args = branchExists(root, branch) ? ['worktree', 'add', path, branch] : ['worktree', 'add', '-b', branch, path, base];
    must(git(root, ...args), `worktree for ${t.id}`);
  }
  return { path, branch, base };
}

export function closeTicket(root, path, branch, { deleteBranch = false } = {}) {
  if (exists(path)) {
    if (!git(root, 'worktree', 'remove', '--force', path).ok) rmSync(path, { recursive: true, force: true });
  }
  git(root, 'worktree', 'prune');
  if (deleteBranch && branch) git(root, 'branch', '-D', branch);
}

// Commit whatever the agent left uncommitted. Returns true if something was committed.
export function commitAll(cwd, message) {
  git(cwd, 'add', '-A');
  if (git(cwd, 'diff', '--cached', '--quiet').ok) return false;
  must(git(cwd, ...identity(cwd), 'commit', '-q', '-m', message), 'commit');
  return true;
}

export function commitsAhead(cwd, base) {
  return Number(git(cwd, 'rev-list', '--count', `${base}..HEAD`).out) || 0;
}

// Merge `from` into the branch checked out in cwd. On conflict, abort and report.
export function mergeInto(cwd, from, message) {
  const r = git(cwd, ...identity(cwd), 'merge', '--no-ff', '--no-edit', '-m', message, from);
  if (r.ok) return { ok: true };
  git(cwd, 'merge', '--abort');
  return { ok: false, err: r.err || r.out };
}

// Bring the feature branch up to date with the base before checks.
export function catchUp(cwd, base) {
  const r = git(cwd, ...identity(cwd), 'merge', '--no-edit', base);
  if (r.ok) return { ok: true };
  git(cwd, 'merge', '--abort');
  return { ok: false, err: r.err || r.out };
}

// After QA: move main to the integration branch, without touching uncommitted work.
export function promote(root, cfg) {
  const ib = cfg.integrationBranch, main = cfg.mainBranch;
  const idir = integrationDir(root, cfg);
  const sync = catchUp(idir, main); // main may have commits made by hand
  if (!sync.ok) return { ok: false, why: `${main} and ${ib} conflict: merge them by hand` };
  if (currentBranch(root) === main) {
    if (!isClean(root)) return { ok: false, why: `you have uncommitted changes on ${main}` };
    const r = git(root, 'merge', '--ff-only', ib);
    return r.ok ? { ok: true } : { ok: false, why: r.err };
  }
  const r = git(root, 'fetch', '.', `${ib}:${main}`);
  return r.ok ? { ok: true } : { ok: false, why: r.err };
}

// `pr` policy: push the branch and open a pull request with the GitHub CLI.
export function openPullRequest(cwd, cfg, t) {
  const branch = `feature/${t.id}`;
  const push = git(cwd, 'push', '-u', 'origin', branch);
  if (!push.ok) return { ok: false, why: `push failed: ${push.err}` };
  const r = spawnSync('gh', ['pr', 'create', '--base', cfg.mainBranch, '--head', branch,
    '--title', `${t.id}: ${t.title}`, '--body', `${t.task}\n\n**Acceptance criteria**\n${t.criteria}\n\n_Opened by solo-company._`],
  { cwd, encoding: 'utf8' });
  return r.status === 0 ? { ok: true, url: r.stdout.trim() } : { ok: false, why: (r.stderr || r.error || '').toString().trim() };
}
