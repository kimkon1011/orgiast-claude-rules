import { symptomDenials, unknown, corrections, meta, sentences, currentTurnEntries, blocks, queriedVendorsFromRaw, claimVendor, claimVendors, needsEvidenceRequest, evidenceRequest } from './state-claim-evidence.mjs';
export { queriedVendorsFromRaw, claimVendor } from './state-claim-evidence.mjs';
const subjects = /残高|クレジット|請求|支払い|カード|課金|Billing|自動チャージ|オートチャージ|Anthropic|OpenAI|Console|API キー|レート制限|Usage Limits|プロパティ|アカウント|権限|オーナー|所有|設定|環境変数|env|シークレット|Secret|レコード|シート|ドキュメント|フォルダ|ファイル|ドメイン|DNS|プロジェクト|リポジトリ|デプロイ|コンテナ|測定ID|GA4|Search Console|GTM|タグマネージャー|Vercel|Supabase|GitHub|Drive|Gmail|Calendar|Workspace|Cloudflare|freee|Stripe|Discord|Notion|Slack/i;
const negatives = /存在しない|存在しません|(?:が|は|も)\s*(?:無い|ない)|ありません|見つからない|見つかりません|見つからなかった|作られていない|作成されていない|登録されていない|設定されていない|入っていない|紐づ(?:いて|かて|かれて)いない|痕跡(?:が|は)?(?:ない|無い|ありません)|履歴に(?:は)?(?:無い|ない|残っていない)|記録(?:が|は)?(?:ない|無い|ありません)|所有していない|持っていない|ゼロです|0件です/g;
const probability = /可能性|おそらく|たぶん|恐らく|と思われ|と考え|はず/;
const capabilities = /API|CLI|SDK|MCP|エンドポイント|パッケージ|ライブラリ/i;
const uiActions = /開いて|ログインして|画面で|プルダウン|一覧に|スクショ/;
const verification = /有るか無いか|あるかないか|存在するか|教えてください|確認してください|見てください|控えてください/;
// 必須例文のように UI 操作を省いた存在確認依頼も検出する。
const existence = /有るか無いか|あるかないか|存在するか/;
const request = /教えてください|確認してください|見てください|控えてください/;
const denial = /denied by the Claude Code auto mode classifier|Permission for this action was denied/;

export function findExternalStateClaim(text) {
  for (const sentence of sentences(text)) {
    if (!subjects.test(sentence) || corrections.test(sentence) || meta.test(sentence)) continue;
    if (unknown.test(sentence) && !probability.test(sentence) && !symptomDenials.test(sentence)) continue;
    if (symptomDenials.test(sentence)) return sentence;
    for (const match of sentence.matchAll(negatives)) {
      if (!capabilities.test(sentence.slice(Math.max(0, match.index - 30), match.index))) return sentence;
    }
  }
  return '';
}

export function findOutsourcedVerification(text) {
  return sentences(text).find(sentence => !corrections.test(sentence) && !meta.test(sentence)
    && ((uiActions.test(sentence) && verification.test(sentence)) || (existence.test(sentence) && request.test(sentence)))) || '';
}

export function hasDirectQueryEvidenceFromRaw(raw) { return queriedVendorsFromRaw(raw).size > 0; }

export function hasPermissionDenialFromRaw(transcriptRaw) {
  return blocks(currentTurnEntries(transcriptRaw), 'tool_result').some(block => {
    const content = block.content;
    const text = typeof content === 'string' ? content : Array.isArray(content)
      ? content.filter(part => part?.type === 'text').map(part => part.text || '').join('\n') : '';
    return denial.test(text);
  });
}

export function configuredMode() {
  return process.env.ORGIAST_EXTERNAL_STATE_GATE === 'warn' ? 'warn' : 'block';
}

export function evaluateExternalStateClaimFromRaw({ text, transcriptRaw }) {
  const queried = queriedVendorsFromRaw(transcriptRaw);
  const claim = sentences(text).filter(s => findExternalStateClaim(s)).find(s => {
    const vendors = claimVendors(s);
    return !vendors.size || [...vendors].some(v => !queried.has(v));
  });
  const direct = hasDirectQueryEvidenceFromRaw(transcriptRaw);
  const decision = configuredMode() === 'warn' ? 'pass' : 'block';
  if (claim) return { decision, code: 'EXTERNAL-STATE', claim,
    reason: `[EXTERNAL-STATE] 「${claim}」は ${claimVendor(claim) || "対象 vendor 不明"} を照会せずに ${[...queried].join(", ") || "照会なし"} の証拠で断定している、対象システムを直接照会していない外部状態の否定断定です。Claude 側の履歴・memory に無いことは証拠になりません（人が Web UI で作ったものは残らない）。vendor MCP / API / 公式 CLI で直接照会してから断定するか、確率表現を使わず「未確認」と書き、user に確認作業を頼まないこと。` };
  // R3 explicitly requires a concrete request when the reported evidence is unreachable.
  const outsourced = needsEvidenceRequest(text, transcriptRaw) && evidenceRequest(text) ? "" : findOutsourcedVerification(text);
  if (outsourced && (!direct || !hasPermissionDenialFromRaw(transcriptRaw) || !String(text).includes('[手渡し判定]'))) {
    return { decision, code: 'OUTSOURCED-VERIFY', claim: outsourced,
      reason: `[OUTSOURCED-VERIFY] 「${outsourced}」は外部状態の検証を user に外注しています。許されるのは、自動経路（vendor MCP / DWD SA API / 公式 CLI）を実際に叩いて permission で止められた記録が transcript にあり、本文に [手渡し判定] がある場合だけです。` };
  }
  return { decision: 'pass', reason: '外部状態の否定断定・検証依頼なし、または必要な照会証拠あり' };
}
