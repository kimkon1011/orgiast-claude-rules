/** 案件情報を施工手順書ジェネレーターへ渡す WebApp API。 */
var CASE_API_TOKEN_DEFAULT = '691b5f21fc97f252672c90c44db69733e3bb221bbcd1273e';

var CASE_API_MASTER_SS_ID = '1t6eMvbPIu17m7hbv6foJcvd-fXrJkZqrePb8P6njxGI';

function _CaseApi_json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function _CaseApi_expectedToken() {
  var configured = String(PropertiesService.getScriptProperties().getProperty('CASE_API_TOKEN') || '');
  return configured && configured.indexOf('__') !== 0 ? configured : CASE_API_TOKEN_DEFAULT;
}

function _CaseApi_norm(value) {
  return String(value || '').normalize('NFKC').toLowerCase()
    .replace(/様$/, '').replace(/[\s　]+/g, '').replace(/＆/g, '&');
}

function _CaseApi_caseCandidates(value) {
  var original = String(value || '');
  var withoutRegion = original.replace(/\s*\/\s*[^/]*[（(][^）)]*[）)]\s*$/, '');
  var normalized = [_CaseApi_norm(original), _CaseApi_norm(withoutRegion)];
  return normalized.filter(function (candidate, index) {
    return candidate && normalized.indexOf(candidate) === index;
  });
}

function _CaseApi_dateParts(value) {
  if (value instanceof Date && !isNaN(value.getTime())) {
    return [{ year: value.getFullYear(), month: value.getMonth() + 1, day: value.getDate() }];
  }
  var text = String(value || '').trim();
  var parts = [];
  var year = 0, month = 0;
  var re = /(\d{4})\s*(?:年|[\/.\-])\s*(\d{1,2})\s*(?:月|[\/.\-])\s*(\d{1,2})\s*日?|(?:^|[^\d])(\d{1,2})\s*(?:月|[\/])\s*(\d{1,2})\s*日?|(?:[~〜～ー–—至-]\s*)(\d{1,2})\s*日?/g;
  var match;
  while ((match = re.exec(text)) !== null) {
    var day = 0;
    if (match[1]) {
      year = Number(match[1]); month = Number(match[2]); day = Number(match[3]);
    } else if (match[4]) {
      month = Number(match[4]); day = Number(match[5]);
    } else if (match[6] && month) {
      day = Number(match[6]);
    }
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      parts.push({ year: year || 0, month: month, day: day });
    }
  }
  return parts;
}

function _CaseApi_targetDates(opts) {
  var options = opts || {};
  return _CaseApi_dateParts(options.startDate).concat(_CaseApi_dateParts(options.endDate));
}

function _CaseApi_chooseMasterMatch(matches, cases, opts) {
  if (!matches.length) return null;
  var longest = -1;
  var winners = [];
  for (var i = 0; i < matches.length; i++) {
    var length = _CaseApi_norm(cases[matches[i]]).length;
    if (length > longest) {
      longest = length;
      winners = [matches[i]];
    } else if (length === longest) {
      winners.push(matches[i]);
    }
  }
  if (winners.length === 1) return { col: winners[0] + 1, source: 'matched' };

  var dateRows = opts && Array.isArray(opts.dateRows) ? opts.dateRows : [];
  var targets = _CaseApi_targetDates(opts);
  if (targets.length && dateRows.length) {
    var dateWinners = winners.filter(function (candidate) {
      var candidateDates = [];
      for (var row = 0; row < dateRows.length; row++) {
        candidateDates = candidateDates.concat(_CaseApi_dateParts(
          Array.isArray(dateRows[row]) ? dateRows[row][candidate] : ''
        ));
      }
      return candidateDates.some(function (candidateDate) {
        return targets.some(function (target) {
          return candidateDate.month === target.month && candidateDate.day === target.day &&
            (!candidateDate.year || !target.year || candidateDate.year === target.year);
        });
      });
    });
    if (dateWinners.length === 1) return { col: dateWinners[0] + 1, source: 'matched' };
  }
  return null;
}

