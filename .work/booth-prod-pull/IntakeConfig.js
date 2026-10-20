/** Drive 上の取り込み設定を安全に読み込む。 */
const INTAKE_CONFIG_FILE_ID = '1Nls_kqnE5mBBN8_Usu2zZbRCud7sWnSr'; // 名前検索の予備。版替えのたびに最新 ID へ更新する
const INTAKE_CONFIG_FILE_NAME = 'booth-intake-config.json';
const INTAKE_CONFIG_CACHE_KEY = 'intake-config';
const INTAKE_CONFIG_ALLOWED_OWNERS = ['cr@orgiast.jp', 'kim@orgiast.jp', 'seisaku-team@orgiast.jp'];
var _INTAKE_CONFIG_LOADED_AT = '';

/** JSON 文字列を正規化済み設定へ変換する純粋関数。 */
function IntakeConfig_parse(text) {
  var parsed;
  try { parsed = JSON.parse(String(text || '').replace(/^\uFEFF/, '')); } catch (e) { return {}; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

  var out = {};
  Object.keys(parsed).forEach(function (key) { out[key] = parsed[key]; });
  if (parsed.discord && typeof parsed.discord === 'object' && !Array.isArray(parsed.discord)) {
    out.discord = {};
    Object.keys(parsed.discord).forEach(function (key) { out.discord[key] = parsed.discord[key]; });
    var channels = {};
    if (parsed.discord.channels && typeof parsed.discord.channels === 'object' && !Array.isArray(parsed.discord.channels)) {
      Object.keys(parsed.discord.channels).forEach(function (channelId) {
        var id = String(channelId || '').trim();
        var caseId = String(parsed.discord.channels[channelId] == null ? '' : parsed.discord.channels[channelId]).trim();
        if (id && caseId) channels[id] = caseId;
      });
    }
    out.discord.channels = channels;
    out.discord.commonChannels = Array.isArray(parsed.discord.commonChannels)
      ? parsed.discord.commonChannels.map(function (id) { return String(id == null ? '' : id).trim(); }).filter(Boolean)
      : [];
  }
  if (parsed.line && typeof parsed.line === 'object' && !Array.isArray(parsed.line)) {
    out.line = {};
    Object.keys(parsed.line).forEach(function (key) { out.line[key] = parsed.line[key]; });
    var sources = {};
    if (parsed.line.sources && typeof parsed.line.sources === 'object' && !Array.isArray(parsed.line.sources)) {
      Object.keys(parsed.line.sources).forEach(function (sourceId) {
        var id = String(sourceId || '').trim();
        var caseId = String(parsed.line.sources[sourceId] == null ? '' : parsed.line.sources[sourceId]).trim();
        if (id && caseId) sources[id] = caseId;
      });
    }
    out.line.sources = sources;
  }
  return out;
}

function _IntakeConfig_ownerOk(file) {
  try {
    var owner = file.getOwner();
    var email = owner && owner.getEmail ? String(owner.getEmail() || '').toLowerCase() : '';
    return INTAKE_CONFIG_ALLOWED_OWNERS.indexOf(email) >= 0;
  } catch (e) { return false; }
}

/**
 * Drive MCP は既存ファイルの中身を書き換えられない(タイトル移動のみ)ため、更新は「同名の新しい版を作り古い版をゴミ箱へ」で行う。
 * 名前 booth-intake-config.json で許可所有者のものを探し、最終更新が最新のものを採用。見つからなければ固定 ID。
 */
function _IntakeConfig_findFile() {
  var best = null, bestTime = 0;
  try {
    var it = DriveApp.getFilesByName(INTAKE_CONFIG_FILE_NAME);
    while (it.hasNext()) {
      var f = it.next();
      if (f.isTrashed() || !_IntakeConfig_ownerOk(f)) continue;
      var t = f.getLastUpdated().getTime();
      if (t > bestTime) { best = f; bestTime = t; }
    }
  } catch (e) { console.warn('IntakeConfig find: ' + e); }
  if (best) return best;
  try {
    var fixed = DriveApp.getFileById(INTAKE_CONFIG_FILE_ID);
    return _IntakeConfig_ownerOk(fixed) ? fixed : null;
  } catch (e2) { return null; }
}

function IntakeConfig_load() {
  try {
    var cache = CacheService.getScriptCache();
    var cached = cache.get(INTAKE_CONFIG_CACHE_KEY);
    if (cached) {
      var envelope = JSON.parse(cached);
      _INTAKE_CONFIG_LOADED_AT = String(envelope.loadedAt || '');
      return envelope.config || {};
    }
    _INTAKE_CONFIG_LOADED_AT = '';
    var file = _IntakeConfig_findFile();
    if (!file) { console.warn('IntakeConfig_load: 設定ファイルが見つかりません'); return {}; }
    var config = IntakeConfig_parse(file.getBlob().getDataAsString());
    _INTAKE_CONFIG_LOADED_AT = new Date().toISOString();
    cache.put(INTAKE_CONFIG_CACHE_KEY, JSON.stringify({ loadedAt: _INTAKE_CONFIG_LOADED_AT, config: config }), 300);
    return config;
  } catch (e) {
    _INTAKE_CONFIG_LOADED_AT = '';
    console.warn('IntakeConfig_load: ' + e);
    return {};
  }
}

function IntakeConfig_status() {
  var config = IntakeConfig_load();
  var discord = config.discord || {};
  var line = config.line || {};
  return {
    fileId: INTAKE_CONFIG_FILE_ID,
    loadedAt: _INTAKE_CONFIG_LOADED_AT,
    discordChannels: Object.keys(discord.channels || {}).length,
    commonChannels: Array.isArray(discord.commonChannels) ? discord.commonChannels.length : 0,
    discordEnabled: discord.enabled !== false,
    lineEnabled: line.enabled === true,
    lineKeyConfigured: !!line.webhookKey,
    lineSources: Object.keys(line.sources || {}).length
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { IntakeConfig_parse: IntakeConfig_parse };
}
