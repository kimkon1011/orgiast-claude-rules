const RELAY_SECRET = '__RELAY_SECRET__';
const CONFIG_SHEET_ID = '1t6eMvbPIu17m7hbv6foJcvd-fXrJkZqrePb8P6njxGI';
const CONFIG_SHEET_TAB_NAME = '正式：reブースタスク進捗管理表';
const SESSION_TIMEOUT_MS = 3600000; // 1 hour

function json_(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}

function getScriptProperties() {
  return PropertiesService.getScriptProperties();
}

function getSpreadsheet() {
  const id = getScriptProperties().getProperty('CONFIG_SHEET_ID') || CONFIG_SHEET_ID;
  const tabName = getScriptProperties().getProperty('CONFIG_SHEET_TAB_NAME') || CONFIG_SHEET_TAB_NAME;
  const spreadsheet = SpreadsheetApp.openById(id);
  const sheet = spreadsheet.getSheetByName(tabName);
  if (!sheet) throw new Error('Target sheet not found: ' + tabName);
  return { spreadsheet, sheet };
}

function doGet(e) {
  // 既存ダイアログHTMLを配信
  const html = HtmlService.createHtmlOutputFromFile('Dialog.html')
    .setTitle('Storage Material Upload')
    .setWidth(600)
    .setHeight(400);
  
  // メニュー設定（WebアプリURLのみを開く）
  const appUrl = ScriptApp.getService().getUrl();
  return html;
}

function doPost(e) {
  let payload;
  try {
    payload = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (error) {
    return json_({ ok: false, status: 400, error: 'invalid_json' });
  }
  
  const expected = getScriptProperties().getProperty('RELAY_SECRET') || RELAY_SECRET;
  if (!expected || payload.token !== expected) return json_({ ok: false, status: 401, error: 'unauthorized' });
  
  const action = payload.action || 'unknown';
  
  switch (action) {
    case 'upload':
      return handleUpload(payload);
    case 'get_uploaders':
      return handleGetUploaders(payload);
    case 'get_file_list':
      return handleGetFileList(payload);
    case 'get_case_data':
      return handleGetCaseData(payload);
    default:
      return json_({ ok: false, status: 400, error: 'invalid_action' });
  }
}

function handleUpload(payload) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return json_({ ok: false, status: 503, error: 'service_busy' });
  
  try {
    const { sheet } = getSpreadsheet();
    const user = Session.getEffectiveUser();
    const uploadTime = new Date();
    const userEmail = user.getEmail();
    
    // アップロード者メールを記録
    const logSheet = getOrCreateLogSheet();
    logSheet.appendRow([
      uploadTime.toISOString(),
      userEmail,
      payload.caseId || '',
      payload.fileName || '',
      payload.fileSize || 0,
      payload.uploadType || 'material',
      JSON.stringify(payload.metadata || {})
    ]);
    
    // 実行者ごとに異なる承認状態を確認
    const approvalKey = payload.caseId + '_' + userEmail;
    const approvalStatus = getUserApprovalStatus(approvalKey, payload);
    
    // アップロードを記録
    const uploadRecord = {
      timestamp: uploadTime.toISOString(),
      user: userEmail,
      caseId: payload.caseId || '',
      fileName: payload.fileName || '',
      fileSize: payload.fileSize || 0,
      uploadType: payload.uploadType || 'material',
      metadata: payload.metadata || {},
      approved: approvalStatus.approved,
      requiresApproval: approvalStatus.requiresApproval,
      approvalId: approvalStatus.approvalId
    };
    
    // アップロードを記録
    const dataSheet = getOrCreateDataSheet();
    dataSheet.appendRow([
      uploadTime.toISOString(),
      userEmail,
      payload.caseId || '',
      payload.fileName || '',
      payload.fileSize || 0,
      approvalStatus.approved ? 'approved' : 'pending_approval',
      approvalStatus.requiresApproval ? 'yes' : 'no'
    ]);
    
    return json_({ 
      ok: true, 
      uploadId: 'upload_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
      record: uploadRecord,
      message: 'Upload successful. Awaiting approval if required.'
    });
    
  } catch (error) {
    return json_({ ok: false, status: 500, error: error.message });
  } finally {
    lock.releaseLock();
  }
}

