#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isEntry } from './is-entry.mjs';
import { readEnvValue } from './env-kv.mjs';
import { createClient, transcriptText, notesText, japanDate } from './tldv-drive-backfill.mjs';
import { matchCase, loadCasesWithRetry, resolvePC, inspectFleet, chooseExecution, createGoogle,
  loadEvents, jstDate, runHeadless, localWorkerArgs, localWorkerEnv } from './meeting-prep-dispatch.mjs';
import { autoProvider, resolveProvider } from './cheap-code.mjs';
import { resolveClaudeExecutableFromDisk, isUnspawnable } from './claude-exe.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOUR = 3600000;
const millis = value => typeof value === 'number' ? value : Date.parse(value);
const iso = value => new Date(millis(value)).toISOString();
const normalize = value => String(value || '').normalize('NFKC').toLowerCase().replace(/\s+/g, '');
const titleOf = meeting => meeting.name || meeting.title || '';
const safePart = value => encodeURIComponent(String(value)).replace(/\./g, '%2E');
const authError = error => [401, 403].includes(error?.status) || /tldv-http-(401|403)/.test(error?.message || '');
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(temp, text, { mode: 0o600 }); fs.renameSync(temp, file); }
  finally { fs.rmSync(temp, { force: true }); }
}
const saveJson = (file, data) => atomicWrite(file, JSON.stringify(data, null, 2) + '\n');
function initState(state) {
  for (const key of ['processed', 'skipped', 'held', 'pending', 'draftsSeen']) state[key] ||= {};
  return state;
}

