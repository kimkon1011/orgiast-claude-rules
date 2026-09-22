/**
 * 営業自動化アプリが収集した顧客メール添付を、案件の預かり素材へ保存する。
 * Gmail は直接読まず、外部 API の一覧・ダウンロードだけを利用する。
 */

const MAIL_ATTACH_LOG_SHEET = 'Claude_メール添付取込';
const MAIL_ATTACH_MAX_BYTES = 25 * 1024 * 1024;
// 新しい案件に「着手してよい」締切。これを過ぎたら残りは次回トリガーへ回す。
const MAIL_ATTACH_START_DEADLINE_MS = 2.5 * 60 * 1000;
// 1案件あたりの上限。着手締切との合算 (2.5+3.0=5.5分) が6分制限に収まる値であること。
// CaseDigest で「着手締切と案件内予算に同じ秒数を使い、締切直前に着手して6分超で死ぬ」事故を踏んでいる。
const MAIL_ATTACH_CASE_BUDGET_MS = 3.0 * 60 * 1000;
// 実行全体のハード締切。案件内ループもこれを超えたら必ず止まる (着手済み案件の暴走止め)。
const MAIL_ATTACH_RUN_HARD_DEADLINE_MS = 5.2 * 60 * 1000;
const MAIL_ATTACH_LOOKBACK_DAYS = 90;
const MAIL_ATTACH_STALE_AFTER_DAYS = 60;
const MAIL_ATTACH_CURSOR_KEY = 'MailAttachments_caseCursor';
// 構成上どうしても取得できないもの。これだけは即確定させる。
// not_found はここに入れてはいけない: こちら側のリクエスト不備でも返るため、
// 恒久扱いにすると自分のバグを直した後も永久にスキップされる(実際に踏んだ)。
const MAIL_ATTACH_PERMANENT_ERRORS = ['unsupported_mailbox'];
// error が何回続いたら諦めるか。無限リトライでログが膨らむのを防ぐ。
const MAIL_ATTACH_MAX_ERROR_RETRIES = 3;
const MAIL_ATTACH_LOG_HEADERS = [
  '取込日時', '案件ID', 'クライアント', '受信日時', '差出人', '件名', '元ファイル名',
  '保存名', '保存先URL', 'bytes', 'messageId', 'attachmentId', '状態'
];

// 同一実行内の pollAll → syncCase 間でログ全行の再読込を避ける。
let _MAIL_ATTACH_LOG_STATE = null;

function _MailAttach_apiConfig() {
  const props = PropertiesService.getScriptProperties();
  let url = props.getProperty('SALES_CONTEXT_URL');
  let token = props.getProperty('SALES_CONTEXT_TOKEN');
  if (!url || url.indexOf('http') !== 0) url = SALES_CTX_URL_DEFAULT;
  if (!token || token.indexOf('__') === 0) token = SALES_CTX_TOKEN_DEFAULT;
  if (!url || !token) return null;
  const originMatch = String(url).match(/^(https?:\/\/[^/]+)/i);
  if (!originMatch) return null;
  return {
    baseUrl: originMatch[1] + '/api/external/booth-mail-attachments',
    token: token
  };
}

function _MailAttach_fetchJson(params, label) {
  const config = _MailAttach_apiConfig();
  if (!config) {
    console.warn('MailAttachments API config unavailable: ' + label);
    return { ok: false, error: 'api_config_unavailable' };
  }
  const query = ['token=' + encodeURIComponent(config.token)];
  Object.keys(params || {}).forEach(function (key) {
    if (params[key] === null || params[key] === undefined || params[key] === '') return;
    query.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(params[key])));
  });
  try {
    const response = UrlFetchApp.fetch(config.baseUrl + '?' + query.join('&'), {
      muteHttpExceptions: true
    });
    const code = response.getResponseCode();
    let body;
    try {
      body = JSON.parse(response.getContentText());
    } catch (parseError) {
      console.warn('MailAttachments JSON parse failed: ' + label + ' / HTTP ' + code);
      return { ok: false, error: 'invalid_json', status: code };
    }
    if (code !== 200) {
      console.warn('MailAttachments API failed: ' + label + ' / HTTP ' + code + ' / ' + String(body && body.error || ''));
      return { ok: false, error: String(body && body.error || ('http_' + code)), status: code, body: body };
    }
    if (!body || !body.ok) {
      console.warn('MailAttachments API returned not ok: ' + label + ' / ' + String(body && body.error || 'unknown'));
      return { ok: false, error: String(body && body.error || 'api_not_ok'), status: code, body: body };
    }
    return { ok: true, body: body, status: code };
  } catch (e) {
    console.warn('MailAttachments fetch failed: ' + label + ' / ' + e.message);
    return { ok: false, error: 'fetch_failed:' + e.message };
  }
}