function handleGetUploaders(payload) {
  const { sheet } = getSpreadsheet();
  const user = Session.getEffectiveUser();
  const userEmail = user.getEmail();
  
  // 現在このユーザーに承認が必要な案件を取得
  const approvalRequiredCases = getCasesRequiringApprovalForUser(userEmail);
  
  return json_({
    ok: true,
    uploaders: [{
      user: userEmail,
      pendingCases: approvalRequiredCases,
      totalPending: approvalRequiredCases.length
    }],
    message: 'Uploaders list retrieved'
  });
}

function handleGetFileList(payload) {
  const { sheet } = getSpreadsheet();
  const user = Session.getEffectiveUser();
  
  // ユーザーがアクセスできる案件のファイル一覧を取得
  const accessibleCases = getAccessibleCasesForUser(user.getEmail());
  const fileList = [];
  
  for (const caseData of accessibleCases) {
    const files = getFilesForCase(caseData.caseId, user.getEmail());
    if (files && files.length > 0) {
      fileList.push({
        caseId: caseData.caseId,
        caseName: caseData.caseName,
        files: files
      });
    }
  }
  
  return json_({
    ok: true,
    fileList: fileList,
    message: 'File list retrieved'
  });
}

function handleGetCaseData(payload) {
  const { sheet } = getSpreadsheet();
  const caseId = payload.caseId;
  const userEmail = Session.getEffectiveUser().getEmail();
  
  const caseData = getCaseDataById(caseId, userEmail);
  
  return json_({
    ok: true,
    caseData: caseData,
    message: 'Case data retrieved'
  });
}

function getUserApprovalStatus(approvalKey, payload) {
  // 実行者ごとに異なる承認ロジック
  const userEmail = approvalKey.split('_')[1];
  const caseId = approvalKey.split('_')[0];
  
  // システム設定に基づいて承認が必要かどうかを判断
  const approvalRequired = isApprovalRequiredForUserAndCase(userEmail, caseId);
  
  let approvalId = null;
  let approved = false;
  
  if (approvalRequired) {
    // 承認IDを生成（一意性のためタイムスタンプを含む）
    approvalId = 'approval_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    
    // 承認状態を記録
    recordUserApproval(approvalKey, approvalId, payload);
    
    // 自動承認条件をチェック
    approved = checkAutoApprovalCondition(userEmail, caseId, payload);
  }
  
  return {
    approvalKey: approvalKey,
    approvalId: approvalId,
    approved: approved,
    requiresApproval: approvalRequired,
    approvalStatus: approvalRequired ? (approved ? 'auto_approved' : 'pending') : 'not_required'
  };
}

function isApprovalRequiredForUserAndCase(userEmail, caseId) {
  // システム設定に基づいて承認ロジックを実装
  // 通常はケースの権限設定やユーザーの役割に基づいて判断
  
  // 例：設定ファイルまたはシステム権限に基づいて判断
  const approvalConfig = getScriptProperties().getProperty('APPROVAL_CONFIG');
  let config = {};
  
  try {
    config = approvalConfig ? JSON.parse(approvalConfig) : {};
  } catch (_) {
    config = {};
  }
  
  // ユーザーが管理者かどうかをチェック
  const isAdmin = isUserAdmin(userEmail);
  if (isAdmin) {
    return false; // 管理者は承認不要
  }
  
  // 特定のケースでは全員に承認が必要
  if (config.requireApprovalForAllCases === true) {
    return true;
  }
  
  // ユーザーごとの例外ケース
  if (config.exemptUsers && config.exemptUsers.includes(userEmail)) {
    return false;
  }
  
  // 権限に基づいて承認が必要かどうかを判断
  const userPermissions = getUserPermissions(userEmail);
  if (userPermissions && userPermissions.includes('upload.material')) {
    return false; // 権限がある場合は承認不要
  }
  
  // デフォルト：承認が必要
  return true;
}

