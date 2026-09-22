/** 当日スタッフ用チェックリストのデータ層と Web アプリ API（2026-09-07）。 */

var CHECKLIST_TEMPLATE_SHEET = "Checklist_Templates";
var CHECKLIST_PROGRESS_SHEET = "Checklist_Progress";
var CHECKLIST_RUSH_SHEET = "Checklist_Rush";
var CHECKLIST_RUSH_HEADERS = [
  "id", "timestamp", "caseId", "caseName", "staffName", "role", "itemName", "quantity",
  "neededTime", "destination", "notes", "photoUrl", "status", "discordPosted", "updatedAt", "updatedBy",
  "discordMessageId", "editLog",
];
var CHECKLIST_RUSH_STATUSES = ["new", "対応中", "出荷済", "到着", "取消"];
var CHECKLIST_DAYS = ["設営前日", "設営初日", "設営二日目", "本番日", "撤収日"];
var CHECKLIST_VEHICLES = ["デュトロ", "キャラバン", "その他"];
var CHECKLIST_ROOT_FOLDER_ID = "1Yt1E9En7K8tMVONET32KgHkMWR4jWT8t";
var CHECKLIST_TEMPLATE_HEADERS = [
  "id",
  "role",
  "day",
  "order",
  "title",
  "detail",
  "type",
  "url",
  "required",
  "active",
  "updatedAt",
];
var CHECKLIST_PROGRESS_HEADERS = [
  "ts",
  "caseId",
  "caseLabel",
  "staffName",
  "role",
  "day",
  "vehicle",
  "templateId",
  "title",
  "status",
  "photoUrls",
  "note",
];

