import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { repoDir } from './gate-contracts.mjs';

const distributedKeys = JSON.parse(fs.readFileSync(path.join(repoDir, 'tools/keyserve-distribution-manifest.json'), 'utf8')).distributions.flatMap(d => d.keys).filter(k => /^[A-Z][A-Z0-9_]+$/.test(k));
export function missingAcquisition(text) {
  return text.split(/\r?\n\s*\r?\n/).filter(p => /kim\s*(?:に|へ)\s*(?:確認|聞[くい]|訊|尋ね)|分からなければ\s*kim/i.test(p)
    && !/(?:node|pwsh|powershell|gh|clasp|git)\s+[^\r\n`]+/.test(p) && !distributedKeys.some(key => p.includes(key)));
}
function files(dir) {
  return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e => {
    if (['.git','node_modules'].includes(e.name)) return [];
    const file=path.join(dir,e.name);
    return e.isDirectory()?files(file):[file];
  });
}
test('hook remedies, docs and every SKILL.md have an acquisition path', () => {
  const violations=[];
  for (const file of files(repoDir)) {
    const relative=path.relative(repoDir,file).replaceAll('\\','/');
    if (/\.test\.|fixtures\//.test(relative)) continue;
    if (!(relative.endsWith('SKILL.md') || relative.endsWith('.md') || /^tools\/.*\.(?:mjs|ps1)$/.test(relative))) continue;
    for(const paragraph of missingAcquisition(fs.readFileSync(file,'utf8'))) violations.push(`${relative}: ${paragraph.slice(0,160)}`);
  }
  assert.deepEqual(violations,[]);
});
test('lint rejects naked escalation, accepts a command or distributed key in the same paragraph', () => {
  assert.equal(missingAcquisition('kim に確認してください').length,1);
  assert.equal(missingAcquisition('kimに聞く\n\nnode tools/onboarding-sync.mjs --keys-only --force').length,1);
  assert.equal(missingAcquisition('kim に確認。先に node tools/keyserve-status.mjs --json').length,0);
  assert.equal(missingAcquisition('kim に聞く前に FEEDBACK_SHARED_FORM_URL を取得').length,0);
});
