#!/usr/bin/env node
import fs from 'node:fs';
import { writeHandoff } from './next-session-rotate.mjs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isEntry } from './is-entry.mjs';
import { auditHome, loadResources, buildPrompt, requestAudit, appendJsonl, fired } from './handoff-audit-gate.mjs';
import { scan } from './permanent-fix-deferral-scan.mjs';

export function readJsonl(file) {
  try { return fs.readFileSync(file, 'utf8').split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}
export function promotionFile(home) {
  return path.join(home, '.claude', 'handoff-audit-promotions.jsonl');
}
// 先送り検出器はこのファイルの隣のコピー（＝nightly-batch.ps1 が起動するデプロイ済みツリー）で走る。
// 夜間バッチは実行前に自己更新しないため、修正が origin/main に入ってもその夜は1日古い検出器で回り、
// 検証セッション自身の報告文（パターン名「恒久修正の先送り文」の引用）を P1 と誤検出して
// 余計な handoff を積んだ（2026-10-06 03:00:03 JST / session d401053d。検出器の更新は 03:02 着）。
// git クローン（nightly-bootstrap が origin/main を保つ）の方が新しいときはそちらを読む。
export function deferralDetectorFile(home, env = process.env) {
  const local = fileURLToPath(new URL('./permanent-fix-deferral-scan.mjs', import.meta.url));
  const root = env.ORGIAST_NIGHTLY_REPO || path.join(home, '.claude', 'nightly-repo');
  const clone = path.join(root, 'tools', 'permanent-fix-deferral-scan.mjs');
  // 改行コード差だけで「別物」と判定しないよう正規化してから比べる。
  const read = file => { try { return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'); } catch { return null; } };
  const cloneText = read(clone);
  if (cloneText === null || cloneText === read(local)) return { file: local, source: 'local', differs: false };
  return { file: clone, source: 'clone', differs: true };
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
  const routes = new Set();
  for (const line of output.split(/\r?\n/)) {
    const body = line.match(/^\s*\d+\. \[handoff-audit:[^\]]+\] (.*)$/)?.[1];
    if (!body) continue;
    const route = body.match(/（再発防止の経路: (.*)）/)?.[1]
      ?? body.match(/^.*?: (.*) を既存権限で調査・検証し結果を記録する/)?.[1];
    if (route !== undefined) routes.add(key(route));
  }
  for (const item of items) {
    const id = hash([key(item.pattern), key(item.route)]).slice(0, 16);
    if (output.includes(`[handoff-audit:${id}]`)) continue;
    if (routes.has(key(item.route))) continue;
    const oneLine = s => s.replace(/[\r\n]+/g, ' ').trim();
    const todo = `1. [handoff-audit:${id}] ${oneLine(item.pattern)} — この handoff が再発していないかを実物で検証し結果を記録する（再発防止の経路: ${oneLine(item.route)}）。送信・権限変更は既存の承認範囲を守る。kimへのDMなし。`;
    const heading = /^## 残TODO[^\r\n]*(?:\r?\n|$)/m;
    if (heading.test(output)) output = output.replace(heading, m => `${m.endsWith('\n') ? m : m + '\n'}${todo}\n\n`);
    else output += `\n<!-- NEXT-SESSION v1 -->\n## 残TODO\n${todo}\n`;
    routes.add(key(item.route));
  }
  return output;
}
export function deferralLedgerFile(home) {
  return path.join(home, '.claude', 'handoff-audit-deferral-ledger.jsonl');
}
export function deferralObservation(row) {
  return hash([row.ts, row.sessionId, row.pattern, row.match]);
}
export function deferralTodo(row) {
  const quote = String(row.match ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, 80);
  return {
    pattern: `恒久修正の先送り文を検出（${row.ts} / ${String(row.sessionId).slice(0, 8)} / ${row.pattern}）「${quote}」`,
    route: `違反セッションの先送りを当ターン内に実装まで終える（例: ${row.ts} / ${row.sessionId}）。検出は handoff-audit-nightly が毎晩自動実行する（tools/permanent-fix-deferral-scan.mjs）`
  };
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
    let reviewed = 0, added = 0, promoted = 0;
    for (const target of targets) {
      const observation = hash([target.sessionId, target.evidence]);
      if (done.has(observation)) continue;
      const result = await requestAudit(buildPrompt(target.evidence, { ...resources, knowledge }), { ...options, home });
      reviewed++;
      // 既知経路にない生成文を自動実行キューへ流さない。
      const learned = result.learned.filter(l => knownRoutes.has(l.route));
      const merged = mergeKnowledge(knowledge, learned, candidates, observation);
      if (merged.knowledge.length !== knowledge.length) fs.writeFileSync(knowledgeFile, JSON.stringify(merged.knowledge, null, 2) + '\n');
      // nightly-bootstrap が毎回 reset --hard する tree の外に置く。reset で route 文が消えないようにするため。
      for (const entry of merged.promoted) {
        appendJsonl(promotionFile(home), { ts: new Date().toISOString(), observation, ...entry });
        promoted++;
      }
      for (const candidate of merged.candidates.slice(candidates.length)) appendJsonl(candidateFile, candidate);
      const nextFile = path.join(dir, 'next-session.md');
      let previous = ''; try { previous = fs.readFileSync(nextFile, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      const updated = enqueueTodos(previous, learned.filter(l => l.confidence === 'high' || merged.promoted.some(p => key(p.pattern) === key(l.pattern))));
      if (updated !== previous) writeHandoff(nextFile, updated);
      added += merged.promoted.length;
      knowledge = merged.knowledge; candidates = merged.candidates;
      appendJsonl(processedFile, { ts: new Date().toISOString(), observation, sessionId: target.sessionId, ...result });
    }
    // 先送り検出器（恒久修正を設計のみで次セッションへ送る型）を夜間監査に載せる。
    // ここで失敗しても監査本体は落とさない（fail-open）。ただし黙らず deferral.error に残す。
    let deferral = { total: 0, hits: 0, byPattern: {}, enqueued: 0 };
    try {
      const from = since.toISOString(), to = until.toISOString();
      const detector = deferralDetectorFile(home, options.env || process.env);
      let usedDetector = detector.source;
      let detect = scan;
      if (detector.source === 'clone') {
        // クローン側が読めなければローカルの検出器で続行する（夜間監査を落とさない）。
        try {
          const module = await import(pathToFileURL(detector.file).href);
          if (typeof module.scan !== 'function') throw new Error('scan が無い検出器');
          detect = module.scan;
        } catch { detect = scan; usedDetector = 'local'; }
      }
      const report = detect({ home, since: from, until: to });
      const rows = report.sources.flatMap(source => (source.rows || []).map(row => ({ ...row, source: source.name })));
      const byPattern = {};
      let total = 0;
      for (const source of report.sources) {
        total += source.total || 0;
        for (const [pattern, count] of Object.entries(source.byPattern || {})) byPattern[pattern] = (byPattern[pattern] || 0) + count;
      }
      const ledgerFile = deferralLedgerFile(home);
      const seen = new Set(readJsonl(ledgerFile).filter(r => r.kind === 'hit').map(r => r.observation));
      const fresh = rows.filter(row => !seen.has(deferralObservation(row)));
      const ts = new Date().toISOString();
      // hits が 0 でも必ず書く（「0 は測った 0」を後から証明できるようにする）。
      appendJsonl(ledgerFile, { ts, kind: 'window', since: from, until: to, total, hits: rows.length, byPattern, detector: usedDetector, detectorDiffers: detector.differs });
      for (const row of fresh) appendJsonl(ledgerFile, { ts, kind: 'hit', observation: deferralObservation(row), ...row });
      let enqueued = 0;
      if (fresh.length > 0) {
        const nextFile = path.join(dir, 'next-session.md');
        let previous = ''; try { previous = fs.readFileSync(nextFile, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
        const updated = enqueueTodos(previous, fresh.map(deferralTodo));
        if (updated !== previous) { writeHandoff(nextFile, updated); enqueued = fresh.length; }
      }
      deferral = { total, hits: rows.length, byPattern, enqueued, detector: usedDetector, detectorDiffers: detector.differs };
    } catch (error) { deferral = { ...deferral, error: error.message }; }
    return { targets: targets.length, reviewed, added, promoted, deferral };
  } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}
if (isEntry(import.meta.url)) {
  try { console.log(JSON.stringify(await runNightly())); }
  catch (error) { console.error(`handoff-audit-nightly: ${error.message}`); process.exitCode = 1; }
}
