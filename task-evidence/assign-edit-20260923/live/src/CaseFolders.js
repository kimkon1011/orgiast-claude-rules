/**
 * 案件のプロジェクトフォルダ解決 (共通)。
 *
 * authoritative source は 実施計画書(zissi) の settei!B6 (B5/B7 fallback) にある
 * プロジェクトフォルダ URL。 booth 案件一覧 L列 (projectFolderId) は booth 自身が
 * 作った「制作フォルダ(…様」を指すことがあり、実運用の「制作」フォルダと一致しない
 * (2026-08-13 預かり素材の二重化事故 / 2026-08-16 図面が生成に渡らない問題の根因)。
 *
 * 解決順: settei!B6/B5/B7 → zissi Task!C1 HYPERLINK → booth L列 → 案件フォルダ。
 * 10分キャッシュ。
 */
function Case_resolveProjectRoot(c) {
  if (!c) return '';
  const cache = CacheService.getScriptCache();
  const key = 'projroot_' + c.caseId;
  const hit = cache.get(key);
  if (hit) return hit;

  let rootId = '';
  if (c.zissiId) {
    try {
      const zissiSs = SpreadsheetApp.openById(c.zissiId);
      const settei = zissiSs.getSheetByName('settei');
      if (settei) {
        const cand = ['B6', 'B5', 'B7'];
        for (let i = 0; i < cand.length && !rootId; i++) {
          const v = String(settei.getRange(cand[i]).getValue() || '');
          const m = v.match(/folders\/([a-zA-Z0-9_-]+)/);
          if (m) rootId = m[1];
        }
      }
      if (!rootId) {
        const taskSheet = zissiSs.getSheetByName('Task') || zissiSs.getSheetByName('task');
        if (taskSheet) {
          const formula = String(taskSheet.getRange('C1').getFormula() || '');
          const m = formula.match(/folders\/([a-zA-Z0-9_-]+)/);
          if (m) rootId = m[1];
        }
      }
    } catch (e) { /* fallback へ */ }
  }
  if (!rootId) rootId = c.projectFolderId || c.folderId || '';
  if (rootId) cache.put(key, rootId, 600);
  return rootId;
}

// 案件標準サブフォルダのマーカー（この名前を持つ子が複数あるフォルダ = 現場の作業フォルダ）
var AZUKARI_WORKROOT_MARKERS = ['当日写真', '書類', '企画・提案', '手配', '本番使用最終版', 'アフターフォロー', 'ネガチェック', '見積り'];

function _Azukari_normalizeName(name) {
  return String(name || '').normalize('NFC').replace(/[\s　]+/g, '');
}

function _Azukari_markerCount(folders) {
  let count = 0;
  (folders || []).forEach(function (folder) {
    const name = _Azukari_normalizeName(folder.getName());
    if (AZUKARI_WORKROOT_MARKERS.some(function (marker) { return name.indexOf(marker) >= 0; })) count++;
  });
  return count;
}

function _Azukari_listChildren(folderId) {
  const out = [];
  let parent;
  try { parent = DriveApp.getFolderById(folderId); } catch (e) { return out; }
  const it = parent.getFolders();
  while (it.hasNext()) out.push(it.next());
  return out;
}

/** projectRoot 直下から現場の「制作」作業フォルダを選ぶ。 */
function Azukari_findWorkRoot(rootId) {
  if (!rootId) return null;
  const children = _Azukari_listChildren(rootId);
  // root 自身がすでに作業フォルダなら、呼び出し側で root をそのまま使う。
  if (_Azukari_markerCount(children) >= 2) return null;

  const scored = children.map(function (folder) {
    const normalized = _Azukari_normalizeName(folder.getName());
    let score = 0;
    if (normalized === '制作') score += 100;
    else if (!/^\d+/.test(normalized) && normalized.indexOf('制作') >= 0) score += 30;
    return { folder: folder, score: score };
  });
  if (scored.length <= 3) {
    scored.forEach(function (candidate) {
      candidate.score += Math.min(5, _Azukari_markerCount(_Azukari_listChildren(candidate.folder.getId()))) * 10;
    });
  }
  scored.sort(function (a, b) { return b.score - a.score; });
  if (!scored.length || scored[0].score <= 0) return null;
  return { id: scored[0].folder.getId(), name: scored[0].folder.getName() };
}

