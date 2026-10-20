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

/** 装飾や括弧内の補足は保持し、空白だけを除去する。 */
function _CaseApi_labelKey(value) {
  return String(value == null ? '' : value).normalize('NFKC').replace(/\s+/g, '').replace(/:$/, '');
}

/** 結合セルを含む概要の表示値から、公開可能なラベルだけを読む。 */
function CaseApi_parseOverview(values) {
  var labels = {
    companyName: ['企業名', '出展社名', '出展者名'], contactPerson: ['ご担当者様', 'ご担当者'],
    contactTel: ['連絡先'], contactMail: ['MAIL', 'メール'], representative: ['代表'],
    officialName: ['正式名称'], eventName: ['展示会名'], organizer: ['運営事務局'],
    organizerContact: ['Mail/TEL'], setupDate: ['設営日', '設営日程', '搬入設営', '搬入設営日', '搬入・設営日'], eventDate: ['開催日', '会期', '開催期間'],
    loadInDate: ['搬入日', '搬入日時'], teardownDate: ['撤去日', '撤去日時', '搬出日', '搬出撤去日'],
    hall: ['ホール', 'ホール名', '展示ホール'], producer: ['担当P', '制作P', '制作プロデューサー'],
    startTime: ['開始時刻'], firstDayWorkTime: ['初日施工時間'],
    badgeMethod: ['出展社証の受け取り方法'], badgeCount: ['出展社証の枚数'],
    noSoliciting: ['ブース外声掛け'], venueName: ['会場名', '会場'], boothNo: ['小間位置番号', '小間番号', 'ブース番号'],
    boothSize: ['小間サイズ(mm)', '込小間サイズ(mm)', '小間サイズ'],
    openSides: ['何面開放か', '何面開放'], koma: ['コマ数'],
    heightLimit: ['装飾に関する制限事項(高さ制限等)'],
    electric: [], internet: [], rental: [], venueUrl: ['会場URL'], access: ['アクセス'],
    wifi: ['Wi-Fi'], decoMethod: ['装飾方法'], stockRoom: ['ストックルーム'], notes: ['備考'],
    clientUrl: [], eventUrl: [], clientAddress: [], venueAddress: []
  };
  var result = {}, lookup = Object.create(null);
  Object.keys(labels).forEach(function (key) {
    result[key] = '';
    labels[key].forEach(function (label) { lookup[_CaseApi_labelKey(label)] = key; });
  });
  // 出力しない見出しも、隣の項目との境界として登録する。
  ['クライアント名', '社員数', '事業内容', '事業所',
    '出展者登録サイト', 'PASS', 'パスワード', 'ログイン', 'PW', 'ID'].forEach(function (label) {
    lookup[_CaseApi_labelKey(label)] = 'blocked';
  });
  function labelType(value, isValue) {
    var label = _CaseApi_labelKey(value);
    // 単語境界は空白を除去する前に判定。メール本文の LINE ID は禁止しない。
    var rawLabel = String(value == null ? '' : value).normalize('NFKC');
    if (!isValue && (/出展者登録サイト|PASS|パスワード|ログイン/i.test(label) ||
        /\b(?:PW|ID)\b/i.test(rawLabel))) return 'blocked';
    if (lookup[label]) return lookup[label];
    if (label === 'URL' || label === '住所') return label;
    var partials = [['小間サイズ', 'boothSize'], ['制限事項', 'heightLimit'],
      ['電気使用', 'electric'], ['インターネット', 'internet'], ['レンタル品', 'rental']];
    for (var i = 0; i < partials.length; i++) {
      if (label.indexOf(partials[i][0]) >= 0) return partials[i][1];
    }
    return '';
  }
  var rows = Array.isArray(values) ? values : [];
  var officialRow = -1, venueRow = -1;
  rows.forEach(function (row, r) {
    row.forEach(function (cell) {
      var type = labelType(cell);
      if (type === 'officialName' && officialRow < 0) officialRow = r;
      if (type === 'venueName' && venueRow < 0) venueRow = r;
    });
  });
  rows.forEach(function (row, r) {
    row.forEach(function (cell, col) {
      var key = labelType(cell);
      if (!key || key === 'blocked') return;
      if (key === 'URL') {
        if (officialRow < 0 || r < officialRow) key = 'clientUrl';
        else if (r > officialRow && (venueRow < 0 || r < venueRow)) key = 'eventUrl';
        else return;
      }
      if (key === '住所') key = venueRow >= 0 && r >= venueRow ? 'venueAddress' : 'clientAddress';
      if (result[key]) return;
      var parts = [];
      for (var j = col + 1; j < row.length; j++) {
        var value = String(row[j] == null ? '' : row[j]).trim();
        if (!value) continue;
        if (labelType(value, true) || /(?:PW|PASS)\s*[:：]/i.test(value)) break;
        parts.push(value);
        if (key !== 'eventDate' || parts.length === 4) break;
      }
      var joined = parts.join(' ');
      result[key] = /^[分〜~:\s]*$/.test(joined.normalize('NFKC')) ? '' : joined;
    });
  });
  return result;
}

