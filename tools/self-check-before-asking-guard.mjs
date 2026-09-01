#!/usr/bin/env node
// 自分で調べられることを user に「確認して教えてください」と投げる応答を止める。
// ONBOARDING §1.1(手作業ゼロ) / §1.2(頼む前に根本診断する)。
//
// なぜ必要か: 2026-08-31、マキモノX自動投稿の件で「@makimono_md にログインできるか、
// メールが届いているか確認して返信してください」と user に調査を依頼した。実際には
// Gmail MCP が接続済みで、こちらが `search_threads` を1回叩けば
// 「登録メールは nishi@orgiast.jp」「Xからの受信は歓迎メール1通のみ」まで即判明した。
// user から「ユーザーに手間をかけさせすぎ。徹底して自分たちで解決するように」と指摘。
// 文書ルール(§1.2)は既にあったのに守れなかったので hook で機械強制する。
//
// 2026-09-01 強化(user 厳命「何度も起きている。二度と起こらないように徹底して」):
//  1. 段落単位の近接判定にした。従来は本文のどこかに依頼表現、どこかにデータソース語が
//     あれば違反にしていたので、「メール非露出0件」のような無関係な文で誤検知していた。
//     誤検知は「またこれか」と無視する癖を作り、本物の違反を見逃す原因になる。
//  2. 取りこぼしていたデータソースを追加した。実害: 「別のセッションが並行作業していた
//     かもしれないので確認してください」と user に投げたが、~/.claude/projects/*/*.jsonl を
//     grep すれば当該セッションIDまで特定できた(実際その場で1分で特定できた)。
//  3. 「ツール名を使ったか」だけでは足りない。Bash は毎セッション何十回も使うので、
//     Bash が tool 条件だと**素通ししてしまう**。そこで tool_use の *入力(コマンド本文)* を
//     probe 正規表現で照合し、「実際にそのデータソースを叩いたか」で判定する。
//  4. 逃がし弁を理由付き必須にした。素の [SELFCHECK-OK] は通さない。
//
// 判定の考え方: 「依頼文か」ではなく「調査の外注か」を見る。実行依頼(ボタンを押す・
// パスワードを入れる)は人にしかできないので通す。止めるのは *結果をこちらに報告させる*
// 形(教えてください/返信ください/確認して報告)で、かつ当該データソースを
// このセッションで一度も自分で叩いていない場合だけ。
import fs from 'node:fs';
import { isEntry } from './is-entry.mjs';
import { lastAssistantText, readStdin } from './transcript-tail.mjs';

// 「調べた結果をこちらに返してほしい」という形。実行依頼(押して/入力して)は含めない。
const REPORT_BACK = /(?:教えて|返信して|報告して|共有して|知らせて|返して)\s*(?:ください|下さい|もらえますか|いただけますか|ほしい|欲しい)|返信(?:を)?(?:ください|下さい|お願い)|(?:確認|チェック|調べ|見)(?:して|し|て)\s*(?:みて)?\s*(?:ください|下さい|もらえますか|いただけますか)|(?:あるか|いるか|できるか|届いているか|存在するか|どちらか|どれか)[^。.\n]{0,20}(?:教えて|返信|報告|確認)|(?:分かりますか|わかりますか|ご存じですか|心当たり)/;

// 人にしかできない操作。この語を含む段落は「頼んで良い依頼」なので判定から外す。
// ここを削ると「同意・承認・支払いまで自動化しろ」という誤ったガードになる(CLAUDE.md 🛑上限)。
const HUMAN_ONLY = /OAuth|初回同意|同意画面|ブラウザで(?:ログイン|同意|承認|許可)|支払|決済|クレジットカード|APIキーを(?:発行|作成)|SMS|二段階認証|物理|現地|電話|権限(?:を)?(?:付与|付けて|足して)/;

