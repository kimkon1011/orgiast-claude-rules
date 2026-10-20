/**
 * スタッフリストからドライバー情報を抽出・管理するモジュール。
 */

const STAFF_COLUMN_DEFINITIONS = {
  role:   { names: ['主な業務', '業務', '役割'] },
  name:   { names: ['名前', '氏名'] },
  tel:    { names: ['連絡先 TEL', '連絡先', 'TEL', '電話番号', '携帯'] },
  status: { names: ['手配状況', '手配'] }
};

const TRUCK_ALIASES = {
  'デュトロ': ['デュトロ'],
  '日産キャラバン': ['キャラバン'],
  'トヨエース': ['トヨエース'],
  '2トン ロング箱車': ['2トンロング', '２トンロング', '2tロング'],
  '2トン ショート箱車': ['2トンショート'],
  '4トン 標準箱車': ['4トン', '４トン'],
  '軽トラック 標準': ['軽トラ']
};

function normalizeHeaderCell(cell) {
  if (cell === null || cell === undefined) return '';
  return String(cell).replace(/[\s\r\n　]+/g, '');
}

function indexToColLetter(index) {
  let letter = '';
  let temp = index;
  while (temp >= 0) {
    letter = String.fromCharCode((temp % 26) + 65) + letter;
    temp = Math.floor(temp / 26) - 1;
  }
  return letter;
}

function StaffDrivers_resolveColumns(headerRow) {
  const result = {
    columns: { role: -1, name: -1, tel: -1, status: -1 },
    warnings: []
  };
  
  if (!headerRow || !Array.isArray(headerRow)) {
    return result;
  }

  const keys = ['role', 'name', 'tel', 'status'];
  
  keys.forEach(function (key) {
    const def = STAFF_COLUMN_DEFINITIONS[key];
    const candidates = def.names;
    
    // 1. Try complete matches (完全一致)
    let foundIndices = [];
    let matchedCandidateName = '';
    
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      const normCandidate = normalizeHeaderCell(candidate);
      
      const currentMatches = [];
      for (let colIdx = 0; colIdx < headerRow.length; colIdx++) {
        if (normalizeHeaderCell(headerRow[colIdx]) === normCandidate) {
          currentMatches.push(colIdx);
        }
      }
      
      if (currentMatches.length > 0) {
        foundIndices = currentMatches;
        matchedCandidateName = candidate;
        break;
      }
    }
    
    // 2. Try prefix matches (前方一致)
    if (foundIndices.length === 0) {
      for (let i = 0; i < candidates.length; i++) {
        const candidate = candidates[i];
        const normCandidate = normalizeHeaderCell(candidate);
        
        const currentMatches = [];
        for (let colIdx = 0; colIdx < headerRow.length; colIdx++) {
          const normCell = normalizeHeaderCell(headerRow[colIdx]);
          if (normCell && normCell.indexOf(normCandidate) === 0) {
            currentMatches.push(colIdx);
          }
        }
        
        if (currentMatches.length > 0) {
          foundIndices = currentMatches;
          matchedCandidateName = candidate;
          break;
        }
      }
    }
    
    // Process matches
    if (foundIndices.length > 0) {
      if (foundIndices.length > 1) {
        const letters = foundIndices.map(indexToColLetter).join(', ');
        result.warnings.push('列名が重複: ' + matchedCandidateName + ' → ' + letters + '（先頭を使用）');
      }
      result.columns[key] = foundIndices[0];
    } else {
      const primaryName = candidates[0];
      result.warnings.push('列が見つかりません: ' + primaryName);
    }
  });
  
  return result;
}

