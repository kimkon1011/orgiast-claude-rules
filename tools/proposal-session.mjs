#!/usr/bin/env node
// 提案は FIFO で1件ずつ提示する。承認・実装・マージの判断は session-start の監督が行う。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { isEntry } from './is-entry.mjs';
import { acquireLock, resolveFleetLabel } from './fleet-mail.mjs';
import { launchNextSession } from './next-session-launch.mjs';
import { notifyKim } from './notify-kim.mjs';
import { redactSecrets } from './redact-secrets.mjs';

const START = '<!-- PROPOSAL-SESSION START -->';
const END = '<!-- PROPOSAL-SESSION END -->';
const ANSWER = '承認なら「承認」、却下なら「却下 <理由>」と答えてください。承認で Codex が onApprove の指示書を実行し PR→pr-merge まで進めます';
export const proposalHome = () => process.env.ORGIAST_HOME || os.homedir();
const read = (file, fallback = '') => { try { return fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; } };
const json = (file, fallback = null) => { const text = read(file); return text ? JSON.parse(text) : fallback; };
function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(tmp, value, { mode: 0o600 }); fs.renameSync(tmp, file); }
  finally { fs.rmSync(tmp, { force: true }); }
}
const save = (file, value) => write(file, `${JSON.stringify(value, null, 2)}\n`);
const textValue = (v) => typeof v === 'string' && v.trim().length > 0;
const validId = (id) => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id);
export function validateProposal(p) {
  if (!validId(p?.id) || !textValue(p.title) || !textValue(p.source) || !Array.isArray(p.evidence) || !p.evidence.every(textValue)
    || !textValue(p.proposal?.summary) || !Array.isArray(p.proposal.changes)
    || !p.proposal.changes.every(c => textValue(c.file || c.setting) && textValue(c.before) && textValue(c.after))
    || !Array.isArray(p.proposal.risks) || !p.proposal.risks.every(textValue)
    || !textValue(p.proposal.costImpact?.basis)
    || !(p.proposal.costImpact.perMonthUsd === null || Number.isFinite(p.proposal.costImpact.perMonthUsd))
    || JSON.stringify(p).includes(START) || JSON.stringify(p).includes(END)
    || p.onApprove?.kind !== 'codex-task' || !textValue(p.onApprove.promptFile) || !textValue(p.onReject)) throw new Error('invalid proposal');
  return p;
}
export function renderProposal(p) {
  const amount = p.proposal.costImpact.perMonthUsd;
  return [`# ${p.title}`, `提案ID: ${p.id} / 生成元: ${p.source}`, '', '## 提案', p.proposal.summary,
    '', '## 根拠', ...p.evidence.map(x => `- ${x}`), '', '## 変更内容',
    ...p.proposal.changes.map(c => `- ${c.file || c.setting}\n  変更前: ${c.before}\n  変更後: ${c.after}`),
    '', '## 費用効果', amount === null ? '月額効果: 未算定' : `月額削減見込み: $${amount}`,
    p.proposal.costImpact.basis, '', '## リスク', ...p.proposal.risks.map(x => `- ${x}`),
    '', '## 承認するとどうなる', `onApprove: codex-task / 指示書: ${p.onApprove.promptFile}`,
    'Codex が実装・関連テスト・PR作成を行い、監督が検証して tools/pr-merge.mjs でマージします。',
    '', '## 却下するとどうなる', p.onReject, '', ANSWER, ''].join('\n');
}
function list(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => validateProposal(json(path.join(dir, f))))
    .sort((a, b) => a.order - b.order || String(a.createdAt).localeCompare(String(b.createdAt)) || a.id.localeCompare(b.id));
}
function stripBlock(text) {
  const start = text.indexOf(START), end = text.indexOf(END);
  if (start < 0 && end < 0) return text;
  if (start !== 0 || end < start || text.indexOf(START, START.length) !== -1) throw new Error('invalid handoff block');
  return text.slice(end + END.length).replace(/^\r?\n\r?\n/, '');
}
function register(home, pending) {
  const file = path.join(home, '.claude', 'next-session.md');
  const original = stripBlock(read(file));
  const first = pending[0];
  write(file, first ? `${START}\n${renderProposal(first)}${END}\n\n${original}` : original);
}
const day = now => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(now);
const unique = values => [...new Map(values.map(v => [JSON.stringify(v), v])).values()];
function mergeCost(old, incoming) {
  return { ...old, evidence: unique([...old.evidence, ...incoming.evidence]),
    proposal: { ...old.proposal, changes: unique([...old.proposal.changes, ...incoming.proposal.changes]),
      risks: unique([...old.proposal.risks, ...incoming.proposal.risks]) } };
}
export async function submitProposal(input, { home = proposalHome(), dryRun = false, now = new Date(), promptText,
  notify = notifyKim, launch = launchNextSession, label = resolveFleetLabel, log = console.log, sendNotification = true } = {}) {
  let release;
  try {
    validateProposal(input);
    const dir = path.join(home, '.claude', 'proposals');
    if (!dryRun) { release = acquireLock(path.join(dir, '.queue.lock')); if (!release) throw new Error('busy'); }
    const pending = list(dir), done = list(path.join(dir, 'done'));
    let p = structuredClone(input);
    const prior = pending.find(x => x.id === p.id) || (p.source === 'cost-improve' && pending.find(x => x.source === p.source));
    if (done.some(x => x.id === p.id) || (!prior && p.source === 'cost-improve' && done.some(x => x.source === p.source && x.createdDay === day(now)))) {
      return { ok: true, skipped: '処理済み（cost-improve は1日1件まで）' };
    }
    if (prior) p = p.source === 'cost-improve' ? mergeCost(prior, p) : prior;
    else p = { ...p, status: 'pending', createdAt: now.toISOString(), createdDay: day(now), order: Math.max(0, ...pending.map(x => x.order || 0)) + 1 };
    const changed = !prior || JSON.stringify(p) !== JSON.stringify(prior);
    if (changed) p.revision = (prior?.revision || 0) + 1;
    const queue = prior ? pending.map(x => x.id === prior.id ? p : x) : [...pending, p];
    const first = queue[0];
    const dm = `実装提案セッションを用意しました: ${p.title.replace(/[\r\n\t]+/g, ' ')}（次に Claude Code を開くと先頭に出ます）`;
    if (dryRun) {
      log(redactSecrets(`[dry-run] 実装提案セッション: ${p.title}\n保存予定: ${dir}/${p.id}.{json,md}\n導線: next-session.md の先頭（既存本文を保持）\n提示順: ${queue.map(x => x.title).join(' → ')}\n起動: ${label(home) === 'kim-PC' ? 'launchNextSession --target vscode（Enter 1回が必要）' : 'スキップ（kim-PC 以外）'}\n\n${renderProposal(p)}\nDM予定: ${dm}`));
      return { ok: true, dryRun: true, proposal: p };
    }
    if (promptText && changed) {
      // 生成元の指示書は管理ディレクトリ内だけに保存。既存 cost 提案への追記は全文を再生成する。
      p.onApprove.promptFile = path.join(dir, `${p.id}.codex.md`);
      write(p.onApprove.promptFile, p.source === 'cost-improve' ? `${renderProposal(p)}\n上記の変更を実装し、関連テストを更新・実行して PR を作成してください。マージは監督が行います。\n` : promptText);
    }
    if (!fs.existsSync(p.onApprove.promptFile)) throw new Error('missing prompt');
    save(path.join(dir, `${p.id}.json`), p);
    write(path.join(dir, `${p.id}.md`), renderProposal(p));
    register(home, queue);
    // 後続の提案ごとにタブを増やさない。失敗通知は再投入時に再試行できる。
    if (first.id === p.id && !p.launchAttemptedAt && label(home) === 'kim-PC') {
      await launch(['--target', 'vscode', '--prompt', '/session-start'], { homedir: home, log: line => log(redactSecrets(line)) });
      p.launchAttemptedAt = now.toISOString();
      save(path.join(dir, `${p.id}.json`), p);
    }
    if (!p.notifiedAt && sendNotification) {
      const result = await notify(redactSecrets(dm), { home, webhookFallback: false });
      if (result?.delivered !== 'dm') throw new Error('notification failed');
      p.notifiedAt = now.toISOString();
    }
    save(path.join(dir, `${p.id}.json`), p);
    log(`提案セッション: ${redactSecrets(p.title)}`);
    return { ok: true, proposal: p, changed };
  } catch { log('proposal-session: 保存・登録・起動・通知のいずれかに失敗。再試行が必要です。'); return { ok: false }; }
  finally { release?.(); }
}

