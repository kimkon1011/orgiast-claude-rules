#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';
import { CASE_ID } from './lib/case-handoff.mjs';
import { goalHome, goalsPath, loadGoals, updateGoals, writeJson, progressLine } from './lib/case-goals.mjs';
import { syncGoals } from './lib/case-goals-drive.mjs';

export async function main(args = process.argv.slice(2), { home = goalHome(), sync = syncGoals, out = console.log } = {}) {
  const [command, caseId, ...rest] = args;
  if (command === 'list') {
    if (caseId) throw Error('list に引数は不要です');
    const dir = path.join(home, '.claude', 'case-sessions');
    for (const id of fs.existsSync(dir) ? fs.readdirSync(dir).filter(id => CASE_ID.test(id)).sort() : []) {
      const data = loadGoals(id, home);
      if (data) out(`${id}\n${data.goals.map(g => progressLine(g)).join('\n')}`);
    }
    return;
  }
  goalsPath(caseId, home);
  if (command === 'show') {
    if (rest.length) throw Error('show にオプションは不要です');
    const data = loadGoals(caseId, home);
    out(data ? `${JSON.stringify(data, null, 2)}\n${data.goals.map(g => progressLine(g)).join('\n')}` : `${caseId}: 目標未登録`);
    return;
  }
  const allowed = command === 'set' ? ['metric', 'target', 'deadline', 'source', 'kim-approved'] : command === 'progress' ? ['metric', 'current', 'sent'] : [];
  if (!allowed.length) throw Error('usage: case-goals.mjs set|progress|show <caseId> | list');
  const opts = {};
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i].replace(/^--/, '');
    if (!rest[i].startsWith('--') || !allowed.includes(key) || key in opts || rest[i + 1] === undefined || rest[i + 1].startsWith('--')) throw Error(`invalid option: ${rest[i]}`);
    opts[key] = rest[i + 1];
  }
  // Reject local shrink before network access; refresh before committing so a
  // stale seat cannot overwrite a newer target from another seat.
  updateGoals(loadGoals(caseId, home), caseId, command, opts);
  await sync(caseId, { home });
  const data = updateGoals(loadGoals(caseId, home), caseId, command, opts);
  writeJson(goalsPath(caseId, home), data);
  try { await sync(caseId, { home }); }
  catch (e) { throw Error(`目標はローカル保存済み・Drive同期未完了: ${e.message}。case-handoff.mjs sync ${caseId} で再試行`); }
  out(`${caseId}\n${data.goals.map(g => progressLine(g)).join('\n')}`);
}
if (isEntry(import.meta.url)) await main().catch(e => { console.error(e.message); process.exitCode = e.exitCode || 1; });