// Substring list sorted by length descending
let cachedSearchList = null;
function getSearchList() {
  if (cachedSearchList) return cachedSearchList;
  
  const list = [];
  
  // 1. Add all aliases from TRUCK_ALIASES
  Object.keys(TRUCK_ALIASES).forEach(function (vehicle) {
    const aliases = TRUCK_ALIASES[vehicle];
    aliases.forEach(function (alias) {
      list.push({ substring: alias, vehicleName: vehicle });
    });
    // Ensure the vehicle key itself is also checked
    if (aliases.indexOf(vehicle) === -1) {
      list.push({ substring: vehicle, vehicleName: vehicle });
    }
  });
  
  // 2. Add keys from TRUCK_EXTERIOR_SPECS if defined globally or from require
  // (We define them here as a fallback to avoid hard dependency at runtime)
  const knownSpecs = [
    'デュトロ', '日産キャラバン', 'トヨエース', '軽トラック 標準', '軽トラック ハイルーフ',
    '2トン ショート箱車', '2トン ロング箱車', '2トン ワイドロング箱車',
    '4トン 標準箱車', '4トン セミワイド箱車', '4トン フルワイド箱車'
  ];
  knownSpecs.forEach(function (vehicle) {
    let exists = false;
    for (let i = 0; i < list.length; i++) {
      if (list[i].substring === vehicle) {
        exists = true;
        break;
      }
    }
    if (!exists) {
      list.push({ substring: vehicle, vehicleName: vehicle });
    }
  });
  
  // Sort by length descending
  list.sort(function (a, b) {
    return b.substring.length - a.substring.length;
  });
  
  cachedSearchList = list;
  return list;
}

function StaffDrivers_detectVehicle(roleText) {
  if (!roleText) return null;
  const list = getSearchList();
  for (let i = 0; i < list.length; i++) {
    if (roleText.indexOf(list[i].substring) !== -1) {
      return list[i].vehicleName;
    }
  }
  return null;
}

function StaffDrivers_normalizeTel(raw) {
  if (raw === null || raw === undefined) return '';
  let s = String(raw).trim();
  if (!s || /^[@＠]/.test(s)) return '';
  
  // Convert full-width numbers to half-width
  s = s.replace(/[０-９]/g, function (m) {
    return String.fromCharCode(m.charCodeAt(0) - 0xFEE0);
  });
  
  // Convert full-width hyphens/dashes to half-width hyphen
  s = s.replace(/[－ー—‐]/g, '-');
  
  s = s.trim();
  if (s === '-' || s === '' || s.indexOf('確認中') !== -1 || s.indexOf('未定') !== -1 || s.indexOf('なし') !== -1) {
    return '';
  }
  const digits = s.replace(/\D/g, '');
  return digits.length >= 10 && digits.length <= 11 ? s : '';
}

/** チェックリストとスタッフ照合で共用する車両キー。レンタル名は保持する。 */
function Checklist_normalizeVehicleName(name) {
  const value = String(name || '').normalize('NFKC').trim();
  return value === '日産キャラバン' ? TRUCK_ALIASES['日産キャラバン'][0] : value;
}

function StaffDrivers_fetch(zissiSpreadsheet) {
  return StaffDrivers_fetchRows_(zissiSpreadsheet, false);
}

/** 列解決と電話番号整形を共有し、ドライバー以外の担当者も返す。 */
function StaffDrivers_fetchAll(zissiSpreadsheet) {
  const result = StaffDrivers_fetchRows_(zissiSpreadsheet, true);
  result.staff = result.drivers;
  return result;
}

function StaffDrivers_unassignedReason(name) {
  const value = String(name || '').normalize('NFKC').trim().replace(/^\(\s*(.*?)\s*\)$/, '$1');
  if (value === '不要') return '不要';
  return /^(?:[-−?]|未定|未確定|未アサイン|要アサイン|要確認|TBD)?$/i.test(value) ? '未定' : '';
}

function StaffDrivers_staffSheet_(zissiSpreadsheet) {
  if (!zissiSpreadsheet) return null;
  const sheets = zissiSpreadsheet.getSheets().filter(function (sheet) {
    return sheet.getName().indexOf('スタッフ') >= 0 &&
      sheet.getName().indexOf('プルダウン') < 0 &&
      sheet.getName().indexOf('更新案') < 0;
  });
  return sheets.filter(function (sheet) { return sheet.getName() === 'スタッフ'; })[0] || sheets[0] || null;
}