export function isExcludedTitle(title, patterns = []) {
  return patterns.some(pattern => new RegExp(pattern, 'iu').test(title || ''));
}
export function meetingEnd(meeting) {
  return Date.parse(meeting.happenedAt) + (Number.isFinite(meeting.duration) && meeting.duration >= 0 ? meeting.duration * 1000 : 0);
}
export function selectCandidates(meetings, state, { now = Date.now(), config }) {
  const candidates = [], excluded = [], seen = new Set();
  for (const meeting of meetings) {
    if (seen.has(meeting.id)) continue;
    seen.add(meeting.id);
    const start = Date.parse(meeting.happenedAt);
    if (!Number.isFinite(start) || start < millis(now) - config.lookbackHours * HOUR ||
        meetingEnd(meeting) > millis(now) - config.endedGraceMinutes * 60000 ||
        ['processed', 'skipped', 'held'].some(key => Object.hasOwn(state[key] || {}, meeting.id))) continue;
    (isExcludedTitle(titleOf(meeting), config.excludeTitlePatterns) ? excluded : candidates).push(meeting);
  }
  return { candidates, excluded };
}
export function transcriptReady(payload) {
  return Array.isArray(payload?.data) && payload.data.some(item => typeof item?.text === 'string' && item.text.trim());
}
export function matchCalendarEvent(meeting, events, { minutes = 30 } = {}) {
  const emails = new Set((meeting.invitees || []).map(person => person.email?.toLowerCase()).filter(Boolean));
  const title = normalize(titleOf(meeting));
  return events.filter(event => event.status !== 'cancelled' && event.start?.dateTime).map(event => {
    const distance = Math.abs(Date.parse(event.start.dateTime) - Date.parse(meeting.happenedAt));
    const email = [event.organizer, ...(event.attendees || [])].some(person => person?.email && emails.has(person.email.toLowerCase()));
    const summary = normalize(event.summary);
    return { event, distance, email: Number(email), title: Number(!!title && !!summary && (title.includes(summary) || summary.includes(title))) };
  }).filter(row => row.distance <= minutes * 60000)
    .sort((a, b) => b.email - a.email || b.title - a.title || a.distance - b.distance)[0]?.event || null;
}
export function customerName({ caseMatch, event, meeting }) {
  if (caseMatch?.case?.client?.trim()) return caseMatch.case.client.trim();
  const clean = text => String(text || '').normalize('NFKC').replace(/【[^】]*】/g, '')
    .replace(/^\s*M\s*[:：]\s*/i, '').replace(/(?:\s*[（(][^）)]*[）)])+\s*$/g, '').replace(/様|御中/g, '')
    .replace(/打ち合わせ|打合せ|打合わせ|ミーティング|\bMTG\b/gi, '').replace(/^[\s_:：\-]+|[\s_:：\-]+$/g, '').trim();
  return clean(event?.summary) || clean(titleOf(meeting || {})) || null;
}
export function classifyFollowup({ meeting, event, caseMatch, config, transcript = '' }) {
  if (caseMatch?.reason === '複数候補・要確認') return { kind: 'unknown', reason: caseMatch.reason };
  if (caseMatch?.case?.ambiguousId) return { kind: 'unknown', reason: '案件ID重複・要確認' };
  const c = caseMatch?.case;
  const text = normalize([c?.name, c?.phase, c?.client, event?.summary, event?.description, titleOf(meeting)].filter(Boolean).join(' '));
  const hint = (config.clientKindHints || []).find(item => [titleOf(meeting), event?.summary, event?.description, c?.client]
    .some(value => normalize(value).includes(normalize(item.match))));
  if (hint) return { kind: hint.kind, reason: `取引先ヒント: ${hint.note}`, customer: hint.customer };
  for (const kind of ['production', 'gakkai', 'booth', 'other']) {
    const keyword = (config.keywords[kind] || []).find(word => text.includes(normalize(word)));
    if (keyword) return { kind, reason: `キーワード: ${keyword}` };
  }
  if (!c) {
    const source = normalize(String(transcript).slice(0, 4000));
    const counts = Object.entries(config.keywords || {}).map(([kind, words]) => ({ kind,
      count: words.reduce((sum, word) => sum + Math.max(0, source.split(normalize(word)).length - 1), 0) }))
      .sort((a, b) => b.count - a.count);
    if (counts[0]?.count >= 3 && counts[0].count >= (counts[1]?.count || 0) * 2)
      return { kind: counts[0].kind, reason: `文字起こし冒頭から推定（${counts[0].kind}:${counts[0].count}回）` };
  }
  return c ? { kind: 'other', reason: '案件特定済み' } : { kind: 'unknown', reason: '案件・種別未特定' };
}
export function routeFollowup(kind, config, pcMap, beacons = []) {
  const rule = config.routes[kind];
  if (!rule) return { pc: null, requested: null, note: '' };
  let pc = resolvePC(rule.remoteName, pcMap, beacons), note = '';
  if (!pc && kind === 'booth' && rule.fallback) {
    pc = resolvePC(rule.fallback, pcMap, beacons); note = '014未解決のため008で代行';
  }
  return { pc, requested: rule.remoteName, note };
}
export function folderName(meeting, customer) {
  const name = [...String(customer || '顧客未特定').replace(/[\\/:*?"<>|\x00-\x1f]/g, '').trim()].slice(0, 40).join('').replace(/[. ]+$/g, '') || '顧客未特定';
  return `${japanDate(meeting.happenedAt).slice(0, 10).replace(/-/g, '')}-${name}`;
}
export function renderPrompt(template, ctx) {
  const max = ctx.maxTranscriptChars ?? 60000, original = String(ctx.transcript || '');
  const values = { ...ctx, transcript: original.slice(0, max),
    transcriptNote: original.length > max ? `先頭${max}文字のみ。全文は tl;dv MCP で取得` : '全文' };
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => String(values[key] ?? ''));
}
export function writeBomUtf8(file, text) { atomicWrite(file, '\uFEFF' + text.replace(/^\uFEFF/, '')); }

export function appendLedgerItems(ledgerFile, items, { dryRun = false, now = Date.now() } = {}) {
  const ledger = readJson(ledgerFile, { items: [] });
  if (!Array.isArray(ledger.items)) throw new Error('送信待ち台帳のitems形式不一致');
  const ids = new Set(ledger.items.map(item => item.id)), added = [];
  for (const item of items) {
    const id = item.id || `tldv:${item.meetingId}:${item.n}`;
    if (ids.has(id)) continue;
    if (!item.meetingId || !Number.isSafeInteger(item.n) || item.n < 1 || typeof item.body !== 'string' || !Number.isFinite(Date.parse(item.after)))
      throw new Error('フォロー下書きの必須情報が不足');
    const body_path = path.join(path.dirname(ledgerFile), 'bodies', `tldv-${safePart(item.meetingId)}-${item.n}.txt`);
    const to = item.to || '不明';
    const entry = { id, to, cc: [], body_path, reply_to_message_id: null, reply_to_note: null, thread_id: null,
      gmail_draft_id: null, from: 'seisaku-team@orgiast.jp', urgent: false, status: '未送信',
      evidence: [`tldv-followup ${item.meetingId}`], last_checked_at: null, sent_message_id: null,
      client: item.client || '', case: item.case || '', subject: item.subject || '', decided_date: jstDate(millis(now)),
      stop_reason: 'tl;dv打合せ後フォロー下書き（承認待ち）', channel: item.channel || 'email', match: { to, after: iso(item.after) } };
    if (!dryRun) atomicWrite(body_path, item.body);
    ids.add(id); added.push(entry);
  }
  if (!dryRun && added.length) saveJson(ledgerFile, { ...ledger, items: [...ledger.items, ...added], generated_at: iso(now) });
  return added;
}
export function collectDraftReplies(inbox, state) {
  initState(state);
  const items = [];
  state.draftCounts ||= {};
  for (const mail of inbox) {
    if (!mail.id || Object.hasOwn(state.draftsSeen, mail.id)) continue;
    let body;
    try { body = JSON.parse(mail.body); } catch { continue; }
    if (body?.type !== 'tldv-followup-draft' || typeof body.body !== 'string' || !body.body.trim()) continue;
    const processed = state.processed[body.meetingId];
    if (!processed || !Number.isFinite(Date.parse(processed.endAt))) continue;
    const n = (state.draftCounts[body.meetingId] || 0) + 1;
    items.push({ ...body, id: `tldv:${body.meetingId}:${n}`, n, after: processed.endAt });
    state.draftCounts[body.meetingId] = n;
    state.draftsSeen[mail.id] = { meetingId: body.meetingId, n };
  }
  return items;
}

export async function planRun({ meetings, state, now = Date.now(), config, events = [], cases = [], pcMap = {}, beacons = [], fetchTranscript, fetchNotes }) {
  initState(state);
  const { candidates, excluded } = selectCandidates(meetings, state, { now, config });
  const results = [];
  for (const meeting of [...candidates, ...excluded]) {
    if (excluded.includes(meeting)) {
      const result = { meetingId: meeting.id, title: titleOf(meeting), startJst: japanDate(meeting.happenedAt),
        endAt: iso(meetingEnd(meeting)), customer: customerName({ meeting }), caseName: '', caseId: '', casePhase: '',
        kind: 'unknown', kindLabel: '—', requestedPc: null, pc: null, status: 'excluded', reason: '除外タイトル',
        transcript: '', transcriptChars: 0, notes: '', event: null, meeting };
      state.skipped[meeting.id] = { at: iso(now), reason: result.reason }; results.push(result); continue;
    }
    const event = matchCalendarEvent(meeting, events, { minutes: config.calendarMatchMinutes });
    const caseMatch = matchCase({ ...event, summary: `${event?.summary || ''} ${titleOf(meeting)}`,
      attendees: [...(event?.attendees || []), ...(meeting.invitees || [])] }, cases);
    let transcript = '', notes = '', transcriptFailure = null, notesFailure = null;
    try {
      const payload = await fetchTranscript(meeting.id);
      if (!transcriptReady(payload)) throw new Error('transcript-not-ready');
      transcript = transcriptText({ data: payload.data.filter(item => typeof item?.text === 'string') });
    } catch (error) { transcriptFailure = error; }
    try { notes = notesText(await fetchNotes(meeting.id)); }
    catch (error) { notes = '（メモ取得失敗）'; notesFailure = error; }
    const classification = classifyFollowup({ meeting, event, caseMatch, config, transcript });
    const route = routeFollowup(classification.kind, config, pcMap, beacons);
    const result = { meetingId: meeting.id, title: titleOf(meeting), startJst: japanDate(meeting.happenedAt),
      endAt: iso(meetingEnd(meeting)), customer: classification.customer || customerName({ caseMatch, event, meeting }),
      caseName: caseMatch.case?.name || '', caseId: caseMatch.case?.id || '', casePhase: caseMatch.case?.phase || '',
      kind: classification.kind, kindLabel: config.routes[classification.kind]?.label || '種別未特定',
      requestedPc: route.requested, pc: route.pc, status: 'ready', reason: [classification.reason, route.note, config.calendarError].filter(Boolean).join(' / '),
      transcript, transcriptChars: transcript.length, notes, event, meeting };
    if (transcriptFailure) {
      const previous = state.pending[meeting.id];
      const lastReason = authError(transcriptFailure) ? 'TLDV_API_KEY 失効または権限不足' : 'transcript未準備・取得失敗';
      state.pending[meeting.id] = { firstSeen: previous?.firstSeen || iso(now), attempts: (previous?.attempts || 0) + 1, lastReason };
      result.authFailure = authError(transcriptFailure) || authError(notesFailure);
      result.status = millis(now) - millis(state.pending[meeting.id].firstSeen) >= config.pendingGiveUpHours * HOUR ? 'gave-up' : 'pending';
      result.reason = [lastReason, result.status === 'gave-up' ? '再試行期限超過' : '', notesFailure ? 'メモ取得失敗' : '', config.calendarError].filter(Boolean).join(' / ');
      if (result.status === 'gave-up') { state.skipped[meeting.id] = { at: iso(now), reason: result.reason }; delete state.pending[meeting.id]; }
    } else if (classification.kind === 'unknown' || config.casesError) {
      result.status = 'held'; if (config.casesError) result.reason = [config.casesError, config.calendarError].filter(Boolean).join(' / ');
      result.reason += ` / 文字起こし準備済み（${result.transcriptChars}文字）`;
      state.held[meeting.id] = { at: iso(now), ...result }; delete state.pending[meeting.id];
    } else {
      delete state.pending[meeting.id];
      if (notesFailure) { result.authFailure = authError(notesFailure); result.reason += ' / メモ取得失敗'; }
    }
    results.push(result);
  }
  return results;
}

function sender(home, dir) {
  return async (batch, body) => {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${batch.id}.md`); writeBomUtf8(file, body);
    const why = `tl;dvフォロー ${batch.customer}`;
    if (batch.method === 'fleet-mail') {
      const output = execFileSync(process.execPath, [path.join(ROOT, 'tools/fleet-mail.mjs'), '--send', '--to', batch.pc,
        '--kind', 'prompt', '--exec', 'claude', '--exec-cwd', batch.cwd, '--body-file', file, '--why', why, '--expires-hours', '24'],
      { encoding: 'utf8', timeout: 180000, maxBuffer: 2 * 1024 * 1024, windowsHide: true, env: { ...process.env, ORGIAST_HOME: home }, cwd: ROOT });
      const id = output.match(/送信済み:\s*(mail-[\w-]+)/)?.[1];
      if (!id) throw new Error('fleet-mailが送信成功IDを返していません');
      return { id };
    }
    const { main: sendDirective } = await import('./fleet-directive-send.mjs');
    const result = await sendDirective(['--kind', 'prompt', '--targets', batch.pc, '--body-file', file, '--why', why,
      '--expires-hours', '24', '--push', ...(batch.cwd ? ['--cwd', batch.cwd] : [])], { home, repo: ROOT });
    const id = result.id || result.directive?.id;
    if (!id) throw new Error('fleet-directiveが送信成功IDを返していません');
    return { id };
  };
}

// Same isolated headless runner as meeting-prep. The parent persists its output;
// this tool-free worker cannot send mail or claim it changed external sheets.
export async function executeLocalFollowup(batch, body, { home, run = runHeadless,
  provider = resolveProvider(autoProvider({ home })), resolveExecutable = resolveClaudeExecutableFromDisk } = {}) {
  if (!['openrouter.ai', 'api.z.ai'].includes(new URL(provider.base).hostname) || /claude|anthropic/i.test(provider.defaultModel))
    throw new Error('Claude API・Claudeモデルは利用禁止');
  const key = process.env[provider.keyName] || readEnvValue(path.join(home, '.claude', provider.envFile), provider.keyName);
  if (!key) throw new Error('ローカル実行用APIキー未設定');
  const { executable } = await resolveExecutable(process);
  if (isUnspawnable(executable, process.platform) || process.platform === 'win32' && executable === 'claude') throw new Error('headless実行ファイル未検出');
  const configDir = path.join(home, '.claude/tldv-followup/worker');
  fs.mkdirSync(configDir, { recursive: true });
  const prompt = body + '\n\n【ローカル実行の出力契約】ツールは使用不可。外部更新や送信は行わず、未実行と明記する。' +
    'JSONのみ返す: {"report":"決定事項・宿題・期限・次の連絡日・未実行のシート更新を含むMarkdown",' +
    '"drafts":[{"to":"宛先または不明","subject":"件名","body":"本文","channel":"emailまたはline"}]}。';
  const raw = await run(executable, localWorkerArgs(provider.defaultModel), { prompt, cwd: batch.folder,
    signal: AbortSignal.timeout(12 * 60000), env: { ...localWorkerEnv(provider, key, process.env, configDir), ORGIAST_HEADLESS_JOB: 'tldv-followup' } });
  const envelope = JSON.parse(raw);
  if (envelope.is_error) throw new Error('ローカル実行失敗');
  const answer = typeof envelope.result === 'string' ? JSON.parse(envelope.result.replace(/^```(?:json)?\s*|\s*```$/g, '')) : envelope;
  if (typeof answer.report !== 'string' || !answer.report.trim() || !Array.isArray(answer.drafts)) throw new Error('ローカル出力形式不一致');
  return answer;
}

export async function dispatch({ results, state, config, receivers = {}, send, runLocal = executeLocalFollowup,
  dryRun = false, home = os.homedir(), now = Date.now(), checkpoint = () => {} }) {
  const working = dryRun ? structuredClone(state) : state;
  initState(working);
  send ||= sender(home, path.join(home, '.claude/tldv-followup/outgoing'));
  const template = config.template ?? fs.readFileSync(path.join(ROOT, 'config/tldv-followup-prompt.md'), 'utf8');
  for (const result of results) {
    if (result.status !== 'ready' || working.processed[result.meetingId]) continue;
    const execution = chooseExecution({ pc: result.pc, requested: result.requestedPc }, receivers);
    const name = folderName(result.meeting, result.customer);
    const folder = path.join(home, 'gb-reports', name);
    result.method = execution.method; result.executedOn = execution.executedOn; result.folder = folder;
    if (dryRun) {
      result.status = 'planned';
      result.reason += ` / 起動予定: ${execution.executedOn}（実行経路: ${execution.method}${execution.method === 'local' ? `: ${execution.reason}` : ''}）`;
      if (execution.method === 'local' && !config.localExec) result.reason += ' / localExec=false: 資料保存のみ';
      continue;
    }
    const batch = { id: `tldv-${createHash('sha256').update(result.meetingId).digest('hex').slice(0, 24)}`, pc: result.pc?.label,
      cwd: execution.cwd, method: execution.method, folder, customer: result.customer || '顧客未特定', meetingId: result.meetingId };
    const body = renderPrompt(template, { ...result, pcLabel: execution.method === 'local' ? 'kim-PC' : result.pc.label,
      endJst: japanDate(result.endAt), participants: (result.meeting.invitees || []).map(p => [p.name, p.email].filter(Boolean).join(' / ')).join('、'),
      tldvUrl: result.meeting.url || `https://tldv.io/app/meetings/${encodeURIComponent(result.meetingId)}`,
      calendarSummary: result.event?.summary || '照合なし', folderName: name, caseSheetId: config.caseSheetId,
      maxTranscriptChars: config.maxTranscriptChars });
    // Claim before external effects. An interrupted/ambiguous launch needs review,
    // never an automatic resend on the next scheduled tick.
    working.held[result.meetingId] = { ...result, status: 'held', at: iso(now),
      reason: '起動処理中・結果未確認（再送前に実行状況を確認）' };
    checkpoint();
    let receipt;
    try {
      if (execution.method === 'local') {
        fs.mkdirSync(folder, { recursive: true });
        // Keep each meeting's immutable inputs too: two calls for one client/day share the requested folder.
        const archive = path.join(folder, 'meetings', safePart(result.meetingId));
        writeBomUtf8(path.join(archive, 'prompt.txt'), body);
        atomicWrite(path.join(archive, 'transcript.txt'), result.transcript);
        writeBomUtf8(path.join(folder, 'prompt.txt'), body);
        atomicWrite(path.join(folder, 'transcript.txt'), result.transcript);
        const skeleton = `# ${result.customer || result.title} フォロー\n\n担当PCで起動できなかった理由: ${execution.reason}\n\n## 決定事項・宿題・期限・次の連絡日\n未作成\n\n## シート更新\n未実行\n`;
        atomicWrite(path.join(folder, 'REPORT.md'), skeleton);
        if (!config.localExec) { result.status = 'held'; result.reason += ` / ${execution.reason} / ローカル実行無効・資料保存済み`; }
        else {
          receipt = await runLocal(batch, body, { home, config });
          if (receipt?.report) {
            const report = skeleton.replace('未作成', receipt.report);
            atomicWrite(path.join(archive, 'REPORT.md'), report); atomicWrite(path.join(folder, 'REPORT.md'), report);
          }
        }
      } else receipt = await send(batch, body);
      if (result.status !== 'held') {
        if (execution.method !== 'local' && !receipt?.id) throw new Error('実行受付IDなし');
        working.processed[result.meetingId] = { at: iso(now), kind: result.kind, pc: execution.executedOn, method: execution.method,
          folder, mailId: receipt?.id || null, endAt: result.endAt, customer: result.customer, caseName: result.caseName };
        // Store local drafts durably before marking them seen in the ledger collection step.
        if (Array.isArray(receipt?.drafts)) working.processed[result.meetingId].drafts = receipt.drafts;
        delete working.held[result.meetingId];
        result.status = 'dispatched'; result.reason += ` / ${execution.reason}`;
      }
    } catch {
      // Never propagate child stderr or API exception text (may contain credentials).
      result.status = 'held'; result.reason += ' / 起動失敗・要確認（自動再送なし）';
    }
    if (result.status === 'held') working.held[result.meetingId] = { ...result, at: iso(now) };
    checkpoint();
  }
  return results;
}

