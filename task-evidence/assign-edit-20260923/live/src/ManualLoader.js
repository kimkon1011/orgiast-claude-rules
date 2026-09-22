/**
 * Growi マニュアル取り込み。Drive 一次ソース「社内マニュアル_NotebookLM連携」
 * フォルダ (1LMRI2jFpVG3WnDYlepgbOuyJ6ZBYzI8B) の Part01-13 Google Docs から
 * ページタイトル/パスを指定して本文を抽出する。
 *
 * 各 Part Doc は ~450KB のプレーンテキストで以下の構造を繰り返す:
 *   ### ページタイトル: <title>
 *   --- 内部パス: <path> ---
 *   ---------- マニュアル本文 ----------
 *   <body>
 *
 * WebFetch は使わず Drive 経由で取得（認証必須サイト対策、global rule）。
 */

const MANUAL_PARTS_FOLDER_ID = '1LMRI2jFpVG3WnDYlepgbOuyJ6ZBYzI8B';
const MANUAL_CACHE_PREFIX = 'manual_part_';
const MANUAL_INDEX_CACHE_KEY = 'manual_page_index_v1';
const MANUAL_CACHE_TTL_SEC = 21600; // 6h

function ManualLoader_freshnessCheck() {
  const parts = _Manual_listParts();
  if (parts.length === 0) {
    SpreadsheetApp.getUi().alert('Part01-13 が見つかりません。Drive フォルダ ID を確認してください。');
    return;
  }
  const now = new Date();
  const lines = parts.map(p => {
    const ageDays = Math.floor((now - p.modifiedTime) / (1000 * 60 * 60 * 24));
    const flag = ageDays > 90 ? ' ⚠️3ヶ月超' : '';
    return p.title + ' / 最終更新: ' + p.description + ' / Driveでの更新: ' + ageDays + '日前' + flag;
  });
  const oldest = Math.max(...parts.map(p => Math.floor((now - p.modifiedTime) / (1000 * 60 * 60 * 24))));
  const warning = oldest > 90
    ? '\n\n⚠️ 最古ファイルが3ヶ月超古いです。GAS の取り込みフローが止まっている可能性があります。'
    : '';
  SpreadsheetApp.getUi().alert('マニュアル鮮度', lines.join('\n') + warning, SpreadsheetApp.getUi().ButtonSet.OK);
}

/**
 * ページタイトル（部分一致）または内部パス（部分一致）でページを検索し本文を返す。
 * @return {Array<{title, path, body, partTitle}>} マッチしたページのリスト
 */
function ManualLoader_findPages(queries) {
  // queries: ['ページタイトル文字列', '/path/to/page', ...] — 単一文字列でも可
  if (typeof queries === 'string') queries = [queries];
  const index = _Manual_buildIndex();
  const results = [];
  const seen = {};
  queries.forEach(q => {
    if (!q) return;
    const qNorm = String(q).trim();
    index.forEach(entry => {
      const matchByPath = qNorm.indexOf('/') >= 0 && entry.path.indexOf(qNorm) >= 0;
      const matchByTitle = entry.title.indexOf(qNorm) >= 0 || entry.path.indexOf(qNorm) >= 0;
      if ((matchByPath || matchByTitle) && !seen[entry.partId + '#' + entry.startOffset]) {
        seen[entry.partId + '#' + entry.startOffset] = true;
        let body = '';
        try { body = _Manual_extractBody(entry); }
        catch (e) { body = '(本文取得失敗: ' + e.message + ')'; }
        results.push({
          title: entry.title,
          path: entry.path,
          partTitle: entry.partTitle,
          body: body
        });
      }
    });
  });
  return results;
}

function ManualLoader_findFirst(query) {
  const r = ManualLoader_findPages(query);
  return r.length > 0 ? r[0] : null;
}

// -------- internals --------

function _Manual_listParts() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get('manual_part_list');
  if (cached) {
    return JSON.parse(cached).map(p => ({ ...p, modifiedTime: new Date(p.modifiedTime) }));
  }
  const folder = DriveApp.getFolderById(MANUAL_PARTS_FOLDER_ID);
  const it = folder.getFilesByType(MimeType.GOOGLE_DOCS);
  const parts = [];
  while (it.hasNext()) {
    const f = it.next();
    const title = f.getName();
    if (title.indexOf('_Part') < 0) continue;
    parts.push({
      id: f.getId(),
      title: title,
      description: f.getDescription() || '',
      modifiedTime: f.getLastUpdated()
    });
  }
  parts.sort((a, b) => a.title.localeCompare(b.title));
  cache.put('manual_part_list', JSON.stringify(parts.map(p => ({
    ...p, modifiedTime: p.modifiedTime.toISOString()
  }))), MANUAL_CACHE_TTL_SEC);
  return parts;
}

function _Manual_getPartText(partId) {
  const cache = CacheService.getScriptCache();
  const key = MANUAL_CACHE_PREFIX + partId;
  const cached = cache.get(key);
  if (cached) return cached;
  const url = 'https://docs.google.com/feeds/download/documents/export/Export?id=' +
    partId + '&exportFormat=txt';
  // 429 rate limit に対して exponential backoff で 3 回まで再試行
  let lastCode = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) Utilities.sleep(1500 * attempt);
    const response = UrlFetchApp.fetch(url, {
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
      muteHttpExceptions: true
    });
    lastCode = response.getResponseCode();
    if (lastCode === 200) {
      const text = response.getContentText();
      if (text.length < 90000) {
        cache.put(key, text, MANUAL_CACHE_TTL_SEC);
      }
      return text;
    }
    if (lastCode !== 429 && lastCode !== 500 && lastCode !== 503) break;
  }
  throw new Error('Part 取得失敗: ' + partId + ' / ' + lastCode);
}

function _Manual_buildIndex() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get(MANUAL_INDEX_CACHE_KEY);
  if (cached) return JSON.parse(cached);
  const parts = _Manual_listParts();
  const index = [];
  const titleRe = /### ページタイトル:\s*(.+?)[\r\n]+--- 内部パス:\s*(.+?)\s*---/g;
  const failedParts = [];
  parts.forEach(p => {
    let text;
    try {
      text = _Manual_getPartText(p.id);
    } catch (e) {
      failedParts.push(p.title + ' (' + e.message + ')');
      return;
    }
    let m;
    while ((m = titleRe.exec(text)) !== null) {
      index.push({
        title: m[1].trim(),
        path: m[2].trim(),
        partId: p.id,
        partTitle: p.title,
        startOffset: m.index
      });
    }
  });
  if (failedParts.length > 0) {
    console.warn('manual buildIndex: skipped failing parts: ' + failedParts.join(', '));
  }
  // インデックスは大きすぎる可能性があるので圧縮しない形で保存試行、ダメなら諦める
  try {
    cache.put(MANUAL_INDEX_CACHE_KEY, JSON.stringify(index), MANUAL_CACHE_TTL_SEC);
  } catch (e) {
    // 100KB 超なら諦めて毎回再構築（保守的）
  }
  return index;
}

function _Manual_extractBody(entry) {
  const text = _Manual_getPartText(entry.partId);
  // entry.startOffset から次の「### ページタイトル:」まで抜き出し、本文以降を切り出す
  const headerEnd = text.indexOf('---------- マニュアル本文 ----------', entry.startOffset);
  if (headerEnd < 0) return '';
  const bodyStart = headerEnd + '---------- マニュアル本文 ----------'.length;
  const next = text.indexOf('### ページタイトル:', bodyStart);
  const bodyEnd = next < 0 ? text.length : next;
  return text.substring(bodyStart, bodyEnd).trim();
}