function _MailAttach_ensureLogState() {
  if (_MAIL_ATTACH_LOG_STATE) return _MAIL_ATTACH_LOG_STATE;
  const ss = SpreadsheetApp.getActive();
  let sheet = ss.getSheetByName(MAIL_ATTACH_LOG_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(MAIL_ATTACH_LOG_SHEET);
    sheet.appendRow(MAIL_ATTACH_LOG_HEADERS);
    sheet.getRange(1, 1, 1, MAIL_ATTACH_LOG_HEADERS.length)
      .setFontWeight('bold').setBackground('#cfe2f3');
    sheet.setFrozenRows(1);
  }
  // keys = 決着済み (saved / skipped_*) で二度と触らないもの。
  // errorCounts = error 行の回数。**error は決着扱いにしない**。こちら側のバグで出た
  // エラーを恒久扱いにすると、直した後もその添付が永久にスキップされる
  // (download に clientName を渡し忘れて全件 error:not_found を記録し、実際にそうなった)。
  // ただし無限リトライでログが膨らむのも困るので回数で打ち切る。
  const keys = new Set();
  const errorCounts = {};
  if (sheet.getLastRow() > 1) {
    const values = sheet.getRange(2, 11, sheet.getLastRow() - 1, 3).getDisplayValues();
    values.forEach(function (row) {
      if (!row[0] || !row[1]) return;
      const key = String(row[0]) + ':' + String(row[1]);
      const status = String(row[2] || '');
      if (status.indexOf('error') === 0) errorCounts[key] = (errorCounts[key] || 0) + 1;
      else keys.add(key);
    });
  }
  _MAIL_ATTACH_LOG_STATE = { sheet: sheet, keys: keys, errorCounts: errorCounts };
  return _MAIL_ATTACH_LOG_STATE;
}

/** 決着済み、または error が上限回数に達していれば触らない。 */
function _MailAttach_isSettled(logState, dupKey) {
  if (logState.keys.has(dupKey)) return true;
  return (logState.errorCounts[dupKey] || 0) >= MAIL_ATTACH_MAX_ERROR_RETRIES;
}

function _MailAttach_appendLog(state, c, attachment, finalName, url, bytes, status) {
  state.sheet.appendRow([
    new Date(), c.caseId, c.clientName || '', attachment.receivedAt || '', attachment.sender || '',
    attachment.subject || '', attachment.name || '', finalName || '', url || '', Number(bytes) || 0,
    attachment.messageId || '', attachment.attachmentId || '', status
  ]);
}

function _MailAttach_dupKey(attachment) {
  return String(attachment.messageId || '') + ':' + String(attachment.attachmentId || '');
}

function _MailAttach_classifyPrefix(name) {
  const normalized = String(name || '').normalize('NFC');
  const rules = [
    [/出展マニュアル|出展要項|出品マニュアル/, '出展マニュアル_'],
    [/出展規定|規約|規則|規程/, '出展規定_'],
    [/出展ガイド|ガイドライン|チェックリスト/, '出展ガイド_'],
    [/申請/, '申請_'],
    [/申込|申し込み/, '申込_'],
    [/見積|御見積|お見積|Quotation/i, '見積_'],
    [/実測|採寸|寸法|測定|現調|下見/, '実測_'],
    // 「1F平面.pdf」「外観立面.pdf」のように図/面だけの名前が実際に届く(C0039 実測)。
    // ここで パース_ を付けておくと CaseMaterials/designKeywords の設計資料判定にも乗る。
    [/パース|レイアウト|平面|立面|断面|矩計|図面|割付|什器図/, 'パース_'],
    [/主催者|事務局|ご案内|お知らせ/, '主催者_']
  ];
  for (let i = 0; i < rules.length; i++) {
    if (rules[i][0].test(normalized)) return rules[i][1];
  }
  return 'メール添付_';
}

