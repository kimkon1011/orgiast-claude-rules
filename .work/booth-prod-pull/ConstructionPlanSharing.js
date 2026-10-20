/** 施工手順書をリンクを知っている全員が閲覧できるようにする。 */
function ConstructionPlan_shareAnyoneWithLink(fileId) {
  let v3Error = '';
  if (typeof Drive !== 'undefined' && Drive && Drive.Permissions && Drive.Permissions.create) {
    try {
      const listed = Drive.Permissions.list(fileId, { fields: 'permissions(id,type,role)', supportsAllDrives: true });
      const existing = ((listed && listed.permissions) || []).find(function (p) { return p && p.type === 'anyone'; });
      if (existing) {
        return { id: fileId, ok: true, via: 'v3-existing', access: 'ANYONE_WITH_LINK', permission: existing.role };
      }
      const created = Drive.Permissions.create(
        { type: 'anyone', role: 'reader', allowFileDiscovery: false },
        fileId,
        { fields: 'id,type,role', supportsAllDrives: true }
      );
      return { id: fileId, ok: true, via: 'v3', access: 'ANYONE_WITH_LINK', permission: created.role || 'reader' };
    } catch (e) {
      v3Error = String(e && e.message || e);
    }
  }
  try {
    const file = DriveApp.getFileById(fileId);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    const shared = {
      id: fileId,
      ok: true,
      access: String(file.getSharingAccess()),
      permission: String(file.getSharingPermission())
    };
    if (v3Error) shared.v3Error = v3Error;
    return shared;
  } catch (e) {
    const error = String(e && e.message || e);
    console.warn('[ConstructionPlan_shareAnyoneWithLink] id=' + fileId + ' failed: ' + error);
    const failed = { id: fileId, ok: false, error: error };
    if (v3Error) failed.v3Error = v3Error;
    return failed;
  }
}

/** Drive API v3 と DriveApp の anyone 共有可否を新規一時ファイルで切り分ける。 */
function _debug_anyoneShareProbe() {
  let effectiveUser = '';
  let fileId = '';
  try {
    try { effectiveUser = Session.getEffectiveUser().getEmail(); } catch (e) { effectiveUser = ''; }
    const stamp = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd_HHmmss');
    const probeFile = DriveApp.getFolderById(CMD_FOLDER_ID).createFile('_shareprobe_' + stamp + '.txt', 'probe');
    fileId = probeFile.getId();
    const result = {
      ok: true,
      effectiveUser: effectiveUser,
      fileId: fileId,
      v3: { ok: false, error: '' },
      driveApp: { ok: false, error: '' },
      permissions: []
    };

    if (typeof Drive !== 'undefined' && Drive && Drive.Permissions && Drive.Permissions.create) {
      try {
        Drive.Permissions.create(
          { type: 'anyone', role: 'reader', allowFileDiscovery: false },
          fileId,
          { fields: 'id,type,role', supportsAllDrives: true }
        );
        result.v3.ok = true;
      } catch (e) {
        result.v3.error = String(e && e.message || e);
      }
      try {
        const listed = Drive.Permissions.list(fileId, { fields: 'permissions(type,role)', supportsAllDrives: true });
        result.permissions = ((listed && listed.permissions) || []).map(function (p) {
          return { type: p.type, role: p.role };
        });
      } catch (e) {
        if (!result.v3.error) result.v3.error = String(e && e.message || e);
      }
    } else {
      result.v3.error = 'Drive advanced service unavailable';
    }

    if (!result.v3.ok) {
      try {
        DriveApp.getFileById(fileId).setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
        result.driveApp.ok = true;
      } catch (e) {
        result.driveApp.error = String(e && e.message || e);
      }
    }
    try {
      const markerName = 'shareprobe_' + (result.v3.ok ? 'v3ok' : 'v3ng') + '_' + (result.driveApp.ok ? 'driveappok' : 'driveappng') + '_' + Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd_HHmmss') + '.txt';
      const markerFolder = _cmdQueue_childFolder(DriveApp.getFolderById(CMD_FOLDER_ID), 'cpshare_marks');
      markerFolder.createFile(markerName, '').setDescription(JSON.stringify({
        effectiveUser: effectiveUser,
        fileId: fileId,
        v3: result.v3,
        driveApp: result.driveApp,
        permissions: result.permissions
      }).slice(0, 8000));
    } catch (e) { /* marker best effort */ }
    return result;
  } catch (e) {
    return { ok: false, error: String(e && e.message || e), effectiveUser: effectiveUser };
  } finally {
    if (fileId) {
      try { DriveApp.getFileById(fileId).setTrashed(true); } catch (e) { /* cleanup best effort */ }
    }
  }
}

/**
 * permissions 配列に「リンクを知っている全員」が含まれるか（純関数）。
 * Drive.Permissions.list の応答（配列または {permissions:[]}）を受ける。
 */
function ConstructionPlan_hasAnyonePermission(permissions) {
  const list = Array.isArray(permissions) ? permissions : (permissions && permissions.permissions) || [];
  return list.some(function (p) {
    return p && String(p.type || '').toLowerCase() === 'anyone' &&
      ['reader', 'writer', 'commenter'].indexOf(String(p.role || '').toLowerCase()) >= 0;
  });
}

