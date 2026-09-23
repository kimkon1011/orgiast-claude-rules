#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';
import { readStdin } from './transcript-tail.mjs';

export const GMAIL_WRITE_ACTIONS = ['create_draft', 'send_message', 'update_draft', 'reply', 'forward'];
export const TARGET = new RegExp(`^mcp__claude_ai_Gmail(?:_\\d+)?__(${GMAIL_WRITE_ACTIONS.join('|')})$`);
const RECIPIENT_FIELD = /^(?:to|cc|bcc|recipients?|to_?recipients?|cc_?recipients?|bcc_?recipients?|to_?addresses?|cc_?addresses?|bcc_?addresses?)$/i;
const ADDRESS_FIELD = /^(?:email|email_?address|address|value)$/i;

// GitHub の @メンションは「誰に届くか」が GitHub 側の通知になるため、内部ハンドルを同じ台帳で塞ぐ。
// 2026-09-18 実害: PR #413/#417/#424 で `gh pr comment --body '@kimkon1011 …'` が素通りした。
// 対象は gh の書き込み系コマンドだけ（読み取りや無関係な Bash では判定しない）。
export const SHELL_TOOLS = 'Bash|PowerShell';
export const SHELL_TOOL = new RegExp(`^(?:${SHELL_TOOLS})$`);
// register-hooks.mjs は add() がスクリプト名(basename)で重複判定し、syncMatcherFor が
// 同スクリプトを含む全 group の matcher をこの値へ上書きする。よって「Gmail 用」「Bash 用」の
// 2本登録はできない（2本目は no-op になり、1本目の matcher も潰れる）。matcher は1本に合成する。
export const HOOK_MATCHER = `${TARGET.source.replace(/^\^/, '').replace(/\$$/, '')}|${SHELL_TOOLS}`;
// gh の書き込み系。`--body` を伴う PR/Issue 本文・レビュー・コメントが該当する。
const GH_WRITE = /(?:^|[\s;&|(])gh\s+(?:pr|issue)\s+(?:comment|create|review|edit)\b/i;
// `gh api repos/o/r/issues/1/comments -f body='…'` のような REST 経由の投稿。
const GH_API_COMMENT = /(?:^|[\s;&|(])gh\s+api\b[^\n]*\/comments\b/i;
// 境界付きハンドル抽出。直後が英数/- なら長い別ハンドルの一部、直前がメールのローカル部
// （[A-Za-z0-9._%+-]）ならメールアドレスなので拾わない。
const MENTION = /(?<![\w.%+-])@([A-Za-z0-9][A-Za-z0-9-]{0,38})(?![A-Za-z0-9-])/g;

export function extractAddresses(toolInput) {
  const addresses = new Set();
  function visit(value, recipient = false) {
    if (typeof value === 'string') {
      if (recipient) for (const match of value.matchAll(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+/gi)) addresses.add(match[0].toLowerCase());
    } else if (Array.isArray(value)) {
      for (const item of value) visit(item, recipient);
    } else if (value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) visit(item, RECIPIENT_FIELD.test(key) || (recipient && ADDRESS_FIELD.test(key)));
    }
  }
  visit(toolInput);
  return [...addresses];
}

export function isInternal(addr, ledger) {
  const normalized = String(addr).trim().toLowerCase();
  const domain = normalized.slice(normalized.lastIndexOf('@') + 1);
  return ledger.addresses.some((item) => item.trim().toLowerCase() === normalized)
    || (normalized.includes('@') && ledger.domains.some((item) => item.trim().toLowerCase() === domain));
}

export function judge(hookInput, ledger) {
  if (!TARGET.test(hookInput?.tool_name || '')) return { decision: 'pass', addresses: [], internal: [] };
  const addresses = extractAddresses(hookInput.tool_input);
  const internal = addresses.filter((addr) => isInternal(addr, ledger));
  if (!internal.length) return { decision: 'pass', addresses, internal };
  const reason = `[INTERNAL-RECIPIENT] ${internal.join(', ')} は内部（社内・グループ会社・スタッフ）宛です。kim の内部連絡はリモートデスクトップ／LINE／Discord で、Gmail は見に行きません（2026-09-11 厳命）。Gmail の下書き・送信は作らず、チャット本文に「宛先／用件／本文」をコピペできる完成形で表示してください。Gmail 下書きは顧客・取引先・外部の人宛だけ有効です。台帳: ~/.claude/internal-recipients.json`;
  return { decision: 'block', addresses, internal, reason };
}

export function githubHandles(ledger) {
  const handles = ledger?.githubHandles;
  return Array.isArray(handles) ? handles.map((item) => String(item).trim().toLowerCase()).filter(Boolean) : [];
}

export function isGhWriteCommand(command) {
  const text = String(command ?? '');
  if (!/\bgh\b/.test(text)) return false;
  return GH_WRITE.test(text) || GH_API_COMMENT.test(text);
}

export function extractMentions(command) {
  const handles = new Set();
  for (const match of String(command ?? '').matchAll(new RegExp(MENTION.source, MENTION.flags))) handles.add(match[1].toLowerCase());
  return [...handles];
}

export function judgeBash(hookInput, ledger) {
  if (!SHELL_TOOL.test(hookInput?.tool_name || '')) return { decision: 'pass', mentions: [], internal: [] };
  const command = String(hookInput?.tool_input?.command ?? '');
  if (!isGhWriteCommand(command)) return { decision: 'pass', mentions: [], internal: [] };
  const mentions = extractMentions(command);
  const internal = mentions.filter((handle) => githubHandles(ledger).includes(handle));
  if (!internal.length) return { decision: 'pass', mentions, internal };
  const reason = `[INTERNAL-MENTION] @${internal.join(', @')} は内部ハンドルです。GitHub のコメント・PR/Issue 本文で @メンションすると通知が GitHub 側に飛び、内部連絡が外部サービス経由になります（2026-09-18 実害: PR #413/#417/#424）。@ を外して名前はプレーンテキスト（例: kim）で書き、相手に渡すのは URL をチャットに出す形にしてください。台帳: ~/.claude/internal-recipients.json の githubHandles`;
  return { decision: 'block', mentions, internal, reason };
}

export function loadLedger({ home = process.env.ORGIAST_HOME || os.homedir() } = {}) {
  const read = (file) => {
    const ledger = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (!ledger || !['domains', 'addresses'].every((key) => Array.isArray(ledger[key]) && ledger[key].every((item) => typeof item === 'string'))) throw new Error('台帳の形式が不正です');
    // githubHandles は任意項目。既に ~/.claude/internal-recipients.json を持つ他PCを壊さないため
    // 未定義を許容する（欠けていてもキーを足さず、参照側で [] に倒す）。
    if (ledger.githubHandles !== undefined && (!Array.isArray(ledger.githubHandles) || !ledger.githubHandles.every((item) => typeof item === 'string'))) throw new Error('台帳の形式が不正です (githubHandles)');
    return ledger;
  };
  try {
    return read(path.join(home, '.claude', 'internal-recipients.json'));
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('[INTERNAL-RECIPIENT] 台帳を読めないため default 台帳を使用します。');
    return read(new URL('./internal-recipients.default.json', import.meta.url));
  }
}

async function main() {
  try {
    const raw = await readStdin();
    if (!raw.trim()) return;
    const input = JSON.parse(raw);
    const toolName = input?.tool_name || '';
    const result = TARGET.test(toolName) ? judge(input, loadLedger())
      : SHELL_TOOL.test(toolName) ? judgeBash(input, loadLedger())
        : null;
    if (result?.decision === 'block') console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: result.reason } }));
  } catch {
    console.error('[INTERNAL-RECIPIENT] 入力または台帳を読めないため判定をスキップしました。');
  }
}

if (isEntry(import.meta.url)) await main();
