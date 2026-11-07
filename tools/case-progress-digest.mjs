// 案件ハブの読み取りと表示。配信済みチェックポイントの保存は digest の送信成功時だけ行う。
import { caseWatch, client } from './case-handoff.mjs';
import { hash } from './lib/case-handoff.mjs';
import { redactSecrets } from './redact-secrets.mjs';

const DAY = 86400000;
const stamp = /^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/gm;
const lines = text => String(text || '').split('\n').map(s => s.trim()).filter(Boolean);
// Do not interpret decimal values such as 1.5 as list markers.
const numberedMarker = String.raw`(?:\d+[.)．）](?!\d)|[①-⑳])`;
const itemPrefix = new RegExp(String.raw`^\s*(?:[-*]\s+|${numberedMarker}\s*)`);
const itemBoundary = new RegExp(String.raw`(?<=[\s。、；;])(?=${numberedMarker})`);
function displayItem(text, limit = 80) {
  const clean = redactSecrets(String(text))
    .replace(/\[[^\]\r\n]*20\d{2}-[^\]\r\n]*\]/g, '')
    .replace(itemPrefix, '')
    .replace(/\s+/g, ' ').trim();
  const chars = Array.from(clean);
  return chars.length > limit ? `${chars.slice(0, limit - 1).join('')}…` : clean;
}
// Split before display truncation so a kim request late in a paragraph is still found.
const items = text => lines(text).flatMap(line => line.split(itemBoundary).map(s => s.trim()).filter(Boolean));
const needsKim = text => /kim\s*待ち|送信OK|kim\s*の\s*(?:判断|返事)|kim\s*による/i.test(text);
const incomplete = text => !/^\s*\[x\]/i.test(text.replace(itemPrefix, ''));
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
  const last = displayItem(section['最終更新']?.trim() || '席・時刻不明');
  const stalled = Number.isFinite(latestLog) ? now - latestLog >= DAY : true;
  const suffix = stalled ? `・停滞（${Number.isFinite(latestLog) ? '24時間以上 LOG なし' : 'LOG の更新時刻不明'}）` : '';
  const decisionKey = text => text.replace(/\s*\[[^\]]*20\d{2}[^\]]*\]\s*$/, '').trim();
  const checkpoint = { fingerprint, decisions: decisions.map(decisionKey), lastDeliveredAt: new Date(now).toISOString() };
  if (previous?.fingerprint === fingerprint) return { text: `${id}: 変化なし・最終更新 ${last}${suffix}`, checkpoint };
  const fresh = decisions.filter(d => !(previous?.decisions || []).map(decisionKey).includes(decisionKey(d)));
  const next = items(section['未完了・次の一手']).filter(incomplete).filter(s => !needsKim(s)).slice(0, 3);
  const waiting = [...new Set(Object.entries(section)
    .filter(([heading]) => !['顧客の意向', '関連ファイル・ID'].includes(heading))
    .flatMap(([, content]) => items(content)).filter(incomplete).filter(needsKim)
    .map(s => displayItem(s)))];
  const heading = `${id}: 案件進捗${suffix}`;
  const footer = `最終更新: ${last}`;
  const labels = ['決定事項: ', '未完了・次の一手: ', 'kim の判断待ち: '];
  // Reserve space for all three sections and the update seat, even with many items.
  const budget = Math.floor((600 - Array.from(heading + footer + labels.join('')).length - 4) / 3);
  const summaries = [fresh, next, waiting].map((group, i) => {
    // Keep all three selected next steps visible, even when each one is long.
    const itemLimit = i === 1 && group.length ? Math.min(80, Math.floor((budget - (group.length - 1) * 3) / group.length)) : 80;
    return displayItem(group.map(s => displayItem(s, itemLimit)).join(' ／ ') || ['新しい決定なし', '未確認', 'なし'][i], budget);
  });
  const text = [heading, ...summaries.map((summary, i) => labels[i] + summary), footer].join('\n');
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
    } catch (error) { output.push(`${id}: 照会失敗（${displayItem(error.message || error)}）`); }
  }
  return { text: output.length ? `【案件進捗】\n${output.join('\n')}` : '', checkpoints };
}