function _CaseApi_overviewLines(overview, fields) {
  return fields.filter(function (field) { return overview[field[0]]; }).map(function (field) {
    return field[1] + ': ' + overview[field[0]];
  }).join('\n');
}

function _CaseApi_norm(value) {
  return String(value || '').normalize('NFKC').toLowerCase()
    .replace(/様$/, '').replace(/[\s　]+/g, '').replace(/＆/g, '&');
}

/**
 * パネルの実行パネルタブ名(例: "🚀株式会社〇〇 第9回〇〇")のように、
 * 絵文字装飾が先頭に付いたラベルから装飾だけを除去する。
 * " / " 区切りの本来のラベルにも影響しない(先頭に絵文字が無ければ何もしない)。
 */
function _CaseApi_stripDecoration(value) {
  return String(value || '').replace(/^[\u{1F000}-\u{1FFFF}\u{2190}-\u{2BFF}\u{2600}-\u{27BF}️\s　]+/gu, '');
}

/**
 * ラベル(event クエリ値)から案件一覧の caseId を解決する純関数。
 * rows は [{caseId, clientName, caseName}, ...]。
 * 1) "クライアント / 案件名" 形式の通常ラベルをまず試す。
 * 2) 区切りが無い場合(例: パネルのシートタブ名がそのまま渡った場合)は、
 *    絵文字を除去したラベル全体が「クライアント名+案件名」の連結に前方一致する行を探す。
 */
