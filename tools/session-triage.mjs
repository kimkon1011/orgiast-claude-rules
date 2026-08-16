#!/usr/bin/env node
// Claude Code の transcript を先頭64 KiB・末尾256 KiBだけ読んで未完了度を判定する。
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 256 * 1024;
const DAY_MS = 86_400_000;
const args = process.argv.slice(2);

function usage(message) {
  if (message) console.error(`エラー: ${message}`);
  console.error('使い方: node tools/session-triage.mjs [--days N|--all] [--top N] [--status 要対応|要確認|完了っぽい|短命/雑談] [--json] [--md path] [--llm] [--all-status] [--include-current]');
  process.exit(message ? 2 : 0);
}

function option(name) {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  if (!args[i + 1] || args[i + 1].startsWith('--')) usage(`${name} に値が必要です`);
  return args[i + 1];
}

if (args.includes('--help') || args.includes('-h')) usage();
const daysRaw = option('--days');
const topRaw = option('--top');
const days = daysRaw === undefined ? 90 : Number(daysRaw);
const top = topRaw === undefined ? 20 : Number(topRaw);
if (!Number.isFinite(days) || days < 0) usage('--days は0以上の数値にしてください');
if (!Number.isInteger(top) || top < 0) usage('--top は0以上の整数にしてください');
const all = args.includes('--all');
const jsonMode = args.includes('--json');
const llmMode = args.includes('--llm');
const allStatus = args.includes('--all-status');
const includeCurrent = args.includes('--include-current');
const mdPath = option('--md');
const statusFilter = option('--status');
const validStatuses = new Set(['要対応', '要確認', '完了っぽい', '短命/雑談']);
if (statusFilter && !validStatuses.has(statusFilter)) usage(`不明な status: ${statusFilter}`);

const projectsRoot = process.env.CLAUDE_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects');
const started = Date.now();
const stats = { found: 0, scanned: 0, corruptLines: 0, emptyFiles: 0, skippedFiles: 0, readErrors: 0 };

function textOf(content, includeToolResults = false) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.flatMap((part) => {
    if (!part || typeof part !== 'object') return [];
    if (part.type === 'text' && typeof part.text === 'string') return [part.text];
    if (includeToolResults && part.type === 'tool_result') {
      return [textOf(part.content, true)];
    }
    return [];
  }).filter(Boolean).join('\n');
}

function cleanPrompt(input) {
  let s = String(input || '');
  s = s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, ' ');
  s = s.replace(/<task-notification>[\s\S]*?<\/task-notification>/gi, ' ');
  s = s.replace(/<ide_(?:opened_file|selection)>[\s\S]*?<\/ide_(?:opened_file|selection)>/gi, ' ');
  s = s.replace(/<(command-name|command-message|local-command-stdout)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/^\s*\[AUTOMATION-FIRST\][^\n]*(?:\n|$)/gim, ' ');
  s = s.replace(/^\s*\[(?:HOOK|SYSTEM|AUTOMATION)[^\]]*\][^\n]*(?:\n|$)/gim, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

function shorten(s, n) {
  const value = String(s || '').replace(/\s+/g, ' ').trim();
  return value.length > n ? `${value.slice(0, n - 1)}…` : value;
}

async function readWindow(file, size, fromTail) {
  const length = Math.min(size, file.size);
  if (!length) return '';
  const offset = fromTail ? file.size - length : 0;
  const handle = await fs.open(file.path, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    let value = buffer.subarray(0, bytesRead).toString('utf8');
    // UTF-8途中開始の置換文字と、窓の境界にある不完全JSONL行を捨てる。
    if (fromTail && offset > 0) value = value.slice(value.indexOf('\n') + 1);
    if (!fromTail && length < file.size) value = value.slice(0, value.lastIndexOf('\n') + 1);
    return value;
  } finally {
    await handle.close();
  }
}

function parseLines(value) {
  const events = [];
  let bytes = 0;
  for (const line of value.split(/\r?\n/)) {
    if (!line.trim()) continue;
    bytes += Buffer.byteLength(line) + 1;
    try { events.push(JSON.parse(line)); } catch { stats.corruptLines++; }
  }
  return { events, bytes };
}

function isActualUser(event) {
  if (event?.type !== 'user' || event?.message?.role !== 'user') return false;
  const c = event.message.content;
  if (Array.isArray(c) && c.length && c.every((x) => x?.type === 'tool_result')) return false;
  // task-notification や IDE/hook 注入だけの user event は人間の依頼ではない。
  return Boolean(cleanPrompt(textOf(c)));
}