function _CaseApi_validateStoredCol(clients, cases, clientName, caseName, storedCol) {
  var fallback = Number(storedCol) || 0;
  if (fallback <= 0 || fallback % 1 !== 0) return { col: 0, source: 'none' };

  for (var offset = 0; offset <= 2; offset++) {
    var index = fallback - 1 - offset;
    if (index < 0) break;
    var storedClient = String(clients[index] || '');
    if (!storedClient.trim()) continue;
    if (_CaseApi_norm(storedClient) !== _CaseApi_norm(clientName)) return { col: 0, source: 'none' };
    var storedCase = _CaseApi_norm(cases[fallback - 1]);
    var requestedCases = _CaseApi_caseCandidates(caseName);
    var caseMatches = !storedCase || requestedCases.some(function (requestedCase) {
      return storedCase === requestedCase || storedCase.indexOf(requestedCase) === 0 ||
        requestedCase.indexOf(storedCase) === 0;
    });
    return caseMatches ? { col: fallback, source: 'stored' } : { col: 0, source: 'none' };
  }
  return { col: 0, source: 'none' };
}

/**
 * master の案件先頭列を特定する純関数。
 * headerRows は [row1, row2] のゼロ始まり配列で、配列 index 0 がシート列1に対応する。
 * row1=クライアント名、row2=案件名。保存列は一致しない場合だけ後方互換用に使う。
 */
function CaseApi_resolveMasterCol(headerRows, clientName, caseName, storedCol, opts) {
  var rows = Array.isArray(headerRows) ? headerRows : [];
  var clients = Array.isArray(rows[0]) ? rows[0] : [];
  var cases = Array.isArray(rows[1]) ? rows[1] : [];
  var clientN = _CaseApi_norm(clientName);
  var caseNames = _CaseApi_caseCandidates(caseName);
  var width = Math.max(clients.length, cases.length);
  var candidates = [];
  var i;

  if (clientN && caseNames.length) {
    for (i = 0; i < width; i++) {
      if (_CaseApi_norm(clients[i]) === clientN) candidates.push(i);
    }

    var exactMatches = candidates.filter(function (candidate) {
      var masterCaseN = _CaseApi_norm(cases[candidate]);
      return caseNames.indexOf(masterCaseN) >= 0;
    });
    var resolution = _CaseApi_chooseMasterMatch(exactMatches, cases, opts);
    if (resolution) return resolution;

    var prefixMatches = candidates.filter(function (candidate) {
      var masterCaseN = _CaseApi_norm(cases[candidate]);
      return masterCaseN && caseNames.some(function (caseN) {
        return masterCaseN.indexOf(caseN) === 0 || caseN.indexOf(masterCaseN) === 0;
      });
    });
    resolution = _CaseApi_chooseMasterMatch(prefixMatches, cases, opts);
    if (resolution) return resolution;

    var prefixes = caseNames.map(function (caseN) { return caseN.slice(0, 12); });
    var prefix12Matches = candidates.filter(function (candidate) {
      var masterPrefix = _CaseApi_norm(cases[candidate]).slice(0, 12);
      return masterPrefix && prefixes.indexOf(masterPrefix) >= 0;
    });
    resolution = _CaseApi_chooseMasterMatch(prefix12Matches, cases, opts);
    if (resolution) return resolution;
  }

  return _CaseApi_validateStoredCol(clients, cases, clientName, caseName, storedCol);
}

/** GAS の task シートからヘッダを読み、純関数へ渡す薄いラッパ。 */
function CaseApi_resolveMasterColFromSheet(task, clientName, caseName, storedCol, opts) {
  if (!task) return CaseApi_resolveMasterCol([], clientName, caseName, storedCol, opts);
  var lastCol = task.getLastColumn();
  var headers = lastCol > 0 ? task.getRange(1, 1, 5, lastCol).getValues() : [];
  var options = opts || {};
  options.dateRows = [headers[3] || [], headers[4] || []];
  return CaseApi_resolveMasterCol(headers, clientName, caseName, storedCol, options);
}