function _MailAttach_finalName(originalName) {
  let cleanName = String(originalName || 'attachment').normalize('NFC').replace(/[\\/]/g, '_');
  _UPLOAD_PREFIX_OPTIONS.forEach(function (option) {
    if (cleanName.indexOf(option.value) === 0) cleanName = cleanName.slice(option.value.length);
  });
  if (!cleanName) cleanName = 'attachment';
  const prefix = _MailAttach_classifyPrefix(originalName);
  if (prefix.length + cleanName.length <= 200) return prefix + cleanName;
  const dot = cleanName.lastIndexOf('.');
  const hasExtension = dot > 0 && dot < cleanName.length - 1;
  const extension = hasExtension ? cleanName.slice(dot) : '';
  const baseName = hasExtension ? cleanName.slice(0, dot) : cleanName;
  const maxBaseLength = Math.max(1, 200 - prefix.length - extension.length);
  return prefix + baseName.slice(0, maxBaseLength) + extension;
}

/**
 * Office ファイルを Google 形式に変換させず、原本のまま保存する。
 *
 * 注意 (誤診の記録): 保存された .xlsx の URL が docs.google.com/spreadsheets/... だったので
 * 変換されたと判断したが、**実際には変換されていなかった**。Drive は非変換の Office ファイルにも
 * エディタで開く URL を返す(`rtpof=true`)ため、URL の形では変換の有無を判定できない。
 * 判定は mimeType を見ること。実測: DriveApp.createFile で保存した .xlsx は
 * application/vnd.openxmlformats-officedocument.spreadsheetml.sheet / 738733 bytes = 原本のまま。
 *
 * それでも REST v3 を使う理由: DriveApp.createFile は実行アカウントの Drive 設定
 * 「アップロードしたファイルを Google ドキュメント エディタ形式に変換」に従うため、
 * その設定が変わると黙って挙動が変わる。v3 の multipart upload は既定で変換しないので、
 * 誰の設定にも依存せず原本を保てる。REST が失敗したら DriveApp にフォールバックする
 * ——取りこぼすくらいなら変換されても保存する方がよいため。
 * 認証は CaseMaterials_pptxToPdf と同じ ScriptApp.getOAuthToken()。
 */
function _MailAttach_createFileKeepFormat(folderId, bytes, mime, name) {
  const boundary = '-------booth' + Utilities.getUuid().replace(/-/g, '');
  const metadata = { name: name, parents: [folderId] };
  const payload = Utilities.newBlob(
    '--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' +
    JSON.stringify(metadata) + '\r\n--' + boundary + '\r\nContent-Type: ' + mime + '\r\n\r\n'
  ).getBytes()
    .concat(bytes)
    .concat(Utilities.newBlob('\r\n--' + boundary + '--').getBytes());
  try {
    const res = UrlFetchApp.fetch(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,mimeType,size',
      {
        method: 'post',
        contentType: 'multipart/related; boundary=' + boundary,
        payload: payload,
        headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
        muteHttpExceptions: true
      }
    );
    if (res.getResponseCode() === 200) {
      const created = JSON.parse(res.getContentText());
      if (created && created.id) return DriveApp.getFileById(created.id);
    }
    console.warn('MailAttachments upload v3 failed: HTTP ' + res.getResponseCode() +
      ' / ' + res.getContentText().slice(0, 200) + ' → DriveApp にフォールバック');
  } catch (e) {
    console.warn('MailAttachments upload v3 threw: ' + e.message + ' → DriveApp にフォールバック');
  }
  return DriveApp.getFolderById(folderId).createFile(Utilities.newBlob(bytes, mime, name));
}

/**
 * _MailAttach_createFileKeepFormat が本当に変換を回避できているかを実環境で確認する。
 * 案件フォルダは汚さず、アプリ自身の親フォルダ配下 `_変換キャッシュ` に小さな検証ファイルを置く。
 * 期待値: resultMimeType が xlsx のまま (google-apps.spreadsheet に化けていない)。
 * **URL では判定できない**(非変換の Office ファイルもエディタ URL を返す)ので mimeType を見る。
 */