function statusFor(score) {
  if (score >= 60) return { emoji: '🔴', name: '要対応' };
  if (score >= 30) return { emoji: '🟡', name: '要確認' };
  if (score >= 0) return { emoji: '⚪', name: '完了っぽい' };
  return { emoji: '🗑', name: '短命/雑談' };
}

function analyze(file, headEvents, tailEvents, tailBytes) {
  const combined = headEvents.concat(tailEvents);
  let title = '';
  let cwd = '';
  let gitBranch = '';
  const sessionId = path.basename(file.path, '.jsonl');
  for (const event of combined) {
    cwd ||= event?.cwd || '';
    gitBranch ||= event?.gitBranch || '';
    if (!title && isActualUser(event)) title = cleanPrompt(textOf(event.message.content));
  }

  let lastTs = '';
  let lastRole = '';
  let lastAssistantText = '';
  let lastMessageText = '';
  let lastMessageEvent;
  const pendingTools = new Map();
  let endedWithError = false;
  for (const event of tailEvents) {
    if (event?.timestamp) lastTs = event.timestamp;
    const content = event?.message?.content;
    if (Array.isArray(content)) {
      for (const part of content) {
        if (part?.type === 'tool_use' && part.id) pendingTools.set(part.id, part.name || 'tool');
        if (part?.type === 'tool_result' && part.tool_use_id) pendingTools.delete(part.tool_use_id);
      }
    }
    if (event?.type === 'error' || event?.error || event?.message?.error) endedWithError = true;
    if (isActualUser(event)) {
      lastRole = 'user';
      lastMessageText = textOf(content);
      lastMessageEvent = event;
      endedWithError = false;
    } else if (event?.type === 'assistant' && event?.message?.role === 'assistant') {
      const assistantText = textOf(content);
      if (assistantText) lastAssistantText = assistantText;
      lastRole = 'assistant';
      lastMessageText = assistantText;
      lastMessageEvent = event;
      endedWithError = Boolean(event?.error || event?.message?.error);
    }
  }

  const ageDays = Math.max(0, (Date.now() - file.mtimeMs) / DAY_MS);
  const sampledLines = tailEvents.length;
  const messageCount = Math.max(0, tailBytes ? Math.round(file.size * sampledLines / tailBytes) : 0);
  const reasons = [];
  let score = 0;
  const add = (points, reason) => { score += points; reasons.push(`${points > 0 ? '+' : ''}${points} ${reason}`); };
  if (lastRole === 'user') add(50, '末尾user未応答');
  const interruptionText = `${lastMessageText}\n${lastAssistantText}`;
  if (/\[Request interrupted by user\]|request interrupted|interrupted by user|リクエストはユーザーにより中断/i.test(interruptionText)) add(45, '中断マーカー');
  if (pendingTools.size) add(40, `未完了tool_use ${pendingTools.size}件`);
  const unfinished = /残\s*TODO|未実施|未実行|待ち|pending|次は|次に|TODO|後で|確認してください|依頼中|ブロック/i;
  const completed = /完了|done|修正済|デプロイ済|反映済/i;
  // 長い完了報告の経緯に出る「次に」等は偽陽性になるため、結論に近い末尾500字で判定する。
  const assistantConclusion = lastAssistantText.slice(-500);
  if (unfinished.test(assistantConclusion)) add(35, 'assistant末尾の未完了語');
  if (endedWithError || (lastMessageEvent && /API[^\n]{0,30}(?:error|エラー)|rate.?limit|authentication error/i.test(lastMessageText))) add(30, 'API/error終了');
  if (completed.test(assistantConclusion) && !unfinished.test(assistantConclusion)) add(-40, 'assistant完了報告');
  // 末尾窓の平均行長から概算。短命セッションを上位から外すため仕様の重みを採用。
  if (messageCount < 4) add(-30, '総イベント概算4件未満');
  if (ageDays <= 7) add(15, '7日以内');
  else if (ageDays <= 30) add(5, '30日以内');
  else if (ageDays > 90) add(-10, '90日超');
  const status = statusFor(score);
  return {
    sessionId, file: file.path, cwd, projectDir: path.basename(path.dirname(file.path)),
    mtime: new Date(file.mtimeMs).toISOString(), sizeMB: Number((file.size / 1024 / 1024).toFixed(2)),
    gitBranch, title: shorten(title || '(タイトルなし)', 80), llmTitle: shorten(title || '(タイトルなし)', 1500), lastTs, lastRole,
    lastAssistantText: shorten(lastAssistantText, 1500), ageDays: Number(ageDays.toFixed(1)),
    messageCountEstimate: messageCount, score, status: status.name, emoji: status.emoji, reasons,
    signals: {
      lastUserUnanswered: lastRole === 'user',
      interrupted: /\[Request interrupted by user\]|request interrupted|interrupted by user|リクエストはユーザーにより中断/i.test(interruptionText),
      pendingToolUse: pendingTools.size,
    },
  };
}