// 監督が PR の merged を確認した後、または却下後に呼ぶ。実装や承認判断を自動化しない。
export function completeProposal(id, { home = proposalHome(), decision, reason = '', pr = '', revision, dryRun = false, log = console.log } = {}) {
  let release;
  try {
    if (!validId(id) || !['approved', 'rejected'].includes(decision) || (decision === 'approved' && !/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(pr))) throw new Error('invalid completion');
    const dir = path.join(home, '.claude', 'proposals');
    if (!dryRun) { release = acquireLock(path.join(dir, '.queue.lock')); if (!release) throw new Error('busy'); }
    const pending = list(dir), p = pending.find(x => x.id === id);
    if (!p || pending[0].id !== id || Number(revision) !== p.revision) throw new Error('stale proposal');
    if (dryRun) { log(`dry-run: ${id} を ${decision} として完了予定`); return { ok: true }; }
    const dest = path.join(dir, 'done');
    save(path.join(dest, `${id}.json`), { ...p, status: decision, reason, pr, completedAt: new Date().toISOString() });
    for (const ext of ['md', 'codex.md']) {
      const file = path.join(dir, `${id}.${ext}`);
      if (fs.existsSync(file)) { fs.mkdirSync(dest, { recursive: true }); fs.renameSync(file, path.join(dest, `${id}.${ext}`)); }
    }
    fs.rmSync(path.join(dir, `${id}.json`));
    register(home, pending.filter(x => x.id !== id));
    log(`proposal-session: ${id} 完了、次の提案 ${pending.length - 1} 件`);
    return { ok: true };
  } catch { log('proposal-session: 完了処理を保留（先頭ID・revision・PR・保存状態を確認してください）。'); return { ok: false }; }
  finally { release?.(); }
}
export async function main(argv = process.argv.slice(2), io = {}) {
  try {
    const { values: v } = parseArgs({ args: argv, options: { file: { type: 'string' }, 'dry-run': { type: 'boolean' }, complete: { type: 'string' }, decision: { type: 'string' }, reason: { type: 'string' }, pr: { type: 'string' }, revision: { type: 'string' } } });
    if (Boolean(v.file) === Boolean(v.complete)) throw new Error('usage');
    if (v.file) await submitProposal(json(v.file), { ...io, dryRun: !!v['dry-run'] });
    else completeProposal(v.complete, { ...io, ...v, dryRun: !!v['dry-run'] });
  } catch { (io.log || console.log)('使い方: proposal-session.mjs --file <提案.json> [--dry-run] / --complete <id> --revision <番号> --decision approved --pr <URL> | rejected --reason <理由>'); }
  return 0;
}
if (isEntry(import.meta.url)) process.exitCode = await main();
