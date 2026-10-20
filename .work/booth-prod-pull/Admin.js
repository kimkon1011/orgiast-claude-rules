/** Script Properties の読み取り専用一覧。秘密情報は設定状態と文字数だけ返す。 */
function Admin_getSafeScriptProperties() {
  const source = PropertiesService.getScriptProperties().getProperties();
  const properties = Object.create(null);
  [
    'EVENT_SHIPPING_MODE',
    'DISCORD_WAREHOUSE_CHANNEL_ID',
    'EVENT_SHIPPING_PRODUCTION_CHANNEL_ID',
    'EVENT_SHIPPING_TEST_EMAIL',
    'EVENT_SHIPPING_DATE_FORMAT'
  ].forEach(function (key) {
    properties[key] = null;
  });
  Object.keys(source).forEach(function (key) {
    const value = source[key];
    properties[key] = /TOKEN|SECRET|KEY|WEBHOOK|PASSWORD/i.test(key)
      ? { set: value.length > 0, length: value.length }
      : value;
  });
  return { ok: true, properties: properties };
}

/** 発送モードを設定する。本番送信の有効化には明示的な確認文字列が必要。 */
function Admin_setEventShippingMode(mode, opts) {
  if (mode !== 'off' && mode !== 'test' && mode !== 'live') {
    throw new Error('EVENT_SHIPPING_MODE は off / test / live のみ指定できます');
  }
  if (mode === 'live' && (!opts || opts.confirm !== 'ENABLE-LIVE-SENDING')) {
    throw new Error('live への変更には opts.confirm = ENABLE-LIVE-SENDING が必要です');
  }
  return _Admin_setVerifiedProperty('EVENT_SHIPPING_MODE', mode);
}

/** 発送テスト用メールアドレスを設定する（簡易形式検証）。 */
function Admin_setEventShippingTestEmail(email) {
  if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('EVENT_SHIPPING_TEST_EMAIL のメール形式が不正です');
  }
  return _Admin_setVerifiedProperty('EVENT_SHIPPING_TEST_EMAIL', email);
}

/**
 * 指定ファイルの共有状態を読み取り、editors 指定があれば編集者を追加して読み戻す。
 * 実行ユーザー（キューを回しているトリガーの実行者）の Drive 権限で操作する。
 */
function Admin_driveSharing(fileId, opts) {
  const options = opts || {};
  const result = _Admin_driveSharingRun(fileId, options);
  // cr@ トークンでは result_*.txt の本文を読めないため、成否を名前に載せた目印を残す。
  if (options.marker !== false) _Admin_writeSharingMarker(result);
  return result;
}

/** 目印ファイルの名前は Drive のメタデータだけで読めるよう、成否と実行者を名前に入れる。 */
function _Admin_writeSharingMarker(result) {
  try {
    const user = String(result.effectiveUser || 'unknown').replace(/[^A-Za-z0-9._@-]/g, '_');
    const name = 'sharemark_' + (result.ok ? 'ok' : 'ng') +
      '_add' + (result.added ? result.added.length : 0) +
      '_fail' + (result.failed ? result.failed.length : 0) +
      '_' + user + '.txt';
    DriveApp.getFolderById(CMD_FOLDER_ID).createFile(name, JSON.stringify(result));
  } catch (e) { /* 目印は best-effort。失敗しても本体の結果は返す */ }
}

function _Admin_driveSharingRun(fileId, options) {
  const id = String(fileId || '').trim();
  if (!id) return { ok: false, error: 'fileId is required' };
  const requested = options.editors == null ? [] : (Array.isArray(options.editors) ? options.editors : [options.editors]);
  const editors = requested.map(function (email) { return String(email || '').trim(); }).filter(Boolean);
  const effectiveUser = (function () {
    try { return Session.getEffectiveUser().getEmail() || ''; } catch (e) { return ''; }
  })();
  try {
    let file = DriveApp.getFileById(id);
    const added = [];
    const failed = [];
    editors.forEach(function (email) {
      try {
        file.addEditor(email);
        added.push(email);
      } catch (e) {
        failed.push({ email: email, message: String(e && e.message ? e.message : e) });
      }
    });
    file = DriveApp.getFileById(id);
    const owner = file.getOwner();
    return {
      ok: true,
      effectiveUser: effectiveUser,
      id: id,
      name: file.getName(),
      owner: owner ? owner.getEmail() : null,
      editors: file.getEditors().map(function (user) { return user.getEmail(); }),
      viewers: file.getViewers().map(function (user) { return user.getEmail(); }),
      access: String(file.getSharingAccess()),
      permission: String(file.getSharingPermission()),
      added: added,
      failed: failed
    };
  } catch (e) {
    return { ok: false, effectiveUser: effectiveUser, id: id, error: String(e && e.message ? e.message : e) };
  }
}

function _Admin_setVerifiedProperty(key, value) {
  const properties = PropertiesService.getScriptProperties();
  const previous = properties.getProperty(key);
  properties.setProperty(key, value);
  const current = properties.getProperty(key);
  console.log('[Admin] ' + key + ': ' + JSON.stringify({ previous: previous, requested: value, current: current }));
  if (current !== value) {
    throw new Error(key + ' の read-back verify に失敗しました');
  }
  return { ok: true, previous: previous, current: current };
}
