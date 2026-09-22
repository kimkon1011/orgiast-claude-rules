/** 案件フォルダ内の、Claude が読める資料を予算内で収集する。 */
const CASE_MATERIALS_CACHE_PARENT_ID = '1Yt1E9En7K8tMVONET32KgHkMWR4jWT8t';
const CASE_MATERIALS_CACHE_FOLDER_NAME = '_変換キャッシュ';
const CASE_MATERIALS_DESIGN_KEYWORDS = /パース|レイアウト|ブースデザイン|デザイン|完成|イメージ|外観|内観|平面|図面|立面|配置図|小間|ゾーニング|zoning|ブース案|トラス|配線|電気|アンカー|施工図|什器|プラン|CAD|金具|LEDUP|実機|測定|実測|採寸|寸法|現調|下見|検証|寸法確認/i;
// フォルダ名で除外する語 (実機 C0039 で「見積り（社外見積もり）/施工会社/株式会社オージャスト.pdf」が
// ファイル名に「見積」を含まないため混入した。金額情報を生成に混ぜないための防波堤。
// 「01企画・提案」の"提案"に誤爆しないよう金額語だけに限定する)
const CASE_MATERIALS_EXCLUDE_PATH_KEYWORDS = /見積|請求|支払|入金|発注書|契約/;
// 実体が無くリンクだけの native Google ファイルは枠を食うだけなので落とす閾値
const CASE_MATERIALS_MIN_NATIVE_BYTES = 3000;
const CASE_MATERIALS_EXCLUDE_KEYWORDS = /出展マニュアル|主催者|出展規定|出展ガイド|申請|申込|提出フォーマット|見積|請求|スクリーンショット/;
let Case_collectCaseMaterials_lastSkipped = [];

function CaseMaterials_kindForMimeType(mimeType) {
  const kinds = {
    'application/pdf': 'pdf',
    'application/vnd.google-apps.presentation': 'slides',
    'application/vnd.google-apps.document': 'docs',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
    'image/png': 'image', 'image/jpeg': 'image', 'image/webp': 'image', 'image/gif': 'image'
  };
  return kinds[String(mimeType || '')] || '';
}

/** 案件資料へ混ぜない、アプリ自身が生成した成果物かを判定する。 */
function CaseMaterials_isAppGenerated(label, caseId) {
  const name = String(label || '').normalize('NFC');
  const id = String(caseId || '').normalize('NFC');
  if (!id || name.indexOf('議事録') >= 0) return false;
  return name.indexOf(id + '_') === 0 || name.indexOf('Claude_') === 0;
}

function CaseMaterials_dedupeAndRank(files) {
  const byKey = {};
  (files || []).forEach(function (f) {
    const nameKey = String(f.label || '').normalize('NFC').toLowerCase()
      .replace(/\.[a-z0-9]{2,5}$/i, '').replace(/のコピー| - コピー|copy of /gi, '')
      .replace(/\s*\(\d+\)\s*$/, '').replace(/[\s　]+/g, '');
    const key = nameKey + '|' + (f.kind || CaseMaterials_kindForMimeType(f.mimeType));
    const prev = byKey[key];
    if (!prev || (f.lastUpdated || 0) > (prev.lastUpdated || 0)) byKey[key] = f;
  });
  return Object.keys(byKey).map(function (k) { return byKey[k]; }).sort(function (a, b) {
    const ap = CASE_MATERIALS_DESIGN_KEYWORDS.test(String(a.label || '').normalize('NFC')) ? 1 : 0;
    const bp = CASE_MATERIALS_DESIGN_KEYWORDS.test(String(b.label || '').normalize('NFC')) ? 1 : 0;
    return bp - ap || (b.lastUpdated || 0) - (a.lastUpdated || 0);
  });
}

