/**
 * 「制作」フォルダ配下の行き先定義と振り分け。
 *
 * 正本: docs/PROJECT-FOLDER-DEFINITION.md（kim 指示 2026-10-12）。
 * 案件ルート直下にはデータを置かず、受け取ったデータや制作物は必ず「制作/」配下のどれかへ入れる。
 * これまで 00預かり素材 固定だった保存先を、内容に応じて定義表どおりに振り分ける。
 *
 * 既存の Azukari_resolveFolderId（src/CaseFolders.js）の挙動は変えない。
 * 預かり素材だけは既存の深い探索（実績あり）を最優先で使う。
 */

// kind → 定義。path は「制作」フォルダからの相対パス。
// match は各階層で既存フォルダを探す正規表現で、_Azukari_normalizeName() 後の名前に対して test する
// （表記ゆれ＝番号の有無・空白を許容する）。
var SEISAKU_DESTINATIONS = {
  azukari:    { label: '預かり素材（顧客から預かった原稿・座席表・式次第・ロゴ等）', path: ['00預かり素材'],            match: [/預かり/] },
  plan:       { label: '企画・提案（企画書・提案書）',                               path: ['01企画・提案'],            match: [/企画|提案/] },
  arrange:    { label: '手配（会場・演者・機材）',                                   path: ['02手配'],                  match: [/^\d*手配/] },
  meeting:    { label: 'ネガチェック・打合せ資料（議事録）',                          path: ['03ネガチェック・打合せ資料'], match: [/ネガ|打合せ|打ち合せ/] },
  production: { label: '制作（制作物の作業データ）',                                 path: ['04制作'],                  match: [/^\d*制作$/] },
  video:      { label: '映像制作（映像素材・本番の収録データ）',                      path: ['04制作', '映像制作'],       match: [/^\d*制作$/, /映像/] },
  final:      { label: '本番使用最終版（当日流した最終データ）',                      path: ['05本番使用最終版'],         match: [/本番使用最終版|最終版/] },
  aftercare:  { label: 'アフターフォロー（本番後の振り返り）',                        path: ['06アフターフォロー'],       match: [/アフター|フォロー/] },
  daymedia:   { label: '当日写真・当日映像（顧客へ納品する編集後データ）',            path: ['当日写真・当日映像'],       match: [/当日写真|当日映像/] },
  estimate:   { label: '見積り（社外見積もり・協力会社からの見積書）',                path: ['見積り（社外見積もり）'],   match: [/^見積/] }
};

var SEISAKU_DEFAULT_KIND = 'azukari';

// 映像の収録データと判定する拡張子（小文字）。
var SEISAKU_VIDEO_EXT = ['mp4', 'mov', 'avi', 'mxf', 'mts', 'm2ts', 'mpg', 'mpeg', 'mkv', 'flv', 'webm', 'wmv', 'm4v', 'r3d', 'braw'];

/** UI 用の選択肢。定義順（= 定義表の並び順）で返す。 */
function Seisaku_destinationOptions() {
  return Object.keys(SEISAKU_DESTINATIONS).map(function (kind) {
    const d = SEISAKU_DESTINATIONS[kind];
    return { kind: kind, value: kind, label: d.label, path: d.path.slice() };
  });
}

/**
 * ファイル名から保存先 kind を推定する。
 * 確実に判定できるものだけ自動振り分けし、迷うものは既定（00預かり素材）へ倒す。
 */
function Seisaku_classifyDestination(fileName) {
  const name = String(fileName || '').normalize('NFC');
  const m = name.match(/\.([a-z0-9]{1,5})$/i);
  const ext = m ? m[1].toLowerCase() : '';
  if (SEISAKU_VIDEO_EXT.indexOf(ext) >= 0) return 'video';
  if (/収録データ|収録素材|撮影データ|カメラマン/.test(name)) return 'video';
  return SEISAKU_DEFAULT_KIND;
}

/**
 * 「制作」フォルダを解決する（見つからなければ null）。
 *   1. root 直下に標準サブフォルダが 2 つ以上あれば root 自身が制作フォルダ
 *   2. root 直下の「制作」
 *   3. 「制作フォルダ（…様 …）」配下の「制作」（root 直下に制作作業フォルダが無い案件）
 */
