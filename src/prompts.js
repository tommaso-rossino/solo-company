// Prompts: the editable role file + project context + a fixed answer contract.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { exists, tail } from './util.js';

export function read(dir, file) {
  const p = join(dir, file);
  return exists(p) ? readFileSync(p, 'utf8').trim() : '';
}

const role = (dir, name) => read(dir, join('roles', `${name}.md`));

export function ticketText(t) {
  return [
    `TICKET ${t.id} [${t.role}] P${t.priority}: ${t.title}`,
    `Task: ${t.task}`,
    `Acceptance criteria: ${t.criteria}`,
    t.why && `Why: ${t.why}`,
  ].filter(Boolean).join('\n');
}

const openList = (store) =>
  store.open().map((t) => `- ${t.id} [${t.role}] ${t.state} P${t.priority}: ${t.title}`).join('\n') || '(none)';

export function pmPrompt(ctx, pending) {
  const { dir, cfg, store } = ctx;
  const roles = ['dev', 'ux', ...(cfg.features.research.enabled ? ['research'] : [])];
  return `ROLE: pm
${role(dir, 'pm')}

# Goal
${read(dir, 'GOAL.md')}

# New requests from the owner
${pending.length ? pending.map((r) => `- ${r}`).join('\n') : '(none: plan the next steps towards the goal, or nothing if it is reached)'}

# Open tickets
${openList(store)}

# Recently done
${store.tickets.filter((t) => t.state === 'done').slice(-10).map((t) => `- ${t.id}: ${t.title}`).join('\n') || '(none)'}

Limits: each ticket at most ${cfg.limits.ticketMinutes} minutes. Roles you can use: ${roles.join(', ')}.
You may look at the code in the current folder to plan well, but do not change anything.

Answer with your reasoning if you like, then end with exactly one JSON object:
\`\`\`json
{"tickets": [{"title": "", "role": "dev", "task": "", "criteria": "", "why": "", "priority": 3, "minutes": 15,
  "after": "id of an existing ticket or #n for the n-th ticket of this list (optional)",
  "drafts": [ /* only for a ux ticket: the dev tickets that wait for the mockup approval, same fields */ ]}],
 "questions": ["only questions about money, accounts or real product choices"]}
\`\`\`
An empty "tickets" list means there is nothing useful to do now.`;
}

export function workPrompt(ctx, t, extra = '') {
  const { dir, cfg } = ctx;
  const contract = t.role === 'research'
    ? 'Write your findings as Markdown in the "report" field.'
    : t.role === 'ux'
      ? `Put every mockup file (HTML, SVG or images) in the folder mockups/${t.id}/ and nothing else.`
      : `Work only in this folder. Commit your work or leave it uncommitted: the engine commits what is left.
Checks the engine will run after you: ${cfg.checks.length ? cfg.checks.join(' && ') : '(none configured)'}.`;
  return `ROLE: ${t.role}
${role(dir, t.role)}

# Project goal
${read(dir, 'GOAL.md')}

# Your ticket
${ticketText(t)}
${t.lastFailure ? `\n# Previous attempt failed — fix this first\n${tail(t.lastFailure, 4000)}\n` : ''}${extra}
${contract}

End with exactly one JSON object:
\`\`\`json
{"summary": "what you did, in one or two sentences", "done": true,
 "blocker": "only if you cannot go on without the owner (money, account, real choice); otherwise empty"${t.role === 'research' ? ', "report": "markdown"' : ''}}
\`\`\``;
}

export function qaPrompt(ctx, tickets, checkReport) {
  const { dir } = ctx;
  return `ROLE: qa
${role(dir, 'qa')}

# Project goal
${read(dir, 'GOAL.md')}

# Delivered tickets to test (the code in the current folder contains them)
${tickets.map((t) => `${ticketText(t)}\nDev summary: ${t.summary || '-'}`).join('\n\n')}

# Automatic checks on this build
${tail(checkReport, 6000)}

Check every acceptance criterion of every ticket. End with exactly one JSON object:
\`\`\`json
{"results": [{"id": "T1", "pass": true, "evidence": "",
  "bugs": [{"title": "", "steps": "", "expected": "", "actual": ""}]}]}
\`\`\``;
}

export function ceoPrompt(ctx, message, summary) {
  const { dir, cfg } = ctx;
  return `ROLE: ceo
${role(dir, 'ceo')}

# Goal
${read(dir, 'GOAL.md')}

# Company now
${summary}

# Settings
teams: ${JSON.stringify(cfg.teams)}  merge: ${cfg.merge}  autoPlan: ${cfg.autoPlan}
features: ${JSON.stringify(cfg.features)}

# The owner says
${message}

Answer the owner briefly, in their language. If they ask for something, do it with actions.
End with exactly one JSON object:
\`\`\`json
{"reply": "",
 "actions": [
  {"type": "request", "text": "a request for the PM"},
  {"type": "enable", "feature": "nightShift|scheduledChecks|budget|research", "settings": {}},
  {"type": "disable", "feature": ""},
  {"type": "teams", "dev": 1, "ux": 1, "qa": 1},
  {"type": "priority", "id": "T1", "priority": 1},
  {"type": "cancel", "id": "T1"},
  {"type": "approve", "id": "T1"},
  {"type": "resume", "id": "T1", "advice": ""},
  {"type": "goal", "text": "new full goal text"}
 ]}
\`\`\`
Use only the actions you need; an empty list is fine.`;
}
