import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readInbox } from '../fleet-mail.mjs';
import { buildFleetStatus, registrationCandidates } from '../fleet-status.mjs';
import { HOUR, active, iso, millis, readLines, safe, complete, parseUntil } from './fleet-chase-ledger.mjs';

export const EXPECT_RETRY_MS = HOUR;
export const EXPECT_LIMIT = 2;
const clean = value => String(value || '').normalize('NFKC').trim().toLowerCase();
export function machineNames(label, pcMap = {}) {
  const names = new Set([clean(label)]);
  for (const [key, entry] of Object.entries(pcMap)) {
    if (key.startsWith('_') || !entry || typeof entry !== 'object') continue;
    const ids = [key, entry.hostname, ...(entry.aliases || [])].filter(Boolean).map(clean);
    if (ids.includes(clean(label))) ids.forEach(id => names.add(id));
  }
  return names;
}
const same = (a, b, map) => [...machineNames(a, map)].some(n => machineNames(b, map).has(n));
export function registerExpectation(ledger, options, now) {
  const key = options['--expect'];
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(key || '')) throw new Error('invalid --expect key');
  const title = options['--match-why']?.trim(), reason = options['--reason']?.trim();
  const from = options['--from'] || 'any';
  if (!title || title.length > 1000 || !reason) throw new Error('--match-why and --reason required');
  if (!from.trim() || from.length > 128 || /[\r\n]/.test(from)) throw new Error('invalid --from');
  const until = parseUntil(options['--until'], now);
  const id = `expect-${key}`;
  if (ledger.items[id]) throw new Error(`expectation already exists: ${id}`);
  // Explicit past ISO dates are useful for investigation; relative durations must be positive.
  ledger.items[id] = safe({ id, key, kind: 'expect-inbound', target: from, from, title, reason,
    createdAt: iso(now), until: iso(until), nextActionAt: iso(until), status: 'waiting',
    level: 0, attempts: [], repairs: [], chaseMailIds: [], deferredUntil: null, deferReason: '' });
  return ledger.items[id];
}
export function matchesExpectation(item, mail, pcMap, now) {
  const at = millis(mail.createdAt || mail.receivedAt || mail.at);
  return !!mail.id && typeof mail.from === 'string' && !!mail.from.trim() && ['note', 'prompt'].includes(mail.kind || mail.messageKind)
    && at >= millis(item.createdAt) - 5 * 60000 && at <= now
    && String(mail.why || '').includes(item.title)
    && !same(mail.from, 'kim-PC', pcMap)
    && (item.from === 'any' || same(mail.from, item.from, pcMap));
}
export function classifyExpectation(item, { health, trace, pcMap = {}, now }) {
  const beacons = health?.ok ? health.beacons || [] : [];
  const rows = buildFleetStatus({ pcMap, beacons, serverPolls: health?.serverPolls || {}, now });
  const targets = item.from === 'any'
    ? rows.filter(r => !Object.keys(pcMap).some(label => !label.startsWith('_') && same(r.label, label, pcMap)))
    : rows.filter(r => same(r.label, item.from, pcMap));
  const mails = trace?.ok && Array.isArray(trace.mails)
    ? trace.mails.filter(m => matchesExpectation(item, m, pcMap, now)) : [];
  const errors = [];
  if (!health?.ok) errors.push('ビーコン照会失敗');
  if (!trace?.ok || !Array.isArray(trace.mails)) errors.push('送信痕跡照会失敗（サーバ未対応を含む）');
  if (trace?.truncated) errors.push('送信痕跡の件数上限超過');
  let cause = 'その他', detail = '一致する報告の受信を確認できない';
  const wrong = mails.filter(m => !same(m.to, 'kim-PC', pcMap) && m.to !== 'all');
  const failed = mails.filter(m => m.status === 'failed' || m.failReason);
  const unconverged = targets.filter(r => r.failing.some(s => /converg|sync|deploy|install|fleet-mail|fleet-poll|task:|settings:|hook:|skill:|repo:/i.test(s)));
  // Actual mail evidence takes precedence over a stale/missing beacon.
  let repairTargets = [];
  if (wrong.length) { cause = '宛先誤り'; detail = `送信先: ${[...new Set(wrong.map(m => m.to))].join(', ')}`; }
  else if (failed.length) { cause = '送信失敗'; detail = '一致する送信に failed/failReason を確認'; repairTargets = failed.map(m => m.from); }
  else if (unconverged.length) { cause = '配布未収束'; detail = 'ビーコンの配布・受信関連ステップが失敗'; repairTargets = unconverged.map(r => r.label); }
  else if (health?.ok && targets.length && targets.every(r => !r.pollAt || millis(r.pollAt) < millis(item.createdAt))) {
    cause = '未着手'; detail = '登録後の poll が観測されていない'; repairTargets = targets.map(r => r.label);
  }
  else if (mails.length) detail = 'サーバに送信あり、kim-PC のローカル受信は未確認';
  // Unknown/error is never proof of a stopped PC. Save the gaps alongside any positive evidence.
  return safe({ at: iso(now), cause, detail, errors, targets, mails, repairTargets: [...new Set(repairTargets)].filter(t => t && !same(t, 'kim-PC', pcMap)) });
}
function repairBody(item, cause) {
  const action = cause === '未着手'
    ? 'fleet-mail の poll と定期タスクを点検し、既存の許可範囲内で復旧してください。Windows は tools/fleet-fix-now.ps1 -NoOptin -NoLogin 相当の自己修復を使用してください。'
    : cause === '配布未収束' ? '配布の失敗ステップを点検し、既存の配布経路で最新 main を取得し、node tools/setup.mjs --converge で収束を促してください。'
      : 'fleet-mail の送信失敗理由を点検し、送信経路を復旧して報告を再送してください。';
  return `${action}\n受信待ちキー: ${item.key}\n報告の why: ${item.title}\n背景: ${item.reason}\n対象の作業記録がある場合だけ実際の点検結果を node tools/fleet-mail.mjs --send --to kim-PC --kind note --why <上記の報告why> --body-file <結果ファイル> で送ってください。作業記録がなければその旨を修復依頼への返信で知らせてください。資格情報の送信・オプトイン変更・kimへのDiscord DMは禁止。`;
}
export async function checkExpectations(ledger, ctx, { repair = false } = {}) {
  const { home, now, pcMap = {}, request, fetchBeacons, dryRun } = ctx;
  const persist = dryRun ? () => {} : ctx.persist || (() => {});
  const items = Object.values(ledger.items).filter(i => i.kind === 'expect-inbound' && active(i));
  const plans = [];
  // Also refresh candidates on ordinary check/chase, even if no expectation exists.
  let health;
  try { health = await fetchBeacons(); } catch { health = { ok: false }; }
  if (health?.ok) ledger.registrationCandidates = { at: iso(now), items: registrationCandidates({ pcMap, ...health, now }) };
  if (!items.length) return plans;
  const received = [...readInbox(home, { unreadOnly: false }), ...readLines(path.join(home, '.claude', 'fleet-mail-received.jsonl'))];
  const sends = new Map();
  for (const item of items) {
    const match = received.find(m => matchesExpectation(item, m, pcMap, now) && (same(m.to, 'kim-PC', pcMap) || m.to === 'all'));
    if (match) { complete(item, { type: 'expected-inbound', mailId: match.id, from: match.from, at: match.receivedAt || match.at || iso(now) }, now); persist(); continue; }
    if (millis(item.until) > now || millis(item.deferredUntil) > now) continue;
    // A second unsuccessful wait becomes debt; late arrivals can still complete it above.
    if (item.repairs.length >= EXPECT_LIMIT && now >= millis(item.nextActionAt)) {
      item.status = 'blocked'; item.level = 3;
      item.humanReason = '修復を2回依頼した後も報告未着。停止中のPCは同じpoll経路のpromptを受け取れないため、担当者による起動・Claudeログイン・受信許可の確認が必要。';
    }
    if (millis(item.nextActionAt) > now) continue;
    let trace;
    try {
      // Old GAS routes unknown kinds into status upserts. Never probe an unadvertised action.
      trace = health?.capabilities?.includes('mail-trace-v1')
        ? await request('mail-trace', { matchWhy: item.title, since: iso(millis(item.createdAt) - 5 * 60000) }, 15000)
        : { ok: false };
    }
    catch { trace = { ok: false }; }
    item.diagnosis = classifyExpectation(item, { health, trace, pcMap, now });
    for (const round of item.repairs) for (const route of round.routes) {
      try {
        const result = await request('mail-get', { id: route.payload.id }, 15000);
        route.result = result?.ok && result.mail ? safe({ status: result.mail.status, failReason: result.mail.failReason, resultBody: String(result.mail.resultBody || '').slice(0, 500) }) : { status: '確認不能' };
      } catch { route.result = { status: '確認不能' }; }
    }
    item.nextActionAt = iso(now + EXPECT_RETRY_MS);
    if (item.status === 'blocked' && item.repairs.length >= EXPECT_LIMIT) { persist(); continue; }
    if (item.repairs.length < EXPECT_LIMIT) { item.status = 'waiting'; delete item.humanReason; }
    const diagnosis = item.diagnosis;
    const targets = item.pendingRepair?.routes.map(r => r.payload.to) || diagnosis.repairTargets;
    plans.push({ id: item.id, target: targets.join(',') || item.target, action: `受信待ち調査: ${diagnosis.cause}`, at: iso(now) });
    if (!repair || dryRun) { item.nextActionAt = iso(now); continue; }
    if (!targets.length) {
      item.status = 'blocked'; item.level = 3;
      item.humanReason = diagnosis.errors.length ? `調査情報が不足: ${diagnosis.errors.join(' / ')}。接続・デプロイ状態の確認が必要。`
        : diagnosis.cause === '宛先誤り' ? '送信元の宛先指定を確認し、kim-PC 宛てに元の報告を再送する必要がある。'
          : '送信元や未着の原因を特定できないため、自己点検を貼ったPCで実行状況の確認が必要。';
      persist(); continue;
    }
    if (!item.pendingRepair) {
      const n = item.repairs.length + 1;
      item.pendingRepair = { at: iso(now), cause: diagnosis.cause, routes: targets.map(to => ({ payload: safe({
        id: `mail-expect-${createHash('sha256').update(`${item.id}:${item.createdAt}:${to}`).digest('hex').slice(0, 24)}-${n}`,
        from: 'kim-PC', to, messageKind: 'prompt', why: `[受信待ち修復] ${item.key} (${n}/2)`,
        body: repairBody(item, diagnosis.cause), auto: false, hop: 0, priority: 'normal',
        chaseOf: item.id, expiresAt: iso(now + 24 * HOUR) }) })) };
      persist(); // Durable IDs before transport; ambiguous failures reuse the same IDs.
    }
    for (const route of item.pendingRepair.routes) {
      if (route.sent || (sends.get(route.payload.to) || 0) >= 3) continue;
      sends.set(route.payload.to, (sends.get(route.payload.to) || 0) + 1);
      route.transportAttempts = (route.transportAttempts || 0) + 1;
      persist();
      try {
        fs.appendFileSync(path.join(home, '.claude', 'fleet-mail-sent.jsonl'), JSON.stringify({ at: iso(now), action: 'send-attempt', ...route.payload }) + '\n', { mode: 0o600 });
        const result = await request('mail-send', route.payload);
        if (!result?.ok) throw new Error('mail-send rejected');
        route.sent = true; route.result = { status: 'queued' };
        item.chaseMailIds.push(route.payload.id);
      } catch { route.result = { status: '送信失敗または応答不明' }; }
      persist();
    }
    if (item.pendingRepair.routes.every(r => r.sent || r.transportAttempts >= 2)) {
      item.repairs.push(item.pendingRepair); delete item.pendingRepair;
    }
    item.status = 'waiting'; persist();
  }
  return plans;
}
