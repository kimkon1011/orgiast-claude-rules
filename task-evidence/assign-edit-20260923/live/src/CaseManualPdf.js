// PDF カテゴリ判定用のプレフィックス定義
const _PDF_PREFIX_PRIMARY = ['出展マニュアル_', '主催者_', '出展規定_', '出展ガイド_'];  // 全生成で必読
const _PDF_PREFIX_SUBMISSION = ['申請_', '申込_'];                                       // 提出書類生成時のみ

// 実運用の命名揺れを許容する。旧プレフィックスの語もすべて包含する上位互換。
const _PDF_KEYWORD_PRIMARY = /出展マニュアル|出展者マニュアル|出品マニュアル|出展要項|出展規定|出展規程|展示規則|出展ガイド|小間規定|主催者/;
const _PDF_KEYWORD_SUBMISSION = /申請|申込|申し込み/;

/**
 * 案件の参照 PDF をファイル名のキーワードで仕分けて検出。
 *
 * 仕分け:
 *  - PRIMARY (出展マニュアル / 出展規定 / 主催者等): 全 Phase 生成で必読
 *  - SUBMISSION (申請 / 申込 / 申し込み): 提出書類生成時のみ追加
 *  - 上記いずれも一致しないファイル: Claude には渡さない（参考素材扱い）
 *
 * 取得元:
 *   実施計画書 Task!C1 から プロジェクトフォルダ → 「預かり素材」フォルダ (再帰探索)
 *   → そのフォルダ + 2 階層下までの PDF を採取
 *
 * @param {Object} caseInfo CaseList_getById の戻り
 * @param {Object} [opts] { includeSubmission: bool, maxFiles: number }
 *   includeSubmission=true なら 申請_/申込_ も含める (提出書類生成専用)
 *   maxFiles はカテゴリ毎の上限。デフォルト 10。
 * @return {Array<{driveFileId, label, source, category}>}
 */
function CaseManualPdf_find(caseInfo, opts) {
  opts = opts || {};
  if (!caseInfo) return [];
  const MAX = opts.maxFiles || 10;
  const includeSubmission = !!opts.includeSubmission;
  const found = [];
  const seen = {};

  const azukariFolderId = _CaseManualPdf_findAzukariFolder(caseInfo);
  if (azukariFolderId) {
    // 預かり素材階層 (2階層下まで) の PDF を全部リスト化 → キーワードで仕分け
    const allCandidates = [];
    try {
      _CaseManualPdf_listPdfsRecursive(azukariFolderId, allCandidates, seen, '預かり素材', 3);
    } catch (e) {}
    // PRIMARY
    const primary = Case_dedupeNewestFiles(allCandidates.filter(function (p) { return _CaseManualPdf_classify(p.label) === 'PRIMARY'; }));
    primary.slice(0, MAX).forEach(function (p) {
      found.push({ driveFileId: p.driveFileId, label: p.label, source: p.source, category: 'PRIMARY' });
    });
    // SUBMISSION（必要時のみ）
    if (includeSubmission) {
      const submission = Case_dedupeNewestFiles(allCandidates.filter(function (p) { return _CaseManualPdf_classify(p.label) === 'SUBMISSION'; }));
      submission.slice(0, MAX).forEach(function (p) {
        found.push({ driveFileId: p.driveFileId, label: p.label, source: p.source, category: 'SUBMISSION' });
      });
    }
  }
  if (found.length > 0) return found;

  // 2) フォールバック: 案件フォルダ直下の PDF をキーワードで仕分け
  const candidates = [caseInfo.folderId, caseInfo.projectFolderId].filter(Boolean);
  const primaryFb = [];
  const submissionFb = [];
  candidates.forEach(function (fid) {
    try {
      const folder = DriveApp.getFolderById(fid);
      const it = folder.getFilesByType(MimeType.PDF);
      while (it.hasNext()) {
        const f = it.next();
        const name = f.getName();
        const id = f.getId();
        if (seen[id]) continue;
        seen[id] = true;
        const cat = _CaseManualPdf_classify(name);
        let lastUpdated = 0;
        try { lastUpdated = f.getLastUpdated().getTime(); } catch (e2) {}
        if (cat === 'PRIMARY') primaryFb.push({ driveFileId: id, label: name, source: 'case folder', category: 'PRIMARY', lastUpdated: lastUpdated });
        else if (cat === 'SUBMISSION') submissionFb.push({ driveFileId: id, label: name, source: 'case folder', category: 'SUBMISSION', lastUpdated: lastUpdated });
      }
    } catch (e) { /* skip */ }
  });
  Case_dedupeNewestFiles(primaryFb).slice(0, MAX).forEach(function (p) { found.push(p); });
  if (includeSubmission) Case_dedupeNewestFiles(submissionFb).slice(0, MAX).forEach(function (p) { found.push(p); });
  return found;
}

