#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { isEntry } from './is-entry.mjs';
import { latestAssistantText as readLatestAssistantText } from './lib/assistant-text.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const completionPattern = /(完了|反映済|push\s*済|deploy\s*完了|PASS|✅)/i;
const todoHeadingPattern = /(残TODO|残タスク|次タスク|次の一手|残り|未着手|TODO:)/i;
const questionPattern = /(\?|？|どちら|いいですか|しますか|進めて良い|よろしい)/;
const escapePattern = /(\[TODO-NONE\]|\[STOP-OK\]|残TODO\s*:?\s*なし|残タスク\s*:?\s*なし)/i;
export const consentExemptPattern = /(送信|送る|公開|投稿|課金|支払|請求|決済|削除|消す|本番|デプロイ|deploy|マージ|merge|push|共有|招待|解約|退会|発注|契約|外部|先方|お客様|クライアント|取引先|承認|許可|権限|認証|パスワード|クレデンシャル|APIキー|アカウント作成|OAuth|予算|価格|見積|宛先|誰に|いつまで|締切|好み|ご希望|意向)/;
export const progressQuestionPattern = /(ますか|ましょうか|でしょうか|でいい(です)?か|よろしい|どちら|どれ(を|が)|進めて|着手して|やりますか|作りますか|実装しますか|続けますか|\?|？)/;
export const QUESTION_TAIL_CHARS = 200;
const bulletPattern = /^\s*(?:[-*]|\d+\.)\s+\S/;
const home = () => process.env.ORGIAST_HOME || process.env.USERPROFILE || process.cwd().match(/^(\/mnt\/[a-z]\/Users\/[^/]+)/i)?.[1] || os.homedir();

export function remainingItems(text) {
  const source = String(text || '');
  const heading = source.match(todoHeadingPattern);
  if (!heading || heading.index === undefined) return [];
  return source.slice(heading.index + heading[0].length).split(/\r?\n/).filter(line => bulletPattern.test(line)).slice(0, 5);
}

export function shouldBlock(text) {
  const source = String(text || '');
  if (!source || escapePattern.test(source)) return false;
  if (!completionPattern.test(source) || !todoHeadingPattern.test(source)) return false;
  if (questionPattern.test(source.slice(-200))) return false;
  return remainingItems(source).length > 0;
}

export function shouldBlockProgressQuestion(text) {
  const source = String(text || '');
  if (!source.trim() || escapePattern.test(source)) return false;
  const tail = source.slice(-QUESTION_TAIL_CHARS);
  if (!progressQuestionPattern.test(tail)) return false;
  if (consentExemptPattern.test(tail)) return false;
  return true;
}

export function pruneState(state, now = new Date()) {
  const result = {};
  const cutoff = new Date(now).getTime() - DAY_MS;
  if (!state || typeof state !== 'object' || Array.isArray(state)) return result;
  for (const [key, value] of Object.entries(state)) {
    const updated = Date.parse(value?.updatedAt || '');
    if (Number.isFinite(updated) && updated > cutoff) result[key] = value;
  }
  return result;
}

export function bumpState(state, sessionId, requestedBlock, now = new Date()) {
  const next = pruneState(state, now);
  if (!sessionId) return { state: next, blocked: Boolean(requestedBlock) };
  const consecutive = Number.isInteger(next[sessionId]?.consecutive) ? Math.max(0, next[sessionId].consecutive) : 0;
  const blocked = Boolean(requestedBlock) && consecutive < 3;
  next[sessionId] = { consecutive: blocked ? consecutive + 1 : 0, updatedAt: new Date(now).toISOString() };
  return { state: next, blocked };
}

export function latestAssistantText(transcript, options) {
  return readLatestAssistantText(transcript, options);
}

function enabled() {
  if (process.env.ORGIAST_STOP_GATE === '1') return true;
  try { return fs.existsSync(path.join(home(), '.claude', 'stop-gate-enabled')); } catch { return false; }
}

function reasonFor(items) {
  return `[STOP-GATE] 完了報告と同時に、次の残作業が宣言されています:\n${items.join('\n')}\n\n止まらず次の項目に着手せよ。全部終わったら止まってよい。\n本当に残っていないなら応答に \`[TODO-NONE]\` を、意図して止まるなら理由付きで \`[STOP-OK]\` を含めれば通る。\n完了報告での停止は実測で最多(14日で573回)。§1.15の自律進行を機械で強制している`;
}

function progressQuestionReason() {
  return `[STOP-GATE] 承認が要らない質問で止まっている。末尾が「〜しますか/進めますか」で終わっている。

次の一手が明らかなら聞かずに実行せよ。実行してから結果を1〜3行で報告する。選択肢が複数あるなら、最も妥当な案を自分で選んで実行し、選んだ理由と他案を1行で併記せよ（情報を伏せるのではなく、決めてから見せる）。

本当に人間の権限が必要な場合（送信・公開・本番デプロイ・課金・削除・外部への連絡・契約、または予算や宛先など user しか知らない事実）は聞いてよい。その場合は何を・なぜ人間に聞くのかを1行書いて \`[STOP-OK]\` を含めれば通る。

実測: Stop 地点169のうち31回(18.3%)が承認不要の「進めていいですか」。user が「すすめて」と打った15回に対し現行ゲートの発火は0回だった`;
}

function appendLedger(input, kind, text) {
  const ledgerPath = path.join(home(), '.claude', 'stop-gate-ledger.jsonl');
  const record = {
    ts: new Date().toISOString(),
    sessionId: input?.session_id || input?.sessionId || input?.transcript_path || '',
    kind,
    excerpt: String(text || '').slice(-QUESTION_TAIL_CHARS),
  };
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.appendFileSync(ledgerPath, `${JSON.stringify(record)}\n`);
}

async function main() {
  if (!enabled()) return;
  try {
    let raw = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) raw += chunk;
    if (!raw.trim()) return;
    const input = JSON.parse(raw);
    if (input?.stop_hook_active) return;
    const text = input?.assistant_text || latestAssistantText(input?.transcript_path);
    if (!text) return;
    const sessionId = input?.session_id || input?.sessionId || input?.transcript_path || '';
    const statePath = path.join(home(), '.claude', 'stop-gate-state.json');
    let state = {};
    try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch {}
    const remainingTodoBlock = shouldBlock(text);
    const progressQuestionBlock = !remainingTodoBlock && shouldBlockProgressQuestion(text);
    const kind = remainingTodoBlock ? 'remaining-todo' : progressQuestionBlock ? 'progress-question' : '';
    const result = bumpState(state, sessionId, Boolean(kind));
    if (sessionId) {
      try {
        fs.mkdirSync(path.dirname(statePath), { recursive: true });
        fs.writeFileSync(statePath, JSON.stringify(result.state, null, 2) + '\n');
      } catch {}
    }
    if (result.blocked) {
      try { appendLedger(input, kind, text); } catch (error) {
        console.error(`[stop-gate] 台帳書き込み失敗: ${error instanceof Error ? error.message : String(error)}`);
      }
      const reason = kind === 'remaining-todo' ? reasonFor(remainingItems(text)) : progressQuestionReason();
      console.log(JSON.stringify({ decision: 'block', reason }));
    }
  } catch {}
}

if (isEntry(import.meta.url)) await main();