async function listFiles() {
  const bySessionId = new Map();
  const excluded = new Set(['subagents', 'workflows', '_deleted-backup', '_headless']);
  const sessionFilePattern = /^[0-9a-f-]{36}$/i;
  const projects = await fs.readdir(projectsRoot, { withFileTypes: true });
  for (const project of projects) {
    if (!project.isDirectory() || excluded.has(project.name)) continue;
    let entries;
    try { entries = await fs.readdir(path.join(projectsRoot, project.name), { withFileTypes: true }); }
    catch { stats.readErrors++; continue; }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      stats.found++;
      const sessionId = path.basename(entry.name, '.jsonl');
      if (entry.name.startsWith('agent-') || entry.name.startsWith('wf_') || !sessionFilePattern.test(sessionId)) {
        stats.skippedFiles++;
        continue;
      }
      const filePath = path.join(projectsRoot, project.name, entry.name);
      try {
        const st = await fs.stat(filePath);
        if (!all && Date.now() - st.mtimeMs > days * DAY_MS) { stats.skippedFiles++; continue; }
        if (!includeCurrent) {
          const currentId = process.env.CLAUDE_SESSION_ID;
          if ((currentId && entry.name === `${currentId}.jsonl`) || (!currentId && Math.abs(started - st.mtimeMs) <= 5 * 60_000)) {
            stats.skippedFiles++;
            continue;
          }
        }
        const file = { path: filePath, size: st.size, mtimeMs: st.mtimeMs };
        const previous = bySessionId.get(sessionId);
        if (!previous || previous.mtimeMs < file.mtimeMs) bySessionId.set(sessionId, file);
        if (previous) stats.skippedFiles++;
      } catch { stats.readErrors++; }
    }
  }
  return [...bySessionId.values()];
}

async function inspect(file) {
  if (!file.size) { stats.emptyFiles++; return null; }
  try {
    const [headRaw, tailRaw] = await Promise.all([readWindow(file, HEAD_BYTES, false), readWindow(file, TAIL_BYTES, true)]);
    const head = parseLines(headRaw);
    const tail = parseLines(tailRaw);
    if (!head.events.length && !tail.events.length) { stats.emptyFiles++; return null; }
    stats.scanned++;
    return analyze(file, head.events, tail.events, tail.bytes);
  } catch { stats.readErrors++; return null; }
}

function parseLlmResult(stdout) {
  const raw = String(stdout || '').trim();
  const candidates = [raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')];
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(raw.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate);
      if (!['未完了', '完了', '不明'].includes(value.verdict)) continue;
      const confidence = Number(value.confidence);
      if (!Number.isFinite(confidence) || confidence < 0 || confidence > 100) continue;
      return { verdict: value.verdict, confidence: Math.round(confidence), next: value.verdict === '完了' ? '' : shorten(value.next, 40) };
    } catch { /* フェンス除去後とJSON部分抽出後を順に試す。 */ }
  }
  return { verdict: '不明', confidence: 0, next: '' };
}

function applyLlmResult(record, result) {
  record.llm = result;
  record.nextAction = result.next;
  record.reasons.push(`LLM:${result.verdict}(${result.confidence})`);
  if (result.confidence < 60 || result.verdict === '不明') return;
  if (result.verdict === '未完了') {
    record.status = '要対応';
    record.emoji = '🔴';
  } else {
    record.status = '完了っぽい';
    record.emoji = '⚪';
  }
}