/**
 * ファイル名から PDF カテゴリを判定。
 * @return 'PRIMARY' | 'SUBMISSION' | null
 */
function _CaseManualPdf_classify(filename) {
  const n = String(filename || '')
    .normalize('NFC')
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); })
    .replace(/　/g, ' ');

  // 出展者ポータル等の操作説明は、主催者ルール類ではない。
  if (/操作マニュアル/.test(n)) return null;

  // 両方の語を含む場合は、全 Phase 必読の PRIMARY を優先する。
  if (_PDF_KEYWORD_PRIMARY.test(n)) return 'PRIMARY';
  if (_PDF_KEYWORD_SUBMISSION.test(n)) return 'SUBMISSION';
  return null;
}

/**
 * 指定フォルダ + 子フォルダの PDF を再帰的に列挙（仕分けは呼び出し側で実施）。
 * 上限は max（既存比互換のため out.length チェックは無し、呼び出し側で slice）
 */
function _CaseManualPdf_listPdfsRecursive(folderId, out, seen, source, maxDepth) {
  if (maxDepth <= 0) return;
  let folder;
  try { folder = DriveApp.getFolderById(folderId); } catch (e) { return; }
  const it = folder.getFilesByType(MimeType.PDF);
  while (it.hasNext()) {
    const f = it.next();
    const id = f.getId();
    if (seen[id]) continue;
    seen[id] = true;
    let lastUpdated = 0;
    try { lastUpdated = f.getLastUpdated().getTime(); } catch (e) {}
    out.push({ driveFileId: id, label: f.getName(), source: source, lastUpdated: lastUpdated });
  }
  const subs = folder.getFolders();
  while (subs.hasNext()) {
    const sub = subs.next();
    _CaseManualPdf_listPdfsRecursive(sub.getId(), out, seen, source + '/' + sub.getName(), maxDepth - 1);
  }
}

/**
 * 実施計画書から プロジェクトフォルダ URL を辿り、「預かり素材」サブフォルダ ID を返す。
 *
 * 実施計画書テンプレの構造:
 *   - Task!C1 のセル値は「■制作ﾌｫﾙﾀﾞURL」ラベル
 *   - 実体の URL は HYPERLINK 数式の参照先 (settei!B6) に入っている
 *
 * 探索順:
 *   1) Task!C1 の HYPERLINK formula を解析 → 参照セルを読む
 *   2) Task!C1 が生 URL ならそのまま使う
 *   3) settei!B6 を直接読む（fallback、典型ロケーション）
 *   4) settei!B6 が無い場合は settei!B5/B7 も試す（テンプレ差異）
 *
 * URL を取得できたら → そのフォルダ内の「預かり素材」サブフォルダ ID を返す。
 * いずれも失敗時は null。
 */
function _CaseManualPdf_findAzukariFolder(caseInfo) {
  return Azukari_resolveFolderId(caseInfo, { create: false }) || null;
}

function _CaseManualPdf_findFolderByNameRecursive(parentId, regex, maxDepth) {
  if (maxDepth <= 0) return null;
  let parent;
  try { parent = DriveApp.getFolderById(parentId); } catch (e) { return null; }
  // 直下を先にチェック
  const subs = parent.getFolders();
  const queue = [];
  while (subs.hasNext()) {
    const s = subs.next();
    const name = s.getName();
    if (regex.test(name)) return s.getId();
    queue.push(s.getId());
  }
  // 直下に見つからなければ1階層下に降りる
  for (let i = 0; i < queue.length; i++) {
    const found = _CaseManualPdf_findFolderByNameRecursive(queue[i], regex, maxDepth - 1);
    if (found) return found;
  }
  return null;
}

function _CaseManualPdf_extractFolderId(url) {
  if (!url) return '';
  const s = String(url);
  // /drive/folders/<id>
  let m = s.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  // /drive/u/0/folders/<id>
  m = s.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  // ?id=<id>
  m = s.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  return '';
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { _CaseManualPdf_classify: _CaseManualPdf_classify };
}
