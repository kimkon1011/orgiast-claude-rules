import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isEntry } from './is-entry.mjs';
import { latestAssistantText as readLatestAssistantText } from './lib/assistant-text.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ruleId = 'negative-claim-primary-source';
const home = () => process.env.ORGIAST_HOME || process.env.USERPROFILE || process.cwd().match(/^(\/mnt\/[a-z]\/Users\/[^/]+)/i)?.[1] || os.homedir();
const targets = /(?:API|CLI|SDK|MCP|エンドポイント|パッケージ|ライブラリ|プラグイン|コマンド|公式ツール|インテグレーション)/i;
const negatives = /(?:存在しない|(?:が|は)\s*無い|提供されていない|公開されていない|用意されていない|対応していない|未対応|使えない|組み込めない|不可能|実現できない|no public API|not available|does not exist)/i;
const negativeTerms = /(?:存在しない|(?:が|は)\s*無い|提供されていない|公開されていない|用意されていない|対応していない|未対応|使えない|組み込めない|不可能|実現できない|no public API|not available|does not exist)/gi;
const reservations = /(?:まだ確認できていない|確認できていない|未確認|不明|分からない|わからない|と思われる|可能性がある|かもしれない|seem(?:s)?|appears?|may|might|unknown|unconfirmed)/i;
const primarySources = /(?:registry\.npmjs\.org|\bnpm\s+(?:view|search)\b|pypi\.org|\bpip\s+index\b|api\.github\.com|\bgh\s+(?:api|search)\b|crates\.io|pkg\.go\.dev|rubygems\.org|packagist\.org)/i;
const correctionMarkers = /(?:誤り(?:だった)?|訂正|と答えた|と書いた|と断定した|前回|先ほど)/i;
const metaMarkers = /(?:検出|パターン|正規表現|ゲート|フック|ルール)/i;
const environmentAfterNegative = /(?:存在しない|(?:が|は)\s*無い|提供されていない|公開されていない|用意されていない|対応していない|未対応|使えない|組み込めない|不可能|実現できない)\s*(?:この\s*)?(?:機体|端末|PC|環境|マシン|サーバー?|コンテナ)/i;
const judgmentMarkers = /(?:✅|❌|⚠️|真陽性|偽陽性|誤爆|期待)/;

function tailText(file, maxBytes = 1024 * 1024) {
  try {
    const stat = fs.statSync(file); const size = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(size); const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buffer, 0, size, stat.size - size); } finally { fs.closeSync(fd); }
    return buffer.toString('utf8');
  } catch { return ''; }
}

export function latestAssistantText(transcript) {
  return readLatestAssistantText(transcript);
}

function sentences(text) { return String(text).split(/(?<=[。！？!?])|\r?\n/).map(x => x.trim()).filter(Boolean); }