async function addLlmJudgments(records) {
  const helper = path.join(path.dirname(fileURLToPath(import.meta.url)), 'llm-ask.mjs');
  const llmStats = { success: 0, failure: 0, providerNotes: [], failureReasons: new Map() };
  const failRecord = (record, reason) => {
    const detail = shorten(reason || '原因不明', 200);
    const result = { verdict: '失敗', confidence: 0, next: '', error: detail };
    record.llm = result;
    record.nextAction = '';
    record.reasons.push('LLM:失敗');
    llmStats.failure++;
    llmStats.failureReasons.set(detail, (llmStats.failureReasons.get(detail) || 0) + 1);
    console.error(`llm失敗 ${record.sessionId.slice(0, 8)}: ${detail}`);
  };
  try { await fs.access(helper); } catch {
    for (const record of records) failRecord(record, 'tools/llm-ask.mjs が見つかりません');
    return llmStats;
  }
  const providers = (process.env.SESSION_TRIAGE_LLM_PROVIDERS || 'groq,openrouter,gemini')
    .split(',').map((value) => value.trim()).filter(Boolean);
  const disabledProviders = new Set();
  const notedProviders = new Set();
  const isRateLimit = (error) => /(?:\b429\b|rate.?limit|too many requests|TP[DM])/i.test(String(error?.stderr || error?.message || error));
  const errorDetail = (error) => String(error?.stderr || error?.message || error).trim().split('\n').slice(-1)[0].slice(0, 200);
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let cursor = 0;
  async function worker() {
    while (cursor < records.length) {
      const record = records[cursor++];
      const facts = [];
      if (record.signals.lastUserUnanswered) facts.push('末尾のuserにassistantが未応答');
      if (record.signals.interrupted) facts.push('中断マーカーあり');
      if (record.signals.pendingToolUse) facts.push(`tool_use未完了 ${record.signals.pendingToolUse}件`);
      // 実測(2026-08-16): 判定を委ねる書き方だとモデルが逃げて verdict=不明/confidence=0 を連発した(20件中14件)。
      // 「不明は末尾テキストが空の時だけ」「必ず二択・confidence 60以上」と明示して初めて実用的な判定が返る。
      const prompt = `あなたは作業状況の判定器。出力はJSON1個のみ、説明禁止。
判定: ユーザーの当初の依頼に対し、まだ実行されていない作業・判断待ち・確認待ちが残っていれば「未完了」、成果物が納品済みで残作業が無ければ「完了」。
【重要】当初依頼の中核と、assistantが末尾で任意に提案した追加作業を区別せよ。成果物のURLや結果が納品済みなら「次にやるなら」「進めますか」等の任意提案・別依頼・ファイル整理は残作業に数えず「完了」。文中に「次は」「確認してください」「残TODO」があるだけで未完了にしない。逆に「完了」と書いてあっても保留・指示待ち・未実施が明記されていれば未完了。
例: 「調査して資料を作って」に資料URLを納品し末尾で「次は入稿レベルまで詰めますか？」→「完了」。「修正して」に原因診断だけで「修正方針を確認してください」で止まった→「未完了」。
末尾assistantテキストが空の時だけ「不明」。それ以外は必ず未完了か完了を選び、confidenceは60以上を付けること。
出力形式: {"verdict":"未完了|完了|不明","confidence":0-100,"next":"次にやるべき1アクション(40字以内、完了なら空文字)"}\n\n当初の依頼: ${record.llmTitle}\n末尾assistantテキスト: ${shorten(record.lastAssistantText || '(なし)', 900)}\n構造上の事実: ${facts.join('、') || '特になし'}`;
      let result;
      const errors = [];
      for (const provider of providers) {
        if (disabledProviders.has(provider)) continue;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const { stdout } = await execFileAsync(process.execPath, [helper, '--provider', provider, '--max', '200', prompt], { timeout: 15_000, maxBuffer: 256 * 1024 });
            result = parseLlmResult(stdout);
            if (process.env.SESSION_TRIAGE_DEBUG) console.error(`DBG ${record.sessionId.slice(0, 8)} provider=${provider} promptLen=${prompt.length} raw=${JSON.stringify(String(stdout).slice(0, 300))}`);
            break;
          } catch (error) {
            const rateLimited = isRateLimit(error);
            errors.push(`${provider}: ${errorDetail(error)}`);
            if (rateLimited && attempt === 0) {
              await wait(300);
              continue;
            }
            if (rateLimited) {
              disabledProviders.add(provider);
              if (!notedProviders.has(provider)) {
                notedProviders.add(provider);
                llmStats.providerNotes.push(`${provider}:429でスキップ`);
              }
            }
            break;
          }
        }
        if (result) break;
      }
      if (result) {
        applyLlmResult(record, result);
        llmStats.success++;
      } else {
        failRecord(record, errors.at(-1) || '利用可能なLLMプロバイダがありません');
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(2, records.length) }, () => worker()));
  return llmStats;
}

function ageLabel(daysValue) {
  if (daysValue < 1) return '今日';
  return `${Math.floor(daysValue)}日前`;
}