function CaseMaterials_selectCandidates(files, opts) {
  opts = opts || {};
  const caseId = String(opts.caseId || '');
  // unlimited: ダイジェスト用に件数/合計サイズの予算を外す (1ファイル上限だけ残す)
  if (opts.unlimited) {
    opts = Object.assign({}, opts, {
      maxFiles: opts.maxFiles == null ? Infinity : Number(opts.maxFiles),
      maxTotalBytes: opts.maxTotalBytes == null ? Infinity : Number(opts.maxTotalBytes),
      maxImages: opts.maxImages == null ? Infinity : Number(opts.maxImages),
      maxFileBytes: opts.maxFileBytes == null ? 20 * 1024 * 1024 : Number(opts.maxFileBytes),
      reserveImages: 0
    });
  }
  const limits = {
    maxFiles: opts.maxFiles == null ? 6 : Number(opts.maxFiles),
    maxTotalBytes: opts.maxTotalBytes == null ? 20 * 1024 * 1024 : Number(opts.maxTotalBytes),
    maxFileBytes: opts.maxFileBytes == null ? 9 * 1024 * 1024 : Number(opts.maxFileBytes),
    maxImages: opts.maxImages == null ? 3 : Number(opts.maxImages)
  };
  const eligible = [], skipped = [];
  (files || []).forEach(function (f) {
    const item = Object.assign({}, f);
    item.label = String(item.label || '').normalize('NFC');
    item.kind = item.kind || CaseMaterials_kindForMimeType(item.mimeType);
    if (CaseMaterials_isAppGenerated(item.label, caseId)) {
      skipped.push(Object.assign(item, { reason: 'app_generated' }));
    } else if (CASE_MATERIALS_EXCLUDE_KEYWORDS.test(item.label)) {
      skipped.push(Object.assign(item, { reason: 'excluded_keyword' }));
    } else if (CASE_MATERIALS_EXCLUDE_PATH_KEYWORDS.test(String(item.folderPath || '').normalize('NFC'))) {
      skipped.push(Object.assign(item, { reason: 'excluded_folder' }));
    } else if ((item.kind === 'docs' || item.kind === 'slides') &&
               (Number(item.bytes) || 0) < CASE_MATERIALS_MIN_NATIVE_BYTES) {
      skipped.push(Object.assign(item, { reason: 'too_small_link_only' }));
    } else if (!item.kind) {
      skipped.push(Object.assign(item, { reason: 'unsupported_mimeType' }));
    } else {
      eligible.push(item);
    }
  });
  const selected = [], ranked = CaseMaterials_dedupeAndRank(eligible);
  const rankedIds = {};
  ranked.forEach(function (item) { rankedIds[item.driveFileId] = true; });
  eligible.forEach(function (item) {
    if (!rankedIds[item.driveFileId]) skipped.push(Object.assign({}, item, { reason: 'deduped_older_same_name_kind' }));
  });
  let totalBytes = 0, images = 0;
  // 現況写真はファイル名にキーワードが無く常に最下位へ落ちるため、最新の画像に枠を予約する。
  // (maxFiles が 2 以下の時は設計資料を優先し予約しない)
  const reserveImages = opts.reserveImages == null
    ? (limits.maxFiles >= 3 ? 1 : 0) : Number(opts.reserveImages);
  const reserved = {};
  if (reserveImages > 0 && limits.maxImages > 0) {
    ranked.filter(function (x) {
      return x.kind === 'image' && (Number(x.bytes) || 0) <= limits.maxFileBytes;
    }).sort(function (a, b) {
      return (b.lastUpdated || 0) - (a.lastUpdated || 0);
    }).slice(0, Math.min(reserveImages, limits.maxImages, limits.maxFiles)).forEach(function (x) {
      const bytes = Number(x.bytes) || 0;
      if (totalBytes + bytes > limits.maxTotalBytes) return;
      reserved[x.driveFileId] = true;
      selected.push(x); totalBytes += bytes; images++;
    });
  }
  ranked.forEach(function (item) {
    if (reserved[item.driveFileId]) return;
    const bytes = Number(item.bytes) || 0;
    let reason = '';
    if (bytes > limits.maxFileBytes) reason = 'over_max_file_bytes';
    else if (selected.length >= limits.maxFiles) reason = 'over_max_files';
    else if (item.kind === 'image' && images >= limits.maxImages) reason = 'over_max_images';
    else if (totalBytes + bytes > limits.maxTotalBytes) reason = 'over_max_total_bytes';
    if (reason) skipped.push(Object.assign({}, item, { reason: reason }));
    else {
      selected.push(item); totalBytes += bytes;
      if (item.kind === 'image') images++;
    }
  });
  // 出力順は rank 順に戻す (cache_control は末尾ブロックに付くため重要度の並びを保つ)
  const order = {};
  ranked.forEach(function (x, i) { order[x.driveFileId] = i; });
  selected.sort(function (a, b) { return (order[a.driveFileId] || 0) - (order[b.driveFileId] || 0); });
  return { selected: selected, skipped: skipped, totalBytes: totalBytes };
}

