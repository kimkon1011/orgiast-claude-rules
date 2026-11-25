export const GATE_CONTRACT = {"name": "merge-handoff-gate", "remedies": [{"kind": "repo-file", "ref": "tools/gate-remedies.md", "section": "merge-handoff-gate"}, {"kind": "command", "ref": "gh pr view <N> --json state,mergedAt,mergedBy"}, {"kind": "command", "ref": "gh pr merge <N> --squash --auto"}]};

// 2026-10-25 cr 指摘: kim へ「マージして」と頼んだ PR は開くとほぼ全て既にマージ済みだった（cr568 の PR は 10〜15分で cr-PC の
// 自動セッションが、kimkon1011 の PR は auto-merge.yml がマージする）。PR の状態照会と自分でのマージ試行をした同ターンの記録が無いまま、
// 人へマージを頼む文（本文・DM・fleet-mail）を差し戻す。I/O はせず、本文と当ターンの tool_use だけで判定する。
const REASON = '[MERGE-HANDOFF] PR のマージを人に頼んでいますが、同じターンに PR の状態照会と自分でのマージ試行の記録がありません。自動でマージされる PR（cr568 は cr-PC の自動セッション、kimkon1011 は auto-merge.yml）を kim に頼まない。(1) `gh pr view <N> -R <repo> --json state,mergedAt,mergedBy` で照会し、MERGED なら依頼を消す (2) OPEN なら `gh pr edit <N> --add-label automerge` か `gh pr merge <N> --squash --auto` を自分で試し、通れば「この後の自動進行」に書く (3) 両方失敗した時だけ、その出力を書いて依頼する。例外は `[MERGE-HANDOFF-OK: <理由>]`。';

const mergeWord = /マージ|\bmerge\b/i;
const prWord = /\bPR\b|#\d+|\/pull\/\d+|プルリク|pull\s+request/i;
// 過去形の経緯（お願いしました・依頼しました）や「依頼が届いているか」は拾わない
const askWord = /ください|下さい|お願いします|お願いいたします|お願い致します|頼みます|(?:に|を)依頼する|(?:に|を)依頼します|次に\s*kim\s*がすること[ \t]*[:：]/;
const handled = /既にマージ|マージ済み|MERGED|自動(?:で)?マージ(?:され|する|待ち)|automerge/i;
const exception = /\[MERGE-HANDOFF-OK:[ \t]*[^\]\r\n]{5,}\]/;
const stateQuery = /\bgh\s+pr\s+(?:view|status|checks)\b|\bgh\s+api\s+\S*pulls\/\d+|\bgh\s+pr\s+list\b[^\n]*--state/;
const mergeTry = /\bgh\s+pr\s+merge\b|--add-label\s+["']?automerge|\bgh\s+api\s+-X\s+PUT\s+\S*pulls\/\d+\/merge/;

function proseLines(text) {
  return String(text || '')
    .replace(/^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^[ \t]*\1[ \t]*$|(?![\s\S]))/gm, '')
    .replace(/^[ \t]*>.*$/gm, '')
    .split(/\r?\n/);
}

export function mergeAsks(text) {
  return proseLines(text).map(line => line.trim()).filter(line =>
    line && !line.startsWith('|') && mergeWord.test(line) && prWord.test(line) && askWord.test(line) && !handled.test(line));
}

const commandOf = use => typeof use?.input?.command === 'string' ? use.input.command : '';
// DM・fleet-mail でのマージ依頼も同じ扱い（本文が tool 入力にしか残らないため）
function sentAsks(toolUses) {
  return toolUses.filter(use => {
    const name = String(use?.name || '');
    const body = name.includes('send_dm') || name.includes('send_message') ? String(use.input?.content || '')
      : /fleet-mail\.mjs[^\n]*--send|discord-dm\.mjs/.test(commandOf(use)) ? commandOf(use) : '';
    return body && mergeWord.test(body) && prWord.test(body) && /お願い|ください|依頼/.test(body);
  });
}

export function evaluateMergeHandoff(assistantText, toolUses = []) {
  if (process.env.ORGIAST_MERGE_HANDOFF_GATE === '0') return { decision: 'pass', reason: 'disabled' };
  const asks = mergeAsks(assistantText);
  const sent = sentAsks(toolUses);
  if (!asks.length && !sent.length) return { decision: 'pass', reason: 'マージ依頼なし' };
  if (exception.test(String(assistantText || ''))) return { decision: 'pass', reason: '例外理由あり' };
  const commands = toolUses.map(commandOf);
  if (commands.some(c => stateQuery.test(c)) && commands.some(c => mergeTry.test(c))) return { decision: 'pass', reason: '状態照会とマージ試行の記録あり' };
  return { decision: 'block', code: 'MERGE-HANDOFF', claim: asks[0] || 'DM/fleet-mail でのマージ依頼', reason: REASON };
}