/** 次の表、セクション、連続3空行で打ち切る。1〜2空行は表内の余白。 */
function StaffDrivers_blockRows_(rows) {
  let blanks = 0;
  for (let i = 0; i < rows.length; i++) {
    if (/^(?:製作パート|主な業務|■)/.test(String(rows[i][0] || '').normalize('NFKC').trim())) return rows.slice(0, i);
    blanks = rows[i].every(function (cell) { return !String(cell == null ? '' : cell).trim(); }) ? blanks + 1 : 0;
    if (blanks >= 3) return rows.slice(0, i - 2);
  }
  return rows;
}

/** 製作パート専用。社内の連絡先欄は電話として解釈しない。 */
function StaffDrivers_fetchOfficeContacts(zissiSpreadsheet) {
  const sheet = StaffDrivers_staffSheet_(zissiSpreadsheet);
  if (!sheet) return [];
  const rows = StaffDrivers_displayValues_(sheet.getDataRange());
  const start = rows.findIndex(function (row) { return /^製作パート/.test(String(row[0] || '').trim()); });
  if (start < 0) return [];
  let blanks = 0;
  for (let i = start + 1; i < rows.length; i++) {
    const row = rows[i], first = String(row[0] || '').normalize('NFKC').trim();
    if (/^(?:製作パート|■|主な業務\(自動\))/.test(first)) break;
    blanks = row.every(function (cell) { return !String(cell || '').trim(); }) ? blanks + 1 : 0;
    if (blanks >= 3) break;
    const cols = StaffDrivers_resolveColumns(row).columns;
    if (cols.role < 0 || cols.name < 0) continue;
    const emailCol = row.findIndex(function (cell) { return /^(?:G-?MAIL|E-?MAIL|MAIL|メール(?:アドレス)?)$/i.test(normalizeHeaderCell(cell)); });
    return StaffDrivers_blockRows_(rows.slice(i + 1)).filter(function (r) {
      return String(r[cols.role] || '').trim() && !StaffDrivers_unassignedReason(r[cols.name]);
    }).map(function (r) {
      return { role: String(r[cols.role]).trim(), name: String(r[cols.name]).trim(),
        line: cols.tel >= 0 ? String(r[cols.tel] || '').trim() : '', email: emailCol >= 0 ? String(r[emailCol] || '').trim() : '' };
    });
  }
  return [];
}

/** 時刻は Sheets の表示値で読む。Date のシリアル値を画面へ渡さない。 */
function StaffDrivers_displayValues_(range) {
  return typeof range.getDisplayValues === 'function' ? range.getDisplayValues() : range.getValues();
}

/**
 * 日付見出しセルを "M月D日" に正規化する。認識できないセルは ''。
 * 対応: "10月19日" / "10/18" / "10/18(日)" / "2026/10/18" / Date 型。
 * 年は見出しに現れないため補わない(既存の "M月D日" と同じく月日だけを鍵にする)。
 */
function StaffDrivers_parseDateHeader_(cell) {
  if (Object.prototype.toString.call(cell) === '[object Date]') {
    if (isNaN(cell.getTime())) return '';
    return cell.getMonth() + 1 + '月' + cell.getDate() + '日';
  }
  const text = String(cell == null ? '' : cell).normalize('NFKC').trim();
  if (!text) return '';
  const kanji = /(\d{1,2})月\s*(\d{1,2})日/.exec(text);
  if (kanji) return Number(kanji[1]) + '月' + Number(kanji[2]) + '日';
  const slash = /(?:^|[^\d])(?:(\d{4})[\/.\-])?(\d{1,2})[\/.\-](\d{1,2})(?!\d)/.exec(text);
  if (slash) return Number(slash[2]) + '月' + Number(slash[3]) + '日';
  return '';
}

/** セル全体が日付だけのとき true(役割列のスキップ判定用。"ドライバー(10/19搬入)" 等は false)。 */
function StaffDrivers_isDateOnly_(cell) {
  if (Object.prototype.toString.call(cell) === '[object Date]') return !isNaN(cell.getTime());
  const text = String(cell == null ? '' : cell).normalize('NFKC').trim();
  return /^(?:(?:\d{4}[\/.\-])?\d{1,2}[\/.\-]\d{1,2}|\d{1,2}月\s*\d{1,2}日)\s*(?:\([^)]{1,3}\))?$/.test(text);
}

