// Ticket register: a JSON file inside .solo-company/, the single source of truth.
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const STATES = ['draft', 'todo', 'in_progress', 'review', 'bugs_open', 'done', 'suspended', 'split', 'cancelled'];
export const ROLES = ['dev', 'ux', 'qa', 'research'];

// Allowed moves. Anything else is a bug in the caller.
const MOVES = {
  todo: ['in_progress', 'split', 'cancelled', 'suspended'],
  in_progress: ['review', 'done', 'todo', 'split', 'suspended', 'cancelled'],
  review: ['done', 'bugs_open', 'todo', 'suspended', 'cancelled'],
  bugs_open: ['done', 'cancelled'],
  suspended: ['todo', 'cancelled'],
  split: [],
  done: [],
  cancelled: [],
};

export class TicketStore {
  constructor(dir) {
    this.file = join(dir, 'tickets.json');
    this.tickets = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : [];
  }

  save() {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.tickets, null, 2) + '\n');
    renameSync(tmp, this.file); // atomic: a crash never leaves half a register
  }

  nextId() {
    const max = this.tickets.reduce((m, t) => Math.max(m, Number(t.id.slice(1)) || 0), 0);
    return `T${max + 1}`;
  }

  get(id) {
    return this.tickets.find((t) => t.id === id);
  }

  add({ title, role, task, criteria, why = '', priority = 3, minutes = 15, after = null, draftOf = null, fixes = null, tag = null }) {
    if (!title || !task || !criteria) throw new Error('a ticket needs title, task and criteria');
    if (!ROLES.includes(role)) throw new Error(`unknown role: ${role}`);
    const t = {
      id: this.nextId(),
      title, role, task, criteria, why,
      priority: Math.min(5, Math.max(1, priority)),
      minutes,
      state: draftOf ? 'draft' : 'todo',
      after,        // id of a ticket that must be done first
      draftOf,      // UX ticket whose approval releases this draft
      fixes,        // ticket whose QA bug this one fixes
      tag,          // engine marker, e.g. "build" for automatic build fixes
      attempts: 0,
      history: [],
      created: new Date().toISOString(),
    };
    this.tickets.push(t);
    this.log(t, 'created');
    return t;
  }

  move(id, state, note = '') {
    const t = this.get(id);
    if (!t) throw new Error(`no ticket ${id}`);
    const allowed = t.state === 'draft' ? ['todo', 'cancelled'] : MOVES[t.state];
    if (!allowed.includes(state)) throw new Error(`${id}: cannot go from ${t.state} to ${state}`);
    if (state === 'in_progress') t.attempts += 1;
    t.state = state;
    this.log(t, note ? `${state}: ${note}` : state);
    return t;
  }

  // Tickets that are not finished.
  open() {
    return this.tickets.filter((t) => !['done', 'cancelled', 'split'].includes(t.state));
  }

  // Approving a mockup turns its draft dev tickets into real ones.
  approveMockup(uxId) {
    const drafts = this.tickets.filter((t) => t.draftOf === uxId && t.state === 'draft');
    for (const d of drafts) this.move(d.id, 'todo', `mockup ${uxId} approved`);
    return drafts;
  }

  // Next tickets for a role: ready, dependencies done, most urgent first, then oldest.
  ready(role) {
    return this.tickets
      .filter((t) => t.role === role && t.state === 'todo')
      .filter((t) => !t.after || this.get(t.after)?.state === 'done')
      .sort((a, b) => a.priority - b.priority || a.created.localeCompare(b.created));
  }

  log(t, text) {
    t.history.push({ at: new Date().toISOString(), text });
  }
}