/** シート行をチェックリスト項目へ変換する。 */
function Checklist_rowToItem(row) {
  var r = row || [];
  return {
    id: String(r[0] || ""),
    role: String(r[1] || ""),
    day: String(r[2] || ""),
    order: Number(r[3]) || 0,
    title: String(r[4] || ""),
    detail: String(r[5] || ""),
    type: String(r[6] || "check"),
    url: String(r[7] || ""),
    required: r[8] === true || String(r[8]).toUpperCase() === "TRUE",
    active: r[9] === true || String(r[9]).toUpperCase() === "TRUE",
    updatedAt: r[10] instanceof Date ? r[10].toISOString() : String(r[10] || ""), // google.script.run は Date を返せない
  };
}
/** チェックリスト項目をシート行へ変換する。 */
function Checklist_itemToRow(item) {
  var i = item || {};
  return [
    String(i.id || ""),
    String(i.role || ""),
    String(i.day || ""),
    Number(i.order) || 0,
    String(i.title || ""),
    String(i.detail || ""),
    String(i.type || "check"),
    String(i.url || ""),
    Boolean(i.required),
    i.active !== false,
    i.updatedAt || "",
  ];
}
/** 項目を表示順と ID の順で安定ソートする。 */
function Checklist_sortItems(items) {
  return (items || []).slice().sort(function (a, b) {
    return (
      (Number(a.order) || 0) - (Number(b.order) || 0) ||
      String(a.id).localeCompare(String(b.id))
    );
  });
}
/** 役割を固定優先順、そのほかは初出順に並べる。 */
function Checklist_orderRoles(roles) {
  var priority = ["プロデューサー", "ディレクター", "ドライバー", "スタッフ"];
  var unique = [];
  (roles || []).forEach(function (role) {
    var value = String(role || "");
    if (value && unique.indexOf(value) < 0) unique.push(value);
  });
  return priority.filter(function (role) {
    return unique.indexOf(role) >= 0;
  }).concat(unique.filter(function (role) {
    return priority.indexOf(role) < 0;
  }));
}
/** seed にだけ存在するテンプレート行を返す。 */
function Checklist_diffSeed(existingItems, seedRows) {
  function titleKey(value) {
    return String(value || "").normalize("NFKC").trim();
  }
  function key(role, day, title) {
    return [String(role || ""), String(day || ""), titleKey(title)].join("\n");
  }
  var registered = {};
  (existingItems || []).forEach(function (item) {
    var row = Array.isArray(item) ? item : null;
    registered[key(row ? row[1] : item.role, row ? row[2] : item.day, row ? row[4] : item.title)] = true;
  });
  return (seedRows || []).filter(function (row) {
    var seedKey = key(row[0], row[1], row[3]);
    if (registered[seedKey]) return false;
    registered[seedKey] = true;
    return true;
  });
}
/** 車両マニュアル設定から対象 URL 一覧を解決する。 */
function Checklist_resolveVehicleUrls(urlJson, vehicle) {
  var map = {};
  try {
    map =
      typeof urlJson === "string" ? JSON.parse(urlJson || "{}") : urlJson || {};
  } catch (e) {
    map = {};
  }
  if (vehicle && map[vehicle])
    return [{ label: vehicle, url: String(map[vehicle]) }];
  return Object.keys(map).map(function (k) {
    return { label: k, url: String(map[k]) };
  });
}
/** 有効項目の完了数と必須未完了数を集計する。 */
function Checklist_progressSummary(items, progressRows) {
  var active = (items || []).filter(function (i) {
    return i.active !== false;
  });
  var latest = {};
  (progressRows || []).forEach(function (r) {
    var p = Array.isArray(r)
      ? { templateId: r[7], status: r[9], photoUrls: r[10] }
      : r;
    latest[String(p.templateId || "")] = p;
  });
  var done = active.filter(function (i) {
    return latest[i.id] && latest[i.id].status === "done";
  }).length;
  return {
    total: active.length,
    done: done,
    undone: active.length - done,
    requiredUndone: active.filter(function (i) {
      return i.required && !(latest[i.id] && latest[i.id].status === "done");
    }).length,
  };
}
/** Script Properties と fallback から Web アプリの基底 URL を解決する。 */
function Checklist_resolveBaseUrl(props, fallbackUrl) {
  /** URL のクエリを除き、デプロイ URL は /exec までに揃える。 */
  function normalize(url) {
    var clean = String(url || "")
      .trim()
      .split("?")[0];
    var execEnd = clean.indexOf("/exec");
    return execEnd >= 0 ? clean.slice(0, execEnd + 5) : clean;
  }
  var values = props || {};
  var configured = normalize(values.CHECKLIST_WEBAPP_URL);
  if (configured) return configured;
  var feedback = normalize(values.FEEDBACK_FORM_URL);
  if (feedback) return feedback;
  return normalize(fallbackUrl);
}
/** アイテムリストの見出し比較用に表記揺れを除く。 */
function _Checklist_itemNorm(value) {
  return String(value == null ? "" : value).normalize("NFKC").toLowerCase().replace(/[\s　]+/g, "");
}
/** シート値を google.script.run で返せる値へ揃える。 */
function _Checklist_itemValue(value) {
  if (/^#(?:REF!|N\/A)$/.test(String(value == null ? "" : value).trim())) return "";
  if (typeof value === "number") return value;
  if (value instanceof Date) return value.toISOString();
  return String(value == null ? "" : value);
}
/** 実施計画のアイテムリスト配列から見出しと明細を抽出する。 */
function Checklist_parseItemList(values) {
  var rows = Array.isArray(values) ? values : [];
  var limit = Math.min(10, rows.length);
  var headerRow = -1;
  var fallbackRow = -1;
  for (var r = 0; r < limit; r++) {
    var cells = (rows[r] || []).map(_Checklist_itemNorm);
    var hasName = cells.some(function (v) { return /(アイテム|品名|品目)/.test(v); });
    var hasQty = cells.some(function (v) { return /(数量|必要数|在庫数)/.test(v); });
    var hasBox = cells.some(function (v) { return /(ボックス|ボッス|箱)/.test(v); });
    if (hasName && hasQty && fallbackRow < 0) fallbackRow = r;
    if (hasName && hasQty && hasBox) { headerRow = r; break; }
  }
  if (headerRow < 0) headerRow = fallbackRow;
  var keys = ["name", "code", "location", "category", "siteQty", "shipReqQty", "arrivedQty", "assembled", "owner", "tracking", "box", "boxType", "status", "note", "note2"];
  var header = {};
  keys.forEach(function (key) { header[key] = -1; });
  if (headerRow < 0) return { header: header, items: [] };
  var normalized = (rows[headerRow] || []).map(_Checklist_itemNorm);
  function find(test) {
    for (var i = 0; i < normalized.length; i++) if (test(normalized[i])) return i;
    return -1;
  }
  header.name = find(function (v) { return !/(重要アイテム|アイテムリスト)/.test(v) && /(アイテム名|アイテム|品名|品目)/.test(v); });
  header.code = find(function (v) { return /(備品コード|コード)/.test(v); });
  header.location = find(function (v) { return v.indexOf("場所") >= 0; });
  header.category = find(function (v) { return /(大項目|カテゴリ|オリコン色分け)/.test(v); });
  header.siteQty = find(function (v) { return /(現場必要数|必要数)/.test(v); });
  if (header.siteQty < 0) header.siteQty = find(function (v) { return v.indexOf("数量") >= 0 && !/(本番後|最終倉庫|在庫|出荷|到着|準備完了)/.test(v); });
  header.shipReqQty = find(function (v) { return /(倉庫出荷依頼数|出荷依頼)/.test(v); });
  header.arrivedQty = find(function (v) { return /(現場到着数|到着数)/.test(v); });
  header.assembled = find(function (v) { return /(組み立て確認|組立確認|組み立て)/.test(v); });
  header.owner = find(function (v) { return /(手配担当|購入.*手配.*準備|担当者|担当)/.test(v); });
  header.tracking = find(function (v) { return /(発送時問い合わせ番号|問合せ番号|問い合わせ番号|追跡番号|荷物問合せ)/.test(v); });
  header.boxType = find(function (v) { return /(箱種類|箱の種類)/.test(v); });
  header.box = find(function (v) { return /(ボックス番号|ボックス|箱番)/.test(v) && !/(箱種類|箱の種類)/.test(v); });
  header.status = find(function (v) { return /(ステータス|状態)/.test(v); });
  header.note2 = find(function (v) { return /備考(2|２)/.test(v); });
  header.note = find(function (v) { return v.indexOf("備考") >= 0 && !/備考(2|２)/.test(v); });
  var itemKeys = ["name", "code", "location", "category", "siteQty", "shipReqQty", "arrivedQty", "owner", "tracking", "box", "boxType", "status", "note", "note2"];
  var items = [];
  for (var rowIndex = headerRow + 1; rowIndex < rows.length; rowIndex++) {
    var source = rows[rowIndex] || [];
    var name = header.name >= 0 ? String(_Checklist_itemValue(source[header.name])).trim() : "";
    if (!name) continue;
    var item = { row: rowIndex + 1 };
    itemKeys.forEach(function (key) {
      item[key] = header[key] >= 0 ? _Checklist_itemValue(source[header[key]]) : "";
    });
    item.assembled = header.assembled < 0 ? null : /^(true|○|✓|1)$/i.test(String(_Checklist_itemValue(source[header.assembled])).trim());
    items.push(item);
  }
  return { header: header, items: items };
}
/** アイテム名などを部分一致検索し、一致の強い順で最大30件返す。 */
function Checklist_filterItems(items, query) {
  var q = _Checklist_itemNorm(query);
  if (!q) return [];
  return (items || []).map(function (item, index) {
    var name = _Checklist_itemNorm(item.name);
    var fields = [name, _Checklist_itemNorm(item.code), _Checklist_itemNorm(item.box), _Checklist_itemNorm(item.note), _Checklist_itemNorm(item.note2), _Checklist_itemNorm(item.location)];
    if (!fields.some(function (v) { return v.indexOf(q) >= 0; })) return null;
    return { item: item, index: index, rank: name === q ? 0 : name.indexOf(q) === 0 ? 1 : 2 };
  }).filter(function (x) { return x; }).sort(function (a, b) {
    return a.rank - b.rank || a.index - b.index;
  }).slice(0, 30).map(function (x) { return x.item; });
}
/** 案件情報と成果物一覧から、スタッフ画面用の資料リンクを組み立てる。 */
function Checklist_buildCaseLinks(caseInfo, artifacts, role) {
  var c = caseInfo || {};
  var links = [];
  function add(label, url, group) {
    var value = String(url || "").trim();
    if (!/^https?:/i.test(value)) return;
    links.push({ label: label, url: value, group: group });
  }
  function norm(value) {
    return String(value || "").normalize("NFKC").replace(/[\s　]+/g, "");
  }
  function timestamp(value) {
    var time = new Date(String(value || "")).getTime();
    return isNaN(time) ? 0 : time;
  }
  function latestArtifact(match, preferSlides) {
    var candidates = (artifacts || []).filter(function (artifact) {
      var type = norm(artifact && artifact.type);
      return String(match).split("|").some(function (part) { return type.indexOf(part) >= 0; });
    });
    if (preferSlides) {
      var slides = candidates.filter(function (artifact) {
        return norm(artifact && artifact.type).indexOf("(スライド版)") >= 0;
      });
      if (slides.length) candidates = slides;
    }
    candidates.sort(function (a, b) {
      return timestamp(b && b.createdAt) - timestamp(a && a.createdAt);
    });
    return candidates[0] || null;
  }
  function addArtifact(label, match, group, preferSlides, reject) {
    var artifact = latestArtifact(match, preferSlides);
    if (reject) {
      var candidates = (artifacts || []).filter(function (item) {
        return norm(item && item.type).indexOf(match) >= 0 && !reject(norm(item && item.type));
      }).sort(function (a, b) {
        return timestamp(b && b.createdAt) - timestamp(a && a.createdAt);
      });
      artifact = candidates[0] || null;
    }
    if (artifact) add(label, artifact.url, group);
  }

  if (c.zissiId) {
    var zissiUrl = "https:" + String.fromCharCode(47, 47) + "docs.google.com/spreadsheets/d/" + c.zissiId + "/edit";
    add("📘 実施計画書", zissiUrl, "plan");
    if (c.itemListGid !== undefined && c.itemListGid !== null && String(c.itemListGid) !== "") {
      add("📦 アイテムリスト", zissiUrl + "?gid=" + c.itemListGid + "#gid=" + c.itemListGid, "plan");
    }
  }
  var folderId = c.projectFolderId || c.folderId;
  if (folderId) add("🗂 案件フォルダ", "https:" + String.fromCharCode(47, 47) + "drive.google.com/drive/folders/" + folderId, "plan");

  [
    ["🛠 施工手順書", "施工手順", true],
    ["🚚 搬入出計画", "搬入出", true],
    ["🎯 運営計画", "運営計画|設営撤去手順", true],
    ["🗺 レイアウトシート", "レイアウトシート", true],
    ["📅 スケジュール", "スケジュール", true],
    ["🖨 印刷物チェック", "印刷物", true],
    ["📝 提出書類チェックリスト", "提出書類", true],
    ["🧭 タスク台帳", "タスク台帳", true],
  ].forEach(function (spec) {
    addArtifact(spec[0], spec[1], "doc", spec[2]);
  });
  if (role === "プロデューサー") {
    var estimateArtifact = latestArtifact("見積", false);
    if (estimateArtifact && norm(estimateArtifact.type).indexOf("最終") >= 0) {
      var regularEstimates = (artifacts || []).filter(function (item) {
        var type = norm(item && item.type);
        return type.indexOf("見積") >= 0 && type.indexOf("最終") < 0;
      }).sort(function (a, b) {
        return timestamp(b && b.createdAt) - timestamp(a && a.createdAt);
      });
      estimateArtifact = regularEstimates[0] || null;
    }
    if (estimateArtifact) {
      add("💴 見積", estimateArtifact.url, "money");
    } else if (c.estimateFileUrl) {
      add("💴 見積（" + String(c.estimateFileName || "").slice(0, 20) + "）", c.estimateFileUrl, "money");
    }
    addArtifact("💴 最終見積", "最終見積", "money", false);
    add("📁 見積りフォルダ", c.estimateFolderUrl, "money");
  }
  return links;
}

/** 作業ルート配下（深さ2まで）の見積フォルダと最新ファイルを解決する。 */
function _Checklist_resolveEstimateLinks(rootId) {
  var result = { estimateFolderUrl: "", estimateFileUrl: "", estimateFileName: "" };
  try {
    if (!rootId) return result;
    var work = Azukari_findWorkRoot(rootId);
    var startId = work && work.id ? work.id : rootId;
    var folders = [];
    var level = [DriveApp.getFolderById(startId)];
    for (var depth = 0; depth < 2 && level.length; depth++) {
      var next = [];
      level.forEach(function (parent) {
        var children = parent.getFolders();
        while (children.hasNext()) {
          var child = children.next();
          folders.push({ folder: child, depth: depth + 1 });
          next.push(child);
        }
      });
      level = next;
    }
    var matches = folders.filter(function (item) {
      return String(item.folder.getName() || "").normalize("NFKC").indexOf("見積") >= 0;
    }).sort(function (a, b) { return a.depth - b.depth; });
    var allowed = {
      "application/vnd.google-apps.spreadsheet": true,
      "application/pdf": true,
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": true,
      "application/vnd.ms-excel": true,
    };
    var latest = null;
    /** フォルダ直下のファイルから最新の見積候補を選ぶ。nameFilter=true なら名前に「見積」を含むものだけ。 */
    function pickLatest(folder, nameFilter) {
      var files = folder.getFiles();
      while (files.hasNext()) {
        var file = files.next();
        if (!allowed[String(file.getMimeType() || "")]) continue;
        if (nameFilter && String(file.getName() || "").normalize("NFKC").indexOf("見積") < 0) continue;
        if (!latest || file.getLastUpdated().getTime() > latest.getLastUpdated().getTime()) latest = file;
      }
    }
    if (matches.length) {
      var folder = matches[0].folder;
      result.estimateFolderUrl = "https:" + String.fromCharCode(47, 7 * 0 + 47) + "drive.google.com/drive/folders/" + folder.getId();
      pickLatest(folder, false);
    }
    // 「見積り」フォルダが無い案件（例: ファインスチール C0041）は「御見積書 …」が案件フォルダ直下にある
    if (!latest) {
      pickLatest(DriveApp.getFolderById(rootId), true);
      if (!latest && startId !== rootId) pickLatest(DriveApp.getFolderById(startId), true);
    }
    if (latest) {
      result.estimateFileUrl = latest.getUrl();
      result.estimateFileName = latest.getName();
    }
  } catch (e) { /* Drive 解決失敗時は見積リンクなしで継続する */ }
  return result;
}
/** 案件の資料リンクを10分キャッシュして返す。 */
function Checklist_getCaseLinks(caseId, role, refresh) {
  return _Checklist_result(function () {
    var id = String(caseId || "");
    var cache = CacheService.getScriptCache();
    var cacheKey = "cklinks_" + id;
    var allLinks = null;
    var cached = refresh === true || refresh === "true" ? null : cache.get(cacheKey);
    if (cached) {
      try { allLinks = JSON.parse(cached); } catch (e) { cache.remove(cacheKey); }
    }
    if (!allLinks) {
      var c = CaseList_getById(id);
      if (!c) throw new Error("案件が見つかりません");
      var itemListGid = "";
      if (c.zissiId) {
        var itemSheet = Zissi_findItemListSheet(SpreadsheetApp.openById(c.zissiId));
        if (itemSheet) itemListGid = itemSheet.getSheetId();
      }
      var projectRoot = "";
      var estimateLinks = { estimateFolderUrl: "", estimateFileUrl: "", estimateFileName: "" };
      try {
        projectRoot = Case_resolveProjectRoot(c);
        estimateLinks = _Checklist_resolveEstimateLinks(projectRoot);
      } catch (e) { /* 従来リンクを維持する */ }
      allLinks = Checklist_buildCaseLinks({
        zissiId: c.zissiId,
        itemListGid: itemListGid,
        projectFolderId: projectRoot || c.projectFolderId,
        folderId: c.folderId,
        estimateFolderUrl: estimateLinks.estimateFolderUrl,
        estimateFileUrl: estimateLinks.estimateFileUrl,
        estimateFileName: estimateLinks.estimateFileName,
      }, MasterWriteBack_listArtifacts(id), "プロデューサー");
      cache.put(cacheKey, JSON.stringify(allLinks), 600);
    }
    return {
      ok: true,
      caseId: id,
      links: allLinks.filter(function (link) {
        return role === "プロデューサー" || link.group !== "money";
      }),
    };
  });
}
/** 案件に紐づく実施計画からアイテムリスト全件を返す。 */
function Checklist_getItemList(caseId, refresh) {
  var id = String(caseId || "");
  var cache = CacheService.getScriptCache();
  var cacheKey = "ckitems_" + id;
  if (!refresh) {
    var cached = cache.get(cacheKey);
    if (cached) {
      try { return JSON.parse(cached); } catch (e) { cache.remove(cacheKey); }
    }
  }
  var c = CaseList_getById(id);
  if (!c || !c.zissiId) return { ok: false, error: "この案件には実施計画書（アイテムリスト）が紐づいていません" };
  var ss = SpreadsheetApp.openById(c.zissiId);
  var sheet = Zissi_findItemListSheet(ss);
  if (!sheet) return { ok: false, error: "実施計画書にアイテムリストのシートがありません" };
  var values = sheet.getDataRange().getValues();
  var parsed = Checklist_parseItemList(values);
  var result = {
    ok: true,
    caseId: id,
    sheetName: sheet.getName(),
    total: parsed.items.length,
    items: parsed.items,
    fetchedAt: new Date().toISOString(),
  };
  var json = JSON.stringify(result);
  if (Utilities.newBlob(json).getBytes().length <= 100 * 1024) cache.put(cacheKey, json, 600);
  return result;
}
/** API 例外を共通の結果オブジェクトへ変換する。 */
function _Checklist_result(fn) {
  try {
    return fn();
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}
/** 指定名の管理シートを取得し、無ければ初期化して作成する。 */
function _Checklist_sheet(name, headers) {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, headers.length)
      .setValues([headers])
      .setFontWeight("bold")
      .setBackground("#37474f")
      .setFontColor("#ffffff");
    sh.setFrozenRows(1);
  }
  return sh;
}
/** テンプレートが空の場合だけ既定項目を投入する。 */
function Checklist_seedIfEmpty() {
  return _Checklist_result(function () {
    var sh = _Checklist_sheet(
      CHECKLIST_TEMPLATE_SHEET,
      CHECKLIST_TEMPLATE_HEADERS,
    );
    if (sh.getLastRow() > 1) return { ok: true, seeded: 0 };
    var now = new Date();
    var rows = ChecklistSeed_defaultTemplates().map(function (r, i) {
      return ["tpl_" + now.getTime() + "_" + (i + 1)].concat(r).concat([now]);
    });
    sh.getRange(2, 1, rows.length, CHECKLIST_TEMPLATE_HEADERS.length).setValues(
      rows,
    );
    return { ok: true, seeded: rows.length };
  });
}
/** 既存テンプレートを保持したまま未登録の seed 行だけ追記する。 */
function Checklist_seedMerge() {
  return _Checklist_result(function () {
    var sh = _Checklist_sheet(
      CHECKLIST_TEMPLATE_SHEET,
      CHECKLIST_TEMPLATE_HEADERS,
    );
    var existing = sh.getLastRow() > 1
      ? sh.getRange(2, 1, sh.getLastRow() - 1, CHECKLIST_TEMPLATE_HEADERS.length).getValues()
      : [];
    var seedRows = ChecklistSeed_defaultTemplates();
    var additions = Checklist_diffSeed(existing, seedRows);
    if (additions.length) {
      var now = new Date();
      var rows = additions.map(function (row, i) {
        return ["tpl_" + now.getTime() + "_" + (i + 1)].concat(row).concat([now]);
      });
      sh.getRange(sh.getLastRow() + 1, 1, rows.length, CHECKLIST_TEMPLATE_HEADERS.length).setValues(rows);
    }
    return { ok: true, added: additions.length, skipped: seedRows.length - additions.length };
  });
}
/** 全テンプレート項目を読み込む。 */
function _Checklist_allItems() {
  Checklist_seedIfEmpty();
  var sh = _Checklist_sheet(
    CHECKLIST_TEMPLATE_SHEET,
    CHECKLIST_TEMPLATE_HEADERS,
  );
  if (sh.getLastRow() < 2) return [];
  return sh
    .getRange(2, 1, sh.getLastRow() - 1, CHECKLIST_TEMPLATE_HEADERS.length)
    .getValues()
    .map(Checklist_rowToItem);
}
/** シート由来の日付値を Date へ安全に変換する。 */
function _Checklist_date(value) {
  var d =
    value instanceof Date
      ? value
      : new Date(String(value || "").replace(/\//g, "-"));
  return isNaN(d.getTime()) ? null : d;
}
/** 案件一覧から「テスト/削除済みでない」かつ「終了30日以内 or 終了日未確定」の案件だけをプルダウン用に絞る。 */
function Checklist_filterActiveCases(cases, now) {
  var cutoff = now instanceof Date ? new Date(now) : new Date();
  cutoff.setDate(cutoff.getDate() - 30);
  return (cases || [])
    .filter(function (c) {
      var name = String((c && c.clientName) || "") + " " + String((c && c.caseName) || "");
      if (/(?:テスト|TEST|__DELETED)/i.test(name)) return false;
      var end = _Checklist_date(c && c.endDate);
      return !end || end >= cutoff;
    })
    .map(function (c) {
      return { caseId: c.caseId, label: c.clientName + " / " + c.caseName };
    });
}
/** スタッフ画面の初期選択肢を返す。 */
function Checklist_bootstrap() {
  return _Checklist_result(function () {
    Checklist_seedIfEmpty();
    _Checklist_sheet(CHECKLIST_PROGRESS_SHEET, CHECKLIST_PROGRESS_HEADERS);
    var roles = [];
    _Checklist_allItems().forEach(function (i) {
      if (i.role && roles.indexOf(i.role) < 0) roles.push(i.role);
    });
    var cases = [];
    try {
      cases = Checklist_filterActiveCases(CaseList_listAll(), new Date());
    } catch (e) {
      cases = [];
    }
    return {
      ok: true,
      roles: Checklist_orderRoles(roles),
      days: CHECKLIST_DAYS.slice(),
      cases: cases,
      vehicles: CHECKLIST_VEHICLES.slice(),
    };
  });
}
/** 指定した役割・日程の有効項目を返す。 */
function Checklist_getItems(role, day) {
  return _Checklist_result(function () {
    return {
      ok: true,
      items: Checklist_sortItems(
        _Checklist_allItems().filter(function (i) {
          return (
            i.active &&
            i.role === String(role || "") &&
            i.day === String(day || "")
          );
        }),
      ),
    };
  });
}
/** 案件別または共通の写真保存フォルダを取得する。 */
function _Checklist_photoFolder(caseId) {
  var parent = null;
  if (caseId)
    try {
      var c = CaseList_getById(caseId);
      var root = Case_resolveProjectRoot(c);
      if (root) {
        var work = Azukari_findWorkRoot(root);
        parent = DriveApp.getFolderById(work ? work.id : root);
      }
    } catch (e) {
      parent = null;
    }
  if (!parent) {
    parent = DriveApp.getFolderById(CHECKLIST_ROOT_FOLDER_ID);
    var fallback = parent.getFoldersByName("チェックリスト写真");
    parent = fallback.hasNext()
      ? fallback.next()
      : parent.createFolder("チェックリスト写真");
    return parent;
  }
  var it = parent.getFoldersByName("当日写真");
  return it.hasNext() ? it.next() : parent.createFolder("当日写真");
}
/** Drive ファイル名に使える短い文字列へ正規化する。 */
function _Checklist_safeName(v) {
  return String(v || "")
    .replace(/[\\/:*?"<>|\r\n]/g, "_")
    .slice(0, 40);
}
/** 1項目の進捗と添付写真を保存する。 */
function Checklist_saveProgress(payload) {
  return _Checklist_result(function () {
    var p = payload || {};
    if (!p.staffName || !p.role || !p.day || !p.templateId)
      throw new Error("氏名・役割・日程・項目は必須です");
    var urls = [];
    var decoded = _FeedbackRelay_decodeImages(p.images || []);
    if (decoded.length) {
      var folder = _Checklist_photoFolder(String(p.caseId || ""));
      var stamp = Utilities.formatDate(
        new Date(),
        "Asia/Tokyo",
        "yyyyMMdd_HHmm",
      );
      decoded.forEach(function (x, i) {
        var name =
          stamp +
          "_" +
          _Checklist_safeName(p.day) +
          "_" +
          _Checklist_safeName(p.role) +
          "_" +
          _Checklist_safeName(p.staffName) +
          "_" +
          (i + 1) +
          ".jpg";
        urls.push(folder.createFile(x.blob.copyBlob().setName(name)).getUrl());
      });
    }
    var sh = _Checklist_sheet(
        CHECKLIST_PROGRESS_SHEET,
        CHECKLIST_PROGRESS_HEADERS,
      ),
      values =
        sh.getLastRow() > 1
          ? sh
              .getRange(
                2,
                1,
                sh.getLastRow() - 1,
                CHECKLIST_PROGRESS_HEADERS.length,
              )
              .getValues()
          : [];
    var row = 0;
    for (var i = values.length - 1; i >= 0; i--)
      if (
        String(values[i][1]) === String(p.caseId || "") &&
        String(values[i][3]) === String(p.staffName) &&
        String(values[i][4]) === String(p.role) &&
        String(values[i][5]) === String(p.day) &&
        String(values[i][7]) === String(p.templateId)
      ) {
        row = i + 2;
        if (!urls.length)
          urls = String(values[i][10] || "")
            .split("\n")
            .filter(Boolean);
        break;
      }
    var out = [
      new Date(),
      String(p.caseId || ""),
      String(p.caseLabel || ""),
      String(p.staffName),
      String(p.role),
      String(p.day),
      String(p.vehicle || ""),
      String(p.templateId),
      String(p.title || ""),
      p.status === "done" ? "done" : "undone",
      urls.join("\n"),
      String(p.note || ""),
    ];
    if (row) sh.getRange(row, 1, 1, out.length).setValues([out]);
    else sh.appendRow(out);
    return { ok: true, status: out[9], photoUrls: urls };
  });
}
/** スタッフと日程に対応する保存済み進捗を返す。 */
function Checklist_getProgress(caseId, staffName, role, day) {
  return _Checklist_result(function () {
    var sh = _Checklist_sheet(
      CHECKLIST_PROGRESS_SHEET,
      CHECKLIST_PROGRESS_HEADERS,
    );
    var rows =
      sh.getLastRow() > 1
        ? sh
            .getRange(
              2,
              1,
              sh.getLastRow() - 1,
              CHECKLIST_PROGRESS_HEADERS.length,
            )
            .getValues()
        : [];
    var items = {};
    rows.forEach(function (r) {
      if (
        String(r[1]) === String(caseId || "") &&
        String(r[3]) === String(staffName || "") &&
        String(r[4]) === String(role || "") &&
        String(r[5]) === String(day || "")
      )
        items[String(r[7])] = {
          status: String(r[9]),
          photoUrls: String(r[10] || "")
            .split("\n")
            .filter(Boolean),
          note: String(r[11] || ""),
        };
    });
    return { ok: true, items: items };
  });
}
/** 緊急持ち出し依頼のシート行を API 用オブジェクトへ変換する。 */
function Checklist_rushRowToObject(row) {
  var r = row || [];
  function value(v) { return v instanceof Date ? v.toISOString() : String(v == null ? "" : v); }
  return {
    id: value(r[0]), timestamp: value(r[1]), caseId: value(r[2]), caseName: value(r[3]),
    staffName: value(r[4]), role: value(r[5]), itemName: value(r[6]), quantity: value(r[7]),
    neededTime: value(r[8]), destination: value(r[9]), notes: value(r[10]), photoUrl: value(r[11]),
    status: value(r[12]), discordPosted: r[13] === true || String(r[13]).toUpperCase() === "TRUE",
    updatedAt: value(r[14]), updatedBy: value(r[15]), discordMessageId: value(r[16]), editLog: value(r[17]),
  };
}
/** 既存データを維持したまま、緊急依頼シートの追加ヘッダーを補完する。 */
function _Checklist_rushSheet() {
  var sh = _Checklist_sheet(CHECKLIST_RUSH_SHEET, CHECKLIST_RUSH_HEADERS);
  if (sh.getLastRow() > 0) {
    var current = sh.getRange(1, 1, 1, CHECKLIST_RUSH_HEADERS.length).getValues()[0];
    for (var i = 0; i < CHECKLIST_RUSH_HEADERS.length; i++) {
      if (!String(current[i] || "")) sh.getRange(1, i + 1).setValue(CHECKLIST_RUSH_HEADERS[i]);
    }
  }
  return sh;
}
/** 倉庫への緊急持ち出し依頼を記録し、Discord 通知は best-effort で一度だけ行う。 */
function Checklist_submitRush(payload) {
  return _Checklist_result(function () {
    var p = payload || {};
    if (!p.caseId || !p.staffName || !p.role || !p.itemName || !p.quantity || !p.neededTime || !p.destination)
      throw new Error("案件・氏名・役割・アイテム・数量・必要時刻・届け先は必須です");
    var decoded = p.photoBase64 ? _FeedbackRelay_decodeImages([{ base64: p.photoBase64, mimeType: p.photoMimeType, name: "rush_photo" }]) : [];
    var photoUrl = "";
    if (decoded.length) {
      var photoName = Utilities.formatDate(new Date(), "Asia/Tokyo", "yyyyMMdd_HHmm") + "_緊急_" + _Checklist_safeName(p.itemName);
      photoUrl = _Checklist_photoFolder(String(p.caseId)).createFile(decoded[0].blob.copyBlob().setName(photoName)).getUrl();
    }
    var now = new Date();
    var id = Utilities.getUuid();
    var row = [id, now, String(p.caseId), String(p.caseName || ""), String(p.staffName), String(p.role),
      String(p.itemName), String(p.quantity), String(p.neededTime), String(p.destination), String(p.notes || ""),
      photoUrl, "new", false, now, String(p.staffName), "", ""];
    var sh = _Checklist_rushSheet();
    sh.appendRow(row);
    var rowNumber = sh.getLastRow();
    var saved = sh.getRange(rowNumber, 1, 1, CHECKLIST_RUSH_HEADERS.length).getValues()[0];
    if (String(saved[0]) !== id || String(saved[2]) !== String(p.caseId) || String(saved[6]) !== String(p.itemName) || String(saved[12]) !== "new")
      throw new Error("緊急依頼の保存確認に失敗しました");
    try {
      var config = _FeedbackRelay_config();
      var channelId = String(PropertiesService.getScriptProperties().getProperty("DISCORD_WAREHOUSE_CHANNEL_ID") || "1383253163729223872");
      var content = ["🚨 【緊急持ち出し依頼】" + String(p.caseName || ""), "依頼者: " + p.staffName + "（" + p.role + "）",
        "アイテム: " + p.itemName + " × " + p.quantity, "必要時刻: " + p.neededTime,
        "届け先: " + p.destination, "備考: " + String(p.notes || "")].join("\n");
      var postResult = config.botToken && channelId ? _FeedbackRelay_postToChannel(config.botToken, channelId, content, decoded.map(function (x) { return x.blob; })) : { ok: false, messageId: "" };
      if (postResult.ok) {
        sh.getRange(rowNumber, 14).setValue(true);
        sh.getRange(rowNumber, 17).setValue(postResult.messageId || "");
      }
    } catch (notifyError) { /* 記録を本体とし、通知失敗では送信を失敗させない */ }
    return { ok: true, id: id };
  });
}
/** 緊急依頼を新しい順で返す。 */
function Checklist_listRush(caseId) {
  return _Checklist_result(function () {
    var sh = _Checklist_rushSheet();
    var rows = sh.getLastRow() > 1 ? sh.getRange(2, 1, sh.getLastRow() - 1, CHECKLIST_RUSH_HEADERS.length).getValues() : [];
    var id = String(caseId || "");
    return { ok: true, rows: rows.map(Checklist_rushRowToObject).filter(function (r) { return !id || r.caseId === id; }).sort(function (a, b) { return String(b.timestamp).localeCompare(String(a.timestamp)); }) };
  });
}
/** 本人による緊急依頼の内容変更を保存し、Discord の元投稿へ返信する。 */
function Checklist_editRush(id, patch, editedBy) {
  return _Checklist_result(function () {
    var targetId = String(id || "");
    var p = patch || {};
    var sh = _Checklist_rushSheet();
    var count = sh.getLastRow() > 1 ? sh.getLastRow() - 1 : 0;
    var rows = count ? sh.getRange(2, 1, count, CHECKLIST_RUSH_HEADERS.length).getValues() : [];
    for (var i = 0; i < rows.length; i++) if (String(rows[i][0]) === targetId) {
      var current = Checklist_rushRowToObject(rows[i]);
      if (["出荷済", "到着", "取消"].indexOf(current.status) >= 0) return { ok: false, error: "出荷済み・到着済み・取消済みのため編集できません" };
      var fields = [
        ["itemName", 7, "アイテム名", "change"], ["quantity", 8, "数量", "fix"],
        ["neededTime", 9, "必要時刻", "change"], ["destination", 10, "届け先", "quote"], ["notes", 11, "備考", "notes"]
      ];
      var changes = [];
      var expected = {};
      fields.forEach(function (field) {
        var key = field[0];
        if (!Object.prototype.hasOwnProperty.call(p, key)) return;
        var before = String(current[key] || "");
        var after = String(p[key] == null ? "" : p[key]);
        if (before === after) return;
        sh.getRange(i + 2, field[1]).setValue(after);
        expected[key] = after;
        if (field[3] === "notes") changes.push("備考を更新");
        else if (field[3] === "quote") changes.push(field[2] + "を「" + before + "」→「" + after + "」に変更");
        else changes.push(field[2] + "を" + before + "→" + after + (field[3] === "fix" ? "に修正" : "に変更"));
      });
      if (!changes.length) return { ok: false, error: "変更点がありません" };
      var now = new Date();
      var by = String(editedBy || "");
      var logLine = Utilities.formatDate(now, "Asia/Tokyo", "yyyy-MM-dd HH:mm") + " " + changes.join("、") + "（" + by + "）";
      var log = current.editLog ? current.editLog + "\n" + logLine : logLine;
      sh.getRange(i + 2, 15, 1, 2).setValues([[now, by]]);
      sh.getRange(i + 2, 18).setValue(log);
      var saved = Checklist_rushRowToObject(sh.getRange(i + 2, 1, 1, CHECKLIST_RUSH_HEADERS.length).getValues()[0]);
      if (saved.id !== targetId || saved.updatedBy !== by || saved.editLog !== log) throw new Error("緊急依頼の更新確認に失敗しました");
      Object.keys(expected).forEach(function (key) {
        if (saved[key] !== expected[key]) throw new Error("緊急依頼の更新確認に失敗しました");
      });
      try {
        var config = _FeedbackRelay_config();
        var channelId = String(PropertiesService.getScriptProperties().getProperty("DISCORD_WAREHOUSE_CHANNEL_ID") || "1383253163729223872");
        if (config.botToken && channelId) _FeedbackRelay_replyInChannel(config.botToken, channelId, current.discordMessageId, ["✏️【修正】" + current.caseName + " の緊急持ち出し依頼", changes.join("、"), "依頼者: " + by].join("\n"), []);
      } catch (notifyError) { /* 更新を本体とし、通知失敗では処理を失敗させない */ }
      return { ok: true, id: targetId, changes: changes };
    }
    return { ok: false, error: "指定された依頼が見つかりません" };
  });
}
/** 緊急依頼の状態を更新し、取消だけ Discord の元投稿へ返信する。 */
function Checklist_updateRushStatus(id, status, updatedBy) {
  return _Checklist_result(function () {
    var targetId = String(id || "");
    var next = String(status || "");
    if (CHECKLIST_RUSH_STATUSES.indexOf(next) < 0) return { ok: false, error: "不正な status です" };
    var sh = _Checklist_rushSheet();
    var values = sh.getLastRow() > 1 ? sh.getRange(2, 1, sh.getLastRow() - 1, CHECKLIST_RUSH_HEADERS.length).getValues() : [];
    for (var i = 0; i < values.length; i++) if (String(values[i][0]) === targetId) {
      var now = new Date();
      var current = Checklist_rushRowToObject(values[i]);
      var by = String(updatedBy || "");
      sh.getRange(i + 2, 13).setValue(next);
      sh.getRange(i + 2, 15, 1, 2).setValues([[now, by]]);
      if (next === "取消") {
        var logLine = Utilities.formatDate(now, "Asia/Tokyo", "yyyy-MM-dd HH:mm") + " 取消（" + by + "）";
        sh.getRange(i + 2, 18).setValue(current.editLog ? current.editLog + "\n" + logLine : logLine);
        try {
          var config = _FeedbackRelay_config();
          var channelId = String(PropertiesService.getScriptProperties().getProperty("DISCORD_WAREHOUSE_CHANNEL_ID") || "1383253163729223872");
          if (config.botToken && channelId) _FeedbackRelay_replyInChannel(config.botToken, channelId, current.discordMessageId, "❌【取消】" + current.caseName + " の緊急持ち出し依頼は取消になりました\n依頼者: " + by, []);
        } catch (notifyError) { /* 状態更新を本体とし、通知失敗では処理を失敗させない */ }
      }
      return { ok: true, id: targetId, status: next, updatedAt: now.toISOString() };
    }
    return { ok: false, error: "指定された依頼が見つかりません" };
  });
}
/** 管理画面トークンを取得し、未発行なら生成する。 */
function _Checklist_adminToken() {
  var p = PropertiesService.getScriptProperties(),
    t = String(p.getProperty("CHECKLIST_ADMIN_TOKEN") || "");
  if (!t) {
    t = Utilities.getUuid();
    p.setProperty("CHECKLIST_ADMIN_TOKEN", t);
  }
  return t;
}
/** 管理画面トークンが一致するか判定する。 */
function _Checklist_authorized(token) {
  return String(token || "") === _Checklist_adminToken();
}
/** コマンドキュー向けに管理画面トークンを返す。 */
function Checklist_adminTokenInfo() {
  return { ok: true, token: _Checklist_adminToken() };
}
/** 認証後に管理用テンプレート一覧を返す。 */
function Checklist_adminList(token) {
  return _Checklist_result(function () {
    if (!_Checklist_authorized(token))
      return { ok: false, error: "unauthorized" };
    return {
      ok: true,
      items: _Checklist_allItems(),
      days: CHECKLIST_DAYS.slice(),
    };
  });
}
/** 認証後にテンプレート項目を追加または更新する。 */
function Checklist_adminUpsert(token, item) {
  return _Checklist_result(function () {
    if (!_Checklist_authorized(token))
      return { ok: false, error: "unauthorized" };
    var i = item || {},
      sh = _Checklist_sheet(
        CHECKLIST_TEMPLATE_SHEET,
        CHECKLIST_TEMPLATE_HEADERS,
      ),
      values =
        sh.getLastRow() > 1
          ? sh.getRange(2, 1, sh.getLastRow() - 1, 11).getValues()
          : [],
      row = 0;
    for (var x = 0; x < values.length; x++)
      if (String(values[x][0]) === String(i.id || "")) {
        row = x + 2;
        break;
      }
    if (!i.id)
      i.id =
        "tpl_" +
        new Date().getTime() +
        "_" +
        Math.floor(Math.random() * 100000);
    if (!i.role || CHECKLIST_DAYS.indexOf(i.day) < 0 || !i.title)
      throw new Error("役割・日程・項目文は必須です");
    i.updatedAt = new Date();
    var out = Checklist_itemToRow(i);
    if (row) sh.getRange(row, 1, 1, 11).setValues([out]);
    else sh.appendRow(out);
    return { ok: true, item: Checklist_rowToItem(out) };
  });
}
/** 認証後に項目の表示順を更新する。 */
function Checklist_adminReorder(token, ids) {
  return _Checklist_result(function () {
    if (!_Checklist_authorized(token))
      return { ok: false, error: "unauthorized" };
    var order = {};
    (ids || []).forEach(function (id, i) {
      order[String(id)] = i + 1;
    });
    var sh = _Checklist_sheet(
      CHECKLIST_TEMPLATE_SHEET,
      CHECKLIST_TEMPLATE_HEADERS,
    );
    if (sh.getLastRow() > 1) {
      var rows = sh.getRange(2, 1, sh.getLastRow() - 1, 11).getValues();
      rows.forEach(function (r) {
        if (order[String(r[0])]) r[3] = order[String(r[0])];
      });
      sh.getRange(2, 1, rows.length, 11).setValues(rows);
    }
    return { ok: true };
  });
}
/** 認証後に案件別のチェック進捗明細を返す。 */
function Checklist_adminProgressSummary(token, caseId) {
  return _Checklist_result(function () {
    if (!_Checklist_authorized(token))
      return { ok: false, error: "unauthorized" };
    var sh = _Checklist_sheet(
        CHECKLIST_PROGRESS_SHEET,
        CHECKLIST_PROGRESS_HEADERS,
      ),
      raw =
        sh.getLastRow() > 1
          ? sh.getRange(2, 1, sh.getLastRow() - 1, 12).getValues()
          : [];
    raw = raw.filter(function (r) {
      return !caseId || String(r[1]) === String(caseId);
    });
    var people = {},
      saved = {};
    raw.forEach(function (r) {
      var person = [r[1], r[3], r[4], r[5]].join("\n");
      people[person] = {
        caseId: r[1],
        caseLabel: r[2],
        staffName: r[3],
        role: r[4],
        day: r[5],
        vehicle: r[6],
      };
      saved[person + "\n" + r[7]] = r;
    });
    var rows = [];
    Object.keys(people).forEach(function (key) {
      var person = people[key];
      Checklist_sortItems(
        _Checklist_allItems().filter(function (i) {
          return i.active && i.role === person.role && i.day === person.day;
        }),
      ).forEach(function (item) {
        var r = saved[key + "\n" + item.id];
        rows.push({
          caseId: person.caseId,
          caseLabel: person.caseLabel,
          staffName: person.staffName,
          role: person.role,
          day: person.day,
          vehicle: person.vehicle,
          templateId: item.id,
          title: item.title,
          status: r ? String(r[9]) : "undone",
          photoUrls: r
            ? String(r[10] || "")
                .split("\n")
                .filter(Boolean)
            : [],
          note: r ? String(r[11] || "") : "",
        });
      });
    });
    return { ok: true, rows: rows };
  });
}
/** 現在の Script Properties を使って基底 URL を解決する。 */
function _Checklist_baseUrl() {
  var scriptProps = PropertiesService.getScriptProperties();
  return Checklist_resolveBaseUrl(
    {
      CHECKLIST_WEBAPP_URL: scriptProps.getProperty("CHECKLIST_WEBAPP_URL"),
      FEEDBACK_FORM_URL: scriptProps.getProperty("FEEDBACK_FORM_URL"),
    },
    ScriptApp.getService().getUrl(),
  );
}
/** スタッフ画面と管理画面の URL を返す。 */
function Checklist_getUrls() {
  return _Checklist_result(function () {
    var base = _Checklist_baseUrl();
    var seeded = Checklist_seedIfEmpty();
    return {
      ok: true,
      seeded: seeded && seeded.ok ? seeded.seeded : seeded,
      staff: base + "?app=checklist",
      admin:
        base +
        "?app=checklist&admin=" +
        encodeURIComponent(_Checklist_adminToken()),
    };
  });
}
/** 匿名アクセス可能なスタッフ画面を返す。 */
function Checklist_serveStaff(params) {
  Checklist_seedIfEmpty(); // 初回アクセスで既定テンプレを用意する（キュー不要）
  var t = HtmlService.createTemplateFromFile("ui/Checklist");
  var q = params || {};
  t.presetRole = String(q.role || ""); // ?role=ドライバー&day=設営前日 で役割・日程を事前選択（役割別リンク配布用）
  t.presetDay = String(q.day || "");
  var urls = Checklist_getUrls();
  t.adminUrl = urls.ok ? urls.admin : ""; // 画面右下の半透明「管理」リンク（kim 要望 2026-09-07）
  t.feedbackUrl =
    _Checklist_baseUrl() +
    "?form=feedback&app=" +
    encodeURIComponent("当日チェックリスト");
  return t
    .evaluate()
    .setTitle("当日チェックリスト")
    .addMetaTag("viewport", "width=device-width, initial-scale=1");
}
/** 管理トークンを検証して管理画面を返す。 */
function Checklist_serveAdmin(params) {
  var token = String((params || {}).admin || "");
  if (!_Checklist_authorized(token))
    return HtmlService.createHtmlOutput("unauthorized");
  var t = HtmlService.createTemplateFromFile("ui/ChecklistAdmin");
  t.adminToken = token;
  return t
    .evaluate()
    .setTitle("チェックリスト管理")
    .addMetaTag("viewport", "width=device-width, initial-scale=1");
}
/** 実行パネルへ載せるチェックリスト導線を返す。 */
function Checklist_panelLinks() {
  var u = Checklist_getUrls();
  return u.ok
    ? [
        { label: "📋 当日チェックリスト（スタッフ用）", url: u.staff },
        { label: "⚙ チェックリスト管理", url: u.admin },
      ]
    : [];
}

if (typeof module !== "undefined" && module.exports)
  module.exports = {
    Checklist_rowToItem: Checklist_rowToItem,
    Checklist_itemToRow: Checklist_itemToRow,
    Checklist_resolveVehicleUrls: Checklist_resolveVehicleUrls,
    Checklist_sortItems: Checklist_sortItems,
    Checklist_orderRoles: Checklist_orderRoles,
    Checklist_diffSeed: Checklist_diffSeed,
    Checklist_progressSummary: Checklist_progressSummary,
    Checklist_resolveBaseUrl: Checklist_resolveBaseUrl,
    Checklist_parseItemList: Checklist_parseItemList,
    Checklist_filterItems: Checklist_filterItems,
    Checklist_buildCaseLinks: Checklist_buildCaseLinks,
    Checklist_filterActiveCases: Checklist_filterActiveCases,
    Checklist_rushRowToObject: Checklist_rushRowToObject,
  };