function _debug_testKeepFormat() {
  const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const parent = DriveApp.getFolderById(APP_ROOT_FOLDER_ID);
  let scratch = null;
  const subs = parent.getFoldersByName(CASE_MATERIALS_CACHE_FOLDER_NAME);
  scratch = subs.hasNext() ? subs.next() : parent.createFolder(CASE_MATERIALS_CACHE_FOLDER_NAME);
  // 中身は xlsx として妥当でなくてよい (変換の有無だけを見る)。PK シグネチャだけ付ける。
  const bytes = Utilities.newBlob('PKbooth-keepformat-test').getBytes();
  const name = '_test_keepformat_' + Utilities.getUuid().slice(0, 8) + '.xlsx';
  const file = _MailAttach_createFileKeepFormat(scratch.getId(), bytes, XLSX, name);
  return {
    createdIn: scratch.getName(),
    name: file.getName(),
    fileId: file.getId(),
    resultMimeType: file.getMimeType(),
    convertedToGoogleFormat: String(file.getMimeType()).indexOf('application/vnd.google-apps') === 0,
    url: file.getUrl()
  };
}

function _MailAttach_gmailUrl(messageId) {
  return 'https://mail.google.com/a/orgiast.jp/#all/' + encodeURIComponent(String(messageId || ''));
}

function _MailAttach_endDateTime(value) {
  if (!value) return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value.getTime();
  const normalized = String(value).trim().replace(/[年/.]/g, '-').replace(/月/g, '-').replace(/日/g, '');
  const match = normalized.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!match) return null;
  const parsed = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return isNaN(parsed.getTime()) ? null : parsed.getTime();
}

function _MailAttach_filterCases(cases, now) {
  const cutoff = Number(now || Date.now()) - MAIL_ATTACH_STALE_AFTER_DAYS * 24 * 60 * 60 * 1000;
  const included = [], skipped = [];
  (cases || []).forEach(function (c) {
    const clientName = String(c && c.clientName || '');
    const endDateTime = _MailAttach_endDateTime(c && c.endDate);
    if (!clientName.trim() || clientName.indexOf('__DELETED') >= 0) {
      skipped.push({ caseId: String(c && c.caseId || ''), reason: 'invalid_client' });
    } else if (endDateTime !== null && endDateTime < cutoff) {
      skipped.push({ caseId: String(c && c.caseId || ''), reason: 'stale' });
    } else {
      included.push(c);
    }
  });
  return { included: included, skipped: skipped };
}