function terminalText(records, summary) {
  const lines = [];
  for (const r of records) {
    lines.push(`${r.emoji} [${ageLabel(r.ageDays)}] ${r.title}`);
    lines.push(`   cwd: ${r.cwd || '(不明)'}  (score ${r.score}: ${r.reasons.join(', ') || 'シグナルなし'})`);
    lines.push(`   最後: 「${shorten(r.lastAssistantText || '(assistantテキストなし)', 120)}」`);
    if (r.nextAction) lines.push(`   次アクション: ${r.nextAction}`);
    lines.push(`   再開: claude --resume ${r.sessionId}`, '');
  }
  lines.push(`走査 ${summary.scanned}本 / 検出 ${summary.found}本（破損行 ${summary.corruptLines}、空/解析不能 ${summary.emptyFiles}、読取エラー ${summary.readErrors}、期間外 ${summary.skippedFiles}）`);
  lines.push(`🔴 ${summary.counts['要対応']}本 / 🟡 ${summary.counts['要確認']}本 / ⚪ ${summary.counts['完了っぽい']}本 / 🗑 ${summary.counts['短命/雑談']}本 / ${summary.elapsedSeconds}秒`);
  if (summary.llm) {
    const notes = summary.llm.providerNotes.length ? `（${summary.llm.providerNotes.join('、')}）` : '';
    lines.push(`LLM判定: 成功${summary.llm.success}件 / 失敗${summary.llm.failure}件${notes}`);
    if (summary.llm.failureReasons.length) lines.push(`LLM失敗理由: ${summary.llm.failureReasons.map(({ reason, count }) => `${reason} (${count}件)`).join('、')}`);
  }
  return lines.join('\n');
}

function markdown(records, summary) {
  const esc = (s) => String(s || '').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
  const rows = records.map((r) => `| ${r.emoji} ${r.status} | ${r.score} | ${esc(r.title)} | ${ageLabel(r.ageDays)} | ${esc(r.cwd || '(不明)')} | ${esc(r.reasons.join(', ') || 'シグナルなし')} | ${esc(r.nextAction || (r.status === '完了っぽい' ? 'なし（完了）' : '要確認'))} | \`claude --resume ${r.sessionId}\` |`);
  const llmLine = summary.llm ? `\nLLM判定: 成功${summary.llm.success}件 / 失敗${summary.llm.failure}件\n` : '';
  return `<!-- SESSION-TRIAGE-START -->\n# Claude Code セッショントリアージ\n\n🔴 ${summary.counts['要対応']}本 / 🟡 ${summary.counts['要確認']}本 / 生成時刻 ${new Date().toISOString()}\n\n走査: ${summary.scanned}本\n${llmLine}\n| 分類 | score | タイトル | 更新 | cwd | 理由 | 次アクション | 再開 |\n|---|---:|---|---|---|---|---|---|\n${rows.join('\n')}\n<!-- SESSION-TRIAGE-END -->\n`;
}

try {
  const files = await listFiles();
  const records = (await Promise.all(files.map(inspect))).filter(Boolean).sort((a, b) => b.score - a.score || a.ageDays - b.ageDays);
  const filtered = statusFilter ? records.filter((r) => r.status === statusFilter) : records;
  let selected = filtered.slice(0, top);
  let llmStats;
  if (llmMode) {
    llmStats = await addLlmJudgments(selected);
    selected.sort((a, b) => {
      const rank = (r) => r.llm?.verdict === '未完了' && r.llm.confidence >= 60 ? 0 : r.status === '要確認' ? 1 : 2;
      return rank(a) - rank(b) || a.ageDays - b.ageDays;
    });
    if (!allStatus) selected = selected.filter((r) => r.llm?.verdict !== '完了' || r.llm.confidence < 60);
  }
  const counts = Object.fromEntries([...validStatuses].map((s) => [s, records.filter((r) => r.status === s).length]));
  const llm = llmStats ? {
    success: llmStats.success,
    failure: llmStats.failure,
    providerNotes: llmStats.providerNotes,
    failureReasons: [...llmStats.failureReasons].map(([reason, count]) => ({ reason, count })),
  } : undefined;
  const summary = { ...stats, counts, elapsedSeconds: Number(((Date.now() - started) / 1000).toFixed(2)), projectsRoot, ...(llm && { llm }) };
  if (mdPath) await fs.writeFile(path.resolve(mdPath), markdown(selected, summary), 'utf8');
  if (jsonMode) console.log(JSON.stringify({ summary, sessions: selected }, null, 2));
  else console.log(terminalText(selected, summary));
} catch (error) {
  console.error(`session-triage: ${error.message}`);
  process.exitCode = 1;
}
