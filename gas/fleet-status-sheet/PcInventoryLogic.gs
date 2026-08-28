var PC_SPEC_FIELDS_ = {
  maker:'メーカー', computerName:'コンピュータ名', model:'型番', cpu:'CPU', gpu:'VGA GPU', os:'OS', bits:'ビット',
  memoryType:'ﾒﾓﾘ種類', memoryGb:'ﾒﾓﾘ容量(GB)', memorySlotsFree:'ﾒﾓﾘ空ｽﾛｯﾄ', memoryMaxGb:'ﾒﾓﾘ最大容量',
  diskType:'HDD種類', diskGb:'HDD(GB)', opticalDrive:'CD/DVDドライブ', lan:'LAN口', wifi:'無線LAN', hdmi:'HDMI'
};

function pcNormalizeHeader(value) { return String(value == null ? '' : value).normalize('NFKC').replace(/\s+/g, '').toLowerCase(); }
function pcFindHeader(headers, wanted) {
  var target = pcNormalizeHeader(wanted);
  for (var i=0;i<headers.length;i+=1) if (pcNormalizeHeader(headers[i]) === target) return i;
  return -1;
}
function pcNonEmpty(value) { return value !== '' && value !== null && value !== undefined; }

function fleetPlanPcInventory(headers, rows, payload) {
  var spec = payload && payload.spec && typeof payload.spec === 'object' ? payload.spec : {};
  var host = String(payload && payload.hostname || spec.computerName || '').trim();
  if (!host) throw new Error('hostname_required');
  var computerCol = pcFindHeader(headers, PC_SPEC_FIELDS_.computerName);
  if (computerCol < 0) throw new Error('required header not found: コンピュータ名');
  var rowIndex = -1;
  for (var i=0;i<rows.length;i+=1) if (String(rows[i][computerCol] || '').trim().toLowerCase() === host.toLowerCase()) { rowIndex=i; break; }
  var appended = rowIndex < 0; if (appended) rowIndex = rows.length;
  var values = {};
  Object.keys(PC_SPEC_FIELDS_).forEach(function(key) {
    var col = pcFindHeader(headers, PC_SPEC_FIELDS_[key]); var value = key === 'computerName' ? host : spec[key];
    if (col >= 0 && pcNonEmpty(value)) values[col] = value;
  });
  var updatedCol = pcFindHeader(headers, '情報更新日'); if (updatedCol >= 0 && pcNonEmpty(payload.updatedAt)) values[updatedCol] = payload.updatedAt;
  // No と 種別は「追加時」だけでなく「既存行が空欄のとき」も埋める。
  // 追加専用にすると、先に別経路で作られた行が永久に空のまま残る(実際に39行目がそうなった)。
  // 既に値がある行は人の記入なので絶対に上書きしない。
  var existing = appended ? [] : (rows[rowIndex] || []);
  var blank = function(col) { return col >= 0 && !pcNonEmpty(String(existing[col] == null ? '' : existing[col]).trim()); };
  var noCol = pcFindHeader(headers, 'No');
  if (blank(noCol)) { var max=0; rows.forEach(function(row){ var m=String(row[noCol]||'').match(/^P(\d+)$/i); if(m) max=Math.max(max,Number(m[1])); }); values[noCol]='P'+(max+1); }
  var typeCol=pcFindHeader(headers,'ﾉｰﾄor ﾃﾞｽｸﾄｯﾌﾟ');
  if (blank(typeCol) && pcNonEmpty(spec.deviceType)) values[typeCol]=spec.deviceType;
  return { action: appended ? 'appended' : 'updated', rowIndex: rowIndex, values: values };
}
