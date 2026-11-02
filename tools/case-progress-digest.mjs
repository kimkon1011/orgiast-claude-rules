// 案件ハブの読み取りと表示。配信済みチェックポイントの保存は digest の送信成功時だけ行う。
import { caseWatch, client } from './case-handoff.mjs';
import { hash } from './lib/case-handoff.mjs';
import { redactSecrets } from './redact-secrets.mjs';

const DAY = 86400000;
const stamp = /^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/gm;
const lines = text => String(text || '').split('\n').map(s => s.trim()).filter(Boolean);
const inline = text => redactSecrets(String(text)).replace(/[\r\n]+/g, ' ').slice(0, 700);
export function sections(state) {
  const result = {}; let heading = '';
  for (const line of String(state).split('\n')) {
    const match = line.match(/^##\s+(.+?)\s*$/);
    if (match) { heading = match[1]; result[heading] = ''; }
    else if (heading) result[heading] += `${line}\n`;
  }
  return result;
}
export function expiredCase(state, addedAt, now) {
  // 更新日時や出典の日付では終了扱いにしない。延期時は遅い開催日を優先する。
  const dates = [];
  for (const line of lines(state)) {
    if (!/(開催日|開催予定|実施日|終了日|会期)/.test(line)) continue;
    const content = line.replace(/\[[^\]]*\]/g, '');
    for (const match of content.matchAll(/(?:(20\d{2})[年/\-])?(\d{1,2})[月/\-](\d{1,2})日?/g)) {
      const year = Number(match[1] || new Date(addedAt).getUTCFullYear());
      let date = Date.UTC(year, Number(match[2]) - 1, Number(match[3])) - 9 * 3600000;
      if (!match[1] && date < Date.parse(addedAt) - 180 * DAY) date = Date.UTC(year + 1, Number(match[2]) - 1, Number(match[3])) - 9 * 3600000;
      const parsed = new Date(date + 9 * 3600000);
      if (Number.isFinite(date) && parsed.getUTCMonth() === Number(match[2]) - 1 && parsed.getUTCDate() === Number(match[3])) dates.push(date);
    }
  }
  return dates.length > 0 && now > Math.max(...dates) + 14 * DAY;
}
export function formatCaseProgress(id, data, previous, now) {
  if (typeof data?.state !== 'string' || typeof data?.log !== 'string') throw Error('STATE/LOG の形式が不正');
  const section = sections(data.state);
  const fingerprint = hash(`${Object.entries(section).filter(([key]) => key !== '作業中の席').map(([key, value]) => `${key}\n${value}`).join('\n')}\n${data.log}`);
  const decisions = lines(section['決定事項']);
  const latestLog = [...data.log.matchAll(stamp)].map(m => Date.parse(m[0])).sort((a, b) => b - a)[0];
  const last = inline(section['最終更新']?.trim() || '席・時刻不明');
  const stalled = Number.isFinite(latestLog) ? now - latestLog >= DAY : true;
  const suffix = stalled ? `・停滞（${Number.isFinite(latestLog) ? '24時間以上 LOG なし' : 'LOG の更新時刻不明'}）` : '';
  const decisionKey = text => text.replace(/\s*\[[^\]]*20\d{2}[^\]]*\]\s*$/, '').trim();
  const checkpoint = { fingerprint, decisions: decisions.map(decisionKey), lastDeliveredAt: new Date(now).toISOString() };
  if (previous?.fingerprint === fingerprint) return { text: `${id}: 変化なし・最終更新 ${last}${suffix}`, checkpoint };
  const fresh = decisions.filter(d => !(previous?.decisions || []).map(decisionKey).includes(decisionKey(d)));
  const next = lines(section['未完了・次の一手']).filter(s => !/^[-*]?\s*\[x\]/i.test(s)).slice(0, 3);
  const waiting = lines(data.state).filter(s => !s.startsWith('#') && /kim待ち|送信OK|kim\s*の/i.test(s));
  const text = [`${id}: 案件進捗${suffix}`,
    `決定事項: ${inline(fresh.join(' ／ ') || '新しい決定なし')}`,
    `未完了・次の一手: ${inline(next.join(' ／ ') || '未確認')}`,
    `kim の判断待ち: ${inline(waiting.join(' ／ ') || 'なし')}`,
    `最終更新: ${last}`].join('\n');
  return { text, checkpoint };
}
export async function collectCaseProgress({ home, now, previous = {}, fetchResume, dryRun = false }) {
  // 初回取り込みも既存PCで動く。追加のスケジュールタスクは不要。
  const watched = caseWatch(home, { now, persist: !dryRun });
  const output = [], checkpoints = {};
  let hub;
  for (const [id, watch] of Object.entries(watched.cases)) {
    try {
      const data = await (fetchResume || (caseId => { hub ||= client({ home }); return hub.fetchResume(caseId); }))(id);
      if (typeof data?.state !== 'string' || typeof data?.log !== 'string') throw Error('STATE/LOG の形式が不正');
      if (expiredCase(data.state, watch.addedAt, now)) {
        if (!dryRun) caseWatch(home, { remove: [id], now });
        continue;
      }
      const result = formatCaseProgress(id, data, previous[id], now);
      output.push(result.text); checkpoints[id] = result.checkpoint;
    } catch (error) { output.push(`${id}: 照会失敗（${inline(error.message || error)}）`); }
  }
  return { text: output.length ? `【案件進捗】\n${output.join('\n')}` : '', checkpoints };
}