function StaffDrivers_dateBlocks_(rows, headerIndex, header) {
  for (let r = headerIndex - 1; r >= Math.max(0, headerIndex - 2); r--) {
    const dates = [];
    rows[r].forEach(function (cell, col) {
      const date = StaffDrivers_parseDateHeader_(cell);
      if (date) dates.push({ date: date, col: col });
    });
    if (!dates.length) continue;
    return dates.map(function (date, i) {
      const block = { date: date.date, inCol: -1, outCol: -1 };
      for (let col = date.col; col < (dates[i + 1] ? dates[i + 1].col : header.length); col++) {
        const label = normalizeHeaderCell(header[col]);
        if (label === '入時間') block.inCol = col;
        if (label === '出時間') block.outCol = col;
      }
      return block;
    }).filter(function (block) { return block.inCol >= 0 || block.outCol >= 0; });
  }
  return [];
}

function StaffDrivers_fetchRows_(zissiSpreadsheet, includeAll) {
  const result = {
    found: false,
    sheetName: null,
    headerRow: null,
    drivers: [],
    warnings: []
  };

  if (!zissiSpreadsheet) return result;

  const staffSheet = StaffDrivers_staffSheet_(zissiSpreadsheet);
  if (!staffSheet) {
    return result;
  }

  result.sheetName = staffSheet.getName();

  const lastRow = staffSheet.getLastRow();
  const lastCol = staffSheet.getLastColumn();
  if (lastRow === 0 || lastCol === 0) {
    return result;
  }

  const values = StaffDrivers_displayValues_(staffSheet.getRange(1, 1, Math.min(30, lastRow), lastCol));
  let headerRow = null;
  let headerRowIndex = -1;
  let dateBlocks = [];

  for (let r = 0; r < values.length; r++) {
    let row = values[r];
    if (/^(?:製作パート|主な業務\(自動\))/.test(String(row[0] || '').normalize('NFKC').trim())) break;
    let resolved = StaffDrivers_resolveColumns(row).columns;
    let headerHeight = 1;
    if (resolved.name >= 0 && resolved.tel < 0 && values[r + 1]) {
      const merged = row.map(function (cell, col) {
        return normalizeHeaderCell(cell) ? cell : values[r + 1][col];
      });
      const combined = StaffDrivers_resolveColumns(merged).columns;
      if (combined.role >= 0 && combined.name >= 0 && combined.tel >= 0) {
        row = merged;
        resolved = combined;
        headerHeight = 2;
      }
    }
    if (resolved.role >= 0 && resolved.name >= 0 && (includeAll || resolved.tel >= 0)) {
      headerRow = row;
      headerRowIndex = r + headerHeight;
      dateBlocks = StaffDrivers_dateBlocks_(values, r, row);
      break;
    }
  }

  if (!headerRow) {
    return result;
  }

  result.found = true;
  result.headerRow = headerRow;

  const colResolution = StaffDrivers_resolveColumns(headerRow);
  result.warnings = colResolution.warnings;

  const cols = colResolution.columns;
  if (cols.role === -1 || cols.name === -1) {
    return result;
  }

  if (lastRow <= headerRowIndex) return result;
  const emailCol = headerRow.findIndex(function (cell) { return /^(?:G-?MAIL|E-?MAIL|MAIL|メール(?:アドレス)?)$/i.test(normalizeHeaderCell(cell)); });
  const lineCol = headerRow.findIndex(function (cell) { return /^LINE(?:アカウント|ID)?$/i.test(normalizeHeaderCell(cell)); });
  const allRows = StaffDrivers_blockRows_(StaffDrivers_displayValues_(staffSheet.getRange(headerRowIndex + 1, 1, lastRow - headerRowIndex, lastCol)));
  for (let i = 0; i < allRows.length; i++) {
    const row = allRows[i];
    const roleVal = String(row[cols.role] || '').trim();
    if (!roleVal || StaffDrivers_isDateOnly_(roleVal)) continue;

    if (includeAll || roleVal.indexOf('ドライバー') !== -1 || roleVal.indexOf('運転') !== -1) {
      const rawName = row[cols.name];
      const nameVal = (rawName !== null && rawName !== undefined) ? String(rawName).trim() : '';
      const displayName = nameVal === '' ? '未アサイン' : nameVal;
      const reason = StaffDrivers_unassignedReason(nameVal);

      const rawTel = cols.tel !== -1 ? row[cols.tel] : null;
      const telVal = StaffDrivers_normalizeTel(rawTel);

      const rawStatus = cols.status !== -1 ? row[cols.status] : null;
      const statusVal = (rawStatus !== null && rawStatus !== undefined) ? String(rawStatus).trim() : '';

      const detectedVehicle = StaffDrivers_detectVehicle(roleVal);

      result.drivers.push({
        vehicle: detectedVehicle || '',
        roleLabel: roleVal,
        name: displayName,
        tel: telVal,
        line: [lineCol >= 0 ? String(row[lineCol] || '').trim() : '', !telVal ? String(rawTel || '').trim() : '']
          .filter(function (value, index, values) { return value && values.indexOf(value) === index; }).join(' / '),
        status: statusVal,
        assigned: !reason,
        unassignedReason: reason,
        email: emailCol >= 0 ? String(row[emailCol] || '').trim() : '',
        schedule: dateBlocks.map(function (block) {
          return { date: block.date, in: String(row[block.inCol] || '').trim(), out: String(row[block.outCol] || '').trim() };
        }).filter(function (schedule) { return schedule.in || schedule.out; })
      });
    }
  }

  return result;
}

