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

/**
 * 保存先の選択肢。先頭は自動判定（映像は 04制作/映像制作、その他は 00預かり素材）。
 * 定義表と実装の正本は docs/PROJECT-FOLDER-DEFINITION.md / src/SeisakuFolders.js。
 */
function Upload_getDestinationOptions() {
  const auto = { value: '', kind: 'auto', label: '自動判定（映像は 04制作/映像制作、その他は 00預かり素材）', path: [] };
  return [auto].concat(Seisaku_destinationOptions().map(function (o) {
    return { value: o.kind, kind: o.kind, label: o.label, path: o.path };
  }));
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
 * 保存先は定義表（docs/PROJECT-FOLDER-DEFINITION.md）に従って「制作/」配下へ振り分ける。
 * @param {string} caseId
 * @param {string} prefix '出展マニュアル_' 等
 * @param {Array<{base64, mimeType, name}>} files
 * @param {string} [destination] '' / 'auto' = ファイル名から自動判定、それ以外は SeisakuFolders の kind
 * @return {{ok, savedFiles, folders, folderId, folderUrl, errors}}
 */
function Upload_saveToAzukari(caseId, prefix, files, destination) {
  const c = CaseList_getById(caseId);
  if (!c) throw new Error('案件が見つかりません: ' + caseId);

  // プレフィックス検証
  const validPrefixes = _UPLOAD_PREFIX_OPTIONS.map(function (o) { return o.value; });
  if (validPrefixes.indexOf(prefix) < 0) {
    throw new Error('不正なプレフィックス: ' + prefix);
  }

  const dest = destination || 'auto';
  const autoDest = dest === 'auto';
  if (!autoDest && !SEISAKU_DESTINATIONS[dest]) {
    throw new Error('不正な保存先: ' + destination);
  }
  if (dest === 'auto') {
    // UI の選択肢は '' を「自動判定」に使うため、明示の 'auto' も同じ扱いにする。
    destination = '';
  } else {
    destination = dest;
  }

  // kind → folderId は 1 リクエスト内でメモ化する（同じ保存先を何度も解決しない）。
  const folderIdByKind = {};
  const folders = [];
  const saved = [];
  const errors = [];

  function folderIdFor(kind) {
    if (folderIdByKind[kind] === undefined) {
      const id = Seisaku_resolveFolder(c, kind, { create: true }) || '';
      folderIdByKind[kind] = id;
      if (id) {
        folders.push({
          kind: kind,
          label: SEISAKU_DESTINATIONS[kind].label,
          folderId: id,
          folderUrl: DriveApp.getFolderById(id).getUrl(),
          count: 0
        });
      }
    }
    return folderIdByKind[kind];
  }

  (files || []).forEach(function (f) {
    try {
      if (!f.name || !f.base64) throw new Error('name/base64 が空');
      const kind = autoDest ? Seisaku_classifyDestination(f.name) : destination;
      const folderId = folderIdFor(kind);
      if (!folderId) throw new Error('保存先フォルダの取得・作成に失敗（プロジェクトフォルダ未設定の可能性）');
      const folder = DriveApp.getFolderById(folderId);

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
      folders.forEach(function (g) { if (g.kind === kind) g.count++; });
      saved.push({
        originalName: f.name,
        finalName: finalName,
        fileId: file.getId(),
        url: file.getUrl(),
        size: bytes.length,
        kind: kind,
        folderUrl: folder.getUrl()
      });
    } catch (e) {
      errors.push({ name: f.name, error: e.message });
    }
  });

  const primary = folders.length ? folders[0] : null;
  return {
    ok: true,
    caseId: caseId,
    destination: destination,
    folders: folders,
    folderId: primary ? primary.folderId : '',
    folderUrl: primary ? primary.folderUrl : '',
    savedFiles: saved,
    errors: errors
  };
}

function _Upload_findOrCreateAzukariFolder(caseInfo) {
  return Azukari_resolveFolderId(caseInfo, { create: true }) || null;
}
