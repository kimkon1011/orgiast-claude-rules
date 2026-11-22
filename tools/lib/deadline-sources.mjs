import { ensureKimEditor } from './kim-editor.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { searchGmail } from '../gmail-search.mjs';
import { listDecisions } from '../pending-decisions.mjs';
import { readJson, jstDate } from '../deadline-ledger.mjs';
import { redactSecrets } from '../redact-secrets.mjs';
import { budgetMs as positiveBudget, withAbort } from './deadline-budget.mjs';
export const KEYWORDS = /期限|締切|締め切り|まで(に)?|満了|提出|回答|返送|納期|支払期日|振込期日|更新|期日|催告|督促|裁判|訴訟|答弁|準備書面|消防|質問書|届出|申請|報告書/;
export const trimBytes = text => Buffer.from(String(text || ''), 'utf8').subarray(0, 30000).toString('utf8').replace(/\uFFFD$/, '');
export function isAutomatic(mail) {
  return /github|fleet-mail|\[lane-health\]/i.test(`${mail.from || ''} ${mail.subject || ''}`)
    || /Claude.*(?:報告|まとめ|通知)|【[^】]*Claude Code】/i.test(`${mail.subject || ''} ${mail.snippet || ''}`)
    || /no-?reply/i.test(mail.from || '') && /自動返信|自動応答|auto.?reply|out of office/i.test(mail.subject || '');
}
export const wantsBody = m => !isAutomatic(m) && KEYWORDS.test(`${m.subject || ''} ${m.snippet || ''}`);
function windowState(previous = {}, now, limit) {
  const day = jstDate(now);
  return { ...previous, day, used: previous.day === day ? previous.used || 0 : 0, until: previous.until || now.toISOString(), limit };
}
function finishWindow(state, pageToken, count) {
  const next = { ...state, used: state.used + count, pageToken: pageToken || null };
  if (!pageToken) { next.watermark = state.until; delete next.until; delete next.query; delete next.pageToken; }
  return next;
}
const isBehind = (state, now) => Math.min(...[state.until, state.watermark].map(Date.parse).filter(Number.isFinite)) <= now.getTime() - 86400000;
export async function collectGmail({ user, state, now, search = searchGmail, limit = 400, signal }) {
  let current = windowState(state, now, limit);
  if (current.used >= limit) return { documents: [], next: current };
  const since = current.watermark ? ` after:${Math.floor(Date.parse(current.watermark) / 1000) - 1}` : '';
  const staleQuery = current.watermark && /(?:^|\s)newer_than:/.test(current.query || '');
  const query = !staleQuery && current.query || `${current.watermark ? '' : 'newer_than:3d '}-category:promotions -category:social -list:googlegroups-manage${since} before:${Math.ceil(Date.parse(current.until) / 1000)}`;
  current.query = query;
  const documents = [], behind = isBehind(current, now);
  for (let page = 0; page < (behind ? 50 : 1); page++) {
    const partial = reason => ({ documents, next: current, partial: { reason, remaining: current.pendingIds?.length } });
    if (signal?.aborted) return partial('Gmail取得の時間上限到達');
    let result;
    try {
      result = await search({
        user, query, max: 25, pageToken: current.pageToken, withBody: true, bodyLimit: 30000,
        shouldFetchBody: wantsBody, concurrency: 5, signal, allowPartial: true,
        pendingIds: current.pendingIds, resumeNext: current.resumeNext,
      });
    } catch (error) {
      if (signal?.aborted) return partial('Gmail取得の時間上限到達');
      if (page === 0) throw error;
      return partial(error.message);
    }
    const messages = result.messages || [], used = messages.filter(wantsBody).length;
    documents.push(...messages.filter(m => wantsBody(m) && m.body).map(m => ({
      source: 'Gmail', sourceRef: `gmail:${user}:${m.id}`, text: trimBytes(`${m.subject}\n${m.body}`),
      date: new Date(Number(m.internalDate) || Date.parse(m.date)).toISOString(), url: `https://mail.google.com/mail/u/${encodeURIComponent(user)}/#all/${m.threadId || m.id}`,
      mailbox: user, threadId: m.threadId, to: m.to,
    })));
    if (result.pendingIds?.length) {
      current = { ...current, used: current.used + used, pendingIds: result.pendingIds, resumeNext: result.nextPageToken };
      return partial(result.error || 'Gmail未取得メールを次回へ繰越');
    }
    delete current.pendingIds;
    delete current.resumeNext;
    current = finishWindow(current, result.nextPageToken, used);
    if (!result.nextPageToken || current.used >= limit) break;
  }
  return { documents, next: current };
}
const DRIVE_TEXT_MIME_TYPES = ['application/vnd.google-apps.document', 'application/pdf', 'image/jpeg', 'image/png', 'image/gif', 'image/bmp', 'image/webp'];
export async function readDriveText(file, { user, request, dryRun, signal, cleanupSignal }) {
  if (!DRIVE_TEXT_MIME_TYPES.includes(file.mimeType)) return '';
  let id = file.id, temporary;
  if (file.mimeType !== 'application/vnd.google-apps.document') {
    if (dryRun) return ''; // OCR copies are mutations; fixture dry-run supplies extracted text.
    const copy = await request(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}/copy?ocrLanguage=ja&fields=id&ignoreDefaultVisibility=true`, { user, method: 'POST', signal, body: { name: `deadline-ocr-${id}`, mimeType: 'application/vnd.google-apps.document', appProperties: { deadlineWatchOCR: '1' } } });
    if (!copy.id || copy.id === id) throw new Error('OCRコピーのIDが不正です');
    temporary = id = copy.id;

  }
  try { if (temporary) await ensureKimEditor(id, { actingUser: user, token: 'request-adapter', created: true, api: async (_token, url, options = {}) => { const value = await request(url, { user, signal, method: options.method || 'GET', ...(options.body ? { body: JSON.parse(options.body) } : {}) }); return { json: async () => value }; } });
    return trimBytes(await request(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}/export?mimeType=text%2Fplain`, { user, text: true, signal })); }
  finally {
    if (temporary) {
      const cleanup = cleanupSignal ? AbortSignal.any([cleanupSignal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000);
      await withAbort(cleanup, () => request(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(temporary)}`, { user, method: 'DELETE', signal: cleanup }));
    }
  }
}
export async function collectDrive({ user, state, now, request, dryRun = false, limit = 150, signal, onStage = () => {}, budgetMs = positiveBudget(process.env.DEADLINE_DRIVE_BUDGET_MS, 240_000), perFileTimeoutMs = positiveBudget(process.env.DEADLINE_DRIVE_FILE_TIMEOUT_MS, 45_000), nowMs = Date.now }) {
  let current = windowState(state, now, limit);
  if (current.query?.includes("mimeType contains 'image/'")) {
    delete current.query;
    delete current.pageToken;
  }
  let max = Math.max(0, limit - current.used);
  if (!max) return { documents: [], next: current, skipped: [{ reason: `Drive日次${limit}件上限（次回日付更新後に再開）` }] };
  const started = nowMs();
  const processedIds = new Set(current.processedIds || []);
  const since = current.watermark || new Date(now.getTime() - 3 * 86400000).toISOString();
  const mimeQuery = DRIVE_TEXT_MIME_TYPES.map(mimeType => `mimeType = '${mimeType}'`).join(' or ');
  const q = current.query || `trashed = false and modifiedTime > '${since}' and modifiedTime <= '${current.until}' and (${mimeQuery}) and not appProperties has { key='deadlineWatchOCR' and value='1' }`;
  current.query = q;
  const makeUrl = pageToken => {
    const params = new URLSearchParams({ q, orderBy: 'modifiedTime', pageSize: String(Math.min(1000, max)), fields: 'nextPageToken,files(id,name,mimeType,modifiedTime,webViewLink)', ...(pageToken ? { pageToken } : {}) });
    return `https://www.googleapis.com/drive/v3/files?${params}`;
  };
  const documents = [];
  const skipped = [];
  const behind = isBehind(current, now);
  let processed = 0;
  for (let page = 0; page < (behind ? 50 : 1); page++) {
    max = Math.min(1000, limit - current.used);
    let result;
    const listSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(Math.min(budgetMs, 60_000))]) : AbortSignal.timeout(Math.min(budgetMs, 60_000));
    try { result = await withAbort(listSignal, () => request(makeUrl(current.pageToken), { user, signal: listSignal })); }
    catch (error) {
      if (listSignal.aborted) return { documents, skipped, next: { ...current, processedIds: [...processedIds], used: current.used + processed }, partial: { reason: signal?.aborted ? '全体時間上限到達' : 'Drive一覧取得時間上限到達', processed } };
      if (!current.pageToken || !/HTTP 400/.test(error.message)) throw error;
      delete current.pageToken;
      result = await withAbort(listSignal, () => request(makeUrl(), { user, signal: listSignal }));
    }
    const resumed = (result.files || []).filter(file => processedIds.has(file.id)).length;
    onStage(`drive ${user} page (${result.files?.length || 0} files, ${resumed} already processed)`);
    for (const file of result.files || []) {
      if (processedIds.has(file.id)) continue;
      if (signal?.aborted || nowMs() - started >= budgetMs || current.used + processed >= limit) {
        return { documents, skipped, partial: { reason: signal?.aborted ? '全体時間上限到達' : current.used + processed >= limit ? `Drive日次${limit}件上限` : 'Drive時間予算到達', processed, remaining: (result.files || []).filter(item => !processedIds.has(item.id)).length }, next: { ...current, processedIds: [...processedIds], used: current.used + processed } };
      }
      let text;
      const fileLimit = AbortSignal.timeout(perFileTimeoutMs);
      const readLimit = AbortSignal.timeout(Math.max(1, perFileTimeoutMs - Math.min(5000, perFileTimeoutMs / 10)));
      const fileSignal = signal ? AbortSignal.any([signal, readLimit]) : readLimit;
      const boundedRequest = (url, options) => withAbort(options.signal, () => request(url, options));
      try { onStage(`drive ${user} file ${file.id} start`); text = await readDriveText(file, { user, request: boundedRequest, dryRun, signal: fileSignal, cleanupSignal: fileLimit }); onStage(`drive ${user} file ${file.id} end`); }
      catch (error) {
        skipped.push({ sourceRef: `drive:${file.id}`, title: file.name, reason: `Drive読み取り失敗: ${redactSecrets(error.message).slice(0, 120)}` });
        if (signal?.aborted) return { documents, skipped, partial: { reason: '全体時間上限到達', processed }, next: { ...current, processedIds: [...processedIds], used: current.used + processed } };
        processedIds.add(file.id); processed++; continue;
      }
      if (text) documents.push({ source: 'Drive', sourceRef: `drive:${file.id}`, text: trimBytes(`${file.name}\n${text}`), date: file.modifiedTime, url: file.webViewLink || `https://drive.google.com/file/d/${file.id}/view` });
      processedIds.add(file.id); processed++;
    }
    onStage(`drive ${user} processed=${processed} documents=${documents.length} skipped=${skipped.length} partial=false`);
    current = finishWindow(current, result.nextPageToken, processed);
    processed = 0;
    processedIds.clear();
    if (!result.nextPageToken || current.used >= limit) break;
  }
  delete current.processedIds;
  return { documents, skipped, next: current };
}
function timestamp(value) {
  const numeric = Number(value); return Number.isFinite(numeric) && numeric > 0 ? (numeric < 1e12 ? numeric * 1000 : numeric) : Date.parse(value);
}
export async function collectLine({ sheetId, state = {}, sheets, now }) {
  let values;
  try {
    values = await sheets.get(sheetId, 'Messages!A:H');
  } catch (error) {
    // The original LINE intake sheet predates the normalized Messages schema.
    // Keep it readable without changing the external sheet or its permissions.
    if (!/HTTP 400/.test(error.message)) throw error;
    values = await sheets.get(sheetId, "'受信ログ'!A:H");
  }
  const aliases = { '受信日時(JST)': 'ts', '表示名': 'sender', '本文': 'text', 'メッセージID': 'id' };
  const header = (values[0] || []).map(k => aliases[k] || k);
  if (!['id','ts','text'].every(k => header.includes(k))) throw new Error('LINE履歴の見出しが不足しています');
  const rows = values.slice(1).map(r => Object.fromEntries(header.map((k,i) => [k,r[i]])));
  const since = Date.parse(state.watermark || new Date(now.getTime() - 3 * 86400000).toISOString());
  const documents = rows.filter(r => timestamp(r.ts) > since && timestamp(r.ts) <= now.getTime()).map(r => ({
    source: 'LINE', sourceRef: `line:${sheetId}:${r.id}`, date: new Date(timestamp(r.ts)).toISOString(), text: trimBytes(`${r.sender || ''}: ${r.text || ''}`), url: `https://docs.google.com/spreadsheets/d/${sheetId}/edit`,
  }));
  // Timestamp watermark follows actual rows, not wall time: delayed sync remains eligible.
  return { documents, next: { watermark: documents.length ? new Date(Math.max(...documents.map(r => Date.parse(r.date)))).toISOString() : state.watermark || new Date(since).toISOString() } };
}