function checkAutoApprovalCondition(userEmail, caseId, payload) {
  // 自動承認条件をチェック
  const autoApprovalConfig = getScriptProperties().getProperty('AUTO_APPROVAL_CONFIG');
  let config = {};
  
  try {
    config = autoApprovalConfig ? JSON.parse(autoApprovalConfig) : {};
  } catch (_) {
    config = {};
  }
  
  // 自動承認条件:
  // 1. 管理者は自動承認
  if (isUserAdmin(userEmail)) {
    return true;
  }
  
  // 2. 特定のファイルタイプは自動承認
  if (payload.fileName && config.autoApproveFileTypes) {
    const fileExtension = payload.fileName.split('.').pop().toLowerCase();
    if (config.autoApproveFileTypes.includes(fileExtension)) {
      return true;
    }
  }
  
  // 3. システム設定で自動承認が有効な場合は承認不要
  if (config.enableAutoApproval === true) {
    return true;
  }
  
  // 4. 1回限りの承認後自動承認
  if (config.oneTimeAutoApproval) {
    const hasAlreadyApproved = hasUserAlreadyApprovedForCase(userEmail, caseId);
    if (hasAlreadyApproved) {
      return true;
    }
  }
  
  // デフォルト：自動承認されない
  return false;
}

function recordUserApproval(approvalKey, approvalId, payload) {
  const properties = PropertiesService.getDocumentProperties();
  const key = 'APPROVAL_' + approvalKey;
  const value = {
    approvalId: approvalId,
    user: payload.user || Session.getEffectiveUser().getEmail(),
    caseId: payload.caseId || '',
    timestamp: new Date().toISOString(),
    fileName: payload.fileName || '',
    approved: payload.autoApproved || false
  };
  
  properties.setProperty(key, JSON.stringify(value));
}

function hasUserAlreadyApprovedForCase(userEmail, caseId) {
  const properties = PropertiesService.getDocumentProperties();
  const key = 'APPROVAL_' + caseId + '_' + userEmail;
  const value = properties.getProperty(key);
  return value !== null;
}

function getOrCreateLogSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let logSheet = ss.getSheetByName('UploadLog');
  
  if (!logSheet) {
    logSheet = ss.insertSheet('UploadLog');
    // ヘッダーを設定
    logSheet.getRange('A1').setValue('Timestamp');
    logSheet.getRange('B1').setValue('UserEmail');
    logSheet.getRange('C1').setValue('CaseId');
    logSheet.getRange('D1').setValue('FileName');
    logSheet.getRange('E1').setValue('FileSize');
    logSheet.getRange('F1').setValue('UploadType');
    logSheet.getRange('G1').setValue('Metadata');
  }
  
  return logSheet;
}

function getOrCreateDataSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let dataSheet = ss.getSheetByName('UploadData');
  
  if (!dataSheet) {
    dataSheet = ss.insertSheet('UploadData');
    // ヘッダーを設定
    dataSheet.getRange('A1').setValue('Timestamp');
    dataSheet.getRange('B1').setValue('UserEmail');
    dataSheet.getRange('C1').setValue('CaseId');
    dataSheet.getRange('D1').setValue('FileName');
    dataSheet.getRange('E1').setValue('FileSize');
    dataSheet.getRange('F1').setValue('Status');
    dataSheet.getRange('G1').setValue('RequiresApproval');
  }
  
  return dataSheet;
}

function getCasesRequiringApprovalForUser(userEmail) {
  // システム設定に基づいて承認が必要な案件を取得
  const config = getScriptProperties().getProperty('APPROVAL_CONFIG');
  let approvalConfig = {};
  
  try {
    approvalConfig = config ? JSON.parse(config) : {};
  } catch (_) {
    approvalConfig = {};
  }
  
  const cases = [];
  
  // 現在このユーザーに承認が必要な案件を取得
  if (approvalConfig.casesRequiringApproval) {
    for (const caseData of approvalConfig.casesRequiringApproval) {
      if (caseData.userEmail === userEmail && caseData.status === 'pending') {
        cases.push({
          caseId: caseData.caseId,
          caseName: caseData.caseName,
          requestedAt: caseData.requestedAt,
          status: caseData.status
        });
      }
    }
  }
  
  return cases;
}

