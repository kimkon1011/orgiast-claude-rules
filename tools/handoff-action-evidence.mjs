// 手渡しゲートの証拠面: 本文の書式ではなく transcript 上の実際の tool_use を検証する。
// 2026-10-10 実測: handoff-quality-only 違反率 100% の原因はゲートが書式だけ見ていたこと。
// 実例(e935bf27): IMAP に一度も接続せず「認証情報が無いので読めません」と手渡した。
import { currentTurnEntries, blocks } from './state-claim-evidence.mjs';
import { hasHandoff } from './handoff-quality-gate.mjs';
import { hasManualRequest } from './manual-request-fullsteps-gate.mjs';

// 実行位置での外部 CLI。echo/grep 内の言及は始まらない位置なので除外される
// （state-claim-evidence.mjs queriedVendorsFromRaw と同じ考え方）。
const externalCli = /(?:^|[;\n|&]\s*|\b(?:env|sudo)\s+)(?:\s*)(?:npx\s+)?(curl|wget|Invoke-RestMethod|Invoke-WebRequest|gh|vercel|gcloud|clasp|supabase|wrangler|npm\s+view|npx|ssh|openssl\s+s_client|imap|dig|nslookup)(?=[\s"'`]|$)/gi;

function hostFromUrl(value) {
  try {
    const url = new URL(value);
    return url.hostname || null;
  } catch {
    return null;
  }
}

function cliAtExecutionPosition(command) {
  for (const match of String(command || '').matchAll(externalCli)) {
    return match[1];
  }
  return null;
}

function scanToolUses(toolUses) {
  const external = [];
  const localOnly = [];
  for (const block of toolUses) {
    const name = String(block.name || '');
    const input = block.input || {};
    if (name.startsWith('mcp__')) {
      external.push({ tool: name, target: name.split('__')[1] || 'mcp' });
      continue;
    }
    if (/^Web(?:Fetch|Search)$/i.test(name)) {
      external.push({ tool: name, target: hostFromUrl(input.url) || 'web' });
      continue;
    }
    if (/^(?:Bash|PowerShell)$/i.test(name)) {
      const command = String(input.command || input.script || '');
      const cli = cliAtExecutionPosition(command);
      if (cli) {
        const urlMatch = command.match(/https?:\/\/[^\s"'`<>]+/);
        const host = urlMatch ? hostFromUrl(urlMatch[0]) : null;
        external.push({ tool: name, target: host || cli });
      } else {
        localOnly.push(name);
      }
      continue;
    }
    localOnly.push(name);
  }
  return { external, localOnly };
}

export function scanExternalAccesses(raw) {
  return scanToolUses(blocks(currentTurnEntries(raw), 'tool_use'));
}

// 今ターンに tool_use が1つも無いトランスクリプト向けのフォールバック: 末尾 300 行を走査。
export function scanExternalAccessesRecent(raw) {
  const toolUses = [];
  for (const line of String(raw || '').split(/\r?\n/).slice(-300)) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry || entry.isSidechain === true) continue;
    const content = entry.message?.content || entry.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === 'tool_use') toolUses.push(block);
      }
    }
  }
  return scanToolUses(toolUses);
}

// 条件B: 外部システムが使えないという主張。否定語の近傍 120 字以内に外部対象語がある場合だけ。
const impossibles = /読め(?:ない|ません)|見れ(?:ない|ません)|アクセスでき(?:ない|ません)|接続でき(?:ない|ません)|取得でき(?:ない|ません)|開け(?:ない|ません)|認証情報が(?:無い|ない|ありません)|API\s*が(?:無い|ない)|トークンが(?:無い|ない)|権限が(?:無い|ない)/g;
const externalSubjects = /メール|IMAP|SMTP|Gmail|Yahoo|Outlook|Drive|スプレッドシート|Vercel|Supabase|GitHub|Discord|Slack|Notion|Webhook|Console|Dashboard|freee|Stripe|GA4|Search Console|MCP|外部 API/i;

// 条件A補助: 「Yahoo メールを見てください」のように、外部対象語についての命令形は
// hasHandoff の定型書式に載らないため依頼として検出できていなかった（2026-10-10 実測の fail 2件）。
// 書式そのものではなく「user への依頼であること」を、命令形＋外部対象語の同一文で判定する。
const userImperative = /(ください|下さい|お願いします|お願いいたします|お願い致します|願います)/;

function requestsUserActionOnExternal(value) {
  for (const part of String(value || '').split(/(?<=[。.!！?？])|\r?\n/)) {
    if (userImperative.test(part) && externalSubjects.test(part)) return true;
  }
  return false;
}

function claimsExternalUnreachable(value) {
  for (const match of String(value).matchAll(impossibles)) {
    const from = Math.max(0, match.index - 120);
    const to = match.index + match[0].length + 120;
    if (externalSubjects.test(value.slice(from, to))) return match[0];
  }
  return null;
}

export function formatHandoffActionReason() {
  return `[HANDOFF-ACTION] 手渡す前に、対象システムへ実際にアクセスしていません。

本文に書かれた「試したこと」に対応する tool_use がこのターンに存在しません。
ローカルの Grep/Glob は「外部システムが使えない証拠」になりません。

やること: 対象システムに1回アクセスし、その失敗（エラー本文）を証拠として貼ってから手渡してください。
アクセスできて目的を達せられるなら、手渡しは不要です。自分で完了させてください。`;
}

export function findUnbackedExternalHandoff(text, raw) {
  const value = String(text || '');
  // 逃がし弁: 理由付きのみ有効。素の [HANDOFF-ACTION-OK] は不可。
  if (/\[HANDOFF-ACTION-OK\s*[:：]\s*[^\]]{10,}\]/.test(value)) return null;
  // 条件A: 手渡しである（定型書式のほか、外部対象語についての命令形も依頼として扱う）。
  if (!hasHandoff(value) && !hasManualRequest(value) && !requestsUserActionOnExternal(value)) return null;
  // 条件B: 外部システムが使えないと主張している（ローカル作業の依頼は対象外）。
  const denial = claimsExternalUnreachable(value);
  if (!denial) return null;
  // 条件C: 実アクセスの証拠が無い。ローカルの Grep/Glob/Read は証拠にならない。
  const current = scanExternalAccesses(raw);
  const recent = current.external.length ? { external: [], localOnly: [] } : scanExternalAccessesRecent(raw);
  if (current.external.length + recent.external.length > 0) return null;
  return {
    code: 'HANDOFF-ACTION',
    reason: formatHandoffActionReason(),
    external: [...current.external, ...recent.external],
    localOnly: [...current.localOnly, ...recent.localOnly],
    matched: denial,
  };
}