function MailAttachments_syncCase(caseId, opts) {
  const started = Date.now();
  // 案件内の締切 = 自分の予算と、呼び出し元 (pollAll) のハード締切の早い方。
  // これが無いと pollAll の締切直前に着手した案件が単独で予算を使い切り6分制限を超える。
  let caseDeadlineAt = started + MAIL_ATTACH_CASE_BUDGET_MS;
  if (opts && opts.hardDeadlineAt && opts.hardDeadlineAt < caseDeadlineAt) {
    caseDeadlineAt = opts.hardDeadlineAt;
  }
  const c = CaseList_getById(caseId);
  if (!c) throw new Error('案件が見つかりません: ' + caseId);
  const listed = _MailAttach_fetchJson({
    caseId: c.caseId,
    clientName: c.clientName || '',
    days: MAIL_ATTACH_LOOKBACK_DAYS
  }, 'list:' + c.caseId);
  if (!listed.ok) return { ok: false, caseId: c.caseId, error: listed.error };
  if (!listed.body.found) return { ok: true, found: false, saved: 0 };

  const attachments = listed.body.attachments || [];
  // 保存するものが無いうちにフォルダ解決へ進んではいけない。
  // _Upload_findOrCreateAzukariFolder は見つからなければ「00預かり素材」を新規作成するため、
  // 添付0件の案件にも空フォルダを作ってしまう。加えて解決は実施計画書を開くので
  // 1件あたり数秒かかり、全案件で回すと6分制限を超える(planAll で実際に死んだ)。
  if (attachments.length === 0) return { ok: true, caseId: c.caseId, saved: [], skipped: [], errors: [], truncated: false };

  const folderId = _Upload_findOrCreateAzukariFolder(c);
  if (!folderId) return { ok: false, caseId: c.caseId, error: '預かり素材フォルダを解決できません' };
  const folder = DriveApp.getFolderById(folderId);
  const existingByName = {};
  const files = folder.getFiles();
  while (files.hasNext()) {
    const file = files.next();
    const fileName = file.getName();
    if (!existingByName[fileName]) existingByName[fileName] = {};
    existingByName[fileName][String(file.getSize())] = true;
  }

  const logState = _MailAttach_ensureLogState();
  const saved = [], skipped = [], errors = [];
  let truncated = false;
  for (let i = 0; i < attachments.length; i++) {
    if (Date.now() > caseDeadlineAt) {
      truncated = true;
      break;
    }
    const attachment = attachments[i] || {};
    const dupKey = _MailAttach_dupKey(attachment);
    if (_MailAttach_isSettled(logState, dupKey)) continue;
    const finalName = _MailAttach_finalName(attachment.name);
    const metadataSize = Number(attachment.size) || 0;
    if (attachment.oversize || metadataSize > MAIL_ATTACH_MAX_BYTES) {
      const gmailUrl = _MailAttach_gmailUrl(attachment.messageId);
      _MailAttach_appendLog(logState, c, attachment, finalName, gmailUrl, metadataSize, 'skipped_too_large');
      logState.keys.add(dupKey);
      skipped.push({ name: attachment.name || '', reason: 'too_large', url: gmailUrl });
      continue;
    }
    if (existingByName[finalName] && existingByName[finalName][String(metadataSize)]) {
      _MailAttach_appendLog(logState, c, attachment, finalName, folder.getUrl(), metadataSize, 'skipped_duplicate');
      logState.keys.add(dupKey);
      skipped.push({ name: attachment.name || '', finalName: finalName, reason: 'duplicate' });
      continue;
    }

    const downloaded = _MailAttach_fetchJson({
      caseId: c.caseId,
      // clientName は download でも必須。deals.memo の [booth-app] リンクは本番0件なので、
      // API 側は clientName の正規化一致でしか案件を解決できず、省くと必ず 404 not_found になる
      // (実際に全6件 not_found で保存0件になった)。
      clientName: c.clientName || '',
      messageId: attachment.messageId || '',
      attachmentId: attachment.attachmentId || '',
      download: 1
    }, 'download:' + c.caseId + ':' + dupKey);
    if (!downloaded.ok) {
      const reason = downloaded.error || 'download_failed';
      if (reason === 'too_large' || downloaded.status === 413) {
        const gmailUrl = _MailAttach_gmailUrl(attachment.messageId);
        const tooLargeSize = Number(downloaded.body && downloaded.body.size) || metadataSize;
        _MailAttach_appendLog(logState, c, attachment, finalName, gmailUrl, tooLargeSize, 'skipped_too_large');
        logState.keys.add(dupKey);
        skipped.push({ name: attachment.name || '', reason: 'too_large', url: gmailUrl });
      } else {
        _MailAttach_appendLog(logState, c, attachment, finalName, '', metadataSize, 'error:' + reason);
        // 恒久エラーは取込済みとして確定 (毎15分の再試行でログが無限に膨らむのを防ぐ)。
        // 一時的なエラー (fetch_failed/HTTP 5xx 等) はキーを立てず次回リトライさせる。
        if (MAIL_ATTACH_PERMANENT_ERRORS.indexOf(reason) >= 0) logState.keys.add(dupKey);
        errors.push({ name: attachment.name || '', error: reason });
      }
      continue;
    }
    try {
      const body = downloaded.body;
      const bytes = Utilities.base64Decode(String(body.base64 || ''));
      if (bytes.length > MAIL_ATTACH_MAX_BYTES) {
        const gmailUrl = _MailAttach_gmailUrl(attachment.messageId);
        _MailAttach_appendLog(logState, c, attachment, finalName, gmailUrl, bytes.length, 'skipped_too_large');
        logState.keys.add(dupKey);
        skipped.push({ name: attachment.name || '', reason: 'too_large', url: gmailUrl });
        continue;
      }
      const mime = body.mime || attachment.mime || 'application/octet-stream';
      const created = _MailAttach_createFileKeepFormat(folderId, bytes, mime, finalName);
      _MailAttach_appendLog(logState, c, attachment, finalName, created.getUrl(), bytes.length, 'saved');
      logState.keys.add(dupKey);
      if (!existingByName[finalName]) existingByName[finalName] = {};
      // Gmail 申告サイズと実バイト長がずれる場合があるため両方を登録する。
      // 同じ添付が原メールと転送/返信の2通に含まれると messageId:attachmentId が
      // 別になり重複キーでは弾けない (C0039 で実際に同一3ファイルが2通に出た)。
      // 名前+サイズ照合が唯一の防波堤なので、照合キーを取りこぼさないこと。
      existingByName[finalName][String(bytes.length)] = true;
      existingByName[finalName][String(metadataSize)] = true;
      saved.push({ originalName: attachment.name || '', finalName: finalName, fileId: created.getId(), url: created.getUrl(), size: bytes.length });
    } catch (e) {
      const reason = String(e.message || e);
      _MailAttach_appendLog(logState, c, attachment, finalName, '', metadataSize, 'error:' + reason);
      errors.push({ name: attachment.name || '', error: reason });
    }
  }
  // panelResult が「→ 預かり素材フォルダ」で終わるので、実行パネルからそのフォルダを直接開けるようにする。
  var azukariFolderUrl = '';
  try { azukariFolderUrl = folder.getUrl(); } catch (e) {}
  return { ok: true, caseId: c.caseId, saved: saved, skipped: skipped, errors: errors, truncated: truncated,
    azukariFolderUrl: azukariFolderUrl };
}

