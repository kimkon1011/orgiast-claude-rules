// 案件ハブの読み取りと表示。配信済みチェックポイントの保存は digest の送信成功時だけ行う。
import { caseWatch, client } from './case-handoff.mjs';
import { hash, CASE_ID } from './lib/case-handoff.mjs';
import { redactSecrets } from './redact-secrets.mjs';

const DAY = 86400000;
const stamp = /^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/gm;
const lines = text => String(text || '').split('\n').map(s => s.trim()).filter(Boolean);
// Do not interpret decimal values such as 1.5 as list markers.
const numberedMarker = String.raw`(?:\d+[.)．）](?!\d)|[①-⑳])`;
const itemPrefix = new RegExp(String.raw`^\s*(?:[-*]\s+|${numberedMarker}\s*)`);
const itemBoundary = new RegExp(String.raw`(?<=[\s。、；;])(?=${numberedMarker})`);
function displayItem(text, limit = Infinity) {
  const clean = redactSecrets(String(text))
    .replace(/\[[^\]\r\n]*20\d{2}-[^\]\r\n]*\]/g, '')
    .replace(itemPrefix, '')
    .replace(/\s+/g, ' ').trim();
  const chars = Array.from(clean);
  return chars.length > limit ? `${chars.slice(0, limit - 1).join('')}…` : clean;
}
// Split before display truncation so a kim request late in a paragraph is still found.
const items = text => lines(text).flatMap(line => line.split(itemBoundary).map(s => s.trim()).filter(Boolean));
const needsKim = text => /kim\s*待ち|送信OK|kim\s*(?:の\s*)?(?:判断|返事|承認)|kim\s*による|[「『]?送って[」』]?\s*待ち|送信可否未承認|保留|kim\s*に\s*確認/i.test(text);
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
  const fresh = decisions.filter(d => !(previous?.decisions || []).map(decisionKey).includes(decisionKey(d)));
  const next = items(section['未完了・次の一手']).filter(incomplete).filter(s => !needsKim(s)).slice(0, 3);
  const waiting = [...new Set(Object.entries(section)
    .filter(([heading]) => !['顧客の意向', '関連ファイル・ID'].includes(heading))
    .flatMap(([, content]) => items(content)).filter(incomplete).filter(needsKim)
    .map(s => displayItem(s)))];
  const name = data.name || data.caseName || section['案件名']?.trim() || '案件名未登録';
  const prefix = `${id} ${displayItem(name)}`;
  const unchanged = previous?.fingerprint === fingerprint;
  const heading = `${prefix}: ${unchanged ? '変化なし' : '案件進捗'}${suffix}`;
  const footer = `最終更新: ${last}`;
  const labels = ['決定事項: ', '未完了・次の一手: ', 'kim の判断待ち: '];
  const summaries = [fresh, next, waiting].map((group, i) =>
    group.map(s => displayItem(s)).join(' ／ ') || ['新しい決定なし', '未確認', 'なし'][i]);
  const progress = unchanged ? `${heading}・最終更新 ${last}` :
    [heading, labels[0] + summaries[0], labels[1] + summaries[1], footer].join('\n');
  const references = section['関連ファイル・ID']?.trim();
  const details = references && !/^(?:未確認|なし)$/.test(references) ? `\n関連ファイル・ID: ${redactSecrets(references)}` : '';
  const entries = [{ caseId: id, kind: 'info', text: progress + details }];
  if (waiting.length) entries.push({ caseId: id, kind: 'ask', text: `${prefix}\n${labels[2]}${summaries[2]}\n${footer}${details}` });
  const text = unchanged && !waiting.length ? progress :
    [heading, ...summaries.map((summary, i) => labels[i] + summary), footer].join('\n');
  return { text, entries, checkpoint };
}
export async function collectCaseProgress({ home, now, previous = {}, fetchResume, fetchCatalog, dryRun = false }) {
  // 初回取り込みも既存PCで動く。追加のスケジュールタスクは不要。
  const watched = caseWatch(home, { now, persist: !dryRun });
  const output = [], entries = [], checkpoints = {};
  let hub, catalog = [];
  try {
    catalog = await (fetchCatalog || (fetchResume ? async () => [] : () => {
      hub ||= client({ home }); return hub.catalog(true, { persist: !dryRun });
    }))();
    for (const row of catalog) {
      if (!CASE_ID.test(row.id)) continue;
      watched.cases[row.id] ||= { addedAt: new Date(now).toISOString(), reason: 'catalog' };
    }
    if (!dryRun && catalog.length) caseWatch(home, { add: Object.keys(watched.cases), now, reason: 'catalog' });
  } catch {
    const text = '案件カタログ: 照会失敗（次回再試行。登録済み案件は確認を継続）';
    output.push(text); entries.push({ kind: 'info', text });
  }
  for (const [id, watch] of Object.entries(watched.cases)) {
    try {
      const data = await (fetchResume || (caseId => { hub ||= client({ home }); return hub.fetchResume(caseId); }))(id);
      if (typeof data?.state !== 'string' || typeof data?.log !== 'string') throw Error('STATE/LOG の形式が不正');
      const result = formatCaseProgress(id, { ...data, name: catalog.find(row => row.id === id)?.name || data.name }, previous[id], now);
      if (!result.entries.some(entry => entry.kind === 'ask') && expiredCase(data.state, watch.addedAt, now)) {
        if (!dryRun) caseWatch(home, { remove: [id], now });
        continue;
      }
      output.push(result.text); entries.push(...result.entries); checkpoints[id] = result.checkpoint;
    } catch (error) { const text = `${id} ${catalog.find(row => row.id === id)?.name || '案件名未登録'}: 照会失敗（${displayItem(error.message || error)}）`; output.push(text); entries.push({ caseId: id, kind: 'info', text }); }
  }
  return { text: output.length ? `【案件進捗】\n${output.join('\n')}` : '', entries, checkpoints };
}