/**
 * 実際の permissions を読んで anyone 共有の有無を返す。
 * DriveApp.getSharingAccess() は「見えるが共有権限がない」ファイルで例外になるため、
 * 先に Drive 高度なサービス（permissions.list）を使う。
 */
function ConstructionPlan_readShareState(fileId) {
  if (typeof Drive !== 'undefined' && Drive && Drive.Permissions && Drive.Permissions.list) {
    try {
      const res = Drive.Permissions.list(fileId, { fields: 'permissions(type,role)', supportsAllDrives: true });
      return { ok: true, anyone: ConstructionPlan_hasAnyonePermission(res), source: 'drive' };
    } catch (e) {
      // DriveApp へ退避する
    }
  }
  try {
    const file = DriveApp.getFileById(fileId);
    const access = String(file.getSharingAccess());
    return {
      ok: true,
      anyone: access === String(DriveApp.Access.ANYONE_WITH_LINK) || access === String(DriveApp.Access.ANYONE),
      source: 'driveapp'
    };
  } catch (e) {
    return { ok: false, anyone: false, error: String(e && e.message || e) };
  }
}

/** 共有権限の有無と所有者を読む（取れなければ ok:false）。 */
function ConstructionPlan_readShareCapability(fileId) {
  if (typeof Drive === 'undefined' || !Drive || !Drive.Files || !Drive.Files.get) return { ok: false };
  try {
    const f = Drive.Files.get(fileId, { fields: 'capabilities(canShare),owners(emailAddress)', supportsAllDrives: true });
    return {
      ok: true,
      canShare: !(f.capabilities && f.capabilities.canShare === false),
      owners: (f.owners || []).map(function (o) { return o && o.emailAddress; }).filter(Boolean)
    };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

/** 既存の施工手順書を一括点検し、apply=true の場合だけ共有設定を変更する。 */
function ConstructionPlan_shareAllAnyoneWithLink(opts) {
  opts = opts || {};
  const apply = opts.apply === true;
  const result = {
    apply: apply,
    total: 0,
    changed: 0,
    already: 0,
    wouldChange: 0,
    skipped: [],
    failed: [],
    items: []
  };
  const files = DriveApp.searchFiles("title contains '施工手順書' and trashed = false and (mimeType = 'application/vnd.google-apps.presentation' or mimeType = 'application/vnd.google-apps.document' or mimeType = 'application/pdf')");

  while (files.hasNext()) {
    const file = files.next();
    const id = file.getId();
    const name = file.getName();
    const mimeType = file.getMimeType();
    let before = '';
    let after = '';
    result.total++;
    const state = ConstructionPlan_readShareState(id);
    if (!state.ok) {
      result.failed.push({ id: id, name: name, error: state.error, stage: 'read' });
      if (result.items.length < 300) result.items.push({ id: id, name: name, mimeType: mimeType, before: '', after: '', result: 'read-failed' });
      continue;
    }
    before = state.anyone ? 'ANYONE_WITH_LINK' : 'RESTRICTED';
    after = before;
    if (state.anyone) {
      result.already++;
    } else {
      result.wouldChange++;
      if (apply) {
        const cap = ConstructionPlan_readShareCapability(id);
        if (cap.ok && cap.canShare === false) {
          // 所有者でないため共有を変更できない。失敗ではなく「所有者の対応待ち」。
          result.skipped.push({ id: id, name: name, reason: 'noPermission', owners: cap.owners || [] });
        } else {
          const shared = ConstructionPlan_shareAnyoneWithLink(id);
          if (shared.ok) {
            result.changed++;
            after = shared.access;
          } else {
            const failedItem = { id: id, name: name, error: shared.error };
            if (shared.v3Error) failedItem.v3Error = shared.v3Error;
            if (cap.owners && cap.owners.length) failedItem.owners = cap.owners;
            result.failed.push(failedItem);
          }
        }
      }
    }
    if (result.items.length < 300) {
      result.items.push({ id: id, name: name, mimeType: mimeType, before: before, after: after, source: state.source });
    }
  }

  const status = result.failed.length === 0 ? 'ok' : 'ng';
  const mode = apply ? 'apply' : 'dry';
  const stamp = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd_HHmmss');
  const markerName = 'cpshare_' + status + '_' + mode + '_t' + result.total + '_c' + result.changed + '_a' + result.already + '_f' + result.failed.length + '_s' + result.skipped.length + '_' + stamp + '.txt';
  const markerFolder = _cmdQueue_childFolder(DriveApp.getFolderById(CMD_FOLDER_ID), 'cpshare_marks');
  markerFolder.createFile(markerName, '').setDescription(JSON.stringify({
    total: result.total,
    changed: result.changed,
    already: result.already,
    wouldChange: result.wouldChange,
    skipped: result.skipped,
    failed: result.failed
  }).slice(0, 8000));
  return result;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ConstructionPlan_shareAnyoneWithLink: ConstructionPlan_shareAnyoneWithLink,
    ConstructionPlan_hasAnyonePermission: ConstructionPlan_hasAnyonePermission,
    ConstructionPlan_readShareState: ConstructionPlan_readShareState,
    ConstructionPlan_readShareCapability: ConstructionPlan_readShareCapability,
    ConstructionPlan_shareAllAnyoneWithLink: ConstructionPlan_shareAllAnyoneWithLink,
    _debug_anyoneShareProbe: _debug_anyoneShareProbe
  };
}