function MailAttachments_pollAll() {
  const started = Date.now();
  const hardDeadlineAt = started + MAIL_ATTACH_RUN_HARD_DEADLINE_MS;
  const filtered = _MailAttach_filterCases(CaseList_listAll(), started);
  const cases = filtered.included;
  const props = PropertiesService.getScriptProperties();
  const cursorCaseId = String(props.getProperty(MAIL_ATTACH_CURSOR_KEY) || '');
  let startIndex = 0;
  if (cursorCaseId) {
    const cursorIndex = cases.findIndex(function (c) { return String(c.caseId) === cursorCaseId; });
    if (cursorIndex >= 0) startIndex = cursorIndex + 1;
  }
  const result = { ok: true, casesScanned: 0, casesSkipped: filtered.skipped.length,
    casesProcessed: 0, savedTotal: 0, truncated: false, errors: [] };
  for (let i = startIndex; i < cases.length; i++) {
    if (Date.now() - started > MAIL_ATTACH_START_DEADLINE_MS) {
      result.truncated = true;
      break;
    }
    const item = cases[i] || {};
    result.casesScanned++;
    try {
      const synced = MailAttachments_syncCase(item.caseId, { hardDeadlineAt: hardDeadlineAt });
      result.casesProcessed++;
      if (!synced.ok) result.errors.push({ caseId: item.caseId, error: synced.error || 'sync_failed' });
      else if (Array.isArray(synced.saved)) result.savedTotal += synced.saved.length;
      if (synced.truncated) {
        result.truncated = true;
        break;
      }
      props.setProperty(MAIL_ATTACH_CURSOR_KEY, String(item.caseId));
    } catch (e) {
      result.casesProcessed++;
      result.errors.push({ caseId: item.caseId || '', error: String(e.message || e) });
      props.setProperty(MAIL_ATTACH_CURSOR_KEY, String(item.caseId));
    }
  }
  if (!result.truncated) props.deleteProperty(MAIL_ATTACH_CURSOR_KEY);
  return result;
}

function MailAttachments_setupTrigger() {
  const triggers = ScriptApp.getProjectTriggers();
  let removed = 0;
  triggers.forEach(function (trigger) {
    if (trigger.getHandlerFunction() === 'MailAttachments_pollAll') {
      ScriptApp.deleteTrigger(trigger);
      removed++;
    }
  });
  ScriptApp.newTrigger('MailAttachments_pollAll').timeBased().everyMinutes(15).create();
  return { removedOld: removed, created: true, everyMinutes: 15 };
}

