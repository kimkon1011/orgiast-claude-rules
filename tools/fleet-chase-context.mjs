#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { resolveFleetLabel } from './lib/fleet-label.mjs';
import { loadLedger, readJson, saveJson, active, oldest, millis, DAY, CATEGORY } from './lib/fleet-chase-ledger.mjs';
import { redactSecrets } from './fleet-agent.mjs';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';
import { isEntry } from './is-entry.mjs';

export const CONTEXT_LIMIT = 1200;
export const REPEAT_MS = 30 * 60_000;
export const CONTEXT_COUNTS = Object.freeze({ inbound: 3, outbound: 2 });
export function selectContext(ledger, { home, sessionId = '', now = Date.now() } = {}) {
  const pending = Object.values(ledger.items).filter(active).sort(oldest);
  if (!pending.length) return '';
  const incoming = pending.filter(i => i.kind === 'inbound');
  const inbound = [];
  for (const item of incoming) {
    if (!['open', 'blocked'].includes(item.status)) continue;
    // Stop after the display limit; old inboxes may contain thousands of files.
    const mail = sessionId && /^[A-Za-z0-9-]+$/.test(item.mailId)
      ? readJson(path.join(home, '.claude', 'fleet-inbox', `${item.mailId}.json`)) : null;
    if (sessionId && mail?.presentedSession === sessionId) continue;
    inbound.push(item);
    if (inbound.length === CONTEXT_COUNTS.inbound) break;
  }
  const outbound = pending.filter(i => i.kind === 'outbound' && i.level >= 2).slice(0, CONTEXT_COUNTS.outbound);
  const header = `[fleet-chase 未完了債務 ${pending.length} 件（受信 ${incoming.length} / 送信 ${pending.length - incoming.length}）] 完了の証拠が出るまで毎セッション表示されます。期限切れでも消えません。\n`;
  const footer = '一覧: node tools/fleet-chase.mjs --status';
  let result = header;
  const rollout = pending.filter(item => item.kind === 'rollout').sort((a, b) =>
    Number(b.pc === 'kim-PC' && b.subkind === 'violation') - Number(a.pc === 'kim-PC' && a.subkind === 'violation') || oldest(a, b))[0];
  if (rollout) {
    const line = rollout.pc === 'kim-PC' && rollout.subkind === 'violation'
      ? `kim-PC 自身 ${rollout.ruleId} 違反率 ${Math.round((rollout.latestRule?.rate || 0) * 100)}%: このセッションでも該当操作の前に ${rollout.summary}`
      : `rollout: ${rollout.title}`;
    result += redactSecrets(line).slice(0, 350) + '\n';
  }
  for (const item of [...inbound, ...outbound]) {
    const age = Math.floor((now - millis(item.createdAt)) / DAY);
    const deferred = millis(item.deferredUntil) > now ? ` 保留中:${item.deferredUntil} ${item.deferReason.slice(0, 35)}` : '';
    const instruction = item.category === CATEGORY.decision ? 'kim本人がDiscordで判断。ヘッドレスは代行禁止。'
      : `完了: node tools/fleet-mail.mjs --reply ${item.mailId} --body-file <file>`;
    const line = item.kind === 'inbound'
      ? `受信(最古) ${age}日 from=${item.from} id=${item.mailId} why=${item.title.slice(0, 40)}${deferred} → ${instruction} ／ 保留: node tools/fleet-chase.mjs --defer ${item.id} --until +3d --reason "<理由>"\n`
      : `送信 L${item.level} ${age}日 to=${item.target} id=${item.mailId} why=${item.title.slice(0, 40)}${deferred}（催促 ${item.attempts.filter(a => a.action === 'reminder').length} 回送付済・応答なし）\n`;
    const redacted = redactSecrets(line);
    if (result.length + redacted.length + footer.length <= CONTEXT_LIMIT) result += redacted;
  }
  return redactSecrets(result + footer).slice(0, CONTEXT_LIMIT);
}
export async function main({ home = process.env.ORGIAST_HOME || os.homedir(), now = Date.now,
  readStdin = readStdinWithTimeout, stdout = console.log, stderr = console.error } = {}) {
  try {
    if (resolveFleetLabel(home) !== 'kim-PC') return;
    const input = JSON.parse(await readStdin(100));
    const event = input.hook_event_name;
    if (!['SessionStart', 'UserPromptSubmit'].includes(event)) return;
    const session = String(input.session_id || '');
    const slug = /^[A-Za-z0-9_-]{1,100}$/.test(session) ? session : createHash('sha256').update(session).digest('hex').slice(0, 24);
    const marker = path.join(home, '.claude', 'fleet-chase', `.shown-${slug}.json`);
    const context = selectContext(loadLedger(home), { home, sessionId: session, now: now() });
    if (!context) return;
    const signature = createHash('sha256').update(context).digest('hex');
    const prior = readJson(marker);
    if (prior?.signature === signature && now() - prior.at < REPEAT_MS) return;
    // Sole hook write: the session-local suppression marker. Ledger/inbox remain read-only.
    saveJson(marker, { at: now(), signature });
    stdout(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: context } }));
  } catch { stderr('fleet-chase-context: 提示失敗（セッションは継続）'); }
}
if (isEntry(import.meta.url)) await main();
