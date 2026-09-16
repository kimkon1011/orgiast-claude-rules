const subjects = /プロパティ|アカウント|権限|オーナー|所有|設定|環境変数|env|シークレット|Secret|レコード|シート|ドキュメント|フォルダ|ファイル|ドメイン|DNS|プロジェクト|リポジトリ|デプロイ|コンテナ|測定ID|GA4|Search Console|GTM|タグマネージャー|Vercel|Supabase|GitHub|Drive|Gmail|Calendar|Workspace|Cloudflare|freee|Stripe|Discord|Notion|Slack/i;
const negatives = /存在しない|存在しません|(?:が|は|も)\s*(?:無い|ない)|ありません|見つからない|見つかりません|見つからなかった|作られていない|作成されていない|登録されていない|設定されていない|入っていない|紐づ(?:いて|かて|かれて)いない|痕跡(?:が|は)?(?:ない|無い|ありません)|履歴に(?:は)?(?:無い|ない|残っていない)|記録(?:が|は)?(?:ない|無い|ありません)|所有していない|持っていない|ゼロです|0件です/g;
const unknown = /未確認|まだ確認できていない|不明/;
const probability = /可能性|おそらく|たぶん|恐らく|と思われ|と考え|はず/;
const corrections = /誤り|訂正|と答えた|と書いた|と断定した|前回|先ほど|暫定回答/;
const meta = /検出|パターン|正規表現|ゲート|フック|ルール|fixtures?/i;
const capabilities = /API|CLI|SDK|MCP|エンドポイント|パッケージ|ライブラリ/i;
const uiActions = /開いて|ログインして|画面で|プルダウン|一覧に|スクショ/;
const verification = /有るか無いか|あるかないか|存在するか|教えてください|確認してください|見てください|控えてください/;
// 必須例文のように UI 操作を省いた存在確認依頼も検出する。
const existence = /有るか無いか|あるかないか|存在するか/;
const request = /教えてください|確認してください|見てください|控えてください/;
const vendorCli = /\b(gcloud|vercel|gh|supabase|clasp|wrangler|npx\s+vercel)\b/i;
const vendorHost = /^(?:[a-z0-9-]+\.)*(?:googleapis|google|vercel|github|supabase|cloudflare|freee|stripe|discord)\.com$/i;
const localSearch = /\b(?:grep|rg|findstr)\b/i;
const localHistory = /(?:\.claude[\\/]projects|\bmemory\b)/i;
const denial = /denied by the Claude Code auto mode classifier|Permission for this action was denied/;

function sentences(text) {
  // 行の途中に句点がある引用・表も行全体を免除する。
  return String(text || '').split(/\r?\n/)
    .map(line => line.trim()).filter(line => !line.startsWith('>') && !(line.startsWith('|') && line.endsWith('|')))
    .flatMap(line => line.split(/(?<=[。！？!?])/)).map(sentence => sentence.trim()).filter(Boolean);
}

export function findExternalStateClaim(text) {
  for (const sentence of sentences(text)) {
    if (!subjects.test(sentence) || corrections.test(sentence) || meta.test(sentence)) continue;
    if (unknown.test(sentence) && !probability.test(sentence)) continue;
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

function currentTurnEntries(raw) {
  let entries = [];
  for (const line of String(raw || '').split(/\r?\n/)) {
    let entry; try { entry = JSON.parse(line); } catch { continue; }
    if (!entry || entry.isSidechain === true) continue;
    const content = entry.message?.content;
    if (entry.type === 'user' && entry.message?.role === 'user'
      && !(Array.isArray(content) && content.some(block => block?.type === 'tool_result'))) entries = [];
    entries.push(entry);
  }
  return entries;
}

function blocks(entries, type) {
  return entries.flatMap(entry => Array.isArray(entry.message?.content) ? entry.message.content : [])
    .filter(block => block?.type === type);
}

function isVendorUrl(value) {
  try { const url = new URL(value); return /^https?:$/.test(url.protocol) && vendorHost.test(url.hostname); }
  catch { return false; }
}

export function hasDirectQueryEvidenceFromRaw(transcriptRaw) {
  return blocks(currentTurnEntries(transcriptRaw), 'tool_use').some(block => {
    const name = String(block.name || '');
    if (/^mcp__/.test(name)) return true;
    if (/^WebFetch$/i.test(name)) return isVendorUrl(block.input?.url);
    if (!/^(?:Bash|PowerShell)$/i.test(name)) return false;
    const command = String(block.input?.command || '');
    if (localSearch.test(command) && localHistory.test(command)) return false;
    return vendorCli.test(command) || (command.match(/https?:\/\/[^\s"'`<>]+/gi) || []).some(isVendorUrl);
  });
}

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
  const claim = findExternalStateClaim(text);
  const direct = hasDirectQueryEvidenceFromRaw(transcriptRaw);
  const decision = configuredMode() === 'warn' ? 'pass' : 'block';
  if (claim && !direct) return { decision, code: 'EXTERNAL-STATE', claim,
    reason: `[EXTERNAL-STATE] 「${claim}」は対象システムを直接照会していない外部状態の否定断定です。Claude 側の履歴・memory に無いことは証拠になりません（人が Web UI で作ったものは残らない）。vendor MCP / API / 公式 CLI で直接照会してから断定するか、確率表現を使わず「未確認」と書き、user に確認作業を頼まないこと。` };
  const outsourced = findOutsourcedVerification(text);
  if (outsourced && (!direct || !hasPermissionDenialFromRaw(transcriptRaw) || !String(text).includes('[手渡し判定]'))) {
    return { decision, code: 'OUTSOURCED-VERIFY', claim: outsourced,
      reason: `[OUTSOURCED-VERIFY] 「${outsourced}」は外部状態の検証を user に外注しています。許されるのは、自動経路（vendor MCP / DWD SA API / 公式 CLI）を実際に叩いて permission で止められた記録が transcript にあり、本文に [手渡し判定] がある場合だけです。` };
  }
  return { decision: 'pass', reason: '外部状態の否定断定・検証依頼なし、または必要な照会証拠あり' };
}