export async function collectDiscord({ home, state = {}, now }) {
  const intake = readJson(path.join(home, '.claude/discord-inbox-state.json'), null);
  if (!intake) return { documents: [], next: state };
  // The intake state contains a cursor only. Actual imported messages are decisions.
  const since = Date.parse(state.watermark || new Date(now.getTime() - 3 * 86400000).toISOString());
  const documents = listDecisions({ home }).filter(r => r.source === 'discord-inbox' && Date.parse(r.capturedAt) > since && Date.parse(r.capturedAt) <= now.getTime()).map(r => ({ source: 'Discord', sourceRef: `discord:${r.id}`, date: r.capturedAt, text: trimBytes(r.text), url: '' }));
  return { documents, next: { watermark: documents.length ? new Date(Math.max(...documents.map(r => Date.parse(r.date)))).toISOString() : state.watermark || new Date(since).toISOString() } };
}
export function sourceLoaders({ home, config, state, now, sheets, request, search, dryRun, onStage = () => {}, processSignal }) {
  const sourceSignal = () => processSignal ? AbortSignal.any([processSignal, AbortSignal.timeout(Number(process.env.DEADLINE_SOURCE_TIMEOUT_MS) || 60_000)]) : AbortSignal.timeout(Number(process.env.DEADLINE_SOURCE_TIMEOUT_MS) || 60_000);
  return [
    ...config.lineSheets.map(sheetId => ({ key: `line:${sheetId}`, load: () => collectLine({ sheetId, state: state.sources?.[`line:${sheetId}`], now, sheets }) })),
    { key: 'discord', load: () => collectDiscord({ home, state: state.sources?.discord, now }) },
    ...config.mailboxes.map(user => ({ key: `gmail:${user}`, handlesAbort: true, load: () => collectGmail({ user, state: state.sources?.[`gmail:${user}`], now, search, limit: config.gmailDailyLimit, signal: sourceSignal() }) })),
    ...config.driveUsers.map(user => ({ key: `drive:${user}`, handlesAbort: true, load: () => collectDrive({ user, state: state.sources?.[`drive:${user}`], now, request, dryRun, limit: config.driveDailyLimit, signal: processSignal, onStage }) })),
  ];
}
export function fixtureLoaders(dir) {
  return ['gmail','drive','line','discord'].map(name => ({ key: name, load: async () => ({ documents: readJson(path.join(dir, `${name}.json`), []), next: {} }) }));
}
