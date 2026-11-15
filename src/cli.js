import { createInterface } from 'node:readline';
import { mkdirSync, writeFileSync, copyFileSync, readdirSync, existsSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, dirOf, load, save } from './config.js';
import { detect } from './agents.js';
import { TicketStore } from './tickets.js';

const TEMPLATES = join(dirname(fileURLToPath(import.meta.url)), '..', 'templates');

const HELP = `solo-company — your local AI agent as a small software company (WIP)

  solo-company init                 set up .solo-company/ in this project
  solo-company status               tickets by state
  solo-company request "text"       add a request for the PM
  solo-company approve <ticket>     approve a UX mockup: its dev drafts become tickets
  solo-company help`;

export async function main(argv) {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'init': return init();
    case 'status': return status();
    case 'request': return request(rest.join(' '));
    case 'approve': return approve(rest[0]);
    case undefined: case 'help': case '--help': case '-h': console.log(HELP); return;
    default: throw new Error(`unknown command "${cmd}" (try: solo-company help)`);
  }
}

async function init(root = process.cwd()) {
  const dir = dirOf(root);
  if (existsSync(join(dir, 'config.json'))) throw new Error('.solo-company/ already exists here');
  // Line iterator instead of rl.question(): also works when answers are piped in.
  const rl = createInterface({ input: process.stdin });
  const lines = rl[Symbol.asyncIterator]();
  const ask = async (q) => { process.stdout.write(q); const r = await lines.next(); return r.done ? '' : r.value; };
  try {
    const cfg = structuredClone(DEFAULTS);
    const goal = (await ask('What are you building? ')).trim();

    const found = detect();
    const choices = [...found.map((a) => a.name), 'custom'];
    console.log(found.length ? `Agents found: ${found.map((a) => a.label).join(', ')}` : 'No known agent CLI found on PATH.');
    let pick = (await ask(`Agent to use [${choices.join('/')}] (${choices[0]}): `)).trim() || choices[0];
    if (!choices.includes(pick)) pick = 'custom';
    cfg.agent = pick === 'custom'
      ? { name: 'custom', command: (await ask('Command that reads a prompt on stdin: ')).trim() }
      : { name: pick };

    const merge = (await ask('Merge policy [auto/pr/manual] (pr): ')).trim() || 'pr';
    cfg.merge = ['auto', 'pr', 'manual'].includes(merge) ? merge : 'pr';

    const checks = (await ask('Checks to run on delivered work, comma separated (e.g. npm test): ')).trim();
    cfg.checks = checks ? checks.split(',').map((s) => s.trim()).filter(Boolean) : [];

    mkdirSync(join(dir, 'roles'), { recursive: true });
    save(cfg, root);
    writeFileSync(join(dir, 'GOAL.md'), `# Goal\n\n${goal || '(describe what you are building)'}\n`);
    writeFileSync(join(dir, 'REQUESTS.md'), '# Requests\n\nOne request per line. The PM turns them into tickets.\n\n');
    writeFileSync(join(dir, 'tickets.json'), '[]\n');
    for (const f of readdirSync(join(TEMPLATES, 'roles'))) copyFileSync(join(TEMPLATES, 'roles', f), join(dir, 'roles', f));
    journal(dir, 'company created');
    console.log(`\nDone. Edit ${join('.solo-company', 'GOAL.md')} and the role files any time.`);
  } finally {
    rl.close();
  }
}

function needCompany(root = process.cwd()) {
  const cfg = load(root);
  if (!cfg) throw new Error('no company here yet: run "solo-company init"');
  return { cfg, dir: dirOf(root) };
}

function status() {
  const { dir } = needCompany();
  const store = new TicketStore(dir);
  if (!store.tickets.length) return console.log('No tickets yet.');
  const by = Object.groupBy(store.tickets, (t) => t.state);
  for (const [state, list] of Object.entries(by)) {
    console.log(`\n${state} (${list.length})`);
    for (const t of list) console.log(`  ${t.id}  [${t.role}] P${t.priority}  ${t.title}`);
  }
}

function request(text) {
  if (!text.trim()) throw new Error('write the request, e.g. solo-company request "add dark mode"');
  const { dir } = needCompany();
  appendFileSync(join(dir, 'REQUESTS.md'), `- [ ] ${text.trim()}\n`);
  journal(dir, `request: ${text.trim()}`);
  console.log('Request added. The PM will turn it into tickets.');
}

function approve(id) {
  if (!id) throw new Error('which ticket? e.g. solo-company approve T12');
  const { dir } = needCompany();
  const store = new TicketStore(dir);
  const t = store.get(id);
  if (!t || t.role !== 'ux') throw new Error(`${id} is not a UX ticket`);
  const released = store.approveMockup(id);
  store.save();
  journal(dir, `mockup ${id} approved, ${released.length} dev tickets released`);
  console.log(`${id} approved: ${released.length} ticket(s) ready for the teams.`);
}

function journal(dir, text) {
  appendFileSync(join(dir, 'journal.log'), `${new Date().toISOString()}  ${text}\n`);
}
