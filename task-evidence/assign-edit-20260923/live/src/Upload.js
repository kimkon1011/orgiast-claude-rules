/**
 * 預かり素材アップロード backend。
 * UI (UploadPdf.html) からファイル base64 を受け取り、
 *   案件の「預かり素材」フォルダに <prefix>_<originalName> で保存。
 *
 * 「預かり素材」フォルダが見つからない場合は、現場の「制作」作業フォルダ配下に
 *   「00預かり素材」を新規作成して保存する（制作が無い案件だけ projectRoot 直下）。
 */

const _UPLOAD_PREFIX_OPTIONS = [
  { value: '出展マニュアル_', label: '出展マニュアル (主催者支給の本体)', category: 'PRIMARY' },
  { value: '主催者_',         label: '主催者書類 (案内/お知らせ等)',     category: 'PRIMARY' },
  { value: '出展規定_',       label: '出展規定 (規約/規則)',             category: 'PRIMARY' },
  { value: '出展ガイド_',     label: '出展ガイド (チェックリスト等)',     category: 'PRIMARY' },
  { value: '申請_',           label: '申請書 (電気/車両/搬入 等)',       category: 'SUBMISSION' },
  { value: '申込_',           label: '申込書 (備品/オプション 等)',       category: 'SUBMISSION' },
  { value: '実測_',           label: '現場実測・測定結果 (採寸/寸法確認)',       category: 'DESIGN' },
  { value: 'パース_',         label: 'パース・デザイン検証 (図面/レイアウト)',       category: 'DESIGN' },
  { value: 'メール添付_',     label: 'お客様メール添付 (自動取込)', category: 'AUTO' }
];

function Upload_getPrefixOptions() {
  return _UPLOAD_PREFIX_OPTIONS;
}

function showUploadDialog() {
  const html = HtmlService.createTemplateFromFile('ui/UploadPdf')
    .evaluate()
    .setWidth(540)
    .setHeight(640);
  SpreadsheetApp.getUi().showModalDialog(html, '預かり素材アップロード');
}

/**
 * UI からの保存リクエスト。
 * @param {string} caseId
 * @param {string} prefix '出展マニュアル_' 等
 * @param {Array<{base64, mimeType, name}>} files
 * @return {{ok, savedFiles, folderUrl, errors}}
 */
function Upload_saveToAzukari(caseId, prefix, files) {
  const c = CaseList_getById(caseId);
  if (!c) throw new Error('案件が見つかりません: ' + caseId);

  // プレフィックス検証
  const validPrefixes = _UPLOAD_PREFIX_OPTIONS.map(function (o) { return o.value; });
  if (validPrefixes.indexOf(prefix) < 0) {
    throw new Error('不正なプレフィックス: ' + prefix);
  }

  // 預かり素材フォルダを取得 (無ければ作成)
  let azukariFolderId = _Upload_findOrCreateAzukariFolder(c);
  if (!azukariFolderId) {
    throw new Error('預かり素材フォルダの取得・作成に失敗。プロジェクトフォルダが設定されていない可能性があります。');
  }
  const folder = DriveApp.getFolderById(azukariFolderId);

  const saved = [];
  const errors = [];
  (files || []).forEach(function (f) {
    try {
      if (!f.name || !f.base64) throw new Error('name/base64 が空');
      // 既に prefix が付いていれば剥がす（二重防止）
      let cleanName = f.name;
      validPrefixes.forEach(function (p) {
        if (cleanName.indexOf(p) === 0) cleanName = cleanName.slice(p.length);
      });
      const finalName = prefix + cleanName;
      const bytes = Utilities.base64Decode(f.base64);
      const mime = f.mimeType || 'application/octet-stream';
      const blob = Utilities.newBlob(bytes, mime, finalName);
      const file = folder.createFile(blob);
      saved.push({
        originalName: f.name,
        finalName: finalName,
        fileId: file.getId(),
        url: file.getUrl(),
        size: bytes.length
      });
    } catch (e) {
      errors.push({ name: f.name, error: e.message });
    }
  });

  return {
    ok: true,
    caseId: caseId,
    folderId: azukariFolderId,
    folderUrl: folder.getUrl(),
    savedFiles: saved,
    errors: errors
  };
}

function _Upload_findOrCreateAzukariFolder(caseInfo) {
  return Azukari_resolveFolderId(caseInfo, { create: true }) || null;
}
