// 内部 API 用の既定値 (Vercel env BOOTH_CONTEXT_TOKEN と対)。 顧客コンテキスト読取専用ゲート。
const SALES_CTX_URL_DEFAULT = 'https://aujust-sales-automation.vercel.app/api/external/booth-case-context';
const SALES_CTX_TOKEN_DEFAULT = '57016ee7654749502610dc51be5d02d79744ac3812527cd6';

/**
 * 営業自動化アプリから案件ごとの顧客コンテキストを取得する。
 * 取得失敗は Claude 生成を止めないよう常に空文字にフォールバックする。
 */

function Case_loadClientContext(c) {
  try {
    if (!c || !c.caseId) return '';

    const props = PropertiesService.getScriptProperties();
    let url = props.getProperty('SALES_CONTEXT_URL');
    let token = props.getProperty('SALES_CONTEXT_TOKEN');
    // Script Properties 未設定/placeholder の場合はソース定数を使う (Drive 経由の token 搬送を避けるため)
    if (!url || url.indexOf('http') !== 0) url = SALES_CTX_URL_DEFAULT;
    if (!token || token.indexOf('__') === 0) token = SALES_CTX_TOKEN_DEFAULT;
    if (!url || !token) return '';

    const cache = CacheService.getScriptCache();
    const cacheKey = 'clictx_' + c.caseId;
    const cached = cache.get(cacheKey);
    if (cached !== null) return cached;

    const requestUrl = url + '?caseId=' + encodeURIComponent(c.caseId) +
      '&clientName=' + encodeURIComponent(c.clientName || '') +
      '&token=' + encodeURIComponent(token);
    const response = UrlFetchApp.fetch(requestUrl, { muteHttpExceptions: true });
    if (response.getResponseCode() !== 200) return '';

    const body = JSON.parse(response.getContentText());
    if (!body || !body.ok || !body.found || !body.contextText) return '';

    const context = '【顧客要望・打合せ議事録・お客様メール (営業アプリから自動取得)】\n' +
      String(body.contextText).slice(0, 12000);
    cache.put(cacheKey, context, 300);
    return context;
  } catch (e) {
    return '';
  }
}

function Admin_setSalesContextConfig(url, token) {
  PropertiesService.getScriptProperties().setProperties({
    SALES_CONTEXT_URL: String(url || ''),
    SALES_CONTEXT_TOKEN: String(token || '')
  });
  return { ok: true };
}

function Case_refreshClientContext(caseId) {
  const c = CaseList_getById(caseId);
  if (!c) throw new Error('案件が見つかりません: ' + caseId);

  CacheService.getScriptCache().remove('clictx_' + c.caseId);
  const context = Case_loadClientContext(c);
  const storedContext = context.slice(0, 40000);
  const sheet = SpreadsheetApp.getActive().getSheetByName(CASE_LIST_SHEET_NAME);
  if (!sheet) throw new Error('案件一覧シートが見つかりません');
  // O〜S列は MasterSync が使うため、顧客コンテキストは T列(20) に書く
  const contextHeader = sheet.getRange(1, 20);
  if (!contextHeader.getValue()) {
    contextHeader.setValue('顧客コンテキスト')
      .setFontWeight('bold')
      .setBackground('#cfe2f3');
  }
  sheet.getRange(c.rowIndex, 20).setValue(storedContext);

  return {
    caseId: c.caseId,
    chars: storedContext.length,
    preview: storedContext.slice(0, 200)
  };
}
