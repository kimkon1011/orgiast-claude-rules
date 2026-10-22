import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseExecMarkers } from '../fleet-mail.mjs';
import { redactSecrets } from '../fleet-agent.mjs';
import { listDecisions } from '../pending-decisions.mjs';
import { POLICY, CATEGORY, DAY, HOUR, active, oldest, iso, millis, attempt, safe, outboundTracking, trackedMailIds } from './fleet-chase-ledger.mjs';

import { rolloutSummary, rolloutTop } from './fleet-chase-rollout.mjs';

export const DIGEST_LIMIT = 1900;
export const SEND_CAP_PER_TARGET = 3;

export function resendBody(item, n) {
  const source = redactSecrets(item.sourceMail.body || '');
  const marked = parseExecMarkers(source);
  const header = `【追跡 ${n}回目 / 原本 ${item.mailId} / 初回 ${item.createdAt}】\n`;
  // Execution markers must remain at the very beginning for parseExecMarkers.
  const body = marked.exec ? source.slice(0, source.length - marked.body.length) + header + marked.body : header + source;
  if (body.length > 20000) throw new Error('再送見出し込みで本文20000字超。原文を切らず手動解消待ち');
  return body;
}
function lastTime(item, action) {
  return millis(item.attempts.filter(a => a.action === action).at(-1)?.at);
}
function personFor(target, map) {
  const found = Object.entries(map).filter(([label, entry]) => !label.startsWith('_') &&
    [label, entry?.hostname, ...(entry?.aliases || [])].includes(target));
  const people = [...new Set(found.map(([, entry]) => entry.person).filter(Boolean))];
  return people.length === 1 ? people[0] : null;
}
async function sendChase(item, action, ctx) {
  const { home, now, request, persist, ledger } = ctx;
  if (!item.pendingSend) {
    const n = item.chaseMailIds.length + 1;
    const suffix = `${item.mailId.slice(-16).replace(/[^a-zA-Z0-9-]/g, '')}-${createHash('sha256').update(item.mailId).digest('hex').slice(0, 8)}`;
    const body = action === 'resend' ? resendBody(item, n)
      : `[作業依頼]【催促 ${n}回目】原本 ${item.mailId} の状況を返信してください。完了なら証拠（commit/URL/実測値）、できないなら理由を1行で。\n${item.title}`;
    const categoryTag = item.category === CATEGORY.decision ? '[判断依頼]' : item.category === CATEGORY.task ? '[作業依頼]' : '';
    const why = `${action === 'resend' ? `【再送${n}】` : '【催促】'}${categoryTag && !item.title.includes(categoryTag) ? categoryTag : ''}${item.title}`.slice(0, 1000);
    const execFields = action === 'resend' ? Object.fromEntries(['exec', 'execCwd', 'resumeSessionId']
      .filter(key => item.sourceMail[key] !== undefined).map(key => [key, item.sourceMail[key]])) : {};
    item.pendingSend = { action, payload: safe({ id: `mail-chase-${suffix}-${n}`, from: 'kim-PC', to: item.target,
      messageKind: action === 'resend' ? item.sourceMail.messageKind || item.sourceMail.kind || 'note' : 'note',
      ...execFields, body, why,
      auto: false, hop: 0, priority: item.sourceMail.priority || 'normal', chaseOf: item.id,
      expiresAt: iso(now + POLICY.resend) }) };
    // A crash or ambiguous HTTP failure reuses the same ID and payload on retry.
    persist();
  }
  const pending = item.pendingSend;
  fs.appendFileSync(path.join(home, '.claude', 'fleet-mail-sent.jsonl'),
    JSON.stringify({ at: iso(now), action: 'send-attempt', ...pending.payload }) + '\n', { mode: 0o600 });
  const response = await request('mail-send', pending.payload);
  if (response?.ok !== true) throw new Error('mail-send rejected');
  if (!item.chaseMailIds.includes(pending.payload.id)) item.chaseMailIds.push(pending.payload.id);
  fs.appendFileSync(path.join(home, '.claude', 'fleet-mail-sent.jsonl'),
    JSON.stringify({ at: iso(now), action: 'sent', id: pending.payload.id, to: item.target, chaseOf: item.id }) + '\n', { mode: 0o600 });
  attempt(item, pending.action, pending.payload.id, now);
  ledger.checks ||= {};
  ledger.checks[pending.payload.id] = { checkedAt: null };
  delete item.pendingSend;
  persist();
}
export async function chase(ledger, ctx) {
  const { now, freshness, pcMap = {}, sendDm, dryRun = false, persist = () => {} } = ctx;
  const plans = [];
  const sendsByTarget = new Map();
  for (const item of Object.values(ledger.items).filter(i => outboundTracking(i) && i.status === 'open').sort(oldest)) {
    if (millis(item.deferredUntil) > now) {
      item.nextActionAt = item.deferredUntil;
      plans.push({ id: item.id, target: item.target, action: 'deferred', at: item.nextActionAt });
      continue;
    }
    const unchecked = trackedMailIds(item).some(id => !ledger.checks?.[id]?.verified || ledger.checks[id].error);
    if (unchecked) {
      item.nextActionAt = iso(now + HOUR / 2);
      plans.push({ id: item.id, target: item.target, action: '状態確認待ち', at: item.nextActionAt });
      continue;
    }
    const created = millis(item.createdAt);
    const expiry = millis(item.sourceMail.expiresAt) || created + POLICY.resend;
    const due = created + Math.max(0, expiry - created) * 0.8;
    if (!item.seenAt && now < due) {
      item.nextActionAt = iso(due);
      plans.push({ id: item.id, target: item.target, action: '期限20%前に確認', at: item.nextActionAt });
      continue;
    }
    try {
      const health = await freshness(item.target);
      // ビーコン取得失敗（unknown）は「停止」の証拠ではない。fail-open で再送・催促を続ける
      // （unknown を停止扱いにすると、ビーコン障害中は全件の追跡が黙って止まる）。
      item.targetStopped = !!health.stale;
      item.targetFreshness = redactSecrets(health.text || '最終 poll 不明');
      if (item.targetStopped) {
        item.level = Math.max(item.level, 1);
        const person = personFor(item.target, pcMap);
        // kimへの直接DMは日次ダイジェストだけに集約する。
        const ownerIsKim = person && person === pcMap['kim-PC']?.person;
        const eligible = person && !ownerIsKim && !health.unknown;
        const dmAt = lastTime(item, 'owner-dm-attempt') + POLICY.ownerDm;
        item.nextActionAt = iso(Math.max(now, dmAt));
        plans.push({ id: item.id, target: item.target, action: eligible ? 'owner-dm' : '宛先停止（ダイジェスト）', at: item.nextActionAt });
        if (!dryRun && eligible && now >= dmAt) {
          // Rate-limit attempts, too: Discord failures must not ping the owner every half hour.
          attempt(item, 'owner-dm-attempt', person, now);
          persist();
          const response = await sendDm(person, redactSecrets(`${item.target} の電源と Claude Code 起動をお願いします（kim-PC からの依頼 ${item.title.slice(0, 200)} が届いていません）`));
          if (response?.delivered !== true && response?.delivered !== 'dm') throw new Error('owner DM failed');
          attempt(item, 'owner-dm', person, now);
          item.nextActionAt = iso(now + POLICY.ownerDm);
          persist();
        }
        continue;
      }
      const seen = millis(item.seenAt);
      let action, next;
      if (seen) {
        item.level = now - seen >= POLICY.escalate ? 3 : now - seen >= POLICY.reminder ? 2 : 0;
        const interval = item.level >= 3 ? POLICY.finalReminder : POLICY.reminder;
        next = Math.max(seen + POLICY.reminder, lastTime(item, 'reminder') + interval);
        action = 'reminder';
      } else {
        item.level = 0;
        next = Math.max(due, lastTime(item, 'resend') + POLICY.resend);
        action = 'resend';
      }
      next = Math.max(next, millis(item.rateLimitedUntil));
      if (now >= next) {
        const count = sendsByTarget.get(item.target) || 0;
        if (count >= SEND_CAP_PER_TARGET) {
          item.rateLimitedUntil = item.nextActionAt = iso(now + HOUR / 2);
          plans.push({ id: item.id, target: item.target, action: `${action}(rate-limited)`, at: item.nextActionAt });
          if (!dryRun) persist();
          continue;
        }
        // Count attempts too: a lost response may still mean the mail was delivered.
        sendsByTarget.set(item.target, count + 1);
        delete item.rateLimitedUntil;
      }
      item.nextActionAt = iso(Math.max(now, next));
      plans.push({ id: item.id, target: item.target, action, at: item.nextActionAt });
      if (!dryRun && now >= next) {
        await sendChase(item, action, { ...ctx, ledger, persist });
        item.nextActionAt = iso(now + (action === 'resend' || item.level >= 3 ? POLICY.resend : POLICY.reminder));
        persist();
      }
    } catch (error) {
      attempt(item, 'chase-error', error.message, now);
      item.level = 3;
      item.nextActionAt = iso(now + HOUR / 2);
      if (!dryRun) persist();
    }
  }
  return plans;
}
export function digestText(ledger, { home, now }) {
  const items = Object.values(ledger.items);
  const pending = items.filter(active).sort(oldest);
  const inbound = pending.filter(i => i.kind === 'inbound').length;
  const blocked = pending.filter(i => i.status === 'blocked').length;
  const stopped = pending.filter(i => i.targetStopped);
  const done = items.filter(i => i.status === 'done' && now - millis(i.lastEvidenceAt) < DAY).length;
  const stale = items.filter(i => i.status === 'stale').length;
  const decisions = listDecisions({ home, status: 'pending' }).length;
  const lines = [`📌 fleet 追跡: 未完了 ${pending.length} 件（送信 ${pending.length - inbound} / 受信 ${inbound} / ブロッカー ${blocked} / 宛先停止 ${stopped.length}）／24h で完了 ${done} 件`];
  lines.push(rolloutSummary(ledger));
  for (const item of rolloutTop(ledger)) lines.push(`遵守追跡: ${item.title.slice(0, 160)}`);
  const footer = [`要 kim 判断: ${decisions} 件 → Discord の判断依頼チャンネルで回答`];
  const workExhausted = pending.filter(i => i.attempts.filter(a => a.action === 'work').length >= POLICY.workAttempts).length;
  const finalLevel = pending.filter(i => i.level >= 3).length;
  if (workExhausted || finalLevel) footer.push(`L3 ${finalLevel} 件 / 自動消化5回失敗 ${workExhausted} 件（hookで追跡継続）`);
  for (const item of stopped.slice(0, 2)) footer.push(`宛先停止: ${item.target.slice(0, 40)}（${item.targetFreshness?.slice(0, 90)}）`);
  footer.push(`stale ${stale} 件／蘇生: --revive <id>`, '取り下げ: node tools/fleet-chase.mjs --cancel <id> --reason "<理由>"');
  let shown = 0;
  for (const item of pending.slice(0, 8)) {
    const workFailed = item.attempts.filter(a => a.action === 'work').length >= POLICY.workAttempts && item.status !== 'done';
    const chaseError = item.attempts.at(-1)?.action === 'chase-error' ? ' 追跡失敗（--jsonで理由確認）' : '';
    const line = `${shown === 0 ? '最古: ' : ''}${Math.floor((now - millis(item.createdAt)) / DAY)}日 ${item.target.slice(0, 40)} L${item.level} ${item.title.slice(0, 40)} (${item.id})${workFailed ? ' 自動消化5回失敗' : ''}${chaseError}`;
    if ([...lines, line, ...footer].join('\n').length + 40 > DIGEST_LIMIT) break;
    lines.push(line);
    shown++;
  }
  if (pending.length > shown) lines.push(`ほか ${pending.length - shown} 件`);
  lines.push(...footer);
  return redactSecrets(lines.join('\n'));
}
export async function digest(ledger, ctx) {
  const date = new Date(ctx.now + 9 * HOUR);
  const day = date.toISOString().slice(0, 10);
  if (date.getUTCHours() < 9 || ledger.digestDay === day) return { skipped: true };
  const text = digestText(ledger, ctx);
  if (ctx.dryRun) return { text, planned: true };
  const result = await ctx.notify(text);
  if (result?.delivered === 'dm') {
    ledger.digestDay = day;
    ctx.persist?.();
  }
  return { text, delivered: result?.delivered };
}
