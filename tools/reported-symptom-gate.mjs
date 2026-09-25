import { symptomDenials, unknown, corrections, meta, sentences, queriedVendorsFromRaw, claimVendors, reportedSymptoms, needsEvidenceRequest, evidenceRequest } from './state-claim-evidence.mjs';
export function configuredMode() { return process.env.ORGIAST_REPORTED_SYMPTOM_GATE === 'warn' ? 'warn' : 'block'; }
export function evaluateReportedSymptomFromRaw({ text, transcriptRaw }) {
  const reports = reportedSymptoms(transcriptRaw);
  if (!reports.length) return { decision: 'pass' };
  const decision = configuredMode() === 'warn' ? 'pass' : 'block';
  if (needsEvidenceRequest(text, transcriptRaw) && !evidenceRequest(text)) return {
    decision, code: 'UNREACHABLE-EVIDENCE',
    reason: '[UNREACHABLE-EVIDENCE] 自分では確認できない箇所があるのに、同じメッセージで user に見せてもらう具体的な依頼がありません。見える場所を網羅してから最後に依頼するのは禁止です。スクショ・画面の数値・該当ページで見える値を最初の応答で依頼し、調査と並行させること。',
  };
  const queried = queriedVendorsFromRaw(transcriptRaw);
  const reported = new Set(reports.flatMap(s => [...claimVendors(s)]));
  const marked = new Set([...String(text).matchAll(/\[直接照会:\s*([^\]]+)\]/g)].flatMap(m => [...claimVendors(m[1])]));
  for (const sentence of sentences(text)) {
    if (meta.test(sentence) || corrections.test(sentence) || (unknown.test(sentence) && !symptomDenials.test(sentence) && !/原因が確定しました/.test(sentence))) continue;
    if (!symptomDenials.test(sentence) && !/原因が確定しました/.test(sentence)) continue;
    // A marker alone is not evidence; every reported system must have a matching tool use.
    if (reported.size && [...reported].every(v => queried.has(v) && marked.has(v))) continue;
    return { decision, code: 'REPORTED-SYMPTOM', claim: sentence,
      reason: `[REPORTED-SYMPTOM] 「${sentence}」は、人が実際に観測して報告した不具合を Claude 側の観測で否定、または証拠なしに原因確定しています。報告された障害は事実、再現できない側が証拠不足です。対象システムを直接照会していないなら「未再現（〜は未照会）」と書き、断定しないこと。一度成功したテストは「その時点で動いた」以上の意味を持ちません。[直接照会: <システム名>] と対象 vendor の照会記録の両方が必要です。` };
  }
  return { decision: 'pass' };
}