function CaseApi_resolveCaseIdFromLabel(rawLabel, rows) {
  var label = _CaseApi_stripDecoration(rawLabel);
  var list = Array.isArray(rows) ? rows : [];
  var separator = label.indexOf(' / ');
  var clientPart = separator >= 0 ? label.slice(0, separator) : label;
  var eventPart = separator >= 0 ? label.slice(separator + 3) : '';
  var clientN = _CaseApi_norm(clientPart);
  var eventN = _CaseApi_norm(eventPart).slice(0, 25);

  if (clientN) {
    for (var i = 0; i < list.length; i++) {
      if (_CaseApi_norm(list[i].clientName) === clientN &&
          (eventN === '' || _CaseApi_norm(list[i].caseName).indexOf(eventN) === 0)) {
        var id = String(list[i].caseId || '').trim();
        if (id) return id;
      }
    }
  }

  // フォールバック: 区切りが無い/一致しないラベル。絵文字除去後の全体文字列が
  // 「クライアント名+案件名」の前方一致になる行を、クライアント名が最長のものから選ぶ。
  var wholeN = _CaseApi_norm(label).replace(/\//g, '');
  if (wholeN) {
    var bestId = '', bestLen = -1;
    for (var j = 0; j < list.length; j++) {
      var rowClientN = _CaseApi_norm(list[j].clientName);
      if (!rowClientN || wholeN.indexOf(rowClientN) !== 0) continue;
      if (rowClientN.length > bestLen) {
        bestLen = rowClientN.length;
        bestId = String(list[j].caseId || '').trim();
      }
    }
    if (bestId) return bestId;
  }
  return '';
}

/**
 * 案件一覧に無い/一致しない場合、master task シートのヘッダ行(row1=クライアント, row2=案件名)
 * から直接、ラベル全体の前方一致で列を解決する。CaseApi_resolveMasterCol と違い
 * clientName/caseName が分離できていない生ラベルを直接受け取る。
 */
function CaseApi_resolveMasterColDirect(headerRows, rawLabel) {
  var rows = Array.isArray(headerRows) ? headerRows : [];
  var clients = Array.isArray(rows[0]) ? rows[0] : [];
  var cases = Array.isArray(rows[1]) ? rows[1] : [];
  var label = _CaseApi_stripDecoration(rawLabel);
  var wholeN = _CaseApi_norm(label).replace(/\//g, '');
  if (!wholeN) return 0;
  var width = Math.max(clients.length, cases.length);
  var bestCol = 0, bestLen = -1;
  for (var i = 0; i < width; i++) {
    var rowClientN = _CaseApi_norm(clients[i]);
    if (!rowClientN || wholeN.indexOf(rowClientN) !== 0) continue;
    if (rowClientN.length > bestLen) { bestLen = rowClientN.length; bestCol = i + 1; }
  }
  return bestCol;
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

/** master の制作P表記を取り除く。HTTP と当日チェックで共用。 */
function CaseApi_resolveProducer(task, masterCol) {
  if (!task || !(masterCol > 0)) return '';
  return String(task.getRange(8, masterCol, 1, 1).getValues()[0][0] || '').replace(/^(?:制作)?P[：:\s]*/, '');
}

/** 概要の読み取りとエラー情報を共用し、既存HTTPの出力を維持する。 */
function CaseApi_readOverview(c) {
  var result = { overview: CaseApi_parseOverview([]), zissi: null, caseCode: '', overviewFound: false, overviewError: '' };
  if (!c.zissiId) return result;
  try {
    result.zissi = SpreadsheetApp.openById(c.zissiId);
    var codeMatch = result.zissi.getName().match(/（([A-Za-z0-9]+)_/);
    result.caseCode = codeMatch ? codeMatch[1] : '';
    var sh = result.zissi.getSheetByName('概要') || result.zissi.getSheets().filter(function (s) {
      return s.getName().indexOf('概要') >= 0;
    })[0];
    result.overviewFound = !!sh;
    if (sh) result.overview = CaseApi_parseOverview(sh.getDataRange().getDisplayValues());
  } catch (e) { result.overviewError = String(e && e.message ? e.message : e); }
  return result;
}

/** 会場と小間を分離して解決する。HTTP は従来の地域フォールバック順を維持。 */
function CaseApi_resolveVenue(c, task, options) {
  var opts = options || {}, col = opts.masterCol || Number(c.masterCol), row3 = opts.row3Slice || [];
  if (!opts.row3Slice && task && col > 0) {
    var width = Math.max(1, Math.min(3, task.getLastColumn() - col + 1));
    row3 = task.getRange(3, col, 1, width).getValues()[0];
  }
  var read = opts.overview ? { overview: opts.overview, overviewError: '' } : CaseApi_readOverview(c);
  var overview = read.overview;
  var venue = CaseApi_pickVenue(row3);
  var regional = /^(?:北海道|東北|関東|甲信越|北陸|東海|中部|近畿|関西|中国|四国|九州|沖縄)(?:[（(][^）)]+[）)])?$/.test(venue);
  return {
    venue: !opts.preserveRegionalFallback && regional ? (overview.venueName || c.venue || venue) : (venue || c.venue || overview.venueName),
    boothNo: c.boothNo || overview.boothNo || '',
    overviewError: read.overviewError
  };
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
    if (String(params.form || '') === 'estimate') return EstimateIntake_serveForm(params);
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
    if (!params.caseId && !_CaseApi_norm(_CaseApi_stripDecoration(label))) return _CaseApi_json({ ok: false, error: 'case not found' });

    var sheet = SpreadsheetApp.getActive().getSheetByName(CASE_LIST_SHEET_NAME);
    var data = sheet ? sheet.getDataRange().getValues() : [];
    var caseRows = data.slice(1).map(function (row) {
      return { caseId: row[0], clientName: row[1], caseName: row[2] };
    });
    var caseId = String(params.caseId || '') || CaseApi_resolveCaseIdFromLabel(label, caseRows);
    var c = caseId ? CaseList_getById(caseId) : null;

    var master = SpreadsheetApp.openById(CASE_API_MASTER_SS_ID);
    var task = master.getSheetByName('task');

    // 案件一覧に見つからない/一致しない場合でも、master task シートのヘッダから
    // 直接クライアント名・案件名の列を解決し、最低限の案件情報を組み立てる。
    var directMasterCol = 0;
    if (!c && !params.caseId && task) {
      var lastColForDirect = task.getLastColumn();
      var headerRowsForDirect = lastColForDirect > 0 ? task.getRange(1, 1, 2, lastColForDirect).getValues() : [];
      directMasterCol = CaseApi_resolveMasterColDirect(headerRowsForDirect, label);
      if (directMasterCol > 0) {
        c = {
          caseId: '', clientName: String(headerRowsForDirect[0][directMasterCol - 1] || '').trim(),
          caseName: String(headerRowsForDirect[1][directMasterCol - 1] || '').trim(),
          boothSize: '', zissiId: '', masterCol: directMasterCol, startDate: '', endDate: ''
        };
      }
    }
    if (!c) return _CaseApi_json({
      ok: false, error: 'case not found', apiVersion: 'caseapi-20260929a',
      stage: { caseListRows: caseRows.length, masterTask: !!task, directMasterCol: directMasterCol }
    });

    return _CaseApi_json(_CaseApi_buildCaseContext(c, task, directMasterCol));
  } catch (err) {
    return _CaseApi_json({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

function FeedbackKit_originalDoGet(e) {
  return _CaseApi_dispatch(e);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    CaseApi_parseOverview: CaseApi_parseOverview,
    CaseApi_resolveMasterCol: CaseApi_resolveMasterCol,
    CaseApi_pickVenue: CaseApi_pickVenue,
    CaseApi_resolveVenue: CaseApi_resolveVenue,
    CaseApi_resolveProducer: CaseApi_resolveProducer,
    CaseApi_resolveCaseIdFromLabel: CaseApi_resolveCaseIdFromLabel,
    CaseApi_resolveMasterColDirect: CaseApi_resolveMasterColDirect
    ,_CaseApi_dispatch: _CaseApi_dispatch
  };
}

/** HTTP と見積チェックで共用する案件情報。 */
function _CaseApi_buildCaseContext(c, task, directMasterCol) {
    var venue = '', region = '', setupRaw = '', eventDates = '', producer = '';
    var masterColResolution = { col: Number(c.masterCol) || 0, source: c.masterCol ? 'stored' : 'none' };
    if (task) {
      masterColResolution = directMasterCol > 0
        ? { col: directMasterCol, source: 'matched' }
        : CaseApi_resolveMasterColFromSheet(
          task, c.clientName, c.caseName, c.masterCol,
          { startDate: c.startDate, endDate: c.endDate }
        );
      if (masterColResolution.col > 0) {
        var masterWidth = Math.max(1, Math.min(3, task.getLastColumn() - masterColResolution.col + 1));
        var masterValues = task.getRange(3, masterColResolution.col, 3, masterWidth).getValues();
        var row3Slice = masterValues[0] || [];
        region = String(row3Slice[0] || '').trim();
        // 会場は概要取得後に共通関数で解決する。
        setupRaw = masterValues[1][0];
        producer = CaseApi_resolveProducer(task, masterColResolution.col);
        eventDates = masterValues[2][0];
        if (typeof setupRaw === 'string') setupRaw = setupRaw.trim();
        if (typeof eventDates === 'string') eventDates = eventDates.trim();
      }
    }

    var overviewRead = CaseApi_readOverview(c);
    var itemList = '', caseCode = overviewRead.caseCode, overviewFound = overviewRead.overviewFound, overviewError = overviewRead.overviewError;
    var overview = overviewRead.overview, zissi = overviewRead.zissi;
    if (zissi) {
      var items = Zissi_readExistingItemList(zissi).items;
      itemList = items.slice(0, 200).map(function (item) {
        return item.name + ' ×' + item.qty;
      }).join('\n');
    }

    var constructionFields = CaseApi_constructionFields(c, overview, {
      setupDate: _CaseApi_formatDate(setupRaw), eventDates: _CaseApi_formatDate(eventDates), producer: producer
    });
    var resolvedVenue = CaseApi_resolveVenue(c, task, { masterCol: masterColResolution.col, row3Slice: row3Slice || [], overview: overview, preserveRegionalFallback: true });
    venue = resolvedVenue.venue;
    if (overview.boothNo) venue += ' 小間' + overview.boothNo;
    if (overview.venueAddress) venue += '（' + overview.venueAddress + '）';

    return {
      ok: true,
      apiVersion: 'caseapi-20260929a',
      overviewFound: overviewFound,
      overviewError: overviewError,
      caseCode: caseCode,
      caseId: c.caseId,
      clientName: c.clientName || overview.companyName,
      eventName: c.caseName || overview.eventName,
      venue: venue,
      masterColUsed: masterColResolution.col,
      masterColSource: masterColResolution.source,
      region: region,
      setupDate: constructionFields.setupDate,
      setupDateSource: constructionFields.setupDateSource,
      estimated: constructionFields.estimated,
      setupDateEstimated: constructionFields.estimated,
      eventDates: constructionFields.eventDates,
      eventDatesSource: constructionFields.eventDatesSource,
      loadInDate: constructionFields.loadInDate,
      loadInDateSource: constructionFields.loadInDateSource,
      teardownDate: constructionFields.teardownDate,
      teardownDateSource: constructionFields.teardownDateSource,
      hall: c.hall || overview.hall,
      boothNo: c.boothNo || overview.boothNo,
      exhibitorName: c.clientName || overview.companyName,
      producer: constructionFields.producer,
      boothSize: c.boothSize || overview.boothSize,
      itemList: itemList,
      clientContact: overview.contactPerson || overview.contactTel
        ? '氏名 | 会社名 | 役割 | 連絡先\n' + overview.contactPerson + ' | ' + overview.companyName +
          ' | ご担当者 | ' + overview.contactTel + (overview.contactMail ? ' / ' + overview.contactMail : '') : '',
      venueRules: _CaseApi_overviewLines(overview, [
        ['boothSize', '小間サイズ'], ['openSides', '何面開放'], ['koma', 'コマ数'],
        ['heightLimit', '装飾制限(高さ等)'], ['electric', '電気'], ['internet', 'インターネット'],
        ['rental', 'レンタル品'], ['decoMethod', '装飾方法'], ['stockRoom', 'ストックルーム'],
        ['badgeMethod', '出展社証の受け取り'], ['badgeCount', '出展社証の枚数'],
        ['noSoliciting', 'ブース外声掛け'], ['eventDate', '開催日時'], ['startTime', '開始時刻'],
        ['firstDayWorkTime', '初日施工時間'], ['access', '会場アクセス'], ['wifi', 'Wi-Fi'], ['venueUrl', '会場URL']
      ]),
      extraNotes: _CaseApi_overviewLines(overview, [
        ['officialName', '正式名称'], ['eventUrl', '展示会URL'], ['organizer', '運営事務局'],
        ['organizerContact', '運営事務局連絡先'], ['clientUrl', 'お客様URL'], ['representative', '代表'], ['notes', '備考']
      ])
    };
}