export function renderStatus(results, { now = Date.now(), host = os.hostname() } = {}) {
  const status = { dispatched: '起動済み', planned: '起動予定(dry-run)', ready: '起動待ち', pending: 'transcript未準備・再試行待ち', held: '要確認', excluded: '対象外', 'gave-up': '対象外（再試行期限超過）' };
  const cell = value => String(value || '—').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
  return [`# tldv-followup PC=${host} ${japanDate(iso(now))} JST status=OK 要判断=${results.filter(r => r.status === 'held').length}`, '',
    '| 会議日時 | 顧客名・案件 | 種別 | 担当PC | 実行先 | 状態 | 一言 |', '|---|---|---|---|---|---|---|',
    ...results.map(r => `| ${[r.startJst, [r.customer, r.caseName].filter(Boolean).join(' / ') || r.title,
      ...(r.status === 'excluded' ? ['—', '—', '—'] : [r.kindLabel, r.requestedPc, r.executedOn || r.pc?.label]),
      status[r.status], r.reason].map(cell).join(' | ')} |`), ''].join('\n');
}

const HELP = `tl;dv 打合せ後フォローアップ自動ディスパッチ\n使い方: node tools/tldv-followup-dispatch.mjs [--dry-run] [--date YYYY-MM-DD] [--meeting <id>] [--report-dir <dir>] [--lookback-hours N]\n--help: この使い方を表示\n--report-dir: dry-run.md / dry-run.json の出力先（--dry-run時のみ）\n社外へのメール・LINE送信は行いません。\n`;
function parseArgs(argv) {
  const options = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') options.dryRun = true;
    else if (['--date', '--meeting', '--report-dir', '--lookback-hours'].includes(arg)) {
      const value = argv[++i]; if (!value || value.startsWith('--')) throw new Error('引数の値不足');
      options[{ '--date': 'date', '--meeting': 'meeting', '--report-dir': 'reportDir', '--lookback-hours': 'lookbackHours' }[arg]] = value;
    } else throw new Error('不明な引数');
  }
  if (options.date && (!/^\d{4}-\d{2}-\d{2}$/.test(options.date) || !Number.isFinite(Date.parse(`${options.date}T00:00:00+09:00`)) || jstDate(Date.parse(`${options.date}T00:00:00+09:00`)) !== options.date)) throw new Error('日付が不正');
  if (options.lookbackHours !== undefined && (!Number.isFinite(Number(options.lookbackHours)) || Number(options.lookbackHours) <= 0)) throw new Error('lookback-hoursが不正');
  if (options.reportDir && !options.dryRun) throw new Error('report-dirはdry-run専用');
  return options;
}
function acquireLock(file, now) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const token = randomUUID();
  const claim = () => fs.writeFileSync(file, JSON.stringify({ token, pid: process.pid }), { flag: 'wx', mode: 0o600 });
  try { claim(); } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (millis(now) - fs.statSync(file).mtimeMs < 30 * 60000) return null;
    fs.unlinkSync(file);
    try { claim(); } catch (retry) { if (retry.code === 'EEXIST') return null; throw retry; }
  }
  const timer = setInterval(() => { try { if (readJson(file, {})?.token === token) fs.utimesSync(file, new Date(), new Date()); } catch { /* release checks ownership */ } }, 60000);
  timer.unref();
  return () => { clearInterval(timer); if (readJson(file, {})?.token === token) fs.rmSync(file, { force: true }); };
}
function jobStatus(reason, { error = false, held = 0 } = {}) {
  return `状態: ${error ? '異常' : held ? '要確認' : '正常'}\n理由: ${reason}\n次の一手: ${error ? '認証・接続を確認して再実行' : held ? '保留理由を確認しstate.heldの該当IDを解除して再実行' : '15分後に再検知・下書きを回収'}\n期限: ${error || held ? '次回実行前' : '15分後'}\n`;
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const home = deps.home || os.homedir(), now = deps.now ?? Date.now(), out = deps.out || console.log;
  if (argv.includes('--help')) { out(HELP); return 0; }
  let options, config, release;
  try {
    options = parseArgs(argv);
    config = { ...readJson(path.join(ROOT, 'config/meeting-prep-routing.json'), {}),
      ...readJson(path.join(ROOT, 'config/tldv-followup-routing.json'), {}), ...deps.config };
    if (options.lookbackHours) config.lookbackHours = Number(options.lookbackHours);
    if (!options.dryRun) {
      release = acquireLock(path.join(home, '.claude/state/tldv-followup-dispatch.lock'), now);
      if (!release) { out('実行中のためスキップ'); return 0; }
    }
    const stateFile = path.resolve(home, config.stateFile), state = initState(readJson(stateFile, {}));
    const checkpoint = () => { if (!options.dryRun) saveJson(stateFile, state); };
    const apiKey = deps.client ? '' : process.env.TLDV_API_KEY || readEnvValue(path.join(home, '.claude/tldv.env'), 'TLDV_API_KEY');
    if (!deps.client && !apiKey) throw new Error('missing-tldv-api-key');
    const client = deps.client || createClient({ apiKey, getToken: () => { throw new Error('Driveアクセス禁止'); } });
    const meetings = (await client.listMeetings()).filter(m => (!options.meeting || m.id === options.meeting) && (!options.date || jstDate(Date.parse(m.happenedAt)) === options.date));
    const { candidates } = selectCandidates(meetings, state, { now, config });
    let events = [], cases = [];
    if (candidates.length) {
      const makeGoogle = deps.createGoogle || createGoogle;
      const google = makeGoogle({ user: config.userEmail, dryRun: true }), team = makeGoogle({ user: config.teamEmail, dryRun: true });
      const dates = [...new Set(candidates.map(m => jstDate(Date.parse(m.happenedAt))))].sort();
      const loads = await Promise.allSettled([...(dates.flatMap(date => [google, team].map(g =>
        (deps.loadEvents || loadEvents)(g, config, {}, date)))), (deps.loadCasesWithRetry || loadCasesWithRetry)(google, config)]);
      const caseLoad = loads.pop();
      if (caseLoad.status === 'fulfilled') cases = caseLoad.value;
      else config.casesError = '案件一覧読取失敗・要確認';
      for (const load of loads) {
        if (load.status === 'fulfilled') { events.push(...load.value.events); if (load.value.errors?.length) config.calendarError = 'カレンダー読取失敗'; }
        else config.calendarError = 'カレンダー読取失敗';
      }
    }
    const fleet = await (deps.inspectFleet || inspectFleet)(home, config);
    const results = await planRun({ meetings, state, now, config, events, cases, pcMap: deps.pcMap || readJson(path.join(ROOT, 'fleet-pc-map.json'), {}),
      beacons: fleet.beacons, fetchTranscript: id => client.transcript(id), fetchNotes: id => client.notes(id) });
    if (results.some(r => r.authFailure)) throw Object.assign(new Error('tldv-http-401'), { status: 401 });
    // Pending meetings that age out of lookback must still reach a terminal state.
    for (const [id, pending] of Object.entries(state.pending)) {
      if (millis(now) - millis(pending.firstSeen) < config.pendingGiveUpHours * HOUR || results.some(r => r.meetingId === id)) continue;
      if (options.meeting && options.meeting !== id || options.date && !meetings.some(m => m.id === id)) continue;
      state.skipped[id] = { at: iso(now), reason: 'transcript再試行期限超過' }; delete state.pending[id];
      results.push({ meetingId: id, title: '過去の会議', status: 'gave-up', reason: 'transcript再試行期限超過' });
    }
    await dispatch({ results, state, config, receivers: fleet.receivers, send: deps.send, runLocal: deps.runLocal,
      dryRun: options.dryRun, home, now, checkpoint });
    const inbox = [...(fleet.inbox || [])];
    for (const [meetingId, processed] of Object.entries(state.processed)) {
      for (const [index, draft] of (processed.drafts || []).entries()) inbox.push({ id: `local-${meetingId}-${index}`, body: JSON.stringify({
        ...draft, type: 'tldv-followup-draft', meetingId, client: processed.customer, case: processed.caseName }) });
    }
    const draftState = structuredClone(state);
    const items = collectDraftReplies(inbox, draftState);
    appendLedgerItems(path.resolve(home, config.ledgerFile), items, { dryRun: options.dryRun, now });
    state.draftsSeen = draftState.draftsSeen; state.draftCounts = draftState.draftCounts;
    // Keep unresolved decisions visible even when selection deliberately suppresses redispatch.
    for (const held of Object.values(state.held)) if (held.meetingId && !results.some(r => r.meetingId === held.meetingId)) results.push(held);
    const report = renderStatus(results, { now, host: deps.host || os.hostname() });
    if (options.dryRun) {
      if (options.reportDir) { atomicWrite(path.join(options.reportDir, 'dry-run.md'), report); saveJson(path.join(options.reportDir, 'dry-run.json'), results); }
    } else {
      checkpoint();
      atomicWrite(path.resolve(home, config.statusFile), report);
      saveJson(path.resolve(home, config.runsDir, `${japanDate(iso(now)).replace(/[-:]/g, '').replace(' ', '-')}.json`), results);
      const issues = [...new Set(results.filter(r => ['held', 'pending', 'gave-up'].includes(r.status)).map(r => r.reason))];
      atomicWrite(path.resolve(home, config.jobStatusFile), jobStatus(
        [`${results.length}件確認・下書き${items.length}件回収`, ...issues].join(' / ').replace(/[\r\n]+/g, ' '),
        { held: results.filter(r => r.status === 'held').length }));
    }
    out(report); return 0;
  } catch (error) {
    const reason = authError(error) ? 'TLDV_API_KEY 失効または権限不足' : error.message === 'missing-tldv-api-key' ? 'TLDV_API_KEY 未設定' : '実行失敗（引数・設定・接続・出力先を確認）';
    const status = jobStatus(reason, { error: true });
    if (config && !options?.dryRun) atomicWrite(path.resolve(home, config.jobStatusFile), status);
    if (options?.dryRun && options.reportDir) { atomicWrite(path.join(options.reportDir, 'dry-run.md'), status); saveJson(path.join(options.reportDir, 'dry-run.json'), { error: reason }); }
    out(reason); return authError(error) ? 2 : 1;
  } finally { release?.(); }
}

if (isEntry(import.meta.url)) process.exitCode = await main();
