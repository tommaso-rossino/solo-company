// The CEO: talk to the company in plain words; it answers and acts.
import { ask } from './agents.js';
import { ceoPrompt } from './prompts.js';
import { extractJson, journal, tail } from './util.js';
import * as co from './company.js';

export async function talk(ctx, message) {
  if (!String(message || '').trim()) throw new Error('tell the CEO something, e.g. solo-company ceo "enable the night shift"');
  journal(ctx.dir, `owner to CEO: ${message}`);
  const r = await ask(ctx, ceoPrompt(ctx, message, co.summary(ctx)), { cwd: ctx.root, mode: 'read' });
  if (r.limited) return { reply: 'The agent is at its usage limit right now. Your message is saved in the journal; try again later.', done: [] };
  const j = extractJson(r.out);
  if (!r.ok || !j) return { reply: tail(r.out || r.err, 2000) || 'The CEO did not answer.', done: [] };
  const done = [];
  for (const a of j.actions || []) {
    try {
      done.push(apply(ctx, a));
    } catch (e) {
      done.push(`could not ${a.type}: ${e.message}`);
    }
  }
  return { reply: String(j.reply || ''), done };
}

function apply(ctx, a) {
  switch (a.type) {
    case 'request': co.request(ctx, a.text); return `request added: ${a.text}`;
    case 'enable': co.setFeature(ctx, a.feature, true, a.settings || {}); return `${a.feature} enabled`;
    case 'disable': co.setFeature(ctx, a.feature, false); return `${a.feature} disabled`;
    case 'teams': co.setTeams(ctx, a); return `teams: ${JSON.stringify(ctx.cfg.teams)}`;
    case 'priority': case 'cancel': case 'approve': case 'resume':
      return co.ownerAction(ctx, { action: a.type, id: a.id, priority: a.priority, text: a.advice || '' }).message;
    case 'goal': co.setGoal(ctx, a.text); return 'goal updated';
    default: throw new Error('unknown action');
  }
}