function isExcludedContext(sentence) {
  const trimmed = sentence.trim();
  if ((trimmed.startsWith('|') && trimmed.endsWith('|')) || (trimmed.match(/ \| /g) || []).length >= 2) return true;
  if (correctionMarkers.test(sentence)) return true;
  const negativeCount = [...sentence.matchAll(negativeTerms)].length;
  if (metaMarkers.test(sentence) && negativeCount >= 2 && /[\/／、]/.test(sentence)) return true;
  const quoted = [...sentence.matchAll(/「[^」]*」|『[^』]*』|"[^"]*"/g)];
  if (quoted.some(match => targets.test(match[0]) && negatives.test(match[0]))) {
    const outside = quoted.reduce((text, match) => text.replace(match[0], ''), sentence);
    if (!negatives.test(outside) && judgmentMarkers.test(outside)) return true;
  }
  return environmentAfterNegative.test(sentence);
}

export function findNegativeClaim(text) {
  for (const sentence of sentences(text)) {
    if (targets.test(sentence) && negatives.test(sentence) && !reservations.test(sentence) && !isExcludedContext(sentence)) return sentence;
  }
  return '';
}

export function inferProduct(claim) {
  const before = claim.split(targets)[0]
    .replace(/^[\s>*#`「『【（(]+|[\s「『【（(]+$/g, '')
    .replace(/(?:について|には|では|の|に|は|が)\s*$/g, '').trim();
  const tokens = before.match(/[A-Za-z][A-Za-z0-9._-]*/g);
  if (tokens?.length) return tokens.at(-1);
  const japanese = before.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ーA-Za-z0-9._-]+/gu);
  return japanese?.at(-1) || '対象製品';
}

function productPattern(product) {
  const normalized = product.toLowerCase().replace(/[^a-z0-9]/g, '');
  return normalized.length >= 2 ? normalized : '';
}

export function hasPrimarySourceEvidence(transcript, product) {
  const raw = tailText(transcript);
  const needle = productPattern(product);
  // tool_use の command / url だけを対象にし、検索結果や assistant 本文の記述は証拠にしない。
  for (const line of raw.split(/\r?\n/)) {
    let entry; try { entry = JSON.parse(line); } catch { continue; }
    const blocks = entry?.message?.content; if (!Array.isArray(blocks)) continue;
    for (const block of blocks) {
      if (block?.type !== 'tool_use') continue;
      const command = String(block.input?.command || ''); const url = String(block.input?.url || '');
      if (primarySources.test(command) || primarySources.test(url)) {
        if (!needle) return true;
        const normalizedCommand = command.toLowerCase().replace(/[^a-z0-9]/g, '');
        const normalizedUrl = url.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (normalizedCommand.includes(needle) || normalizedUrl.includes(needle)) return true;
      }
      if (needle && /webfetch/i.test(block.name || '')) {
        try { if (new URL(url).hostname.toLowerCase().replace(/[^a-z0-9]/g, '').includes(needle)) return true; } catch {}
      }
    }
  }
  return false;
}

function commands(product) {
  const query = encodeURIComponent(product); const scope = encodeURIComponent(`@${product}`).replace(/%40/i, '@');
  return [
    `curl -s "https://registry.npmjs.org/-/v1/search?text=${query}"`,
    `curl -s -o /dev/null -w "%{http_code}" "https://registry.npmjs.org/${scope}%2fcli"`,
    `curl -s "https://pypi.org/pypi/${query}/json"`,
    `gh search repos ${JSON.stringify(product)} --limit 10`,
  ];
}

export function evaluateNegativeClaim({ text, transcriptPath }) {
  const claim = findNegativeClaim(text); if (!claim) return { decision: 'pass', reason: '否定存在断定なし' };
  const product = inferProduct(claim);
  if (hasPrimarySourceEvidence(transcriptPath, product)) return { decision: 'pass', reason: '一次ソース照会済み', claim, product };
  return { decision: 'block', reason: `「${claim}」は一次ソース未照会の否定断定です。次を実行して確認してください:\n${commands(product).join('\n')}`, claim, product };
}

function configuredMode() {
  let registryMode = 'warn';
  try {
    const registry = JSON.parse(fs.readFileSync(path.join(here, 'rules-registry.json'), 'utf8'));
    const value = registry.rules?.find(rule => rule.id === ruleId)?.enforcement;
    if (value === 'block' || value === 'warn') registryMode = value;
  } catch {}
  try {
    const enforcement = JSON.parse(fs.readFileSync(path.join(home(), '.claude', 'rule-enforcement.json'), 'utf8'));
    const value = enforcement?.[ruleId];
    const mode = typeof value === 'string' ? value : value?.mode;
    if (mode === 'block' || mode === 'warn') return mode;
  } catch {}
  return registryMode;
}

function appendLedger(input, result, verdict) {
  const ledger = path.join(home(), '.claude', 'handoff-ledger.jsonl');
  const record = { ts: new Date().toISOString(), sessionId: input.session_id || path.basename(input.transcript_path || '', '.jsonl'), rule: ruleId, verdict, reason: result.reason, excerpt: result.claim || '' };
  fs.mkdirSync(path.dirname(ledger), { recursive: true }); fs.appendFileSync(ledger, JSON.stringify(record) + '\n');
  const written = JSON.parse(fs.readFileSync(ledger, 'utf8').trimEnd().split(/\r?\n/).at(-1));
  if (written.rule !== record.rule) throw new Error('台帳のread-backに失敗しました');
}

function applyRepeatGuard(input, result) {
  if (result.decision !== 'block') return result;
  try {
    const stateFile = path.join(home(), '.claude', 'negative-claim-gate-state.json');
    const sessionId = input.session_id || path.basename(input.transcript_path || '', '.jsonl');
    const hash = crypto.createHash('sha256').update(result.claim).digest('hex'); const key = `${sessionId}:${hash}`;
    let state = {}; try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {}
    if (state[key]) return { ...result, decision: 'warn', reason: `${result.reason}\n同一クレームの2回目のため警告のみで通過します。` };
    state[key] = { ts: new Date().toISOString() }; fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  } catch (error) { console.error(`[negative-claim-gate] 状態保存失敗（block判定は維持）: ${error instanceof Error ? error.message : String(error)}`); }
  return result;
}

async function main() {
  try {
    let raw = ''; for await (const chunk of process.stdin) raw += chunk;
    if (!raw.trim()) { console.error('[negative-claim-gate] 入力が空のため判定をスキップしました'); return; }
    let input; try { input = JSON.parse(raw); } catch { console.error('[negative-claim-gate] JSON入力が壊れているため判定をスキップしました'); return; }
    const text = input.assistant_text || latestAssistantText(input.transcript_path);
    if (!text || input.stop_hook_active) return;
    let result = evaluateNegativeClaim({ text, transcriptPath: input.transcript_path });
    if (result.decision === 'pass' && result.reason === '否定存在断定なし') return;
    if (result.decision === 'block' && configuredMode() !== 'block') result = { ...result, decision: 'warn' };
    result = applyRepeatGuard(input, result);
    try { appendLedger(input, result, result.decision === 'block' ? 'blocked' : result.decision === 'warn' ? 'warned' : 'passed'); } catch (error) { console.error(`[negative-claim-gate] 台帳書き込み失敗: ${error.message}`); }
    if (result.decision === 'block') console.log(JSON.stringify({ decision: 'block', reason: result.reason }));
    else if (result.decision === 'warn') console.error(`[negative-claim-gate] ${result.reason}`);
  } catch (error) { console.error(`[negative-claim-gate] 例外を握って通過します: ${error instanceof Error ? error.message : String(error)}`); }
}

if (isEntry(import.meta.url)) await main();