function Seisaku_findWorkFolder(rootId) {
  if (!rootId) return null;
  const children = _Azukari_listChildren(rootId);
  if (_Azukari_markerCount(children) >= 2) {
    try { return DriveApp.getFolderById(rootId); } catch (e) { return null; }
  }
  for (let i = 0; i < children.length; i++) {
    if (_Azukari_normalizeName(children[i].getName()) === '制作') return children[i];
  }
  for (let i = 0; i < children.length; i++) {
    const name = _Azukari_normalizeName(children[i].getName());
    if (name.indexOf('制作') < 0) continue;
    const grand = _Azukari_listChildren(children[i].getId());
    if (_Azukari_markerCount(grand) >= 2) return children[i];
    for (let j = 0; j < grand.length; j++) {
      if (_Azukari_normalizeName(grand[j].getName()) === '制作') return grand[j];
    }
  }
  return null;
}

/** Seisaku_findWorkFolder + 無ければ opts.create のときだけ「制作」を作る。 */
function Seisaku_resolveWorkFolder(rootId, opts) {
  opts = opts || {};
  if (!rootId) return null;
  const found = Seisaku_findWorkFolder(rootId);
  if (found) return found;
  if (!opts.create) return null;
  let root;
  try { root = DriveApp.getFolderById(rootId); } catch (e) { return null; }
  return root.createFolder('制作');
}

function _Seisaku_findChildFolder(parentId, matchers, level) {
  const children = _Azukari_listChildren(parentId);
  for (let i = 0; i < children.length; i++) {
    const name = _Azukari_normalizeName(children[i].getName());
    if (matchers[level].test(name)) return children[i];
  }
  return null;
}

/**
 * 案件の保存先フォルダを解決する。
 * @param {Object} caseInfo CaseList_getById の戻り
 * @param {string} kind SEISAKU_DESTINATIONS のキー（不正なら既定）
 * @param {{create?:boolean,noCache?:boolean}} [opts]
 * @return {string} folderId（解決できなければ ''）
 */
function Seisaku_resolveFolder(caseInfo, kind, opts) {
  opts = opts || {};
  if (!caseInfo) return '';
  if (!SEISAKU_DESTINATIONS[kind]) kind = SEISAKU_DEFAULT_KIND;

  const cache = CacheService.getScriptCache();
  const cacheKey = 'seisaku_' + kind + '_' + String(caseInfo.caseId || '');
  if (!opts.noCache && caseInfo.caseId) {
    const hit = cache.get(cacheKey);
    if (hit) return hit;
  }

  const rootId = Case_resolveProjectRoot(caseInfo);
  if (!rootId) return '';

  let folderId = '';
  // 預かり素材だけは既存の深い探索（深さ2〜3の再帰・実績あり）を最優先で使う。
  if (kind === 'azukari') {
    folderId = Azukari_resolveFolderId(caseInfo, { create: false, noCache: true }) || '';
  }

  if (!folderId) {
    const work = Seisaku_resolveWorkFolder(rootId, { create: opts.create });
    if (work) {
      const path = SEISAKU_DESTINATIONS[kind].path;
      const match = SEISAKU_DESTINATIONS[kind].match;
      let parentId = work.getId();
      let ok = true;
      for (let i = 0; i < path.length; i++) {
        const child = _Seisaku_findChildFolder(parentId, match, i);
        if (child) { parentId = child.getId(); continue; }
        if (!opts.create) { ok = false; break; }
        parentId = DriveApp.getFolderById(parentId).createFolder(path[i]).getId();
      }
      if (ok) folderId = parentId;
    }
  }

  // 「制作」フォルダが無い案件は、従来動作（預かり素材の解決・作成）へフォールバックする。
  if (!folderId && opts.create) {
    folderId = Azukari_resolveFolderId(caseInfo, { create: true, noCache: true }) || '';
  }

  if (folderId && caseInfo.caseId) cache.put(cacheKey, folderId, 600);
  return folderId;
}

function Seisaku_clearCache(caseId) {
  const cache = CacheService.getScriptCache();
  Object.keys(SEISAKU_DESTINATIONS).forEach(function (kind) {
    cache.remove('seisaku_' + kind + '_' + String(caseId || ''));
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    SEISAKU_DESTINATIONS: SEISAKU_DESTINATIONS,
    SEISAKU_DEFAULT_KIND: SEISAKU_DEFAULT_KIND,
    SEISAKU_VIDEO_EXT: SEISAKU_VIDEO_EXT,
    Seisaku_destinationOptions: Seisaku_destinationOptions,
    Seisaku_classifyDestination: Seisaku_classifyDestination,
    Seisaku_findWorkFolder: Seisaku_findWorkFolder,
    Seisaku_resolveWorkFolder: Seisaku_resolveWorkFolder,
    Seisaku_resolveFolder: Seisaku_resolveFolder,
    Seisaku_clearCache: Seisaku_clearCache
  };
}