function _Azukari_collectFolders(startId, maxDepth, skipId) {
  const out = [];
  let level = [{ id: startId, depth: 0 }];
  while (level.length) {
    const next = [];
    level.forEach(function (node) {
      if (node.depth >= maxDepth) return;
      _Azukari_listChildren(node.id).forEach(function (folder) {
        if (skipId && folder.getId() === skipId) return;
        const item = { folder: folder, parentId: node.id, depth: node.depth + 1 };
        out.push(item);
        next.push({ id: folder.getId(), depth: node.depth + 1 });
      });
    });
    level = next;
  }
  return out;
}

function _Azukari_scoreCandidates(items, workRootId, isWorkScope, nameRegex) {
  const candidates = (items || []).filter(function (item) {
    return nameRegex.test(String(item.folder.getName() || ''));
  }).map(function (item) {
    let score = isWorkScope ? 100 : 0;
    if (isWorkScope && item.depth === 1) score += 20;
    if (/預かり.*素材/.test(String(item.folder.getName() || ''))) score += 10;
    return { folder: item.folder, parentId: item.parentId, depth: item.depth, score: score, workRoot: workRootId };
  });
  if (candidates.length <= 5) {
    candidates.forEach(function (candidate) {
      try { if (candidate.folder.getFiles().hasNext()) candidate.score += 5; } catch (e) {}
    });
  }
  return candidates;
}

function _Azukari_oldestFirst(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  let at = 0, bt = 0;
  try { at = a.folder.getDateCreated().getTime(); } catch (e) {}
  try { bt = b.folder.getDateCreated().getTime(); } catch (e) {}
  return at - bt;
}

/** 「制作」配下を優先して預かり素材フォルダを一意に解決する。 */
function Azukari_resolveFolderId(caseInfo, opts) {
  opts = opts || {};
  if (!caseInfo) return '';
  const cache = CacheService.getScriptCache();
  const cacheKey = 'azukari_' + String(caseInfo.caseId || '');
  if (!opts.noCache && caseInfo.caseId) {
    const hit = cache.get(cacheKey);
    if (hit) return hit;
  }
  const rootId = Case_resolveProjectRoot(caseInfo);
  if (!rootId) return '';
  const foundWorkRoot = Azukari_findWorkRoot(rootId);
  const workRoot = foundWorkRoot || { id: rootId, name: '' };
  const workItems = _Azukari_collectFolders(workRoot.id, 2, '');
  let candidates = _Azukari_scoreCandidates(workItems, workRoot.id, true, /預かり/);
  if (!candidates.length) {
    let rootItems = _Azukari_collectFolders(rootId, 3, workRoot.id !== rootId ? workRoot.id : '');
    if (workRoot.id === rootId) rootItems = rootItems.filter(function (item) { return item.depth > 2; });
    candidates = _Azukari_scoreCandidates(rootItems, workRoot.id, false, /預かり/);
  }
  // 「素材集」等は対象外。最後の手段だけ、workRoot 配下の番号付き「素材」を許容する。
  if (!candidates.length) {
    candidates = _Azukari_scoreCandidates(workItems, workRoot.id, true, /^\d*\s*素材(?:フォルダ)?\s*$/);
  }
  candidates.sort(_Azukari_oldestFirst);
  let folderId = candidates.length ? candidates[0].folder.getId() : '';
  if (!folderId && opts.create) {
    folderId = DriveApp.getFolderById(workRoot.id).createFolder('00預かり素材').getId();
  }
  if (folderId && caseInfo.caseId) cache.put(cacheKey, folderId, 600);
  return folderId;
}

