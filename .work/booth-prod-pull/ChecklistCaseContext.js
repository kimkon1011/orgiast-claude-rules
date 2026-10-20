/** 当日の案内に使う案件資料。確定情報を優先し、読み取り結果を10分キャッシュする。 */
function ChecklistCaseContext_emptyParking() {
  return { status: '未確定', source: '推定', primary: null, backups: [], ng: [] };
}

/** Google Drive/Docs の共有URLからIDだけを取り出す（GASでも使える純関数）。 */
function ChecklistCaseContext_fileIdFromUrl(url) {
  var match = String(url || '').trim().match(/^https?:\/\/(?:docs|drive)\.google\.com((?:\/|\?)[^\s#]*)?(?:#.*)?$/i);
  if (!match) return '';
  var path = match[1] || '';
  var id = path.split('?')[0].match(/\/d\/([A-Za-z0-9_-]+)(?:\/|$)/)
    || path.match(/[?&]id=([A-Za-z0-9_-]+)(?:&|$)/);
  return id ? id[1] : '';
}

/** Phase2_OperationsPlan の平文出力を読む。別セクションの注意事項を混ぜない。 */
function ChecklistCaseContext_parseLogisticsDoc(text) {
  var result = { vehicles: [], legs: [], parking: ChecklistCaseContext_emptyParking(), hasParking: false };
  var section = '', leg = null, candidate = null, parkingTitle = '', requirements = [];
  String(text || '').split(/\r?\n/).forEach(function (raw) {
    var line = raw.trim(), match;
    if (/^■\s*/.test(line)) {
      section = ''; leg = null; candidate = null;
      match = line.match(/^■\s*車両[0-9０-９]+\s*[:：]\s*(.*)$/);
      if (match) {
        var label = match[1].split(/\s+[\/／]\s+/)[0].trim();
        if (label) {
          var key = Checklist_normalizeVehicleName(label);
          result.vehicles.push({ key: key, label: label, kind: '', driver: null });
          leg = { vehicle: key, depart: '', arrive: '', driver: '' };
          result.legs.push(leg);
          section = 'vehicle';
        }
      } else if (/^■\s*車両外寸と駐車場要件/.test(line)) {
        section = 'requirements';
      } else if (/^■\s*駐車場(?:\s|[（(]|$)/.test(line) && !/^■\s*駐車場\s*の/.test(line)) {
        section = 'parking'; parkingTitle = line; result.hasParking = true;
      }
      return;
    }
    if (section === 'vehicle') {
      match = line.match(/^(発|着|ドライバー)\s*[:：]\s*(.*)$/);
      if (match) leg[{ '発': 'depart', '着': 'arrive', 'ドライバー': 'driver' }[match[1]]] = match[2];
    }
    if (section === 'requirements' && /【必要な駐車場条件】/.test(line)) requirements.push(line);
    if (section !== 'parking' || !line) return;
    match = line.match(/^【(.*?)】\s*(.*)$/);
    if (match) {
      candidate = null;
      if (/不可|NG/.test(match[1])) {
        var parts = match[2].split(/\s+[—―]\s+/);
        result.parking.ng.push({ name: parts.shift(), reason: parts.join(' — ') });
      } else if (/本命|予備|第一候補|第1候補|確定/.test(match[1])) {
        var fields = match[2].split(/\s+[\/／]\s+/);
        candidate = { name: fields.shift(), note: fields.join(' / ') };
        if (/本命|第一候補|第1候補|確定/.test(match[1]) && !result.parking.primary) result.parking.primary = candidate;
        else result.parking.backups.push(candidate);
      }
    } else if (candidate) {
      var url = line.match(/https?:\/\/[^\s<>]+/);
      if (url && !candidate.url) candidate.url = url[0];
      candidate.note += (candidate.note ? '\n' : '') + line;
    }
  });
  if (result.parking.primary && requirements.length) result.parking.primary.note += '\n' + requirements.join('\n');
  if (result.parking.primary && !/未確定|未定/.test(parkingTitle + result.parking.primary.note)) result.parking.status = '確定';
  return result;
}

/** HEADING 配下だけを読む（生成Docは番号付き Paragraph、人手のListItemも許容）。 */
function ChecklistCaseContext_readMustRules(body) {
  var rules = [], inside = false;
  body.getParagraphs().some(function (p) {
    var text = p.getText().trim();
    var heading = String(p.getHeading());
    if (/HEADING[123]/.test(heading) || /^■/.test(text)) {
      inside = text.indexOf('絶対に守るべきこと') >= 0;
      return false;
    }
    if (inside && text) rules.push(text.replace(/^(?:[・●•\-]|\d+[.．、])\s*/, '').slice(0, 120));
    return rules.length >= 8;
  });
  return rules;
}

/** 車両ごとの明示的な実名/不要だけを採用。未定は下位資料へ委ねる。 */
function ChecklistCaseContext_staffVehicles(staff) {
  var groups = {}, decisions = {};
  (staff || []).forEach(function (s) {
    if (!/ドライバー|運転/.test(s.roleLabel) || !s.vehicle) return;
    var key = Checklist_normalizeVehicleName(s.vehicle);
    (groups[key] || (groups[key] = [])).push(s);
  });
  Object.keys(groups).forEach(function (key) {
    if (groups[key].some(function (s) { return s.assigned; })) decisions[key] = true;
    else if (groups[key].every(function (s) { return s.unassignedReason === '不要'; })) decisions[key] = false;
  });
  return decisions;
}

function ChecklistCaseContext_sheetVehicles(ss) {
  var sheet = ss && ss.getSheetByName('搬入出計画');
  if (!sheet) return [];
  var rows = sheet.getDataRange().getDisplayValues(), text = '';
  rows.some(function (row) {
    var col = row.findIndex(function (cell) { return String(cell).trim() === 'トラック判定'; });
    if (col < 0) return false;
    text = String(row[col + 1] || '');
    return true;
  });
  return ['デュトロ', 'キャラバン', 'トヨエース', 'レンタル'].filter(function (key) {
    return text.indexOf(key) >= 0;
  }).map(function (key) { return { key: key, label: key, kind: '', driver: null }; });
}

function ChecklistCaseContext_assigned(contact) {
  return contact && contact.assigned !== false && !StaffDrivers_unassignedReason(contact.name);
}

function ChecklistCaseContext_director(ctx) {
  var contacts = ctx.contacts || [];
  var directors = contacts.filter(function (c) { return c.role === 'ディレクター' && ChecklistCaseContext_assigned(c); });
  var director = directors.filter(function (c) { return c.source === '確定'; })[0]
    || directors.filter(function (c) { return /制作\s*[/／]\s*当日D/.test(c.roleLabel || ''); })[0] || directors[0];
  if (director) return director;
  var officeDirector = (ctx.officeContacts || []).filter(function (c) {
    return /ディレクター/.test(c.role) && ChecklistCaseContext_assigned(c);
  })[0];
  if (officeDirector) return Object.assign({}, officeDirector, { role: 'ディレクター', roleLabel: officeDirector.role });
  var employees = contacts.filter(function (c) { return c.role === '担当社員' && ChecklistCaseContext_assigned(c); });
  var employee = employees.filter(function (c) { return c.source === 'スタッフ表'; })[0] || employees[0];
  return employee ? Object.assign({}, employee, { name: '担当社員 ' + employee.name + '（ディレクター未決）' }) : {};
}

function ChecklistCaseContext_nameKey(name) {
  return String(name || '').normalize('NFKC').replace(/[\s　]+/g, '');
}

/** 欄名ではなく値で連絡方法を判定する（電話欄のLINE名・LINE欄の電話に対応）。 */
function ChecklistCaseContext_contactMethod(contact) {
  var tel = StaffDrivers_normalizeTel(contact.tel) || StaffDrivers_normalizeTel(contact.line);
  var line = contact.line || (!tel ? contact.tel : '');
  return tel ? { label: '電話', value: tel } : line ? { label: 'LINE', value: line }
    : contact.email ? { label: 'メール', value: 'mailto:' + contact.email } : { label: '連絡先', value: '' };
}

function Checklist_getCaseContext(caseId, refresh) {
  var id = String(caseId || ''), cache, cacheKey = 'checklist:ctx:' + id;
  var ctx = { caseId: id, label: '', venue: '', vehicles: [], parking: ChecklistCaseContext_emptyParking(),
    dock: null,
    contacts: [], officeContacts: [], legs: [], excludedVehicles: [], vehiclesNote: '', docs: { construction: '', constructionSlides: '', logistics: '', operations: '', zissi: '' },
    mustRules: [], manualSteps: [], vehiclesSource: '推定', venueSource: '推定', boothNo: '', boothMap: null, meetingPoint: '', notes: '', qrImageUrl: '', sourceUpdatedAt: '', warnings: [] };
  function warn(message) { if (ctx.warnings.indexOf(message) < 0) ctx.warnings.push(message); }
  function attempt(label, fn) {
    try { return fn(); } catch (e) { warn(label + ': ' + (e.message || String(e))); return null; }
  }
  function updated(fileId, file) {
    return attempt('資料更新日時を取得できません', function () {
      var date = (file || DriveApp.getFileById(fileId)).getLastUpdated().toISOString();
      if (!ctx.sourceUpdatedAt || date > ctx.sourceUpdatedAt) ctx.sourceUpdatedAt = date;
      return date;
    }) || '';
  }
  attempt('キャッシュを取得できません', function () {
    cache = CacheService.getScriptCache();
  });
  if (cache && refresh !== true && refresh !== 'true') {
    var cached = attempt('キャッシュを読めません', function () { return JSON.parse(cache.get(cacheKey) || 'null'); });
    // 旧版の混在したスタッフ表キャッシュは再利用しない。設定保存時の削除キーは維持。
    if (cached && Array.isArray(cached.officeContacts) && Object.prototype.hasOwnProperty.call(cached, 'boothMap')) return cached;
  }
  var c = attempt('案件情報を取得できません', function () { return CaseList_getById(id); });
  if (!c) { warn('案件が見つかりません'); return ctx; }
  ctx.label = [c.clientName, c.caseName].filter(Boolean).join(' / ');
  if (c.masterSsId) updated(c.masterSsId);
  var config = attempt('案件設定を取得できません', function () { return Checklist_getCaseConfig(id); }) || {};
  var configuredVehicles = Array.isArray(config.vehicles) && config.vehicles.length > 0;
  ctx.meetingPoint = config.meetingPoint || '';
  ctx.notes = config.notes || '';
  // 要望 32 行: 当日スタッフ用 QR 画像。未登録の案件では空のまま＝画面に何も出さない。
  ctx.qrImageUrl = String(config.qrImageUrl || '').trim();
  ctx.meetingPointSource = ctx.meetingPoint ? '確定' : '';
  ctx.notesSource = ctx.notes ? '確定' : '';
  if (config.updatedAt) ctx.sourceUpdatedAt = [ctx.sourceUpdatedAt, config.updatedAt].sort().pop();
  [['director', 'ディレクター'], ['supervisor', '現場監督']].forEach(function (entry) {
    if (config[entry[0] + 'Name']) ctx.contacts.push({ role: entry[1], name: config[entry[0] + 'Name'], tel: config[entry[0] + 'Tel'] || '', assigned: true, source: '確定', telSource: config[entry[0] + 'Tel'] ? '確定' : '' });
  });
  var task = attempt('masterを取得できません', function () {
    return c.masterSsId ? SpreadsheetApp.openById(c.masterSsId).getSheetByName('task') : null;
  });
  attempt('会場を取得できません', function () {
    var resolved = CaseApi_resolveVenue(c, task);
    ctx.venue = resolved.venue;
    ctx.boothNo = resolved.boothNo;
    if (resolved.overviewError) warn('概要を取得できません: ' + resolved.overviewError);
  });
  if (!ctx.venue) warn('会場が未登録');
  if (!ctx.boothNo) warn('小間番号が未登録（実施計画書の概要「小間位置番号」）');
  var artifacts = attempt('案件資料一覧を取得できません', function () { return MasterWriteBack_listArtifacts(id); }) || [];
  // 搬入口から入った後のために会場内マップ（主催者の小間割・会場レイアウト図）を探す。資料台帳の「会場内マップ」が最優先（cr 指示 2026-10-19）。
  ctx.boothMap = ChecklistCaseContext_pickBoothMap(artifacts) || attempt('案件フォルダから会場内マップを探せません', function () {
    var roots = [];
    try { roots.push(Case_resolveProjectRoot(c)); } catch (e) {}
    return ChecklistCaseContext_findBoothMapInFolders(roots.concat([c.projectFolderId, c.folderId]));
  }) || null;
  // 設営会社様（匿名アクセス）も開けるよう、施工手順書と同じくリンク閲覧可にする。
  if (ctx.boothMap) attempt('会場内マップをリンク共有できません', function () {
    var shared = ChecklistCaseContext_ensureBoothMapShared(id, ctx.boothMap);
    ctx.boothMap = shared.map;
    if (!shared.ok) {
      var publicMap = ChecklistCaseContext_pickPublicBoothMap(artifacts);
      if (publicMap) {
        ctx.boothMap = publicMap;
        warn('会場内マップは主催者の公開ページを使います: ' + publicMap.url);
      } else {
        warn('会場内マップを社外の方が開けません: ' + shared.error + '。資料台帳に主催者の公開マップURLを「会場内マップ」で登録してください');
      }
    }
  });
  else warn('会場内マップが未登録（案件フォルダに主催者の小間割・会場レイアウト図を入れるか、資料台帳に「会場内マップ」を登録）');
  // 本文は実ファイルがGoogle Docsの資料だけを、更新日時の新しい順で選ぶ。
  ['construction', 'logistics', 'operations'].forEach(function (kind) {
    var names = { construction: /施工手順書|設営撤去手順/, logistics: /搬入出計画/, operations: /運営計画/ };
    var candidates = artifacts.filter(function (a) {
      return names[kind].test(a.type) && !/スライド/.test(a.type) && ChecklistCaseContext_fileIdFromUrl(a.url);
    }).map(function (a) {
      return attempt('資料の種類を取得できません', function () {
        var fileId = ChecklistCaseContext_fileIdFromUrl(a.url), file = DriveApp.getFileById(fileId);
        if (file.getMimeType() !== MimeType.GOOGLE_DOCS) return null;
        return { url: 'https://docs.google.com/document/d/' + fileId + '/edit', id: fileId,
          updated: updated(fileId, file) || a.createdAt || '', createdAt: a.createdAt || '' };
      });
    }).filter(Boolean).sort(function (a, b) { return b.updated.localeCompare(a.updated) || b.createdAt.localeCompare(a.createdAt); });
    if (candidates.length) ctx.docs[kind] = candidates[0].url;
    else warn({ construction: '施工手順書が未生成', logistics: '搬入出計画が未生成', operations: '運営計画が未生成' }[kind]);
  });
  // 現場で開く施工手順書はスライド版が正本（全案件ルール）。手順を項目にし、各ページへのリンクを付ける（cr 指示 2026-10-18）。
  var decks = artifacts.filter(function (a) {
    return /施工手順書/.test(a.type) && ChecklistCaseContext_fileIdFromUrl(a.url);
  }).map(function (a) {
    return attempt('施工手順書スライドの種類を取得できません', function () {
      var fileId = ChecklistCaseContext_fileIdFromUrl(a.url), file = DriveApp.getFileById(fileId);
      if (file.getMimeType() !== MimeType.GOOGLE_SLIDES) return null;
      return { url: 'https://docs.google.com/presentation/d/' + fileId + '/edit', id: fileId,
        updated: updated(fileId, file) || a.createdAt || '', createdAt: a.createdAt || '' };
    });
  }).filter(Boolean).sort(function (a, b) { return b.updated.localeCompare(a.updated) || b.createdAt.localeCompare(a.createdAt); });
  if (decks.length) {
    ctx.docs.constructionSlides = decks[0].url;
    ctx.manualSteps = attempt('施工手順書スライドを読めません', function () {
      return ChecklistCaseContext_readSlideSteps(SlidesApp.openById(decks[0].id), decks[0].url);
    }) || [];
  }
  // DIY 展示台を使わない案件（アイテムリストに DIY の現場数量が無い）では組立マニュアル項目を出さない。読めなければ従来どおり出す。
  attempt('アイテムリストを読めません', function () {
    var list = Checklist_getItemList(id, refresh === true || refresh === 'true');
    if (list && list.ok) ctx.diyInUse = (list.items || []).some(function (i) { return /DIY/i.test(i.name) && Number(i.siteQty) > 0; });
  });
  var parsed = null;
  if (ctx.docs.logistics) parsed = attempt('搬入出計画を読めません', function () {
    return ChecklistCaseContext_parseLogisticsDoc(DocumentApp.openById(ChecklistCaseContext_fileIdFromUrl(ctx.docs.logistics)).getBody().getText());
  });
  var ss = null, staff = [];
  if (c.zissiId) {
    ctx.docs.zissi = 'https://docs.google.com/spreadsheets/d/' + c.zissiId + '/edit';
    updated(c.zissiId);
    ss = attempt('実施計画書を読めません', function () { return SpreadsheetApp.openById(c.zissiId); });
    if (ss) attempt('スタッフを取得できません', function () {
      var fetched = StaffDrivers_fetchAll(ss);
      if (!fetched.found) warn('スタッフシートまたは連絡先の見出しを取得できません');
      (fetched.warnings || []).forEach(warn);
      staff = fetched.staff || [];
    });
  } else warn('実施計画書が未登録');
  if (ss) ctx.officeContacts = attempt('社内連絡先を取得できません', function () {
    return StaffDrivers_fetchOfficeContacts(ss);
  }) || [];
  var decisions = ChecklistCaseContext_staffVehicles(staff);
  var assignedVehicles = Object.keys(decisions).filter(function (key) { return decisions[key] === true; });
  // 設定やスタッフ表で車両が明示されていれば、容積からの推定は不要。
  var trucks = configuredVehicles || assignedVehicles.length ? [] : attempt('使用車両を計算できません', function () { return Phase2_VolumeCalc_estimateTrucks(id).selectedTrucks; }) || [];
  var sheetVehicles = !configuredVehicles && !assignedVehicles.length && !(parsed && parsed.vehicles.length) && ss
    ? attempt('搬入出計画シートを読めません', function () { return ChecklistCaseContext_sheetVehicles(ss); }) || [] : [];
  var fallbackSource = parsed && parsed.vehicles.length ? '搬入出計画' : sheetVehicles.length ? '搬入出計画シート' : '推定';
  var fallbackVehicles = parsed && parsed.vehicles.length ? parsed.vehicles : sheetVehicles.length ? sheetVehicles : trucks.map(function (t) {
    return { key: Checklist_normalizeVehicleName(t.name), label: t.name, kind: t.kind || '', driver: null };
  });
  ctx.vehiclesSource = configuredVehicles ? '確定' : assignedVehicles.length ? 'スタッフ表' : fallbackSource;
  ctx.vehicles = configuredVehicles ? config.vehicles.map(function (key) {
    return { key: Checklist_normalizeVehicleName(key), label: key, kind: '', driver: null, source: '確定' };
  }) : assignedVehicles.length ? assignedVehicles.map(function (key) {
    return { key: key, label: key, kind: '', driver: null, source: 'スタッフ表' };
  }) : fallbackVehicles.filter(function (v) { return decisions[v.key] !== false; }).map(function (v) {
    return Object.assign({}, v, { source: fallbackSource });
  });
  if (!configuredVehicles) {
    Object.keys(decisions).forEach(function (key) {
      if (!decisions[key]) ctx.excludedVehicles.push(key);
    });
    ctx.vehiclesNote = [assignedVehicles.length ? 'スタッフ表: ' + assignedVehicles.join('・') + 'を使用' : '',
      ctx.excludedVehicles.length ? 'スタッフ表: ' + ctx.excludedVehicles.join('・') + 'は「不要」' : ''].filter(Boolean).join(' / ');
  }
  ctx.vehicles.forEach(function (v) {
    v.source = v.source || ctx.vehiclesSource;
    var t = trucks.filter(function (t) { return Checklist_normalizeVehicleName(t.name) === v.key; })[0];
    v.kind = v.kind || (t && t.kind) || (/^(デュトロ|キャラバン|トヨエース)$/.test(v.key) ? '自社便' : 'レンタル');
  });
  if (!ctx.vehicles.length && !ctx.excludedVehicles.length) warn('使用車両を取得できません');
  ctx.legs = parsed ? parsed.legs.filter(function (l) { return ctx.vehicles.some(function (v) { return v.key === l.vehicle; }); }) : [];
  ctx.legs.forEach(function (l) { l.source = '搬入出計画'; });
  ctx.legs.forEach(function (leg) {
    ['depart', 'arrive', 'driver'].forEach(function (key) {
      if (!leg[key] || /^(未定|未確定|未アサイン)/.test(leg[key])) warn(leg.vehicle + 'の' + { depart: '出発', arrive: '到着', driver: 'ドライバー' }[key] + 'が未確定');
    });
  });
  ctx.vehicles.forEach(function (v) {
    var rows = staff.filter(function (s) {
      return /ドライバー|運転/.test(s.roleLabel) && s.assigned && Checklist_normalizeVehicleName(s.vehicle) === v.key;
    });
    v.drivers = [];
    rows.forEach(function (s) {
      (s.schedule || []).forEach(function (schedule) {
        v.drivers.push({ date: schedule.date, name: s.name, tel: s.tel || '', in: schedule.in, out: schedule.out });
      });
    });
    if (rows.length) v.driver = { name: rows[0].name, tel: rows[0].tel || '', source: 'スタッフ表' };
  });
  if (!ctx.legs.length && !ctx.vehicles.some(function (v) {
    return v.drivers.some(function (d) { return d.in || d.out; });
  })) warn('車両の出発・到着行程が未登録');
  // 補助表はA列=名前/B列=メール。見出しの有無に依存しない。
  var emailByName = Object.create(null);
  if (ss) attempt('スタッフ補助メールを取得できません', function () {
    var settings = ss.getSheetByName('スタッフプルダウン設定');
    if (!settings) return;
    var rows = settings.getDataRange().getDisplayValues();
    rows.forEach(function (row) {
      if (row[0] && /\S+@\S+/.test(String(row[1] || ''))) emailByName[ChecklistCaseContext_nameKey(row[0])] = String(row[1]).trim();
    });
  });
  staff.forEach(function (s) {
    var role = /制作\s*[/／]\s*当日D|ディレクター|現場監督/.test(s.roleLabel) ? 'ディレクター'
      : /担当社員|プロデューサー/.test(s.roleLabel) ? '担当社員'
      : /お客様/.test(s.roleLabel) ? 'お客様' : /ドライバー|運転/.test(s.roleLabel) ? 'ドライバー' : '';
    if (!role) return;
    var roles = role === 'ディレクター' && /現場監督/.test(s.roleLabel) ? [role, '現場監督'] : [role];
    roles.forEach(function (contactRole) {
      var existing = ctx.contacts.filter(function (contact) { return contact.role === contactRole && contact.name === s.name; })[0];
      var email = s.email || (role === '担当社員' || role === 'ディレクター' ? emailByName[ChecklistCaseContext_nameKey(s.name)] : '') || '';
      if (existing) {
        if (!existing.tel) { existing.tel = s.tel || ''; existing.telSource = 'スタッフ表'; }
        if (!existing.email) existing.email = email;
        if (!existing.line) existing.line = s.line || '';
        if (!existing.roleLabel) existing.roleLabel = s.roleLabel;
      } else if (!ctx.contacts.some(function (contact) { return contact.role === contactRole && contact.source === '確定'; })) {
        ctx.contacts.push({ role: contactRole, roleLabel: s.roleLabel, name: s.name, tel: s.tel || '', line: s.line || '', email: email,
          assigned: s.assigned, unassignedReason: s.unassignedReason, source: 'スタッフ表' });
      }
    });
  });
  ctx.contacts.forEach(function (contact) {
    if (!contact.email && /^(?:担当社員|ディレクター|現場監督)$/.test(contact.role)) contact.email = emailByName[ChecklistCaseContext_nameKey(contact.name)] || '';
  });
  if (ss && ctx.contacts.some(function (contact) { return contact.role === 'お客様' && (!contact.tel || !contact.email); })) attempt('お客様連絡先を取得できません', function () {
    var overviewSheet = ss.getSheetByName('概要');
    if (!overviewSheet) return;
    var overview = CaseApi_parseOverview(overviewSheet.getDataRange().getDisplayValues());
    var name = ChecklistCaseContext_nameKey(overview.contactPerson);
    ctx.contacts.forEach(function (contact) {
      if (contact.role !== 'お客様' || !ChecklistCaseContext_assigned(contact) || !name || ChecklistCaseContext_nameKey(contact.name) !== name) return;
      if (!contact.tel) contact.tel = StaffDrivers_normalizeTel(overview.contactTel);
      if (!contact.email) contact.email = overview.contactMail || '';
    });
  });
  [['director', 'ディレクター'], ['supervisor', '現場監督']].forEach(function (entry) {
    if (!config[entry[0] + 'Name'] && config[entry[0] + 'Tel']) {
      var contact = ctx.contacts.filter(function (c) { return c.role === entry[1]; })[0];
      if (contact) { contact.tel = config[entry[0] + 'Tel']; contact.telSource = '確定'; }
    }
  });
  if (ChecklistCaseContext_director(ctx).role !== 'ディレクター') warn('ディレクター連絡先が未登録');
  ctx.contacts.forEach(function (c) {
    var rawTel = c.tel;
    c.tel = StaffDrivers_normalizeTel(rawTel);
    if (!c.tel && rawTel && !c.line) c.line = rawTel;
    if (ChecklistCaseContext_assigned(c) && !c.tel && !c.line && !c.email) warn(c.role + ' ' + c.name + 'の電話番号が未登録');
  });
  ctx.vehicles.forEach(function (v) { if (!v.driver) warn(v.label + 'のドライバーが未登録'); });
  var spec = ctx.venue && attempt('会場の駐車場設定を取得できません', function () { return VenueParkingSpec_get(ctx.venue); });
  if (spec && spec.loadingDock) ctx.dock = {
    name: spec.loadingDock.name,
    mapUrl: spec.loadingDock.mapUrl,
    driverRoute: spec.loadingDock.driverRoute,
    staffRoute: spec.loadingDock.staffRoute,
    source: spec.loadingDock.source
  };
  if (config.parkingName) ctx.parking = { status: '確定', source: '確定',
    primary: { name: config.parkingName, note: config.parkingNote || '', url: config.parkingUrl || '' }, backups: [], ng: [] };
  else {
    var fixed = spec && (spec.candidates || []).filter(function (p) { return p.fixed === true; })[0];
    var confirmedDocParking = parsed && parsed.parking.status === '確定';
    function parkingCandidate(p) {
      return { name: p.name, url: p.url || '', mapUrl: p.mapUrl || '', note: [p.address, p.mapUrl ? '地図: ' + p.mapUrl : '', p.feeText, p.note,
        p.heightLimitMm == null ? '高さ制限: 資料で確認' : '高さ制限: ' + p.heightLimitMm + 'mm',
        p.weightLimitKg == null ? '重量制限: 資料で確認' : '重量制限: ' + p.weightLimitKg + 'kg'].filter(Boolean).join('\n') };
    }
    if (fixed) {
      ctx.parking.status = '確定';
      ctx.parking.source = '会場の既定';
      ctx.parking.primary = parkingCandidate(fixed);
      ctx.parking.ng = spec.knownUnusable || [];
    } else if (confirmedDocParking) {
      ctx.parking = parsed.parking;
      ctx.parking.source = '搬入出計画';
    }
    if (ctx.venue && (fixed || (!confirmedDocParking && ctx.vehicles.length))) attempt('駐車場候補を取得できません', function () {
      var recommendation = VenueParkingSpec_recommendFor(ctx.venue, ctx.vehicles.map(function (v) { return v.key === 'キャラバン' ? '日産キャラバン' : v.key; }));
      var candidates = (recommendation.ok || []).filter(function (p) { return !p.fixed; }).slice()
        .sort(function (a, b) { return (a.rank === '本命' ? 0 : 1) - (b.rank === '本命' ? 0 : 1); }).map(parkingCandidate);
      if (!fixed) {
        ctx.parking.primary = candidates.shift() || null;
        if (ctx.parking.primary) ctx.parking.status = '候補';
      }
      ctx.parking.backups = candidates;
      ctx.parking.ng = (recommendation.knownUnusable || []).concat((recommendation.ng || []).map(function (p) { return { name: p.candidate.name, reason: p.ng.join(' / ') }; }));
    });
    // 古いDocの「未確定」だけでは、会場の既定・候補を消さない。
    if (!ctx.parking.primary && parsed && parsed.parking.primary) {
      ctx.parking = parsed.parking;
      ctx.parking.source = '搬入出計画';
    }
  }
  if (ctx.parking.status !== '確定') warn('駐車場が未確定。ディレクターに確認');
  if (ctx.docs.construction) attempt('施工手順書を読めません', function () {
    ctx.mustRules = ChecklistCaseContext_readMustRules(DocumentApp.openById(ChecklistCaseContext_fileIdFromUrl(ctx.docs.construction)).getBody());
    if (!ctx.mustRules.length) warn('施工手順書の「絶対に守るべきこと」が未登録');
  });
  ctx.warnings = ctx.warnings.filter(function (message) {
    if (ctx.vehiclesSource !== '推定' && /使用車両を計算/.test(message)) return false;
    if (config.parkingName && /駐車場/.test(message)) return false;
    if (config.directorName && config.directorTel && /^ディレクター.*(?:連絡先|電話番号)が未登録$/.test(message)) return false;
    if (config.supervisorName && config.supervisorTel && /^現場監督.*(?:連絡先|電話番号)が未登録$/.test(message)) return false;
    return true;
  });
  if (cache) attempt('キャッシュを保存できません', function () { cache.put(cacheKey, JSON.stringify(ctx), 600); });
  return ctx;
}

/** 会場内マップとみなすファイル名・資料種別。自社のレイアウトシート・見積などは除く。 */
var CHECKLIST_BOOTH_MAP_PATTERN = /会場内マップ|会場マップ|小間割|小間配置|小間位置図|会場レイアウト|全体レイアウト|フロアマップ|フロアプラン|会場図|floor\s*plan/i;
var CHECKLIST_BOOTH_MAP_EXCLUDE = /見積|請求|施工手順|搬入出|レイアウトシート|運営計画/;

function ChecklistCaseContext_absoluteMapUrl(url) {
  url = String(url || '').trim();
  if (/^\/file\//i.test(url)) return 'https://drive.google.com' + url;
  if (/^\//.test(url)) return 'https://docs.google.com' + url;
  return url;
}

/** Drive / Docs ではない、社外から開ける可能性のある絶対 HTTP(S) URL かを返す純関数。 */
function ChecklistCaseContext_isPublicMapUrl(url) {
  var match = /^https?:\/\/([^\/:?#]+)(?=[\/:?#]|$)/i.exec(String(url || '').trim());
  if (!match) return false;
  var host = match[1].toLowerCase();
  return host !== 'drive.google.com' && host !== 'docs.google.com';
}

function ChecklistCaseContext_boothMapArtifactCandidates(artifacts) {
  return (artifacts || []).filter(function (a) {
    var text = String(a && a.type || '') + ' ' + String(a && a.title || '');
    return a && a.url && CHECKLIST_BOOTH_MAP_PATTERN.test(text) && !CHECKLIST_BOOTH_MAP_EXCLUDE.test(String(a.type || ''));
  }).map(function (a) {
    return { artifact: a, url: ChecklistCaseContext_absoluteMapUrl(a.url) };
  });
}

function ChecklistCaseContext_mapFromArtifactCandidate(candidate) {
  var a = candidate.artifact;
  return { url: candidate.url, name: String(a.title || a.type || '会場内マップ'), source: '資料台帳' };
}

/** 資料台帳から会場内マップを選ぶ純関数。公開URLを優先し、同じ区分では新しい登録を優先する。 */
function ChecklistCaseContext_pickBoothMap(artifacts) {
  var hits = ChecklistCaseContext_boothMapArtifactCandidates(artifacts).sort(function (a, b) {
    return (ChecklistCaseContext_isPublicMapUrl(b.url) ? 1 : 0) - (ChecklistCaseContext_isPublicMapUrl(a.url) ? 1 : 0) ||
      String(b.artifact.createdAt || '').localeCompare(String(a.artifact.createdAt || ''));
  });
  if (!hits.length) return null;
  return ChecklistCaseContext_mapFromArtifactCandidate(hits[0]);
}

/** 資料台帳から公開URLの会場内マップだけを、新しい登録優先で選ぶ純関数。 */
function ChecklistCaseContext_pickPublicBoothMap(artifacts) {
  var hits = ChecklistCaseContext_boothMapArtifactCandidates(artifacts).filter(function (candidate) {
    return ChecklistCaseContext_isPublicMapUrl(candidate.url);
  }).sort(function (a, b) {
    return String(b.artifact.createdAt || '').localeCompare(String(a.artifact.createdAt || ''));
  });
  return hits.length ? ChecklistCaseContext_mapFromArtifactCandidate(hits[0]) : null;
}

/** 候補ファイル（{name,url,updated}）から会場内マップを選ぶ純関数。「動線」入りを優先し、次に更新日時の新しい順。 */
function ChecklistCaseContext_rankBoothMapFiles(files) {
  var hits = (files || []).filter(function (f) {
    return f && f.url && CHECKLIST_BOOTH_MAP_PATTERN.test(String(f.name || '')) && !CHECKLIST_BOOTH_MAP_EXCLUDE.test(String(f.name || ''));
  }).sort(function (a, b) {
    return (/動線/.test(b.name) ? 1 : 0) - (/動線/.test(a.name) ? 1 : 0) || String(b.updated || '').localeCompare(String(a.updated || ''));
  });
  return hits.length ? { url: hits[0].url, name: hits[0].name, source: '案件フォルダ' } : null;
}

/** 案件フォルダ（深さ3・最大80フォルダ）から会場内マップの候補ファイルを集めて選ぶ。 */
function ChecklistCaseContext_findBoothMapInFolders(folderIds) {
  var seen = Object.create(null), files = [], level = [], visited = 0;
  (folderIds || []).forEach(function (fid) {
    fid = String(fid || '').trim();
    if (!fid || seen[fid]) return;
    seen[fid] = true;
    try { level.push(DriveApp.getFolderById(fid)); } catch (e) {}
  });
  for (var depth = 0; depth < 4 && level.length && visited < 80; depth++) {
    var next = [];
    level.forEach(function (folder) {
      if (visited >= 80) return;
      visited++;
      var it = folder.getFiles();
      while (it.hasNext()) {
        var f = it.next();
        if (CHECKLIST_BOOTH_MAP_PATTERN.test(f.getName())) files.push({ name: f.getName(), url: f.getUrl(), updated: f.getLastUpdated().toISOString() });
      }
      if (depth < 3) {
        var sub = folder.getFolders();
        while (sub.hasNext()) {
          var s = sub.next();
          if (!seen[s.getId()]) { seen[s.getId()] = true; next.push(s); }
        }
      }
    });
    level = next;
  }
  return ChecklistCaseContext_rankBoothMapFiles(files);
}

/**
 * 会場内マップを「リンクを知っている全員が閲覧可」にする。他人所有で共有を変えられない時は、
 * アプリ実行者の持ち物として共有用コピーを作り、資料台帳に「会場内マップ」で登録して次回から使う（cr 指示 2026-10-19: 設営会社様も開けること）。
 */
function ChecklistCaseContext_ensureBoothMapShared(caseId, map) {
  var mapId = ChecklistCaseContext_fileIdFromUrl(map && map.url);
  if (!mapId) return { ok: true, map: map };
  var cache = null;
  var cacheKey = 'boothmap:shareng:' + mapId;
  try {
    cache = CacheService.getScriptCache();
    var cachedError = cache.get(cacheKey);
    if (cachedError) return { ok: false, map: map, error: cachedError };
  } catch (cacheError) { /* キャッシュが使えなければ通常処理を続ける */ }
  var state = ConstructionPlan_readShareState(mapId);
  if (state.ok && state.anyone) return { ok: true, map: map };
  var direct = ConstructionPlan_shareAnyoneWithLink(mapId);
  if (direct.ok) return { ok: true, map: map };
  try {
    var original = DriveApp.getFileById(mapId);
    var parents = original.getParents();
    var name = original.getName().replace(/(\.[A-Za-z0-9]+)?$/, '（当日アプリ共有用）$1');
    var copy, created = false;
    if (parents.hasNext()) {
      var parent = parents.next();
      var existing = parent.getFilesByName(name);
      if (existing.hasNext()) copy = existing.next();
      else { copy = original.makeCopy(name, parent); created = true; }
    } else {
      copy = original.makeCopy(name);
      created = true;
    }
    try {
      copy.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    } catch (sharingError) {
      var shouldTrash = created;
      if (!shouldTrash) try {
        shouldTrash = copy.getOwner().getEmail() === Session.getEffectiveUser().getEmail();
      } catch (ownerError) { /* 所有者を確認できなければ再利用ファイルは残す */ }
      if (shouldTrash) try { copy.setTrashed(true); } catch (trashError) { /* 後始末失敗は無視 */ }
      var errorText = '社外向けのリンク共有が組織の設定で許可されていません（' + String(sharingError && sharingError.message || sharingError) + '）。社内アカウントでは開けます';
      if (cache) try { cache.put(cacheKey, errorText, 21600); } catch (cachePutError) { /* キャッシュ保存失敗は無視 */ }
      return { ok: false, map: map, error: errorText };
    }
    var url = 'https://drive.google.com/file/d/' + copy.getId() + '/view';
    try {
      MasterWriteBack_recordArtifact(caseId, '会場内マップ', (map.name || original.getName()) + '（共有用コピー）', url,
        '元ファイル ' + mapId + ' は共有を変えられないため当日アプリがコピー');
    } catch (e) { /* 台帳登録に失敗してもこの回の表示は続ける */ }
    return { ok: true, map: { url: url, name: map.name, source: map.source + '（共有用コピー）' } };
  } catch (e) {
    return { ok: false, map: map, error: String(e && e.message || e) };
  }
}

/** ブースの場所の項目本文。 */
function ChecklistCaseContext_boothDetail(ctx) {
  var lines = [ctx.boothNo
    ? '搬入口から入ったら、会場内マップで小間「' + ctx.boothNo + '」の場所を確かめてから向かう。'
    : '搬入口から入ったら、会場内マップでブースの場所を確かめてから向かう。'];
  lines.push(ctx.boothMap ? '会場内マップ: ' + ctx.boothMap.url : '会場内マップは未登録。ディレクターに確認');
  return lines.join('\n');
}

/** 集合場所までの役割別の入り方と地図を返す。 */
function ChecklistCaseContext_meetingDetail(ctx, role) {
  var lines = [];
  if (role === 'ドライバー') {
    var parking = ctx.parking;
    if (parking && parking.status === '確定' && parking.primary && parking.primary.name) {
      lines.push('駐車場: ' + parking.primary.name);
      var parkingMap = parking.primary.mapUrl || parking.primary.url;
      if (parkingMap) lines.push('地図: ' + parkingMap);
    }
    if (ctx.dock && ctx.dock.driverRoute) lines.push('搬入口へ: ' + ctx.dock.driverRoute);
  } else if (ctx.dock) {
    if (ctx.dock.staffRoute) lines.push('入り方: ' + ctx.dock.staffRoute);
    if (ctx.dock.mapUrl) lines.push('地図: ' + ctx.dock.mapUrl);
  }
  return lines.join('\n');
}

/** 集合場所は案件設定を優先し、役割ごとに確定済みの値だけで補う。 */
function ChecklistCaseContext_meetingPoint(ctx, role) {
  if (ctx.meetingPoint) return ctx.meetingPoint;
  if (role === 'ドライバー') {
    var parking = ctx.parking;
    return parking && parking.status === '確定' && parking.primary && parking.primary.name
      ? '会場付近の駐車場: ' + parking.primary.name : '';
  }
  return ctx.venue ? ctx.venue + (ctx.boothNo ? ' 小間 ' + ctx.boothNo : '') + (ctx.dock ? ' の搬入口' : '') : '';
}

/** テンプレートを変更せずに案件の値を埋める純関数。 */
function Checklist_applyContext(item, ctx, vehicle, role) {
  var key = Checklist_normalizeVehicleName(vehicle);
  var selected = (ctx.vehicles || []).filter(function (v) { return v.key === key; })[0];
  var leg = selected && (ctx.legs || []).filter(function (l) { return Checklist_normalizeVehicleName(l.vehicle) === key; })[0];
  var director = ChecklistCaseContext_director(ctx);
  var directorMissing = !director.name || /^(未定|未確定|未アサイン|要確認|⚠未確定)/.test(director.name);
  var supervisor = (ctx.contacts || []).filter(function (c) { return c.role === '現場監督'; })[0] || {};
  var parking = ctx.parking && ctx.parking.status === '確定' && ctx.parking.primary;
  var values = { parking: parking && parking.name, parking_note: parking && parking.note,
    director: director.name, director_tel: ChecklistCaseContext_contactMethod(director).value, supervisor: supervisor.name,
    vehicle: selected && selected.label, depart: leg && leg.depart, arrive: leg && leg.arrive, venue: ctx.venue,
    meeting: ChecklistCaseContext_meetingPoint(ctx, role || item.role) || ctx.venue || '' };
  var result = Object.assign({}, item), missing = (item.missing || []).slice();
  ['title', 'detail'].forEach(function (field) {
    var template = String(item[field] || '');
    if (field === 'detail' && item.title === '集合場所に到着したら到着報告') template = template.replace(/^\{\{venue\}\}/, '{{meeting}}');
    result[field] = template.replace(/\{\{(parking|parking_note|director|director_tel|supervisor|vehicle|depart|arrive|venue|meeting)\}\}/g, function (_, name) {
      var value = values[name];
      if (name === 'meeting') return String(value || '');
      if (!value || /^(未定|未確定|未アサイン|要確認|⚠未確定)/.test(String(value))) {
        if (missing.indexOf(name) < 0) missing.push(name);
        if (name === 'director') return '⚠ディレクター未登録';
        if (name === 'director_tel' && directorMissing) return '';
        return '⚠未確定';
      }
      return String(value);
    });
  });
  if (missing.length) result.missing = missing;
  return result;
}

function Checklist_contextItems(items, ctx, role, day, vehicle, staffName) {
  var result = items.map(function (item) { return Checklist_applyContext(item, ctx, vehicle, role); });
  function dynamic(kind, title, detail) {
    return Checklist_applyContext({ id: 'dyn:' + kind + ':' + ctx.caseId, type: 'dynamic', role: role, day: day,
      title: title, detail: detail || '', required: true, active: true, url: '' }, ctx, vehicle);
  }
  if (role === 'ドライバー' && ['設営前日', '設営初日'].indexOf(day) >= 0) {
    var p = ctx.parking || ChecklistCaseContext_emptyParking();
    var parkingTitle = p.status === '確定' && p.primary ? '🅿 {{parking}} へ向かう'
      : p.status === '候補' && p.primary ? '🅿 駐車場候補: ' + p.primary.name + '（ディレクター確認要）'
      : '🅿 駐車場が未確定。ディレクターに確認';
    var parkingDetail = p.status === '確定' && p.primary ? (p.primary.note || '') + '\n高さ・重量制限を車両の外寸・総重量と照合してください。\n' + (p.primary.url || '')
      : p.status === '候補' && p.primary ? [p.primary].concat(p.backups || []).map(function (candidate) {
        return [candidate.name, candidate.note, candidate.url].filter(Boolean).join('\n');
      }).join('\n\n') : '{{director}} {{director_tel}}';
    var parking = dynamic('parking', parkingTitle, parkingDetail);
    parking.source = p.source;
    if (p.status !== '確定') parking.missing = (parking.missing || []).concat(['parking']);
    if (p.ng && p.ng.length) parking.detail += '\n利用不可: ' + p.ng.map(function (n) { return n.name + '（' + n.reason + '）'; }).join(' / ');
    var additions = [parking], key = Checklist_normalizeVehicleName(vehicle);
    if ((ctx.vehicles || []).some(function (v) { return v.key === key; })) {
      var legs = (ctx.legs || []).filter(function (l) { return Checklist_normalizeVehicleName(l.vehicle) === key; });
      // 搬入出計画 Doc 自体が無いときは「発 ⚠未確定 → 着 ⚠未確定」の空項目を出さない（実機で見苦しかった）
      if (!legs.length && ctx.docs && ctx.docs.logistics) additions.push(dynamic('leg:' + key, '🚚 {{vehicle}} 発 {{depart}} → 着 {{arrive}}', '搬入出計画で行程を確認してください。'));
      legs.forEach(function (l, index) {
        var legCtx = Object.assign({}, ctx, { legs: [l] });
        var item = dynamic('leg:' + key + ':' + index, '', '');
        item.title = '🚚 {{vehicle}} 発 {{depart}} → 着 {{arrive}}';
        item.detail = l.driver ? 'ドライバー: ' + l.driver : 'ドライバー: ⚠未確定';
        additions.push(Checklist_applyContext(item, legCtx, vehicle));
      });
    }
    var after = result.findIndex(function (i) { return i.type === 'vehicle_doc' || i.title.indexOf('乗る車のマニュアル') >= 0; });
    result.splice.apply(result, [after < 0 ? Math.min(1, result.length) : after + 1, 0].concat(additions));
  }
  if (role === 'ドライバー') {
    var selected = (ctx.vehicles || []).filter(function (v) { return v.key === Checklist_normalizeVehicleName(vehicle); })[0];
    var drivers = selected && selected.drivers || [];
    var normalizeName = function (name) { return String(name || '').normalize('NFKC').replace(/[\s　]+/g, ''); };
    var own = drivers.filter(function (s) { return normalizeName(staffName) && normalizeName(s.name) === normalizeName(staffName); });
    (own.length ? own : drivers).forEach(function (s) {
      var item = dynamic('schedule:' + selected.key + ':' + Checklist_contextHash([s.date, s.name, s.in, s.out].join('|')),
        '🕒 ' + s.date + ' 入 ' + (s.in || '⚠未定') + ' → 出 ' + (s.out || '⚠未定'),
        s.name + (s.tel ? '（' + s.tel + '）' : ''));
      if (!result.some(function (existing) { return existing.id === item.id; })) result.push(item);
    });
  }
  // DIY 展示台を使わない案件では組立マニュアル項目を出さない（cr 指示 2026-10-18 W2）。
  if (ctx.diyInUse === false) result = result.filter(function (i) { return !/DIY/.test(i.title); });
  // 到着連絡・施工手順書・手順は作業項目より先に置く（cr 指摘 2026-10-18: 到着連絡がトラス設置の後ろに出ていた）。
  var head = [];
  if (role !== 'ドライバー') {
    head = result.filter(function (i) { return /到着/.test(i.title); });
    result = result.filter(function (i) { return head.indexOf(i) < 0; });
  }
  if (['設営初日', '本番日'].indexOf(day) >= 0 && !head.concat(result).some(function (i) { return /到着/.test(i.title); })) {
    var director = ChecklistCaseContext_director(ctx);
    head.push(dynamic('contact', '📞 到着したら {{director}} へ連絡', ChecklistCaseContext_contactMethod(director).label + ': {{director_tel}}'));
  }
  if (ctx.docs && ctx.docs.constructionSlides && /^(設営|撤収)/.test(day)) {
    var manual = dynamic('manual', '🛠 施工手順書を開く', '作業の前に該当ページを確認する。下の各手順の「開く」から該当ページへ飛べます。');
    manual.url = ctx.docs.constructionSlides;
    head.push(manual);
    (ctx.manualSteps || []).filter(function (s) { return s.day === day; }).forEach(function (s) {
      var step = dynamic('step:' + Checklist_contextHash(s.title), '📘 ' + s.title + '（手順書 p.' + s.page + '）', s.detail);
      step.url = s.url;
      head.push(step);
    });
  }
  result = head.concat(result);
  if (Checklist_normalizeRole(role) === CHECKLIST_LEAD_ROLE && (ctx.officeContacts || []).length) {
    result.push(dynamic('officeContacts', '🏢 社内連絡先', ctx.officeContacts.map(function (contact) {
      var method = ChecklistCaseContext_contactMethod(contact);
      return contact.role + ' ' + contact.name + ' / ' + [method.value ? method.label + ': ' + method.value : '',
        contact.email && method.label !== 'メール' ? 'メール: mailto:' + contact.email : ''].filter(Boolean).join(' / ');
    }).join('\n')));
  }
  // 名前の無いお客様行（テンプレの空行）は「⚠未定」として出さない（実機で空行 1 件がノイズになった）
  if (Checklist_normalizeRole(role) === CHECKLIST_LEAD_ROLE && day === '本番日') (ctx.contacts || []).filter(function (c) { return c.role === 'お客様' && ChecklistCaseContext_assigned(c); }).forEach(function (c) {
    result.push(dynamic('customer:' + Checklist_contextHash(c.name), '👤 お客様: ' + c.name + (c.tel ? '（' + c.tel + '）' : ''),
      ChecklistCaseContext_contactMethod(c).value ? ChecklistCaseContext_contactMethod(c).label + ': ' + ChecklistCaseContext_contactMethod(c).value : '連絡先は実施計画書で確認'));
  });
  if (day === '設営初日') (ctx.mustRules || []).slice(0, 8).forEach(function (rule) {
    // 文面が変わったルールは別IDにし、以前の「完了」を誤って引き継がない。
    result.push(dynamic('rule:' + Checklist_contextHash(rule), '🛑 絶対に守る: ' + rule.slice(0, 120)));
  });
  var meetingPoint = ChecklistCaseContext_meetingPoint(ctx, role);
  if (meetingPoint) {
    var meetingDetail = ChecklistCaseContext_meetingDetail(ctx, role);
    if (!ctx.meetingPoint) meetingDetail = [meetingDetail, '（案件設定で変更できます）'].filter(Boolean).join('\n');
    var meeting = dynamic('meeting:' + Checklist_contextHash(meetingPoint), '📍 集合場所: ' + meetingPoint,
      meetingDetail);
    if (!ctx.meetingPoint) meeting.source = '既定';
    result.unshift(meeting);
  }
  // 搬入口から入った後に迷わないよう、小間番号と会場内マップを全案件・全役割に出す（cr 指示 2026-10-19）。
  if (/^(設営|本番|撤収)/.test(day) && day !== '設営前日') {
    var booth = dynamic('booth:' + Checklist_contextHash([ctx.boothNo || '', ctx.boothMap ? ctx.boothMap.url : ''].join('|')),
      '🧭 ブースの場所: ' + (ctx.boothNo ? '小間 ' + ctx.boothNo : '小間番号は未登録（ディレクターに確認）'),
      ChecklistCaseContext_boothDetail(ctx));
    if (ctx.boothMap) booth.url = ctx.boothMap.url;
    if (!ctx.boothNo) booth.missing = (booth.missing || []).concat(['boothNo']);
    result.splice(meetingPoint ? 1 : 0, 0, booth);
  }
  String(ctx.notes || '').split(/\r?\n/).map(function (line) { return line.trim(); }).filter(function (line, i, all) {
    return line && all.indexOf(line) === i;
  }).forEach(function (line) {
    result.push(dynamic('note:' + Checklist_contextHash(line), '📝 ' + line));
  });
  return result;
}

/** 既存のruleと同じハッシュ。文面が変われば完了状態を引き継がない。 */
function Checklist_contextHash(text) {
  var hash = 0;
  for (var i = 0; i < text.length; i++) hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  return (hash >>> 0).toString(36);
}

/** 施工手順書スライドを読み、ページごとの行（上→下、左→右）を ChecklistCaseContext_slideSteps へ渡す。 */
function ChecklistCaseContext_readSlideSteps(deck, deckUrl) {
  var pages = deck.getSlides().map(function (slide, index) {
    var boxes = [];
    slide.getPageElements().forEach(function (el) {
      var type = el.getPageElementType();
      if (type === SlidesApp.PageElementType.SHAPE) {
        boxes.push({ top: el.getTop(), left: el.getLeft(), text: el.asShape().getText().asString() });
      } else if (type === SlidesApp.PageElementType.TABLE) {
        var table = el.asTable(), rows = [];
        for (var r = 0; r < table.getNumRows(); r++) {
          var cells = [];
          for (var c = 0; c < table.getRow(r).getNumCells(); c++) {
            try { cells.push(table.getCell(r, c).getText().asString().trim()); } catch (e) {}
          }
          rows.push(cells.filter(Boolean).join(' / '));
        }
        boxes.push({ top: el.getTop(), left: el.getLeft(), text: rows.join('\n') });
      }
    });
    boxes.sort(function (a, b) { return Math.round(a.top - b.top) || a.left - b.left; });
    var lines = [];
    boxes.forEach(function (b) {
      String(b.text || '').split(/\r?\n|\u000b/).forEach(function (l) { l = l.trim(); if (l) lines.push(l); });
    });
    return { page: index + 1, objectId: slide.getObjectId(), lines: lines };
  });
  return ChecklistCaseContext_slideSteps(pages, deckUrl);
}

/** スライドの行から現場の手順項目を作る純関数。設営・撤去・手順A/B のページだけを対象にし、P工程の見出しがあれば工程ごとに分ける。 */
function ChecklistCaseContext_slideSteps(pages, deckUrl) {
  var base = String(deckUrl || '').replace(/\/edit.*$/, '') + '/edit';
  var steps = [];
  (pages || []).forEach(function (p) {
    var lines = (p.lines || []).filter(function (l) { return !/^\d+$/.test(l) && !/施工手順書\s*v\d/.test(l); });
    var section = lines[0] || '', title = lines[1] || '';
    if (!/設営|撤去|撤収|^手順/.test(section) || /班分け|スケジュール|予備日|持ち物/.test(title)) return;
    var url = base + '#slide=id.' + p.objectId;
    var body = lines.slice(2), blocks = [];
    body.forEach(function (line) {
      if (/^P\d+\s/.test(line)) blocks.push({ title: line, lines: [] });
      else if (blocks.length) blocks[blocks.length - 1].lines.push(line);
    });
    if (!blocks.length) blocks.push({ title: /^P\d+/.test(title) ? title : section.replace(/\s*\/.*$/, '') + '：' + title, lines: body });
    blocks.forEach(function (b) {
      steps.push({ page: p.page, url: url, title: b.title,
        day: /撤去|撤収/.test(section) ? '撤収日' : /2日目/.test(b.title) ? '設営二日目' : '設営初日',
        detail: b.lines.join('\n').slice(0, 800) });
    });
  });
  return steps;
}
