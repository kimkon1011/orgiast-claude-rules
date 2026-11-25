const MERGE_APPROVAL_PATTERNS = [
  /マージして(?:も)?よい(?:か|ですか)?/i,
  /マージ承認/i,
  /マージ可否/i,
  /main\s*にマージ[\s\S]{0,40}(?:承認|よいか)/i,
  /(?:承認|よいか)[\s\S]{0,40}main\s*にマージ/i,
  /pr-merge(?:\.mjs)?\s*でマージ/i,
];

export function isPullRequestMergeApprovalRequest(text) {
  const body = String(text ?? '').normalize('NFKC');
  return MERGE_APPROVAL_PATTERNS.some(pattern => pattern.test(body));
}

export const MERGE_HANDOFF_REJECTION_MESSAGE = 'PR は作った席が pr-land.mjs / pr-merge.mjs で自分でマージする（ONBOARDING §PRは自分でマージする）。破壊的変更などで人の判断が本当に要る時だけ --merge-handoff-ok "<理由>"';
