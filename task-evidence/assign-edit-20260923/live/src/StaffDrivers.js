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
    'デュトロ', '日産キャラバン', '軽トラック 標準', '軽トラック ハイルーフ',
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
  if (raw === null || raw === undefined) return null;
  let s = String(raw).trim();
  if (!s) return null;
  
  // Convert full-width numbers to half-width
  s = s.replace(/[０-９]/g, function (m) {
    return String.fromCharCode(m.charCodeAt(0) - 0xFEE0);
  });
  
  // Convert full-width hyphens/dashes to half-width hyphen
  s = s.replace(/[－ー—‐]/g, '-');
  
  s = s.trim();
  if (s === '-' || s === '' || s.indexOf('確認中') !== -1 || s.indexOf('未定') !== -1 || s.indexOf('なし') !== -1) {
    return null;
  }
  return s;
}

function StaffDrivers_fetch(zissiSpreadsheet) {
  const result = {
    found: false,
    sheetName: null,
    headerRow: null,
    drivers: [],
    warnings: []
  };

  if (!zissiSpreadsheet) return result;

  const sheets = zissiSpreadsheet.getSheets();
  let staffSheet = null;
  for (let i = 0; i < sheets.length; i++) {
    if (sheets[i].getName().indexOf('スタッフ') !== -1) {
      staffSheet = sheets[i];
      break;
    }
  }
  if (!staffSheet) {
    return result;
  }

  result.sheetName = staffSheet.getName();

  const lastRow = staffSheet.getLastRow();
  const lastCol = staffSheet.getLastColumn();
  if (lastRow === 0 || lastCol === 0) {
    return result;
  }

  const values = staffSheet.getRange(1, 1, Math.min(30, lastRow), lastCol).getValues();
  let headerRow = null;
  let headerRowIndex = -1;

  for (let r = 0; r < values.length; r++) {
    const row = values[r];
    let hasName = false;
    let hasTel = false;
    for (let c = 0; c < row.length; c++) {
      const val = String(row[c] || '');
      if (val.indexOf('名前') !== -1) {
        hasName = true;
      }
      if (val.indexOf('連絡先') !== -1 || val.indexOf('TEL') !== -1) {
        hasTel = true;
      }
    }
    if (hasName && hasTel) {
      headerRow = row;
      headerRowIndex = r + 1;
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

  const allRows = staffSheet.getRange(headerRowIndex + 1, 1, lastRow - headerRowIndex, lastCol).getValues();
  for (let i = 0; i < allRows.length; i++) {
    const row = allRows[i];
    const roleVal = String(row[cols.role] || '').trim();
    if (!roleVal) continue;

    if (roleVal.indexOf('ドライバー') !== -1 || roleVal.indexOf('運転') !== -1) {
      const rawName = row[cols.name];
      const nameVal = (rawName !== null && rawName !== undefined) ? String(rawName).trim() : '';
      const displayName = nameVal === '' ? '未アサイン' : nameVal;

      const rawTel = cols.tel !== -1 ? row[cols.tel] : null;
      const telVal = StaffDrivers_normalizeTel(rawTel);

      const rawStatus = cols.status !== -1 ? row[cols.status] : null;
      const statusVal = (rawStatus !== null && rawStatus !== undefined) ? String(rawStatus).trim() : '';

      const detectedVehicle = StaffDrivers_detectVehicle(roleVal);

      result.drivers.push({
        vehicle: detectedVehicle,
        roleLabel: roleVal,
        name: displayName,
        tel: telVal,
        status: statusVal
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
      if (drivers[i].vehicle === truckName && !matchedDriverIndices[i]) {
        result.push({
          truckName: truckName,
          name: drivers[i].name,
          tel: drivers[i].tel,
          status: drivers[i].status,
          roleLabel: drivers[i].roleLabel,
          assigned: drivers[i].name !== '未アサイン'
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
        assigned: driver.name !== '未アサイン'
      });
    }
  });

  return result;
}

if (typeof module !== 'undefined' && module.exports) module.exports = {
  STAFF_COLUMN_DEFINITIONS: STAFF_COLUMN_DEFINITIONS,
  TRUCK_ALIASES: TRUCK_ALIASES,
  StaffDrivers_resolveColumns: StaffDrivers_resolveColumns,
  StaffDrivers_detectVehicle: StaffDrivers_detectVehicle,
  StaffDrivers_normalizeTel: StaffDrivers_normalizeTel,
  StaffDrivers_fetch: StaffDrivers_fetch,
  StaffDrivers_matchToTrucks: StaffDrivers_matchToTrucks
};
