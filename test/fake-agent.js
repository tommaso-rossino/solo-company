#!/usr/bin/env node
// A stand-in for a real agent CLI: reads the prompt on stdin, acts by role.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const prompt = readFileSync(0, 'utf8');
const role = prompt.match(/^ROLE: (\w+)/)?.[1];
const say = (o) => console.log('Thinking done.\n```json\n' + JSON.stringify(o) + '\n```');

if (process.env.FAKE_LIMIT === '1') { console.log('Claude AI usage limit reached'); process.exit(1); }

const title = prompt.match(/^TICKET (T\d+) \[\w+\] P\d: (.+)$/m);
switch (role) {
  case 'pm': {
    const req = prompt.split('# New requests from the owner')[1].split('# Open tickets')[0];
    const tickets = [];
    if (/hello/.test(req)) tickets.push({ title: 'Create hello.txt', role: 'dev', task: 'write hello.txt', criteria: 'hello.txt exists', priority: 2 });
    if (/impossible/.test(req)) tickets.push({ title: 'Impossible thing', role: 'dev', task: 'x', criteria: 'y' });
    if (/button/.test(req)) tickets.push({ title: 'Mockup button', role: 'ux', task: 'draw it', criteria: 'mockup',
      drafts: [{ title: 'Add button.txt', task: 'write button.txt', criteria: 'button.txt exists' }] });
    say({ tickets, questions: [] });
    break;
  }
  case 'dev': {
    const t = title[2];
    if (t === 'Create hello.txt') writeFileSync('hello.txt', 'hello\n');
    if (t === 'Add button.txt') writeFileSync('button.txt', 'button\n');
    if (t.startsWith('Fix')) writeFileSync('fixed.txt', 'fixed\n');
    say({ summary: `did ${t}`, done: true, blocker: '' });
    break;
  }
  case 'ux': {
    mkdirSync(join('mockups', title[1]), { recursive: true });
    writeFileSync(join('mockups', title[1], 'index.html'), '<button>Go</button>');
    say({ summary: 'mockup', done: true, blocker: '' });
    break;
  }
  case 'qa': {
    const ids = [...prompt.matchAll(/^TICKET (T\d+)/gm)].map((m) => m[1]);
    const marker = process.env.FAKE_QA_FAIL_ONCE;
    const failFirst = marker && !existsSync(marker);
    if (failFirst) writeFileSync(marker, '1');
    say({ results: ids.map((id, i) => failFirst && i === 0
      ? { id, pass: false, evidence: 'broken', bugs: [{ title: 'hello is wrong', steps: 'open', expected: 'fixed.txt exists', actual: 'no' }] }
      : { id, pass: true, evidence: 'all criteria met' }) });
    break;
  }
  case 'ceo':
    say({ reply: 'On it.', actions: [{ type: 'request', text: 'hello from the ceo' }, { type: 'enable', feature: 'research' }] });
    break;
  default:
    console.log('unknown role'); process.exit(2);
}
