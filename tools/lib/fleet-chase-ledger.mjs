import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readInbox, mailCategory, hasDecisionRequest } from '../fleet-mail.mjs';
import { redactSecrets } from '../fleet-agent.mjs';
import { listDecisions } from '../pending-decisions.mjs';

export const HOUR = 3600_000;
export const DAY = 24 * HOUR;
// stale: 初回取込（バックフィル）で 7 日より古い依頼は自動追跡せず stale に置く。過去の未完了を一斉再送すると
// 相手PCに古い依頼の嵐が届く（2026-10-18 実測: 23 日前の「着手不要」訂正まで 60 件）。必要なものは --revive で個別に蘇生する。
export const POLICY = Object.freeze({ stale: 7 * DAY, resend: 3 * DAY, ownerDm: DAY,
  reminder: DAY, escalate: 2 * DAY, finalReminder: 3 * DAY, workRetry: 6 * HOUR,
  workLimit: 2, workAttempts: 5, workSeconds: 20 * 60, checkLimit: 20 });
export const CATEGORY = Object.freeze({ decision: mailCategory({ why: '[判断依頼]' }),
  task: mailCategory({ why: '[作業依頼]' }) });
export const BLOCKER = /権限がない|権限なし|できません|未オプトイン|承諾コマンド|判断待ち|BLOCKED|FAILED|exit=[1-9]|マージ権限|push.*権限/i;
export const outboundTracking = item => item.kind === 'outbound'
  || item.kind === 'rollout' && item.direction === 'outbound' && item.subkind !== 'convergence';
export const trackedMailIds = item => item.kind === 'rollout'
  ? [...new Set([...item.chaseMailIds, ...(item.pendingSend ? [item.pendingSend.payload.id] : [])])]
  : [item.mailId, ...item.chaseMailIds];
