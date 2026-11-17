#!/usr/bin/env node
export const GATE_CONTRACT = {"name": "silent-check-failure-gate", "remedies": [{"kind": "repo-file", "ref": "tools/gate-remedies.md", "section": "silent-check-failure-gate"}]};
// Stop gate: auto-progress check の沈黙故障を検出する。
// 応答が check 成功を主張しているのに、実際の exit コードや MODULE_NOT_FOUND が含まれている場合に警告する。
// docs/x-0045-missing-gates.md 優先1「見張りの沈黙故障型」

const CHECK_SUCCESS_PATTERN = /auto-progress|executeCheck|check.*(?:完了|成功|失敗|error|not.?found|PASS|pass|ok)/i;
const FAILURE_SIGNAL = /exit.?code|exit.?[1-9]|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND|path.*normalize|check_error/i;

export function evaluateSilentCheckFailure(text) {
  if (!text || typeof text !== 'string') return { decision: 'pass' };

  // Check 関連の記述が無ければ pass
  if (!CHECK_SUCCESS_PATTERN.test(text)) return { decision: 'pass' };

  // 応答が明示的に failures を報告している場合は除外（正常な検出経路）
  if (/\b(?:check_error|failures?\b.*\d+|exit\s+[1-9]|検出|見つかっ)\b/i.test(text)) return { decision: 'pass' };

  // コードブロック内の引用は除外
  const codeBlocks = [...text.matchAll(/```[\s\S]*?```/g)];
  const bodyText = codeBlocks.reduce((t, m) => t.replace(m[0], ''), text);

  // チェック成功主張 + 障害信号 の両方があるか
  const hasFailureSignal = FAILURE_SIGNAL.test(bodyText);
  if (!hasFailureSignal) return { decision: 'pass' };

  // dry-run は除外
  if (/\bdry.?run\b/i.test(bodyText)) return { decision: 'pass' };

  // テストファイルの出力は除外
  if (/\.test\.mjs|test\/|spec\//i.test(bodyText)) return { decision: 'pass' };

  return {
    decision: 'warn',
    reason: `[SILENT-CHECK-FAILURE] 自動進行の check 実行結果に障害信号（exit code 1以上／MODULE_NOT_FOUND／check_error）が含まれています。check が沈黙故障していないか確認し、必要なら修復してください。`,
    code: 'SILENT-CHECK-FAILURE',
  };
}