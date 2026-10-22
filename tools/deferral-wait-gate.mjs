export const GATE_CONTRACT = {"name": "deferral-wait-gate", "remedies": [{"kind": "repo-file", "ref": "tools/gate-remedies.md", "section": "deferral-wait-gate"}]};

import { detect } from './permanent-fix-deferral-scan.mjs';

// 「完了を待つ」と「その完了後にやる作業」が近接しているときだけ、ターンを閉じる先送りと判定する。
// 本文全体を見る: 実際の違反は本文の途中に「完了を待っています」があり、その後に
// 「次に kim がすること: なし」の定型文が続く。末尾だけを見ると取りこぼす
// （2026-10-18T07:32:28.656Z / 49d68696 の実文がその形）。
// 2026-10-21 の実測（05:14:03 / 05:36:10 / 06:18:53）で「完了報告が届いたら…する」と
// 「完了を待ってから…実行する」が素通りしたため、通知の受け取りと待機後の実行も後続作業に含める。
const FUTURE_WORK = /終わり次第|終わったら|終わると|終了後|完了後|でき次第|出来次第|通知が(?:来|届)|届いたら|(?:完了|終了)を?待ってから|終えたら|上がったら|返ってきたら/;
// 実測 5 件はいずれも 40 字以内に後続作業が続く（`（終わり次第…）` / `（終わると…）` / `（通知が来たら…）`）。
// 離れた位置の言及（ツールの説明文など）を拾わないための距離。
const FUTURE_WINDOW = 160;

// 2026-10-22 実測: 「Codex が作業中です。終わったら本番まで出して確認します。」は
// detect() の W（完了を待って／のを待っています）に一致せず、3 行とも素通りした。
// 他AIレーンの実行中・待機を待機語として扱い、近接する後続作業があるときだけ block する。
const AGENT = '(?:Codex|codex|他AI|エージェント|レーン)';
const AGENT_RUNNING = new RegExp(`${AGENT}[^\\n」"']{0,40}?(?:作業中|実行中|進行中|稼働中|動いてい(?:ます|る)|走ってい(?:ます|る))`, 'g');
// 「Codex の作業が終わったら、…します」「…のを待って、…します」は、条件節自体が待機で
// 後続の動作が同一文に続くため、FUTURE_WORK を待たずに block する（動作が続くときだけ）。
const AGENT_WAIT_THEN = new RegExp(`${AGENT}[^\\n」"']{0,40}?(?:終わったら|終わり次第|終わると|完了したら|待って[、,])`, 'g');
const ACTION_AFTER = /します|する|進めます|実行します|確認します|出します|当てます|テストして|反映して|検証して|報告します|送ります|作ります|実装します|修正します|終えます/;
const ACTION_WINDOW = 120;
const AUDIT_QUOTE_MARKER = /handoff-audit:[0-9a-f]{16}/;

// 監査記録・検証報告が実 excerpt を「…」で引用した行は、先送りの実行ではなく引用なので除外する。
function inAuditQuote(prose, index) {
  const open = prose.lastIndexOf('「', index);
  if (open < 0) return false;
  if (prose.indexOf('」', open + 1) < index) return false;
  const lineStart = prose.lastIndexOf('\n', open - 1) + 1;
  return AUDIT_QUOTE_MARKER.test(prose.slice(lineStart, open));
}

const REPLY_WAIT = /(?:返信|返事)(?:を|が)?お?(?:待って|待ち|待っています)|(?:返信|返事)が来たら|「?続けて」?と返|続けてと返|返信待ち|返事待ち/g;
const PROD = /本番反映|本番デプロイ|本番配備|本番公開|vercel|deploy|デプロイ/i;
const REPLY_WAIT_DONE = /不要|ありません|なし|完了|済み/;
const REPLY_WAIT_WINDOW = 160;
const REPLY_WAIT_DONE_WINDOW = 40;

export function enabled() {
  return process.env.ORGIAST_DEFERRAL_WAIT_GATE !== '0';
}

// 引用行と fenced code block は、回答本文ではなく例示・引用なので判定から外す。
function proseLines(text) {
  let fence;
  return String(text || '').split(/\r?\n/).map(line => {
    if (/^\s*>/.test(line)) return '';
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
      return '';
    }
    if (marker) { fence = marker[1]; return ''; }
    return line;
  }).join('\n');
}

export function judge(text) {
  if (!enabled()) return { decision: 'pass' };
  const prose = proseLines(text);
  for (const replyWait of prose.matchAll(REPLY_WAIT)) {
    const from = replyWait.index;
    const doneNearby = prose.slice(
      Math.max(0, from - REPLY_WAIT_DONE_WINDOW),
      from + replyWait[0].length + REPLY_WAIT_DONE_WINDOW,
    );
    if (REPLY_WAIT_DONE.test(doneNearby)) continue;
    const prodNearby = prose.slice(
      Math.max(0, from - REPLY_WAIT_WINDOW),
      from + replyWait[0].length + REPLY_WAIT_WINDOW,
    );
    if (PROD.test(prodNearby)) {
      return {
        decision: 'block',
        code: 'DEFERRAL-WAIT',
        reason: '本番反映を user の返信待ちにせず、Claude 側の経路（vercel deploy 等）で当ターン内に完了まで進めてください。',
      };
    }
  }
  const waits = [];
  const literal = detect(prose).find(result => result.pattern === 'W');
  if (literal) waits.push(literal.match);
  for (const match of prose.matchAll(AGENT_RUNNING)) {
    if (!inAuditQuote(prose, match.index)) waits.push(match);
  }
  for (const match of prose.matchAll(AGENT_WAIT_THEN)) {
    if (inAuditQuote(prose, match.index)) continue;
    const after = prose.slice(match.index + match[0].length, match.index + match[0].length + ACTION_WINDOW);
    if (ACTION_AFTER.test(after)) {
      return {
        decision: 'block',
        code: 'DEFERRAL-WAIT',
        reason: '完了を待つのではなく、当ターン内に完了まで進めてください。待機が不要なら、待たずに次の作業へ進めて結果まで報告してください。',
      };
    }
  }
  for (const wait of waits) {
    const from = wait.index;
    const nearby = prose.slice(Math.max(0, from - FUTURE_WINDOW), from + wait.length + FUTURE_WINDOW);
    if (FUTURE_WORK.test(nearby)) {
      return {
        decision: 'block',
        code: 'DEFERRAL-WAIT',
        reason: '完了を待つのではなく、当ターン内に完了まで進めてください。待機が不要なら、待たずに次の作業へ進めて結果まで報告してください。',
      };
    }
  }
  return { decision: 'pass' };
}