function _debug_mailAttachments(caseId) {
  const c = CaseList_getById(caseId);
  if (!c) throw new Error('案件が見つかりません: ' + caseId);
  const listed = _MailAttach_fetchJson({
    mode: 'probe',
    caseId: c.caseId,
    clientName: c.clientName || '',
    days: MAIL_ATTACH_LOOKBACK_DAYS
  }, 'debug:' + c.caseId);
  if (!listed.ok) return { ok: false, error: listed.error };

  // debug は読み取り専用のため、作成を伴う _Upload_findOrCreateAzukariFolder は呼ばない。
  const folderId = _CaseManualPdf_findAzukariFolder(c) || '';
  let folderUrl = '';
  if (folderId) {
    try { folderUrl = DriveApp.getFolderById(folderId).getUrl(); } catch (e) {}
  }
  const ss = SpreadsheetApp.getActive();
  const sheet = ss.getSheetByName(MAIL_ATTACH_LOG_SHEET);
  // 取込側と同じ判定 (error 行は決着扱いにしない)。
  const settledState = { keys: new Set(), errorCounts: {} };
  const logRows = [];
  if (sheet && sheet.getLastRow() > 1) {
    const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, MAIL_ATTACH_LOG_HEADERS.length).getDisplayValues();
    values.forEach(function (row) {
      const key = String(row[10] || '') + ':' + String(row[11] || '');
      if (row[10] && row[11]) {
        if (String(row[12] || '').indexOf('error') === 0) {
          settledState.errorCounts[key] = (settledState.errorCounts[key] || 0) + 1;
        } else {
          settledState.keys.add(key);
        }
      }
      if (String(row[1] || '') === String(c.caseId)) logRows.push(row);
    });
  }
  return {
    resolved: listed.body.resolved || {},
    counts: listed.body.counts || {},
    azukariFolderId: folderId,
    azukariFolderUrl: folderUrl,
    attachments: (listed.body.attachments || []).map(function (attachment) {
      const key = _MailAttach_dupKey(attachment);
      return { name: attachment.name || '', size: Number(attachment.size) || 0,
        prefix: _MailAttach_classifyPrefix(attachment.name), matchedVia: attachment.matchedVia || '',
        sender: attachment.sender || '', receivedAt: attachment.receivedAt || '',
        messageId: attachment.messageId || '',
        dupKey: key, settled: _MailAttach_isSettled(settledState, key),
        errorRetries: settledState.errorCounts[key] || 0 };
    }),
    excluded: listed.body.excluded || [],
    logRows: logRows
  };
}