/**
 * 解決列から右2列までの行3を受け、地域表記ではない最初の非空値を返す。
 * 会場名が無い場合は、最初の地域表記（または最初の非空値）へフォールバックする。
 */
function CaseApi_pickVenue(row3Slice) {
  var values = Array.isArray(row3Slice) ? row3Slice : [];
  var fallback = '';
  for (var i = 0; i < values.length; i++) {
    var value = String(values[i] || '').trim();
    if (!value) continue;
    if (!fallback) fallback = value;
    if (!/^[^（）()]+[（(][^）)]+[）)]$/.test(value)) return value;
  }
  return fallback;
}

function _CaseApi_formatDate(value) {
  return value instanceof Date && !isNaN(value.getTime())
    ? Utilities.formatDate(value, 'Asia/Tokyo', 'yyyy年M月d日')
    : String(value || '').trim();
}

/**
 * 開催日程の末尾にある日付を拾う。年が省略された場合は設営日の年だけを補う。
 * 例: "2026年9月1日〜3日" -> "2026年9月3日"
 */
function _CaseApi_lastDate(value, setupValue) {
  if (value instanceof Date && !isNaN(value.getTime())) return _CaseApi_formatDate(value);
  var text = String(value || '').trim();
  if (!text) return '';

  var setupYear = setupValue instanceof Date ? setupValue.getFullYear() : 0;
  var year = 0, month = 0, day = 0, found = false;
  var re = /(\d{4})\s*(?:年|[\/.\-])\s*(\d{1,2})\s*(?:月|[\/.\-])\s*(\d{1,2})\s*日?|(?:^|[^\d])(\d{1,2})\s*(?:月|[\/])\s*(\d{1,2})\s*日?|(?:[~〜～ー–—至-]\s*)(\d{1,2})\s*日?/g;
  var match;
  while ((match = re.exec(text)) !== null) {
    if (match[1]) {
      year = Number(match[1]); month = Number(match[2]); day = Number(match[3]);
    } else if (match[4]) {
      month = Number(match[4]); day = Number(match[5]);
      if (!year) year = setupYear;
    } else if (match[6] && month) {
      day = Number(match[6]);
    }
    found = true;
  }
  if (!found || !year || !month || !day) return '';
  var date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return '';
  return _CaseApi_formatDate(date);
}

