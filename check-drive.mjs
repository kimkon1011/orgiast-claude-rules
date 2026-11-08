import { getDriveToken, driveApi, defaultDriveKeyPath } from './tools/lib/drive-auth.mjs';
async function main() {
  const token = await getDriveToken('seisaku-team@orgiast.jp', defaultDriveKeyPath);
  const api = driveApi(token);
  
  // Check the known folder ID
  try {
    const res = await api.files.get({
      fileId: '1Ptwlbp28q0lmBHUdIjO1_6g_urtThpV0',
      fields: 'id,name,mimeType,parents,webViewLink',
      supportsAllDrives: true
    });
    console.log('FILE:', JSON.stringify(res.data, null, 2));
  } catch(e) {
    console.log('1Ptwlbp28q0lmBHUdIjO1_6g_urtThpV0 NOT_FOUND:', e.message);
  }
  
  // Create a new folder called "212coffeeメニュー写真_わんすけ掲載用"
  try {
    const folder = await api.files.create({
      requestBody: {
        name: '212coffeeメニュー写真_わんすけ掲載用',
        mimeType: 'application/vnd.google-apps.folder',
      },
      fields: 'id,name,webViewLink',
      supportsAllDrives: true
    });
    console.log('FOLDER_CREATED:', JSON.stringify(folder.data, null, 2));
  } catch(e) {
    console.log('FOLDER_CREATE_FAILED:', e.message);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