// 自分で叩けるデータソース。
//   ask   … その段落が「そのデータソースの話」かどうか
//   tool  … 証拠になるツール名(MCP のように名前だけで用途が確定するもの)
//   probe … 証拠になる *コマンド本文*。Bash/PowerShell のように汎用なツールはこちらで見る
// tool と probe はどちらか一方でも当たれば「自分で調べた」と見なす。
const SOURCES = [
  {
    key: 'Gmail',
    ask: /メール|受信トレイ|Gmail|迷惑メール|認証コード|届いて|from:|メールアドレス/i,
    tool: /Gmail/i,
    how: 'mcp__claude_ai_Gmail__search_threads / get_message',
  },
  {
    key: 'Google Drive',
    ask: /Google ?ドキュメント|スプレッドシート|Google ?Drive|ドライブ|共有フォルダ|Docs?\b/i,
    tool: /Google_Drive|gpage-fetch/i,
    how: 'mcp__claude_ai_Google_Drive__search_files / read_file_content',
  },
  {
    key: 'GitHub / シェル',
    ask: /GitHub|リポジトリ|招待|invitation|secrets?|コミット|ブランチ|PR\b/i,
    probe: /gh\s+(?:api|pr|repo|secret|issue|run)|git\s+(?:log|status|remote|show|ls-remote)|api\.github\.com/,
    how: 'gh api / gh pr list / git log を Bash で自分で実行',
  },
  {
    // 2026-09-01 追加。「別窓で誰かが作業していないか確認してください」を止める。
    key: 'Claude セッション / 別窓',
    ask: /別(?:の)?(?:セッション|窓|ウィンドウ)|並行(?:して|作業)|他のセッション|心当たり|どのセッション/,
    tool: /^ListAgents$/,
    probe: /ListAgents|projects[\\/][^"']*\.jsonl|session-handoffs|current-session\.json|--resume/,
    how: 'ListAgents で稼働中セッションを一覧 / ~/.claude/projects/*/*.jsonl を grep して特定',
  },
  {
    key: 'プロセス / 起動状態',
    ask: /起動して(?:いる|る)|動いて(?:いる|る)|プロセス|実行中|止まって(?:いる|る)/,
    probe: /tasklist|Get-Process|\bps\s+-|pgrep/,
    how: 'tasklist / Get-Process を自分で実行',
  },
  {
    key: 'ローカル設定・認証情報',
    ask: /設定(?:ファイル|され)|\.env|トークン|認証情報|permissions|インストール(?:済み|されて)/,
    probe: /\.claude[\\/][^"']*\.env|settings\.json|Test-Path|auth\.json|\bls\b[^\n"']*\.env/,
    how: 'ls ~/.claude/*.env や settings.json の中身で存在を自分で確認する(値は出力しない)',
  },
  {
    key: 'デプロイ / 外部サービスの状態',
    ask: /Vercel|デプロイ(?:され|済|状態)|本番(?:に|へ)?(?:反映|出て)|Discord の(?:チャンネル|投稿)|webhook/i,
    probe: /api\.vercel\.com|vercel[^\n"']*(?:inspect|ls|deploy|env)|discord\.com\/api|curl\s+[^\n"']*https?:/,
    how: 'Vercel / Discord の REST API を curl・fetch で自分で叩いて状態を取得する',
  },
];

// transcript の末尾から tool_use の name と input(コマンド本文)を集める。
// name だけだと Bash が万能キーになって素通しするので、input も証拠に使う。
export function scanToolUses(transcriptPath, maxBytes = 4 * 1024 * 1024) {
  const names = new Set();
  const inputs = [];
  let raw = '';
  try {
    const stat = fs.statSync(transcriptPath);
    const length = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(transcriptPath, 'r');
    try { fs.readSync(fd, buffer, 0, length, stat.size - length); } finally { fs.closeSync(fd); }
    raw = buffer.toString('utf8');
  } catch { return { names, inputs: '' }; }

  for (const line of raw.split('\n')) {
    if (!line.includes('"tool_use"')) continue;
    let parsed;
    try { parsed = JSON.parse(line); } catch { continue; }
    const content = parsed?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || block.type !== 'tool_use') continue;
      if (block.name) names.add(block.name);
      if (block.input) {
        try { inputs.push(JSON.stringify(block.input)); } catch { /* 循環参照などは捨てる */ }
      }
    }
  }
  return { names, inputs: inputs.join('\n') };
}

// 後方互換: 既存の呼び出し元(hook-selfcheck 等)は名前の Set だけを期待している。
export function scanToolNames(transcriptPath, maxBytes = 4 * 1024 * 1024) {
  return scanToolUses(transcriptPath, maxBytes).names;
}

// 逃がし弁は理由付きのときだけ有効。素の [SELFCHECK-OK] を許すと形骸化するため。
export function hasEvidenceMarker(text) {
  return /\[SELFCHECK-OK\s*[:：]\s*[^\]]{10,}\]/.test(String(text || ''));
}