function getAccessibleCasesForUser(userEmail) {
  // ユーザーがアクセスできる案件を取得
  const config = getScriptProperties().getProperty('APPROVAL_CONFIG');
  let approvalConfig = {};
  
  try {
    approvalConfig = config ? JSON.parse(config) : {};
  } catch (_) {
    approvalConfig = {};
  }
  
  const cases = [];
  
  if (approvalConfig.accessibleCases) {
    for (const caseData of approvalConfig.accessibleCases) {
      // ユーザーが案件の閲覧/編集権限があるかどうかをチェック
      if (isUserAuthorizedForCase(userEmail, caseData.caseId)) {
        cases.push({
          caseId: caseData.caseId,
          caseName: caseData.caseName,
          status: caseData.status || 'active',
          owner: caseData.owner || ''
        });
      }
    }
  }
  
  return cases;
}

function isUserAuthorizedForCase(userEmail, caseId) {
  // ユーザーが案件の権限を持つかどうかをチェック
  const config = getScriptProperties().getProperty('APPROVAL_CONFIG');
  let approvalConfig = {};
  
  try {
    approvalConfig = config ? JSON.parse(config) : {};
  } catch (_) {
    approvalConfig = {};
  }
  
  if (approvalConfig.accessibleCases) {
    for (const caseData of approvalConfig.accessibleCases) {
      if (caseData.caseId === caseId) {
        // ユーザーが閲覧権限を持つかどうかをチェック
        if (caseData.viewers && caseData.viewers.includes(userEmail)) {
          return true;
        }
        
        // ユーザーが編集権限を持つかどうかをチェック
        if (caseData.editors && caseData.editors.includes(userEmail)) {
          return true;
        }
        
        // ユーザーが案件の所有者かどうかをチェック
        if (caseData.owner === userEmail) {
          return true;
        }
      }
    }
  }
  
  return false;
}

function getFilesForCase(caseId, userEmail) {
  // ケースのファイルをユーザーごとに取得
  const config = getScriptProperties().getProperty('APPROVAL_CONFIG');
  let approvalConfig = {};
  
  try {
    approvalConfig = config ? JSON.parse(config) : {};
  } catch (_) {
    approvalConfig = {};
  }
  
  const files = [];
  
  if (approvalConfig.caseFiles) {
    for (const fileData of approvalConfig.caseFiles) {
      if (fileData.caseId === caseId) {
        // ユーザーがファイルを閲覧する権限があるかどうかをチェック
        if (isUserAuthorizedForCase(userEmail, caseId)) {
          files.push({
            fileId: fileData.fileId,
            fileName: fileData.fileName,
            fileSize: fileData.fileSize,
            uploadedAt: fileData.uploadedAt,
            uploadedBy: fileData.uploadedBy,
            status: fileData.status,
            approvalRequired: fileData.approvalRequired || false,
            approvalStatus: fileData.approvalStatus || 'pending'
          });
        }
      }
    }
  }
  
  return files;
}

function getCaseDataById(caseId, userEmail) {
  // 案件データをIDで取得
  const config = getScriptProperties().getProperty('APPROVAL_CONFIG');
  let approvalConfig = {};
  
  try {
    approvalConfig = config ? JSON.parse(config) : {};
  } catch (_) {
    approvalConfig = {};
  }
  
  if (approvalConfig.accessibleCases) {
    for (const caseData of approvalConfig.accessibleCases) {
      if (caseData.caseId === caseId) {
        return {
          caseId: caseData.caseId,
          caseName: caseData.caseName,
          status: caseData.status || 'active',
          owner: caseData.owner || '',
          createdAt: caseData.createdAt || '',
          updatedAt: caseData.updatedAt || '',
          description: caseData.description || '',
          files: getFilesForCase(caseId, userEmail),
          metadata: caseData.metadata || {}
        };
      }
    }
  }
  
  return null;
}