function _debug_mailAttachmentsPlanAll() {
  const started = Date.now();
  const hardDeadlineAt = started + MAIL_ATTACH_RUN_HARD_DEADLINE_MS;
  const filtered = _MailAttach_filterCases(CaseList_listAll(), started);
  const ss = SpreadsheetApp.getActive();
  const logSheet = ss.getSheetByName(MAIL_ATTACH_LOG_SHEET);
  // 取込側 (_MailAttach_isSettled) と同じ判定にする。error 行は決着扱いにしない。
  // ここだけ判定が違うとプレビューと実際の取込がずれる。
  // ensureLogState はシートを新規作成しうるので debug からは呼ばず、読み取りだけで組む。
  const settledState = { keys: new Set(), errorCounts: {} };
  if (logSheet && logSheet.getLastRow() > 1) {
    logSheet.getRange(2, 11, logSheet.getLastRow() - 1, 3).getDisplayValues().forEach(function (row) {
      if (!row[0] || !row[1]) return;
      const key = String(row[0]) + ':' + String(row[1]);
      if (String(row[2] || '').indexOf('error') === 0) {
        settledState.errorCounts[key] = (settledState.errorCounts[key] || 0) + 1;
      } else {
        settledState.keys.add(key);
      }
    });
  }
  const result = { cases: [], totalWillUpload: 0, truncated: false };
  for (let i = 0; i < filtered.included.length; i++) {
    if (Date.now() > hardDeadlineAt) { result.truncated = true; break; }
    const c = filtered.included[i];
    const listed = _MailAttach_fetchJson({
      caseId: c.caseId,
      clientName: c.clientName || '',
      days: MAIL_ATTACH_LOOKBACK_DAYS
    }, 'plan:' + c.caseId);
    if (!listed.ok) {
      result.cases.push({ caseId: c.caseId, clientName: c.clientName, azukariFolderFound: false,
        willUpload: [], excludedCount: 0, error: listed.error });
      continue;
    }
    // 添付が無い案件でフォルダ解決をしない。解決は実施計画書を開くので1件あたり数秒かかり、
    // 全18案件でやると6分制限を超えて結果を書けずに死ぬ(実際に死んだ)。
    // 大半の案件は添付0件なので、ここを飛ばすだけで実行時間が桁で落ちる。
    const rawAttachments = listed.body.attachments || [];
    if (rawAttachments.length === 0) {
      result.cases.push({ caseId: c.caseId, clientName: c.clientName, azukariFolderFound: null,
        willUpload: [], excludedCount: (listed.body.excluded || []).length });
      continue;
    }
    // CaseList_listAll() の行は軽量で zissiId/projectFolderId を持たないため、
    // そのまま渡すとフォルダ解決が必ず失敗し azukariFolderFound:false になる
    // (実際に全案件 false になった)。解決には getById の完全な案件オブジェクトが必要。
    const full = CaseList_getById(c.caseId) || c;
    const folderId = _CaseManualPdf_findAzukariFolder(full) || '';
    const existingByName = {};
    if (folderId) {
      try {
        const files = DriveApp.getFolderById(folderId).getFiles();
        while (files.hasNext()) {
          const file = files.next();
          if (!existingByName[file.getName()]) existingByName[file.getName()] = {};
          existingByName[file.getName()][String(file.getSize())] = true;
        }
      } catch (e) {}
    }
    let excludedCount = (listed.body.excluded || []).length;
    const willUpload = [];
    rawAttachments.forEach(function (attachment) {
      const size = Number(attachment.size) || 0;
      const finalName = _MailAttach_finalName(attachment.name);
      if (_MailAttach_isSettled(settledState, _MailAttach_dupKey(attachment)) || attachment.oversize || size > MAIL_ATTACH_MAX_BYTES ||
          (existingByName[finalName] && existingByName[finalName][String(size)])) {
        excludedCount++;
        return;
      }
      // 同一添付が原メールと転送の2通に入ると messageId が別なので上の重複キーでは弾けない。
      // 実際の取込では保存直後に existingByName へ登録されて2通目が skipped_duplicate になるため、
      // プレビューでも同じ扱いにしないと件数を過大報告する (C0039 で 3件を6件と表示した)。
      if (!existingByName[finalName]) existingByName[finalName] = {};
      existingByName[finalName][String(size)] = true;
      willUpload.push({ name: attachment.name || '', finalName: finalName, size: size,
        prefix: _MailAttach_classifyPrefix(attachment.name), matchedVia: attachment.matchedVia || '' });
    });
    result.cases.push({ caseId: c.caseId, clientName: c.clientName,
      azukariFolderFound: Boolean(folderId), willUpload: willUpload, excludedCount: excludedCount });
    result.totalWillUpload += willUpload.length;
  }
  return result;
}

/**
 * 実行パネル用の1行サマリを付ける。saved/skipped/errors は配列なので
 * パネル側 (JobQueue/CommandQueue) からは件数が読めない。
 * skipped(配列) を真偽値の「スキップ」規約と混同しないよう、ここでは触らない。
 */
function _MailAttach_withPanelResult(r) {
  if (!r || typeof r !== 'object') return r;
  if (r.ok === false) {
    r.panelResult = '❌ 取込に失敗しました: ' + String(r.error || '不明なエラー').slice(0, 120);
    r.panelStatus = '❌ エラー';
    return r;
  }
  if (r.found === false) {
    r.panelResult = 'お客様メールが見つかりませんでした (顧客の紐付けを確認してください)';
    return r;
  }
  const saved = (r.saved || []).length;
  const dup = (r.skipped || []).filter(function (s) { return s && s.reason === 'duplicate'; }).length;
  const big = (r.skipped || []).filter(function (s) { return s && s.reason === 'too_large'; }).length;
  const err = (r.errors || []).length;
  if (saved === 0 && dup === 0 && big === 0 && err === 0) {
    r.panelResult = '新しい添付はありませんでした (取込済みのみ)';
    return r;
  }
  const parts = ['保存 ' + saved + '件'];
  if (dup) parts.push('既に取込済み ' + dup + '件');
  if (big) parts.push('サイズ超過 ' + big + '件');
  if (err) parts.push('エラー ' + err + '件');
  if (r.truncated) parts.push('時間切れのため続きは次回');
  r.panelResult = parts.join(' / ') + ' → 預かり素材フォルダ';
  return r;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    _MailAttach_withPanelResult: _MailAttach_withPanelResult,
    _MailAttach_classifyPrefix: _MailAttach_classifyPrefix
  };
}