function Case_collectCaseMaterials(c, opts) {
  const rootId = Case_resolveProjectRoot(c);
  const found = [], scanSkipped = [], seen = {};
  if (!rootId) { Case_collectCaseMaterials_lastSkipped = [{ reason: 'project_root_not_found' }]; return []; }
  function walk(folder, path, depth) {
    if (depth < 0) return;
    const files = folder.getFiles();
    while (files.hasNext()) {
      const f = files.next(), id = f.getId();
      if (seen[id]) continue;
      seen[id] = true;
      let bytes = 0, updated = 0;
      try { bytes = Number(f.getSize()) || 0; } catch (e) {}
      try { updated = f.getLastUpdated().getTime(); } catch (e) {}
      found.push({ driveFileId: id, label: f.getName(), mimeType: f.getMimeType(),
        kind: CaseMaterials_kindForMimeType(f.getMimeType()), bytes: bytes,
        lastUpdated: updated, folderPath: path, reason: 'selected' });
    }
    if (depth === 0) return;
    const folders = folder.getFolders();
    while (folders.hasNext()) {
      const sub = folders.next(), subName = String(sub.getName()).normalize('NFC');
      if (subName === CASE_MATERIALS_CACHE_FOLDER_NAME) {
        scanSkipped.push({ label: subName, folderPath: path, reason: 'conversion_cache_folder' });
        continue;
      }
      walk(sub, path + '/' + subName, depth - 1);
    }
  }
  try { const root = DriveApp.getFolderById(rootId); walk(root, root.getName(), 5); }
  catch (e) { Case_collectCaseMaterials_lastSkipped = [{ reason: 'folder_scan_failed', detail: e.message }]; return []; }
  const selectOpts = Object.assign({}, opts || {}, { caseId: c && c.caseId ? c.caseId : '' });
  const result = CaseMaterials_selectCandidates(found, selectOpts);
  Case_collectCaseMaterials_lastSkipped = scanSkipped.concat(result.skipped);
  console.log('Case materials: selected=' + result.selected.length + ', skipped=' +
    Case_collectCaseMaterials_lastSkipped.length + ', budgetSkipped=' + result.skipped.filter(function (x) {
      return /^over_/.test(x.reason);
    }).length + ', bytes=' + result.totalBytes);
  return result.selected;
}

function CaseMaterials_getCacheFolder() {
  const parent = DriveApp.getFolderById(CASE_MATERIALS_CACHE_PARENT_ID);
  const existing = parent.getFoldersByName(CASE_MATERIALS_CACHE_FOLDER_NAME);
  return existing.hasNext() ? existing.next() : parent.createFolder(CASE_MATERIALS_CACHE_FOLDER_NAME);
}

function CaseMaterials_pptxToPdf(fileId) {
  try {
    const source = DriveApp.getFileById(fileId);
    const updated = source.getLastUpdated().getTime();
    const cache = CaseMaterials_getCacheFolder();
    const cacheName = 'conv_' + fileId + '_' + updated;
    const hits = cache.getFilesByName(cacheName);
    let converted;
    if (hits.hasNext()) converted = hits.next();
    else {
      const response = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(fileId) + '/copy?supportsAllDrives=true', {
        method: 'post', contentType: 'application/json',
        headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
        payload: JSON.stringify({ name: cacheName, mimeType: 'application/vnd.google-apps.presentation', parents: [cache.getId()] }),
        muteHttpExceptions: true
      });
      if (response.getResponseCode() < 200 || response.getResponseCode() >= 300) {
        console.warn('pptx conversion failed: ' + fileId + ' / HTTP ' + response.getResponseCode() + ' / ' + response.getContentText());
        return null;
      }
      converted = DriveApp.getFileById(JSON.parse(response.getContentText()).id);
    }
    return converted.getAs('application/pdf');
  } catch (e) { console.warn('pptx conversion failed: ' + fileId + ' / ' + e.message); return null; }
}

if (typeof module !== 'undefined') module.exports = {
  CaseMaterials_kindForMimeType, CaseMaterials_isAppGenerated,
  CaseMaterials_dedupeAndRank, CaseMaterials_selectCandidates
};