export function hasBareMarker(text) {
  const body = String(text || '');
  return /\[SELFCHECK-OK\s*\]/.test(body) && !hasEvidenceMarker(body);
}

// 判定単位を段落にする。コードブロックと引用は本文ではないので落とす。
export function splitParagraphs(text) {
  const lines = String(text || '').split(/\r?\n/);
  const paragraphs = [];
  let current = [];
  let inFence = false;
  const flush = () => { if (current.length) { paragraphs.push(current.join('\n')); current = []; } };
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('```')) { inFence = !inFence; flush(); continue; }
    if (inFence) continue;
    if (trimmed.startsWith('>')) continue;
    if (trimmed === '') { flush(); continue; }
    current.push(line);
  }
  flush();
  return paragraphs;
}

function hasEvidence(source, evidence) {
  const names = [...(evidence.names || [])];
  if (source.tool && names.some((name) => source.tool.test(name))) return true;
  if (source.probe && source.probe.test(evidence.inputs || '')) return true;
  return false;
}

// evidence は { names:Set, inputs:string }。後方互換のため Set を直接渡す呼び方も許す。
export function findOutsourcedInvestigation(text, evidenceOrNames) {
  const body = String(text || '');
  if (!body.trim()) return null;
  if (hasEvidenceMarker(body)) return null;

  const evidence = evidenceOrNames instanceof Set
    ? { names: evidenceOrNames, inputs: '' }
    : { names: evidenceOrNames?.names || new Set(), inputs: evidenceOrNames?.inputs || '' };

  const found = new Map();
  for (const paragraph of splitParagraphs(body)) {
    if (HUMAN_ONLY.test(paragraph)) continue;      // 人にしかできない操作は頼んで良い
    if (!REPORT_BACK.test(paragraph)) continue;    // 同じ段落に依頼表現が無ければ対象外
    for (const source of SOURCES) {
      if (!source.ask.test(paragraph)) continue;
      if (hasEvidence(source, evidence)) continue;
      if (!found.has(source.key)) found.set(source.key, source);
    }
  }
  if (found.size === 0) return null;
  return { sources: [...found.values()], bareMarker: hasBareMarker(body) };
}

export function formatViolationMessage(result) {
  if (!result) return '';
  const list = result.sources.map((source) => `  - ${source.key}: ${source.how}`).join('\n');
  const bare = result.bareMarker
    ? '\n[SELFCHECK-OK] だけでは通りません。何を実測したかを書いてください: [SELFCHECK-OK: 全セッションの jsonl を grep して特定済み]\n'
    : '';
  return `[SELFCHECK-GUARD] user に「調べて教えてください」と頼んでいますが、そのデータソースをこのセッションで自分では一度も叩いていません。\n\n先に自分で確認してください:\n${list}\n${bare}\nONBOARDING §1.1 / §1.2: user の手作業は極限まで減らす。頼む前に自分で根本診断する。\n人に残していいのは「人にしかできない操作」(初回OAuth同意・APIキー発行・支払い・物理・SMS認証)だけで、\n「アカウントが存在するか」「メールが届いているか」「どのアドレスで登録したか」「別窓で誰が作業しているか」は自分で確認できます。\n\n自分で確認済みの上でなお user にしか分からない場合は、理由付きで [SELFCHECK-OK: 何を実測したか] と書いてください。`;
}

async function main() {
  try {
    const raw = await readStdin();
    if (!raw.trim()) return;
    const input = JSON.parse(raw);
    if (input.stop_hook_active || !input.transcript_path || !fs.existsSync(input.transcript_path)) return;
    const result = findOutsourcedInvestigation(lastAssistantText(input.transcript_path), scanToolUses(input.transcript_path));
    const message = formatViolationMessage(result);
    if (message) {
      console.error(message);
      process.exitCode = 2;
    }
  } catch {}
}

if (isEntry(import.meta.url)) await main();
