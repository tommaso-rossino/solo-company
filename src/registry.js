// The companies on this machine, so a chat anywhere can reach any of them by name.
// ~/.solo-company/companies.json (or $SOLO_COMPANY_HOME/companies.json).
import { mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename, resolve, dirname } from 'node:path';
import { readJson, writeJson, exists } from './util.js';

export const home = () => process.env.SOLO_COMPANY_HOME || join(homedir(), '.solo-company');
const file = () => join(home(), 'companies.json');
const real = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
const isCompany = (root) => exists(join(root, '.solo-company', 'config.json'));

export function list() {
  return readJson(file(), []).filter((c) => isCompany(c.root));
}

export function register(root) {
  root = real(root);
  const all = list().filter((c) => c.root !== root);
  // Names are unique: a second "app" becomes "app-2".
  const base = basename(root).toLowerCase().replace(/[^a-z0-9._-]+/g, '-') || 'company';
  let name = base;
  for (let i = 2; all.some((c) => c.name === name); i++) name = `${base}-${i}`;
  mkdirSync(home(), { recursive: true });
  writeJson(file(), [...all, { name, root, added: new Date().toISOString() }]);
  return name;
}

export function nameOf(root) {
  return list().find((c) => c.root === real(root))?.name || basename(root);
}

// Which company a chat means: a name, a path, the folder it runs in, or the only one there is.
export function resolveCompany(ref, cwd = process.cwd()) {
  const all = list();
  if (ref) {
    const r = String(ref).trim();
    const byName = all.find((c) => c.name === r.toLowerCase()) || all.find((c) => c.name.startsWith(r.toLowerCase()));
    if (byName) return byName.root;
    if (isCompany(resolve(cwd, r))) return real(resolve(cwd, r));
    throw new Error(`no company "${r}". Known: ${all.map((c) => c.name).join(', ') || 'none yet'}`);
  }
  for (let d = real(cwd); ; d = dirname(d)) {
    if (isCompany(d)) return d;
    if (dirname(d) === d) break;
  }
  if (all.length === 1) return all[0].root;
  if (!all.length) throw new Error('no company yet: create one first (company_create, or "solo-company init" in a git project)');
  throw new Error(`which company? Known: ${all.map((c) => c.name).join(', ')}`);
}
