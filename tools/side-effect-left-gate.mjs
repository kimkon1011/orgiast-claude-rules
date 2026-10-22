export const GATE_CONTRACT = {"name": "side-effect-left-gate", "remedies": [{"kind": "repo-file", "ref": "tools/gate-remedies.md", "section": "side-effect-left-gate"}]};

// 自分の変更が生んだ副作用の告知に絞る。「リスク」「可能性」「残っている」単独は分析文・user 側の残作業で多用され、
// 直近494応答の実測で誤検知18.8%になったため対象外（2026-10-17）。
const notice = /(?:取り込ま(?:れ)?|見え|読め|届か|拾わ(?:れ)?|動か|でき|通知(?:が|は)?来)なくな|使えなくなり|影響(?:が|は)?(?:あります|出ます|ありません|しません|ない(?:です)?[。、]|なし)|影響します|影響せず|副作用|取りこぼ|未対応(?:です|のまま)|既知の問題|後で直す|別途対応|消してしまい|上書き(?:して|し)て?しまい|元に戻せ(?:ない|ません)|復元でき(?:ない|ません)/;
const otherEscape = /\[(?:STOP-OK|BURDEN-OK|SELFCHECK-OK|TODO-NONE)\]|^手間監査\s*[:：]/;
const fixed = /直しました|修正済み|対処済み|修正した(?!い)|対処した|→\s*修正|\bPR\s*#\s*\d+|\bcommit\s+[a-f\d]{7,40}\b/i;
const unfixed = /(?:修正|対処)(?:済みでは(?:ない|ありません)|して(?:いない|いません)|したわけでは)|(?:直しました|修正した)(?:とは言え|とはいえ)|(?:修正|対処)予定/;
const evidence = /実測(?!予定|します|する)|確認(?:した(?!い)|しました|済み)|読み戻し(?!予定|します|する)/;
const noImpact = /(?:影響|副作用|リスク|懸念|取りこぼし|漏れ|未対応|既知の問題)(?:は|が|も)?\s*(?:ありません|ない|なし|無し|ゼロ|0件)/;
const investigationPlan = /^(?:[-*]\s*)?(?:影響範囲|副作用|リスク|懸念|取りこぼし|漏れ|未対応項目)(?:を|について)(?:調べます|確認します|調査します|説明します)[。！]?$/;
const exception = /\[SIDE-EFFECT-OK\][ \t]+(?=\S)([^\r\n]+)/;

export function enabled() {
  return process.env.ORGIAST_SIDE_EFFECT_LEFT_GATE !== '0';
}

// 行番号を保つ: 引用・コードの除去で離れた行の対処を「直後」にしない。
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
    if (/^(?: {4}|\t)/.test(line)) return '';
    return line;
  });
}

function addressed(line, next) {
  const local = `${line}\n${next}`;
  // tool_use の存在だけでは対処完了・影響なしの証拠にしない。
  return exception.test(local)
    || [line, next].some(value => fixed.test(value) && !unfixed.test(value))
    || (noImpact.test(local) && evidence.test(local));
}

export function judgeSideEffectLeft(text, toolUses = []) {
  if (!enabled()) return { decision: 'pass', reason: 'disabled' };
  const lines = proseLines(text);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();
    // 表の行は比較表の見出し・セルで、告知文ではない。他 gate の例外印がある行は user 側の残作業として既に審査済み。
    if (t.startsWith('|') || otherEscape.test(t) || investigationPlan.test(t) || !notice.test(line) || addressed(line, lines[i + 1] || '')) continue;
    return {
      decision: 'block', code: 'SIDE-EFFECT', claim: line.trim(), toolUseCount: toolUses.length,
      reason: `[SIDE-EFFECT] 副作用・影響・残作業を告知しただけで終わっています: ${line.trim()}。報告で終わらせず、このターンでその場で直す（修正→検証→結果を書く）。直せない理由が user の承認・権限・支払い等なら \`[SIDE-EFFECT-OK] <理由>\` を書く。`,
    };
  }
  return { decision: 'pass', reason: '告知なし、または同じ行・直後の行に対処・実測根拠・例外理由あり' };
}