function isUserAdmin(userEmail) {
  // ユーザーが管理者かどうかをチェック
  const config = getScriptProperties().getProperty('APPROVAL_CONFIG');
  let approvalConfig = {};
  
  try {
    approvalConfig = config ? JSON.parse(config) : {};
  } catch (_) {
    approvalConfig = {};
  }
  
  return approvalConfig.adminUsers && approvalConfig.adminUsers.includes(userEmail);
}

function getUserPermissions(userEmail) {
  // ユーザーの権限を取得
  const config = getScriptProperties().getProperty('APPROVAL_CONFIG');
  let approvalConfig = {};
  
  try {
    approvalConfig = config ? JSON.parse(config) : {};
  } catch (_) {
    approvalConfig = {};
  }
  
  if (approvalConfig.userPermissions) {
    for (const userData of approvalConfig.userPermissions) {
      if (userData.userEmail === userEmail) {
        return userData.permissions || [];
      }
    }
  }
  
  return [];
}

function addCaseRequiringApproval(caseId, caseName, userEmail) {
  // 新しい承認が必要なケースを追加
  const config = getScriptProperties().getProperty('APPROVAL_CONFIG') || '{}';
  let approvalConfig = {};
  
  try {
    approvalConfig = JSON.parse(config);
  } catch (_) {
    approvalConfig = {};
  }
  
  if (!approvalConfig.casesRequiringApproval) {
    approvalConfig.casesRequiringApproval = [];
  }
  
  const newCase = {
    caseId: caseId,
    caseName: caseName,
    userEmail: userEmail,
    requestedAt: new Date().toISOString(),
    status: 'pending',
    description: 'This case requires approval from the specified user.'
  };
  
  approvalConfig.casesRequiringApproval.push(newCase);
  
  getScriptProperties().setProperty('APPROVAL_CONFIG', JSON.stringify(approvalConfig));
  
  return newCase;
}

function addAccessibleCase(caseId, caseName, ownerEmail, viewers, editors) {
  // 新しいアクセス可能なケースを追加
  const config = getScriptProperties().getProperty('APPROVAL_CONFIG') || '{}';
  let approvalConfig = {};
  
  try {
    approvalConfig = JSON.stringify(config);
  } catch (_) {
    approvalConfig = {};
  }
  
  if (!approvalConfig.accessibleCases) {
    approvalConfig.accessibleCases = [];
  }
  
  const newCase = {
    caseId: caseId,
    caseName: caseName,
    owner: ownerEmail,
    viewers: viewers || [],
    editors: editors || [],
    status: 'active',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    description: 'Accessible case for storage material upload.'
  };
  
  approvalConfig.accessibleCases.push(newCase);
  
  getScriptProperties().setProperty('APPROVAL_CONFIG', JSON.stringify(approvalConfig));
  
  return newCase;
}

function addCaseFile(caseId, fileName, fileSize, userEmail) {
  // 新しいケースファイルを追加
  const config = getScriptProperties().getProperty('APPROVAL_CONFIG') || '{}';
  let approvalConfig = {};
  
  try {
    approvalConfig = JSON.parse(config);
  } catch (_) {
    approvalConfig = {};
  }
  
  if (!approvalConfig.caseFiles) {
    approvalConfig.caseFiles = [];
  }
  
  const newFile = {
    fileId: 'file_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
    caseId: caseId,
    fileName: fileName,
    fileSize: fileSize,
    uploadedAt: new Date().toISOString(),
    uploadedBy: userEmail,
    status: 'uploaded',
    approvalRequired: isApprovalRequiredForCase(userEmail, caseId),
    approvalStatus: 'pending'
  };
  
  approvalConfig.caseFiles.push(newFile);
  
  getScriptProperties().setProperty('APPROVAL_CONFIG', JSON.stringify(approvalConfig));
  
  return newFile;
}