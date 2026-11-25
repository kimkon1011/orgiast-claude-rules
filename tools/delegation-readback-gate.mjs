export const GATE_CONTRACT = {"name":"delegation-readback-gate","remedies":[{"kind":"command","ref":"git status / git diff / node --test などで実ファイルを読み戻した結果を本文に書くか、[DELEGATE-READBACK-OK] <理由> を1行書く"}]};

const BLOCK_REASON = '委譲先の報告だけを根拠に完了を主張している。git status / git diff / node --test などで実ファイルを読み戻した結果を本文に書くか、[DELEGATE-READBACK-OK] <理由> を1行書く';
// 委譲の主張（否定文脈は evaluateDelegationReadback 内で除外）。"Codex に実装" / "Codex へ実装" は
// 「委譲」の語を含まないため個別パターンで拾う。
const delegationClaim = /委譲|codex-do|cheap-code|deepseek|gemini-cli|Codex\s[にへ]\s*実装/i;
const delegationNegated = /委譲しない|委譲せず|委譲は不要|委譲(は|を)?し(てい)?ません/;
const completionClaim = /実装しました|修正しました|変更しました|追加しました|作成しました|反映しました/;
const readbackEvidence = /\[READBACK:[^\]\n]*\]|git\s+(?:diff|status|show|log)\b|node\s+--test|変更(?:した)?ファイル[^。\n]{0,10}?\d/;

// 引用の除外: コードフェンス内・行頭 > の引用行・「」囲みを検査対象から外す
//（claude-fallback-report-gate.mjs の withoutQuotes と同じ考え方。引用文の語で誤検知した事故の再発防止）。
function withoutQuotes(text) {
  const lines = String(text || '').split(/\r?\n/);
  const fences = lines.map((line, index) => /^\s*```/.test(line) ? index : -1).filter(index => index >= 0);
  const hidden = new Set();
  for (let i = 0; i + 1 < fences.length; i += 2) {
    for (let line = fences[i]; line <= fences[i + 1]; line++) hidden.add(line);
  }
  return lines.map((line, index) => hidden.has(index) || /^\s*>/.test(line) ? '' : line.replace(/「[^」]*」/g, '')).join('\n');
}

export function evaluateDelegationReadback(text) {
  const inspect = withoutQuotes(text);
  // 免除の明示: [DELEGATE-READBACK-OK] + 空白 + 10文字以上の理由
  if (/^\[DELEGATE-READBACK-OK\][ \t]+\S.{9,}$/m.test(inspect)) return { decision: 'pass' };
  const sentences = inspect.split(/[。.!！?？\r\n]+/).map(sentence => sentence.trim()).filter(Boolean);
  const hasDelegation = sentences.some(sentence => delegationClaim.test(sentence) && !delegationNegated.test(sentence));
  const hasCompletion = completionClaim.test(inspect);
  const hasEvidence = readbackEvidence.test(inspect);
  if (hasDelegation && hasCompletion && !hasEvidence) {
    return { decision: 'block', code: 'DELEGATE-READBACK', reason: BLOCK_REASON };
  }
  return { decision: 'pass' };
}