function Azukari_clearCache(caseId) {
  CacheService.getScriptCache().remove('azukari_' + String(caseId || ''));
}

/** 削除せず、誤配置フォルダ直下のファイルだけを正解フォルダへ移す。 */
function Azukari_repairMisplaced(caseId, dryRun) {
  if (dryRun === undefined) dryRun = true;
  const c = CaseList_getById(caseId);
  if (!c) return { ok: false, error: '案件が見つかりません: ' + caseId, misplaced: [], dryRun: Boolean(dryRun) };
  const rootId = Case_resolveProjectRoot(c);
  const canonicalId = Azukari_resolveFolderId(c, { create: false, noCache: true });
  if (!rootId || !canonicalId) return { ok: false, error: '預かり素材フォルダを解決できません', misplaced: [], dryRun: Boolean(dryRun) };
  const work = Azukari_findWorkRoot(rootId) || { id: rootId };
  let all = _Azukari_collectFolders(rootId, 1, '').concat(_Azukari_collectFolders(work.id, 3, ''));
  const seen = {};
  all = all.filter(function (item) {
    const id = item.folder.getId();
    if (seen[id] || id === canonicalId || !/預かり/.test(String(item.folder.getName() || ''))) return false;
    seen[id] = true;
    return true;
  });
  const canonical = DriveApp.getFolderById(canonicalId);
  const existingNames = {};
  const existing = canonical.getFiles();
  while (existing.hasNext()) existingNames[existing.next().getName()] = true;
  const misplaced = all.map(function (item) {
    const moved = [], skipped = [];
    const files = item.folder.getFiles();
    while (files.hasNext()) {
      const file = files.next();
      const name = file.getName();
      if (existingNames[name]) {
        skipped.push(name);
      } else {
        moved.push(name);
        if (!dryRun) {
          canonical.addFile(file);
          item.folder.removeFile(file);
        }
        existingNames[name] = true;
      }
    }
    return { id: item.folder.getId(), name: item.folder.getName(), url: item.folder.getUrl(), moved: moved, skipped: skipped };
  });
  Azukari_clearCache(caseId);
  return {
    ok: true,
    canonical: { id: canonicalId, name: canonical.getName(), url: canonical.getUrl() },
    misplaced: misplaced,
    dryRun: Boolean(dryRun)
  };
}

/**
 * ファイル配列の「同名系重複の排除 + 更新日時の新しい順ソート」。
 * 重複キー: 拡張子/「のコピー」/末尾「(n)」/空白 を除いた正規化名。
 * 同じ正規化名が複数ある場合は lastUpdated が最新の1件だけ残す。
 * @param {Array<{label:string, lastUpdated:number}>} files
 */
function Case_dedupeNewestFiles(files) {
  const byKey = {};
  (files || []).forEach(function (f) {
    const key = String(f.label || '').normalize('NFC')
      .toLowerCase()
      .replace(/\.[a-z0-9]{2,5}$/i, '')      // 拡張子
      .replace(/のコピー| - コピー|copy of /gi, '')
      .replace(/\s*\(\d+\)\s*$/, '')          // 末尾 (1) (2)
      .replace(/[\s　]+/g, '');
    const prev = byKey[key];
    if (!prev || (f.lastUpdated || 0) > (prev.lastUpdated || 0)) byKey[key] = f;
  });
  const out = Object.keys(byKey).map(function (k) { return byKey[k]; });
  out.sort(function (a, b) { return (b.lastUpdated || 0) - (a.lastUpdated || 0); });
  return out;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    Case_resolveProjectRoot: Case_resolveProjectRoot,
    Case_dedupeNewestFiles: Case_dedupeNewestFiles,
    AZUKARI_WORKROOT_MARKERS: AZUKARI_WORKROOT_MARKERS,
    Azukari_findWorkRoot: Azukari_findWorkRoot,
    Azukari_resolveFolderId: Azukari_resolveFolderId,
    Azukari_clearCache: Azukari_clearCache,
    Azukari_repairMisplaced: Azukari_repairMisplaced
  };
}
