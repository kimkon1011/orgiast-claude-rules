#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isEntry } from './is-entry.mjs';
import { auditHome, loadResources, buildPrompt, requestAudit, appendJsonl, fired } from './handoff-audit-gate.mjs';

export function readJsonl(file) {
  try { return fs.readFileSync(file, 'utf8').split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}
const key = value => String(value).normalize('NFKC').trim().replace(/\s+/g, ' ');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function mergeKnowledge(knowledge, learned, candidates, observation) {
  const next = [...knowledge];
  const pending = [...candidates];
  const promoted = [];
  for (const item of learned) {
    if (next.some(k => key(k.pattern) === key(item.pattern))) continue;
    const prior = pending.find(c => key(c.pattern) === key(item.pattern) && key(c.route) === key(item.route) && c.observation !== observation);
    if (item.confidence === 'high' || prior) {
      const entry = { ...item, confidence: 'high', source: `handoff-audit-nightly:${observation}` };
      next.push(entry); promoted.push(entry);
    } else if (!pending.some(c => key(c.pattern) === key(item.pattern) && key(c.route) === key(item.route) && c.observation === observation)) pending.push({ ...item, observation });
  }
  return { knowledge: next, candidates: pending, promoted };
}
export function enqueueTodos(markdown, items) {
  let output = markdown;
  for (const item of items) {
    const id = hash([key(item.pattern), key(item.route)]).slice(0, 16);
    if (output.includes(`[handoff-audit:${id}]`)) continue;
    const oneLine = s => s.replace(/[\r\n]+/g, ' ').trim();
    const todo = `1. [handoff-audit:${id}] ${oneLine(item.pattern)}: ${oneLine(item.route)} を既存権限で調査・検証し結果を記録する。送信・権限変更は既存の承認範囲を守る。kimへのDMなし。`;
    const heading = /^## 残TODO[^\r\n]*(?:\r?\n|$)/m;
    if (heading.test(output)) output = output.replace(heading, m => `${m.endsWith('\n') ? m : m + '\n'}${todo}\n\n`);
    else output += `\n<!-- NEXT-SESSION v1 -->\n## 残TODO\n${todo}\n`;
  }
  return output;
}
export function selectTargets(audits, runners, since, until) {
  const inDay = r => Date.parse(r.ts) >= since && Date.parse(r.ts) < until;
  const targets = audits.filter(r => inDay(r) && r.fired && !r.skipped && (r.decision === 'pass' || r.verdict === 'pass')).map(r => ({ ...r, evidence: r.evidence || { text: r.excerpt || '', tools: [], evidenceMissing: true } }));
  const blocked = new Set();
  for (const r of [...runners].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))) {
    if (r.verdict === 'block') blocked.add(r.sessionId);
    if (!inDay(r) || !(r.retryCap || r.verdict === 'retry-cap' || (r.verdict === 'pass' && blocked.has(r.sessionId)))) continue;
    if (!r.auditEvidence && !fired(r.excerpt || '')) continue;
    targets.push({ ...r, evidence: r.auditEvidence || { text: r.excerpt || '', tools: [], evidenceMissing: true } });
  }
  const seen = new Set();
  return targets.filter(r => { const id = hash([r.sessionId, r.evidence]); if (seen.has(id)) return false; seen.add(id); return true; });
}
export async function runNightly(options = {}) {
  const home = options.home || auditHome();
  const dir = path.join(home, '.claude');
  fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, 'handoff-audit-nightly.lock');
  // 異常終了した前回だけ回収する。稼働中/所有者不明のロックは保持。
  try {
    const prior = JSON.parse(fs.readFileSync(lock, 'utf8'));
    if (Number.isInteger(prior.pid) && prior.pid > 0) {
      try { process.kill(prior.pid, 0); } catch (e) { if (e.code === 'ESRCH') fs.unlinkSync(lock); }
    }
  } catch { /* 未作成又は取得中 */ }
  let fd;
  try { fd = fs.openSync(lock, 'wx'); fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, ts: new Date().toISOString() })); } catch (e) { if (e.code === 'EEXIST') return { skipped: 'locked' }; throw e; }
  try {
    const now = options.now || new Date();
    const until = new Date(now); until.setHours(0, 0, 0, 0);
    const since = new Date(until); since.setDate(since.getDate() - 1);
    const knowledgeFile = options.knowledgeFile || fileURLToPath(new URL('./handoff-audit-knowledge.json', import.meta.url));
    let knowledge = JSON.parse(fs.readFileSync(knowledgeFile, 'utf8'));
    const resources = { ...(options.resources || loadResources(home)), knowledge };
    const candidateFile = path.join(dir, 'handoff-audit-candidates.jsonl');
    const processedFile = path.join(dir, 'handoff-audit-nightly-ledger.jsonl');
    let candidates = readJsonl(candidateFile);
    const done = new Set(readJsonl(processedFile).filter(r => r.verdict !== 'audit-unavailable').map(r => r.observation));
    const targets = selectTargets(readJsonl(path.join(dir, 'handoff-audit-ledger.jsonl')), readJsonl(path.join(dir, 'stop-gate-runner-ledger.jsonl')), +since, +until);
    const knownRoutes = new Set([...knowledge.map(k => k.route), ...Object.values(resources.routes).flat()]);
    let reviewed = 0, added = 0;
    for (const target of targets) {
      const observation = hash([target.sessionId, target.evidence]);
      if (done.has(observation)) continue;
      const result = await requestAudit(buildPrompt(target.evidence, { ...resources, knowledge }), { ...options, home });
      reviewed++;
      // 既知経路にない生成文を自動実行キューへ流さない。
      const learned = result.learned.filter(l => knownRoutes.has(l.route));
      const merged = mergeKnowledge(knowledge, learned, candidates, observation);
      if (merged.knowledge.length !== knowledge.length) fs.writeFileSync(knowledgeFile, JSON.stringify(merged.knowledge, null, 2) + '\n');
      for (const candidate of merged.candidates.slice(candidates.length)) appendJsonl(candidateFile, candidate);
      const nextFile = path.join(dir, 'next-session.md');
      let previous = ''; try { previous = fs.readFileSync(nextFile, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      const updated = enqueueTodos(previous, learned.filter(l => l.confidence === 'high' || merged.promoted.some(p => key(p.pattern) === key(l.pattern))));
      if (updated !== previous) fs.writeFileSync(nextFile, updated);
      added += merged.promoted.length;
      knowledge = merged.knowledge; candidates = merged.candidates;
      appendJsonl(processedFile, { ts: new Date().toISOString(), observation, sessionId: target.sessionId, ...result });
    }
    return { targets: targets.length, reviewed, added };
  } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}
if (isEntry(import.meta.url)) {
  try { console.log(JSON.stringify(await runNightly())); }
  catch (error) { console.error(`handoff-audit-nightly: ${error.message}`); process.exitCode = 1; }
}
