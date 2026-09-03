import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { isEntry } from './is-entry.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const home = () => process.env.ORGIAST_HOME || process.env.USERPROFILE || process.cwd().match(/^(\/mnt\/[a-z]\/Users\/[^/]+)/i)?.[1] || os.homedir();
const handoffPatterns = [
  /環境変数.*(設定|追加|登録).*(してください|お願い)/s,
  /Vercel.*(Dashboard|設定|環境変数).*(開いて|クリック|追加|設定|登録)/s,
  /Supabase Dashboard.*(SQL|Connect|実行|開いて)/s,
  /(Settings|Console|Dashboard).*(クリック|タブ|開いて)/s,
  /(コピー|貼り付け|paste).*(ください|お願い)/s,
  /(以下の手順|次の手順|手順は|手順を).*(実行|お試し|お願い|してください)/s,
  /user.*(操作|側で|に依頼)/is, /あなた(の方|側|が).*(設定|実行|操作|登録|追加)/s,
  /こちらの操作が必要|ユーザー側の操作/s,
];
const numbered = /1\.\s*\S+[\s\S]*?\n[\s\S]*?2\.\s*\S+[\s\S]*?\n[\s\S]*?3\.\s*\S+/;
const imperative = /(してください|お願いします|お願いいたします|お願い致します|クリックして|開いてください|入力してください|貼り付けてください|選択してください|コピーして|押してください|ログインしてください)/;
const metaMention = /(gate|hook|検出器|正規表現|ルール|block理由|誤検知)/i;

