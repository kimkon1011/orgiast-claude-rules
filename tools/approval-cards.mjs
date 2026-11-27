#!/usr/bin/env node
import { isEntry } from './is-entry.mjs';
import { registerCard, listActiveCards, markCardSent } from './lib/approval-cards.mjs';
export function main(args = process.argv.slice(2), { home, stdout = console.log } = {}) {
  const value = key => { const i = args.indexOf(key); return i < 0 ? undefined : args[i + 1]; };
  const target = { draftId: value('--draft-id'), to: value('--to'), subject: value('--subject'), channel: value('--channel') };
  if (args.filter(a => ['--register','--list','--mark-sent'].includes(a)).length !== 1) throw Error('--register | --list | --mark-sent を1つ指定してください');
  const result = args.includes('--register') ? registerCard({ ...target, shownTo: value('--shown-to'), at: value('--at') }, { home })
    : args.includes('--mark-sent') ? markCardSent(target, { home, by: value('--by') }) : listActiveCards({ home });
  stdout(JSON.stringify(result));
  return 0;
}
if (isEntry(import.meta.url)) try { process.exitCode = main(); } catch (error) { console.error(error.message); process.exitCode = 2; }