function StaffDrivers_matchToTrucks(drivers, truckNames) {
  const result = [];
  const matchedDriverIndices = {};

  (truckNames || []).forEach(function (truckName) {
    let found = false;
    for (let i = 0; i < drivers.length; i++) {
      if (Checklist_normalizeVehicleName(drivers[i].vehicle) === Checklist_normalizeVehicleName(truckName) && !matchedDriverIndices[i]) {
        result.push({
          truckName: truckName,
          name: drivers[i].name,
          tel: drivers[i].tel,
          status: drivers[i].status,
          roleLabel: drivers[i].roleLabel,
          assigned: drivers[i].assigned !== false && !StaffDrivers_unassignedReason(drivers[i].name)
        });
        matchedDriverIndices[i] = true;
        found = true;
        break;
      }
    }
    if (!found) {
      result.push({
        truckName: truckName,
        name: '未アサイン',
        tel: null,
        status: '',
        roleLabel: '',
        assigned: false
      });
    }
  });

  drivers.forEach(function (driver, i) {
    if (!matchedDriverIndices[i]) {
      result.push({
        truckName: '(車両不明)',
        name: driver.name,
        tel: driver.tel,
        status: driver.status,
        roleLabel: driver.roleLabel,
        assigned: driver.assigned !== false && !StaffDrivers_unassignedReason(driver.name)
      });
    }
  });

  return result;
}

if (typeof module !== 'undefined' && module.exports) module.exports = {
  Checklist_normalizeVehicleName: Checklist_normalizeVehicleName,
  StaffDrivers_fetchAll: StaffDrivers_fetchAll,
  StaffDrivers_fetchOfficeContacts: StaffDrivers_fetchOfficeContacts,
  STAFF_COLUMN_DEFINITIONS: STAFF_COLUMN_DEFINITIONS,
  TRUCK_ALIASES: TRUCK_ALIASES,
  StaffDrivers_resolveColumns: StaffDrivers_resolveColumns,
  StaffDrivers_detectVehicle: StaffDrivers_detectVehicle,
  StaffDrivers_normalizeTel: StaffDrivers_normalizeTel,
  StaffDrivers_fetch: StaffDrivers_fetch,
  StaffDrivers_matchToTrucks: StaffDrivers_matchToTrucks
};