export function handoffDetectionText(text) {
  const lines = String(text).split(/\r?\n/);
  const visible = [];
  let inFence = false;
  for (const line of lines) {
    const startsInFence = inFence;
    const fences = (line.match(/```/g) || []).length;
    if (fences % 2) inFence = !inFence;
    if (startsInFence || fences || /^\s*>/.test(line)) visible.push('');
    else visible.push(line.replace(/`[^`]*`/g, ''));
  }
  return visible.map((line, index) => {
    const nearby = visible.slice(Math.max(0, index - 1), index + 2).join('\n');
    return metaMention.test(nearby) ? '' : line;
  }).join('\n');
}
export function hasHandoff(text) { const detectionText = handoffDetectionText(text); return handoffPatterns.some(r => r.test(detectionText)) || (numbered.test(detectionText) && imperative.test(detectionText)); }
export function allRoutes(catalog) { return [...new Set(Object.values(catalog).flat())]; }
export function matchRoutes(text, catalog) {
  const lower = text.toLowerCase(); const occupied = []; const matched = [];
  for (const route of allRoutes(catalog).sort((a, b) => b.length - a.length)) {
    const needle = route.toLowerCase(); let at = lower.indexOf(needle);
    while (at >= 0) { const end = at + needle.length; if (!occupied.some(([a,b]) => at < b && end > a)) { occupied.push([at,end]); matched.push(route); break; } at = lower.indexOf(needle, at + 1); }
  }
  return matched;
}
function listedRouteCount(text) { return text.split(/[,、;；]|\s+\/\s+/).map(x => x.trim()).filter(Boolean).length; }
export function usesDeprecatedHandoffTag(text) {
  const lines = text.split(/\r?\n/);
  let inFence = false;
  const mention = /(廃止|deprecated|禁止|使わない|置き換え)/i;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    const fenceMatches = [...line.matchAll(/```/g)];
    let cursor = 0;
    let fenced = inFence;
    const fencedRanges = [];
    for (const fence of fenceMatches) {
      if (fenced) fencedRanges.push([cursor, fence.index + 3]);
      cursor = fence.index + 3;
      fenced = !fenced;
    }
    if (fenced) fencedRanges.push([cursor, line.length]);

    for (const tag of line.matchAll(/\[HANDOFF-OK\]/g)) {
      const column = tag.index;
      const inCodeFence = fencedRanges.some(([start, end]) => column >= start && column < end);
      const inlineRuns = [...line.matchAll(/`{1,2}/g)];
      let inlineStart = null;
      let inInlineCode = false;
      for (const run of inlineRuns) {
        if (!inlineStart) inlineStart = run;
        else if (inlineStart[0].length === run[0].length) {
          if (column >= inlineStart.index + inlineStart[0].length && column < run.index) inInlineCode = true;
          inlineStart = null;
        }
      }
      const quoted = /^\s*>/.test(line);
      const nearby = lines.slice(Math.max(0, lineIndex - 1), lineIndex + 2).join('\n');
      if (!inCodeFence && !inInlineCode && !quoted && !mention.test(nearby)) return true;
    }

    if (fenceMatches.length % 2 === 1) inFence = !inFence;
  }
  return false;
}
export function evaluateHandoff(text, { catalog, enforcement = {} } = {}) {
  if (!hasHandoff(text)) return { decision: 'pass', reason: '手渡しなし', routesMatched: [] };
  if (usesDeprecatedHandoffTag(text)) return { decision: 'block', reason: 'このタグは廃止。`[手渡し判定]` を書いてください。', routesMatched: [] };
  const marker = text.search(/\[手渡し判定\]/);
  if (marker < 0) return { decision: 'block', reason: '`[手渡し判定]` ブロックがありません。', routesMatched: [] };
  const block = text.slice(marker);
  const quality = block.match(/品質理由:\s*([^\n]+)/)?.[1]?.trim() || '';
  const tried = block.match(/試した自動化経路:\s*([^\n]+)/)?.[1]?.trim() || '';
  const rejected = block.match(/未試行で却下した経路:\s*([^\n]+)/)?.[1]?.trim() || '';
  const routesMatched = matchRoutes(tried, catalog);
  const enforced = enforcement['handoff-quality-only']?.mode === 'block';
  const requiredRoutes = enforced ? 4 : 3;
  const requiredRejected = enforced ? 2 : 1;
  if (!quality) return { decision: 'block', reason: '品質理由が空です。', quality, routesMatched };
  if (/(面倒|時間|トークン|手間を省|実装量|簡単に)/.test(quality)) return { decision: 'block', reason: '品質理由に効率語彙があります。', quality, routesMatched };
  if (routesMatched.length < requiredRoutes) return { decision: 'block', reason: `既知の自動化経路が${routesMatched.length}件です。${requiredRoutes}件以上必要です。`, quality, routesMatched };
  if (!rejected) return { decision: 'block', reason: '未試行で却下した経路がありません。', quality, routesMatched };
  const rejectedCount = listedRouteCount(rejected);
  if (rejectedCount < requiredRejected) return { decision: 'block', reason: `未試行で却下した経路が${rejectedCount}件です。${requiredRejected}件以上必要です。`, quality, routesMatched };
  return { decision: 'pass', reason: '品質手渡し', quality, routesMatched };
}
export function latestAssistantText(transcript) {
  let lines = []; try { lines = fs.readFileSync(transcript, 'utf8').trimEnd().split(/\r?\n/).slice(-50); } catch { return ''; }
  for (let i = lines.length - 1; i >= 0; i--) { try { const e = JSON.parse(lines[i]); if (e.type !== 'assistant') continue; const c = e.message?.content; return Array.isArray(c) ? c.filter(x => x.type === 'text').map(x => x.text).join('\n') : typeof c === 'string' ? c : ''; } catch {} }
  return '';
}
export function runGate(input) {
  const text = input?.assistant_text || latestAssistantText(input?.transcript_path);
  // stop_hook_active はブロック後の再実行なので、ここで例外を投げると応答を出せなくなる。
  // カタログが読めない配布不備でも、判定を諦めて通す側に倒す。
  let catalog = null;
  try { catalog = JSON.parse(fs.readFileSync(path.join(here, 'automation-routes.json'), 'utf8')); } catch (error) {
    if (input?.stop_hook_active) return { decision: 'pass', reason: 'stop_hook_active', routesMatched: [], text };
    throw error;
  }
  let enforcement = {}; try { enforcement = JSON.parse(fs.readFileSync(path.join(home(), '.claude', 'rule-enforcement.json'), 'utf8')); } catch {}
  if (input?.stop_hook_active) {
    if (!text) return { decision: 'pass', reason: 'stop_hook_active', routesMatched: [], text };
    const evaluated = evaluateHandoff(text, { catalog, enforcement });
    // 無限ループを防ぐため decision は pass に固定する。判定結果は recheck に残して可視化する。
    return { ...evaluated, decision: 'pass', reason: 'stop_hook_active', recheck: evaluated.decision, text };
  }
  return { ...evaluateHandoff(text, { catalog, enforcement }), text };
}
function recordSkip({ sessionId = '', reason, rawHead = '' }) {
  const skips = path.join(home(), '.claude', 'handoff-gate-skips.jsonl');
  const record = { ts: new Date().toISOString(), sessionId, reason, rawHead: String(rawHead).slice(0, 120) };
  try {
    fs.mkdirSync(path.dirname(skips), { recursive: true });
    fs.appendFileSync(skips, JSON.stringify(record) + '\n');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`[handoff-quality-gate] スキップ記録の書き込み失敗: ${detail} path=${skips}`);
  }
}
async function main() {
  let raw = '';
  for await (const c of process.stdin) raw += c;
  if (!raw.trim()) {
    console.error('[handoff-quality-gate] 入力が空のため判定をスキップしました');
    return;
  }
  let input;
  try { input = JSON.parse(raw); } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const reason = `入力をJSONとして解釈できず判定をスキップしました: ${detail}`;
    console.error(`[handoff-quality-gate] ${reason} (先頭120字: ${raw.slice(0, 120)})`);
    const sessionId = raw.match(/"session_id"\s*:\s*"([^"\\]{1,200})"/)?.[1] || '';
    recordSkip({ sessionId, reason, rawHead: raw });
    return;
  }
  const text = input?.assistant_text || latestAssistantText(input?.transcript_path);
  if (!text && !input?.stop_hook_active) {
    const reason = '判定対象の本文が取得できませんでした (assistant_text/transcript_path なし)';
    console.error(`[handoff-quality-gate] ${reason}`);
    recordSkip({ sessionId: input?.session_id || path.basename(input?.transcript_path || '', '.jsonl'), reason, rawHead: raw });
    return;
  }
  const result = runGate(input);
  if (result.decision === 'pass' && result.reason === '手渡しなし') {
    console.error(`[handoff-quality-gate] 判定をスキップしました: ${result.reason}`);
    return;
  }
  const excerpt = (result.text || '').slice(0, 200);
  if (!excerpt) {
    console.error('[handoff-quality-gate] ledger書き込みを中止: excerpt が空です');
    if (result.decision === 'block') console.log(JSON.stringify({ decision: 'block', reason: result.reason }));
    return;
  }
  const ledger = path.join(home(), '.claude', 'handoff-ledger.jsonl');
  const record = { ts: new Date().toISOString(), sessionId: input.session_id || path.basename(input.transcript_path || '', '.jsonl'), verdict: result.recheck === 'block' ? 'bypassed' : result.decision === 'pass' ? 'passed' : 'blocked', reason: result.reason, quality: result.quality || '', routesMatched: result.routesMatched, excerpt };
  try {
    fs.mkdirSync(path.dirname(ledger), { recursive: true });
    fs.appendFileSync(ledger, JSON.stringify(record) + '\n');
    const lines = fs.readFileSync(ledger, 'utf8').trimEnd().split(/\r?\n/);
    const written = JSON.parse(lines.at(-1));
    if (!written.excerpt) throw new Error('read-backした最終行の excerpt が空です');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`[handoff-quality-gate] ledger書き込み失敗: ${reason} path=${ledger}`);
  }
  if (result.decision === 'block') console.log(JSON.stringify({ decision: 'block', reason: result.reason }));
}
if (isEntry(import.meta.url)) await main();
