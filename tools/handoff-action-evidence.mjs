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
const restoreImpossible = /(?:元に)?戻せ(?:ない|ません)|復元でき(?:ない|ません)|戻すことはでき(?:ない|ません)/;
const impossibles = new RegExp(`読め(?:ない|ません)|見れ(?:ない|ません)|アクセスでき(?:ない|ません)|接続でき(?:ない|ません)|取得でき(?:ない|ません)|開け(?:ない|ません)|認証情報が(?:無い|ない|ありません)|API\\s*が(?:無い|ない)|トークンが(?:無い|ない)|権限が(?:無い|ない)|${restoreImpossible.source}|(?:私|Claude)(?:の側|側)?(?:から|で)は.{0,12}(?:でき(?:ない|ません)|戻せ(?:ない|ません))`, 'g');
const externalSubjects = /メール|IMAP|SMTP|Gmail|Yahoo|Outlook|Drive|(?:スプレッド)?シート|フォーム|Forms|回答|編集履歴|変更履歴|版|リビジョン|バージョン|Vercel|Supabase|GitHub|Discord|Slack|Notion|Webhook|Console|Dashboard|freee|Stripe|GA4|Search Console|MCP|外部 API/i;

// 条件A補助: 「Yahoo メールを見てください」のように、外部対象語についての命令形は
// hasHandoff の定型書式に載らないため依頼として検出できていなかった（2026-10-10 実測の fail 2件）。
// 書式そのものではなく「user への依頼であること」を、命令形＋外部対象語の同一文で判定する。
const reworkRequest = /(?:いただけ|もらえ)ますか|再送|もう一度.{0,10}(?:送|入力|登録|提出)|送り直|入力し直/;
const userImperative = new RegExp(`ください|下さい|お願いします|お願いいたします|お願い致します|願います|${reworkRequest.source}`);

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

// 復元は当ターンの実行だけを見る。ローカル検索・過去ターン・本文の経路名は証拠にしない。
function triedRestoreRoute(raw) {
  const entries = currentTurnEntries(raw);
  const results = blocks(entries, 'tool_result');
  return blocks(entries, 'tool_use').some(tool => {
    const name = String(tool.name || '');
    const command = String(tool.input?.command || tool.input?.script || '');
    const executes = /^mcp__|^WebFetch$/i.test(name)
      || (/^(?:Bash|PowerShell)$/i.test(name)
        && (cliAtExecutionPosition(command) || /^\s*(?:node|python3?|pwsh)\s/.test(command)));
    if (!executes) return false;
    const output = tool.id ? results.filter(result => result.tool_use_id === tool.id) : [];
    const evidence = JSON.stringify([name, tool.input, output]);
    return /\/revisions\b|revisions\.list|forms\.googleapis\.com|\/responses\b|exportLinks|versionHistory|バージョン履歴/i.test(evidence)
      || (/\bgh\s+run\b/.test(command) && /auto-purchase-restore/.test(evidence));
  });
}

export function formatHandoffActionReason() {
  return `[HANDOFF-ACTION] 手渡しに必要な取得・復元経路への実アクセスを確認できません。

本文に書かれた「試したこと」に対応する tool_use がこのターンに存在しません。
ローカルの Grep/Glob は「外部システムが使えない証拠」になりません。

やること: 対象システムに1回アクセスし、その失敗（エラー本文）を証拠として貼ってから手渡してください。
人に再作業を頼む前に、Claude 側の復元経路（Drive の版履歴 revisions／Forms API の回答／GitHub Actions＋DWD／制作アプリのコマンドキュー）を当ターンで試し、失敗記録を本文に貼ること。
復元不能＋再作業依頼は通常の外部アクセスでは通りません。例外は [RESTORE-TRIED: <10文字以上の理由>]。
アクセスできて目的を達せられるなら、手渡しは不要です。自分で完了させてください。`;
}

export function findUnbackedExternalHandoff(text, raw) {
  const value = String(text || '');
  // 条件A: 手渡しである（定型書式のほか、外部対象語についての命令形も依頼として扱う）。
  // 第三者に送る引用文（> / &gt;）も、再作業依頼として検査する。
  const restoreHandoff = restoreImpossible.test(value) && reworkRequest.test(value) && externalSubjects.test(value);
  // 通常の逃がし弁では復元の確認を省けない。復元には RESTORE-TRIED を使う。
  if (!restoreHandoff && /\[HANDOFF-ACTION-OK\s*[:：]\s*[^\]]{10,}\]/.test(value)) return null;
  if (!restoreHandoff && !hasHandoff(value) && !hasManualRequest(value) && !requestsUserActionOnExternal(value)) return null;
  // 条件B: 外部システムが使えないと主張している（ローカル作業の依頼は対象外）。
  const denial = claimsExternalUnreachable(value);
  if (!denial) return null;
  // 条件C: 復元不能＋再作業依頼は、一般の外部アクセスや直近300行では代用できない。
  if (restoreHandoff && (/\[RESTORE-TRIED\s*[:：]\s*[^\]]{10,}\]/.test(value) || triedRestoreRoute(raw))) return null;
  const current = scanExternalAccesses(raw);
  const recent = restoreHandoff || current.external.length ? { external: [], localOnly: [] } : scanExternalAccessesRecent(raw);
  if (!restoreHandoff && current.external.length + recent.external.length > 0) return null;
  return {
    code: 'HANDOFF-ACTION',
    reason: formatHandoffActionReason(),
    external: [...current.external, ...recent.external],
    localOnly: [...current.localOnly, ...recent.localOnly],
    matched: denial,
  };
}