function _CaseApi_dispatch(e) {
  try {
    var params = e && e.parameter ? e.parameter : {};
    if (String(params.form || '') === 'feedback') return FeedbackRelay_serveForm(params);
    if (String(params.app || '') === 'checklist' && params.admin) return Checklist_serveAdmin(params);
    if (String(params.app || '') === 'checklist') return Checklist_serveStaff(params);
    if (String(params.token || '') !== _CaseApi_expectedToken()) {
      return _CaseApi_json({ ok: false, error: 'unauthorized' });
    }

    var action = String(params.action || 'case');
    if (action === 'feedback') return _CaseApi_json(FeedbackApi_list(params));
    if (action === 'checklistUrls') return _CaseApi_json(Checklist_getUrls());
    if (action === 'checklistBootstrap') return _CaseApi_json(Checklist_bootstrap());
    if (action === 'checklistSeedMerge') return _CaseApi_json(Checklist_seedMerge());
    if (action === 'checklistItems') return _CaseApi_json(Checklist_getItemList(String(params.caseId || ''), String(params.refresh || '') === 'true'));
    if (action === 'checklistLinks') return _CaseApi_json(Checklist_getCaseLinks(String(params.caseId || ''), String(params.role || ''), String(params.refresh || '') === 'true'));
    if (action === 'rushList') {
      var rush = Checklist_listRush(String(params.caseId || ''));
      if (rush.ok && params.since) {
        var since = new Date(String(params.since));
        if (isNaN(since.getTime())) return _CaseApi_json({ ok: false, error: 'since が不正です' });
        rush.rows = rush.rows.filter(function (row) { return new Date(row.updatedAt).getTime() >= since.getTime(); });
      }
      return _CaseApi_json(rush.ok ? rush.rows : rush);
    }
    if (action === 'rushUpdate') return _CaseApi_json(Checklist_updateRushStatus(String(params.id || ''), String(params.status || ''), String(params.updatedBy || '')));

    var label = String(params.event || '');
    var separator = label.indexOf(' / ');
    var clientPart = separator >= 0 ? label.slice(0, separator) : label;
    var eventPart = separator >= 0 ? label.slice(separator + 3) : '';
    var clientN = _CaseApi_norm(clientPart);
    var eventN = _CaseApi_norm(eventPart).slice(0, 25);
    if (!clientN) return _CaseApi_json({ ok: false, error: 'case not found' });

    var sheet = SpreadsheetApp.getActive().getSheetByName(CASE_LIST_SHEET_NAME);
    var data = sheet ? sheet.getDataRange().getValues() : [];
    var caseId = '';
    for (var i = 1; i < data.length; i++) {
      if (_CaseApi_norm(data[i][1]) === clientN &&
          (eventN === '' || _CaseApi_norm(data[i][2]).indexOf(eventN) === 0)) {
        caseId = String(data[i][0] || '').trim();
        if (caseId) break;
      }
    }
    var c = caseId ? CaseList_getById(caseId) : null;
    if (!c) return _CaseApi_json({ ok: false, error: 'case not found' });

    var venue = '', region = '', setupRaw = '', eventDates = '';
    var masterColResolution = { col: Number(c.masterCol) || 0, source: c.masterCol ? 'stored' : 'none' };
    var master = SpreadsheetApp.openById(CASE_API_MASTER_SS_ID);
    var task = master.getSheetByName('task');
    if (task) {
      masterColResolution = CaseApi_resolveMasterColFromSheet(
        task, c.clientName, c.caseName, c.masterCol,
        { startDate: c.startDate, endDate: c.endDate }
      );
      if (masterColResolution.col > 0) {
        var masterWidth = Math.max(1, Math.min(3, task.getLastColumn() - masterColResolution.col + 1));
        var masterValues = task.getRange(3, masterColResolution.col, 3, masterWidth).getValues();
        var row3Slice = masterValues[0] || [];
        region = String(row3Slice[0] || '').trim();
        venue = CaseApi_pickVenue(row3Slice);
        setupRaw = masterValues[1][0];
        eventDates = masterValues[2][0];
        if (typeof setupRaw === 'string') setupRaw = setupRaw.trim();
        if (typeof eventDates === 'string') eventDates = eventDates.trim();
      }
    }

    var itemList = '';
    if (c.zissiId) {
      var items = Zissi_readExistingItemList(SpreadsheetApp.openById(c.zissiId)).items;
      itemList = items.slice(0, 200).map(function (item) {
        return item.name + ' ×' + item.qty;
      }).join('\n');
    }

    return _CaseApi_json({
      ok: true,
      caseId: c.caseId,
      clientName: c.clientName,
      eventName: c.caseName,
      venue: venue,
      masterColUsed: masterColResolution.col,
      masterColSource: masterColResolution.source,
      region: region,
      setupDate: _CaseApi_formatDate(setupRaw),
      eventDates: eventDates,
      teardownDate: _CaseApi_lastDate(eventDates, setupRaw),
      boothSize: c.boothSize,
      itemList: itemList,
      extraNotes: ''
    });
  } catch (err) {
    return _CaseApi_json({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

function doGet(e) {
  return _CaseApi_dispatch(e);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    CaseApi_resolveMasterCol: CaseApi_resolveMasterCol,
    CaseApi_pickVenue: CaseApi_pickVenue
    ,_CaseApi_dispatch: _CaseApi_dispatch
  };
}
