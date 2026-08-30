const FLEET_HEADERS_ = {
  staff: 'スタッフ名(記入)', done: '実行済み(記入:済/未)', executed: '実行日(記入)', selfPc: '自己申告PC名(記入)', memo: 'メモ(記入)',
  hostname: '【自動検知】PC名/ホスト名', reportedAt: '最終報告(JST)', claudeUsd: 'Claude概算$', mainModel: '主なモデル', delegRatio: '委譲率(安いAIへ)',
  cheapAiUse: '安いAI使用', codexLogin: 'Codexログイン', fable5: 'Fable5検出', disciplineAlert: '委譲規律アラート', consistency: '整合性(自己申告↔検知)',
  osUser: 'OSユーザー名', realHostname: '実ホスト名', gitEmail: 'Gitメール',
  activeProjects: '開発プロジェクト(直近7日)', artifacts: '成果物(リポジトリ/ブランチ)', lastCommit: '直近コミット'
};

const FLEET_OPTIONAL_HEADERS_ = ['osUser', 'realHostname', 'gitEmail', 'activeProjects', 'artifacts', 'lastCommit'];

// ヘッダ照合は正規化してから行う。全角/半角の括弧・英数、前後の空白、改行の違いで
// 「タブが見つからない」と誤判定するのを防ぐ(実セルの表記は目視できないため厳密一致に賭けない)。
function fleetNormalizeHeader(value) {
  return String(value == null ? '' : value).normalize('NFKC').replace(/\s+/g, '').toLowerCase();
}

function fleetFindHeaderIndex(headers, wanted) {
  const target = fleetNormalizeHeader(wanted);
  for (let i = 0; i < headers.length; i += 1) {
    if (fleetNormalizeHeader(headers[i]) === target) return i;
  }
  return -1;
}

function fleetResolveColumns(headers) {
  const columns = {};
  Object.keys(FLEET_HEADERS_).forEach(function(key) {
    const index = fleetFindHeaderIndex(headers, FLEET_HEADERS_[key]);
    if (index < 0 && FLEET_OPTIONAL_HEADERS_.indexOf(key) < 0) throw new Error('required header not found: ' + FLEET_HEADERS_[key]);
    columns[key] = index;
  });
  return columns;
}

// rows はヘッダを除く二次元配列。返り値だけを使い、入力は変更しない。
function fleetPlanUpsert(headers, rows, payload) {
  const columns = fleetResolveColumns(headers);
  const mappedName = typeof payload.mappedName === 'string' && payload.mappedName !== '' ? payload.mappedName : null;
  const label = typeof payload.label === 'string' ? payload.label : '';
  // label が空だと「F列が空の行」に軒並み一致して他PCの行を奪うため、空のときは探さない。
  let index = label ? rows.findIndex(function(row) { return row[columns.hostname] === label; }) : -1;
  if (index < 0 && mappedName) {
    index = rows.findIndex(function(row) { return row[columns.selfPc] === mappedName && !row[columns.hostname]; });
  }
  // 既存行に紐付けられた(F列一致 or 未紐付けのD列一致)なら、fleet-pc-map.json に登録が無くても
  // それは「紐付いている」。O列には kim の手書きメモが入っているので触らない。
  // 新規追記した時だけ「未マッピング」を立てる。
  const appended = index < 0;

  const values = {};
  values[columns.hostname] = label;
  values[columns.reportedAt] = payload.reportedAt || '';
  values[columns.claudeUsd] = payload.claudeUsd == null ? '' : payload.claudeUsd;
  values[columns.mainModel] = payload.mainModel || '';
  values[columns.delegRatio] = payload.delegRatio == null ? '' : payload.delegRatio;
  values[columns.cheapAiUse] = payload.cheapAiUse || '';
  values[columns.codexLogin] = payload.codexLogin || '';
  values[columns.fable5] = payload.fable5 || '';
  values[columns.disciplineAlert] = payload.disciplineAlert || '';
  if (columns.osUser >= 0) values[columns.osUser] = payload.username || '';
  if (columns.realHostname >= 0) values[columns.realHostname] = payload.hostname || '';
  if (columns.gitEmail >= 0) values[columns.gitEmail] = payload.gitEmail == null ? '' : payload.gitEmail;
  if (columns.activeProjects >= 0) values[columns.activeProjects] = payload.activeProjects || '';
  if (columns.artifacts >= 0) values[columns.artifacts] = payload.artifacts || '';
  if (columns.lastCommit >= 0) values[columns.lastCommit] = payload.lastCommit || '';
  if (appended) values[columns.consistency] = '未マッピング(要 fleet-pc-map.json 追記)';
  return { action: index >= 0 ? 'updated' : 'appended', rowIndex: index >= 0 ? index : rows.length, columns: columns, values: values };
}
