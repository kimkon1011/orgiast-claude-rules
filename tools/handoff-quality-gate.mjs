import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

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

export function hasHandoff(text) { return handoffPatterns.some(r => r.test(text)) || (numbered.test(text) && imperative.test(text)); }
export function allRoutes(catalog) { return [...new Set(Object.values(catalog).flat())]; }
export function matchRoutes(text, catalog) {
  const lower = text.toLowerCase(); const occupied = []; const matched = [];
  for (const route of allRoutes(catalog).sort((a, b) => b.length - a.length)) {
    const needle = route.toLowerCase(); let at = lower.indexOf(needle);
    while (at >= 0) { const end = at + needle.length; if (!occupied.some(([a,b]) => at < b && end > a)) { occupied.push([at,end]); matched.push(route); break; } at = lower.indexOf(needle, at + 1); }
  }
  return matched;
}
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
  if (!quality) return { decision: 'block', reason: '品質理由が空です。', quality, routesMatched };
  if (/(面倒|時間|トークン|手間を省|実装量|簡単に)/.test(quality)) return { decision: 'block', reason: '品質理由に効率語彙があります。', quality, routesMatched };
  if (routesMatched.length < 3) return { decision: 'block', reason: `既知の自動化経路が${routesMatched.length}件です。3件以上必要です。`, quality, routesMatched };
  if (!rejected) return { decision: 'block', reason: '未試行で却下した経路がありません。', quality, routesMatched };
  if (enforcement['handoff-quality-only']?.mode === 'block') return { decision: 'block', reason: enforcement['handoff-quality-only'].reason || 'handoff-quality-only は強制block中', quality, routesMatched };
  return { decision: 'pass', reason: '品質手渡し', quality, routesMatched };
}
export function latestAssistantText(transcript) {
  let lines = []; try { lines = fs.readFileSync(transcript, 'utf8').trimEnd().split(/\r?\n/).slice(-50); } catch { return ''; }
  for (let i = lines.length - 1; i >= 0; i--) { try { const e = JSON.parse(lines[i]); if (e.type !== 'assistant') continue; const c = e.message?.content; return Array.isArray(c) ? c.filter(x => x.type === 'text').map(x => x.text).join('\n') : typeof c === 'string' ? c : ''; } catch {} }
  return '';
}
export function runGate(input) {
  const text = input?.assistant_text || latestAssistantText(input?.transcript_path);
  if (input?.stop_hook_active) return { decision: 'pass', reason: 'stop_hook_active', routesMatched: [], text };
  const catalog = JSON.parse(fs.readFileSync(path.join(here, 'automation-routes.json'), 'utf8'));
  let enforcement = {}; try { enforcement = JSON.parse(fs.readFileSync(path.join(home(), '.claude', 'rule-enforcement.json'), 'utf8')); } catch {}
  return { ...evaluateHandoff(text, { catalog, enforcement }), text };
}
async function main() {
  let raw = '';
  for await (const c of process.stdin) raw += c;
  if (!raw.trim()) return;
  let input;
  try { input = JSON.parse(raw); } catch { return; }
  const result = runGate(input);
  if (result.decision === 'pass' && result.reason === '手渡しなし') return;
  const excerpt = (result.text || '').slice(0, 200);
  if (!excerpt) {
    console.error('[handoff-quality-gate] ledger書き込みを中止: excerpt が空です');
    if (result.decision === 'block') console.log(JSON.stringify({ decision: 'block', reason: result.reason }));
    return;
  }
  const ledger = path.join(home(), '.claude', 'handoff-ledger.jsonl');
  const record = { ts: new Date().toISOString(), sessionId: input.session_id || path.basename(input.transcript_path || '', '.jsonl'), verdict: result.decision === 'pass' ? 'passed' : 'blocked', reason: result.reason, quality: result.quality || '', routesMatched: result.routesMatched, excerpt };
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
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