export const active = item => ['open', 'waiting', 'blocked'].includes(item.status);
export const iso = time => new Date(time).toISOString();
export const millis = value => typeof value === 'number' ? value : Date.parse(value) || 0;
export const oldest = (a, b) => millis(a.createdAt) - millis(b.createdAt) || a.id.localeCompare(b.id);
export const ledgerPath = home => path.join(home, '.claude', 'fleet-chase', 'ledger.json');
export function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
export function readLines(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return text.split(/\r?\n/).flatMap(line => {
    try { return line.trim() ? [JSON.parse(line)] : []; } catch { return []; }
  });
}
export function safe(value) {
  return JSON.parse(JSON.stringify(value, (_key, v) => typeof v === 'string' ? redactSecrets(v) : v));
}
export function saveJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(safe(value), null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(temp, file);
  } finally { fs.rmSync(temp, { force: true }); }
}
export function loadLedger(home) {
  const ledger = readJson(ledgerPath(home), { version: 1, items: {} });
  if (ledger.version !== 1 || !ledger.items || Array.isArray(ledger.items)) throw new Error('invalid chase ledger');
  return ledger;
}
export function attempt(item, action, detail, now) {
  item.attempts.push({ at: iso(now), action, detail: redactSecrets(detail) });
}
export function makeItem(mail, kind, now) {
  mail = safe(mail); // Redact full fields before creating excerpts.
  const createdAt = mail.createdAt || mail.at || iso(now);
  return safe({ id: `${kind}-${mail.id}`, kind, mailId: mail.id, chaseMailIds: [],
    target: kind === 'outbound' ? mail.to : mail.from, from: mail.from,
    title: mail.why || '', bodyHead: (mail.body || '').slice(0, 200), category: mailCategory(mail),
    createdAt, firstSeenAt: iso(now), status: now - millis(createdAt) > POLICY.stale ? 'stale' : 'open',
    level: 0, attempts: [], nextActionAt: iso(now), lastEvidenceAt: null, evidence: null,
    blockerSummary: '', deferredUntil: null, deferReason: '', sourceMail: mail });
}
export function ingest(ledger, { home, now }) {
  const dir = path.join(home, '.claude');
  const sent = readLines(path.join(dir, 'fleet-mail-sent.jsonl'));
  const noReply = /\[(?:回答|報告)・返信不要\]/;
  for (const mail of sent) {
    if (mail.action !== 'send-attempt' || !mail.id || mail.chaseOf) continue;
    if (!mail.to || /^(?:all|kim-PC)$/.test(mail.to) || /[,;\s]/.test(mail.to)) continue;
    if (mail.id.startsWith('mail-reply-') || mail.id.startsWith('mail-chase-') || mail.replyTo) continue;
    if (noReply.test(`${mail.why}\n${mail.body}`) || /\[配布通知\]/.test(`${mail.why}\n${mail.body}`)) continue;
    const item = makeItem(mail, 'outbound', now);
    ledger.items[item.id] ||= item;
  }
  for (const mail of sent.filter(m => m.chaseOf)) {
    const parent = ledger.items[mail.chaseOf] || ledger.items[`outbound-${mail.chaseOf}`];
    if (parent && !parent.chaseMailIds.includes(mail.id)) parent.chaseMailIds.push(mail.id);
  }
  for (const mail of readInbox(home, { unreadOnly: false })) {
    const tagged = /\[(?:作業|判断)依頼\]/.test(`${mail.why}\n${mail.body}`);
    if (mail.to !== 'kim-PC' && !(mail.to === 'all' && tagged)) continue;
    if (noReply.test(`${mail.why}\n${mail.body}`) || mail.replyTo || mail.id.startsWith('mail-reply-')) continue;
    if (![CATEGORY.decision, CATEGORY.task].includes(mailCategory(mail)) && mail.kind !== 'prompt') continue;
    const item = makeItem(mail, 'inbound', now);
    ledger.items[item.id] ||= item;
  }
  return ledger;
}
export function complete(item, evidence, now) {
  item.status = 'done';
  item.lastEvidenceAt = iso(now);
  item.evidence = evidence;
  item.nextActionAt = null;
}
function handBack(ledger, item, mail, now) {
  item.status = 'blocked';
  item.blockerSummary = redactSecrets(mail.resultBody).slice(0, 200);
  item.lastEvidenceAt = iso(now);
  item.evidence = { type: 'blocker', mailId: mail.id || item.mailId, at: mail.resultAt || iso(now), detail: item.blockerSummary };
  const id = `inbound-blocker-${item.mailId}`;
  if (ledger.items[id]) return;
  const derived = makeItem({ ...item.sourceMail, id: item.mailId, from: item.target, to: 'kim-PC',
    why: `[ブロッカー解消] ${item.title}`, body: `${item.blockerSummary}\n\n${item.sourceMail.body || ''}` }, 'inbound', now);
  Object.assign(derived, { id, derivedFrom: item.id, status: 'open', category: item.category === CATEGORY.decision ? CATEGORY.decision : CATEGORY.task });
  ledger.items[id] = derived;
}
export function checkInbound(ledger, { home, now }) {
  const inbox = new Map(readInbox(home, { unreadOnly: false }).map(m => [m.id, m]));
  const sent = readLines(path.join(home, '.claude', 'fleet-mail-sent.jsonl'));
  const decisions = listDecisions({ home });
  for (const item of Object.values(ledger.items).filter(i => i.kind === 'inbound' && active(i))) {
    const mail = inbox.get(item.mailId);
    if (!mail || mail.status !== 'done' || BLOCKER.test(mail.resultBody || '')) continue;
    if (item.derivedFrom && millis(mail.resultAt) < millis(item.firstSeenAt)) continue;
    if (item.rejectedCompletionAt && millis(mail.resultAt) <= millis(item.rejectedCompletionAt)) continue;
    if (item.category === CATEGORY.decision || hasDecisionRequest(item.sourceMail)) {
      // 判断依頼の完了証拠は「kim の回答が送られた」こと。pending-decisions は 'batched'（提示済み）までしか
      // 更新されない（2026-10-18 実測）ので status だけでは判定しない。
      //  (a) --answer が書く ~/.claude/fleet-answers/<id>.json（hub 回答・セッション再開）
      //  (b) --reply のログ（action:'reply'）
      //  (c) 対話セッションでの明示 --ack（ackAt あり）。decision-ack の受領 note は原本を done にしないので混同しない。
      const answered = fs.existsSync(path.join(home, '.claude', 'fleet-answers', `${item.mailId}.json`))
        || sent.some(r => r.id === item.mailId && r.action === 'reply')
        || Boolean(mail.ackAt);
      if (!answered) continue;
      const ack = sent.find(r => r.action === 'decision-ack' && r.id === item.mailId);
      const decision = decisions.find(d => d.id === ack?.decisionId);
      if (decision && decision.status === 'pending') continue; // 提示すらされていない判断は未回答とみなす
    }
    complete(item, { type: 'inbox', mailId: item.mailId, at: mail.resultAt || mail.ackAt || iso(now) }, now);
  }
}
export async function checkLedger(ledger, { home, now, request, stderr = console.error }) {
  const cache = readJson(path.join(home, '.claude', 'fleet-mail-sent-status.json'), {});
  ledger.checks ||= {};
  const candidates = [...new Set(Object.values(ledger.items).filter(i => outboundTracking(i) && active(i))
    .flatMap(trackedMailIds))];
  candidates.sort((a, b) => millis(ledger.checks[a]?.checkedAt) - millis(ledger.checks[b]?.checkedAt) || a.localeCompare(b));
  for (const id of candidates.slice(0, POLICY.checkLimit)) {
    const previous = ledger.checks[id] || {};
    ledger.checks[id] = { ...previous, checkedAt: iso(now) };
    try {
      // kim-PC は CPU 飽和で GAS 応答が 3〜8 秒かかる（5 秒では取得失敗が常態化・2026-10-18 実測）。
      const result = await request('mail-get', { id }, 15000);
      if (result?.ok !== true) throw new Error('mail-get rejected');
      ledger.checks[id] = { checkedAt: iso(now), mail: safe(result.mail), verified: true };
    } catch {
      ledger.checks[id].error = 'mail-get failed';
      stderr(`fleet-chase: 状態取得失敗 ${id}（次回再試行）`);
    }
  }
  for (const item of Object.values(ledger.items).filter(i => outboundTracking(i) && active(i))) {
    const ids = trackedMailIds(item);
    const replies = ids.map(id => ledger.checks[id]).filter(c => c?.verified && c.mail?.status === 'done').map(c => c.mail);
    const done = replies.find(m => !BLOCKER.test(m.resultBody || ''));
    if (done && item.kind === 'rollout') {
      const observedAt = item.replyEvidence?.mailId === done.id ? item.replyEvidence.at : iso(now);
      item.replyEvidence = { type: 'reply', mailId: done.id, at: done.resultAt || observedAt };
    } else if (done) {
      complete(item, { type: 'reply', mailId: done.id || item.mailId, at: done.resultAt || iso(now) }, now);
      for (const derived of Object.values(ledger.items).filter(i => i.derivedFrom === item.id && active(i))) {
        complete(derived, item.evidence, now);
      }
      continue;
    }
    if (replies.length && !done) {
      if (item.kind === 'rollout') item.blockerSummary = redactSecrets(replies[0].resultBody || '').slice(0, 200);
      else handBack(ledger, item, replies[0], now);
    }
    // Cache is a hint for timing only. It cannot establish completion.
    const states = ids.map(id => ledger.checks[id]?.mail || cache[id]).filter(Boolean);
    const seen = states.map(m => m.seenAt).filter(Boolean).sort();
    if (seen.length) item.seenAt = seen[0];
  }
  checkInbound(ledger, { home, now });
}
export function control(ledger, action, id, { reason, until, now }) {
  const item = ledger.items[id];
  if (!item) throw new Error('item not found');
  if (action !== 'revive' && !reason?.trim()) throw new Error('--reason required');
  if (action === 'cancel') {
    item.status = 'cancelled';
    item.nextActionAt = null;
  } else if (action === 'defer') {
    const relative = /^\+(\d+)d$/.exec(until || '');
    const time = relative ? now + Number(relative[1]) * DAY : Date.parse(until);
    if (!Number.isFinite(time) || time <= now) throw new Error('--until must be in the future');
    item.deferredUntil = iso(time);
    item.deferReason = redactSecrets(reason);
    item.nextActionAt = iso(time);
  } else if (action === 'revive') {
    if (item.status !== 'stale') throw new Error('revive requires stale item');
    item.status = 'open';
    item.nextActionAt = iso(now);
  }
  attempt(item, action, reason || 'stale → open', now);
}
