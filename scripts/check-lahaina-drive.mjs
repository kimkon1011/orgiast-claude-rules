import { getDriveToken, driveApi } from '../tools/lib/drive-auth.mjs';

async function main() {
  try {
    const token = await getDriveToken();
    const q = "trashed = false and (name contains 'ラハイナ' or name contains 'lahaina' or name contains '許可証' or name contains '譲渡')";
    const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType,modifiedTime,parents)&pageSize=30&orderBy=modifiedTime desc`;
    const res = await driveApi(token, url);
    const data = await res.json();
    console.log('--- Search files ---');
    for (const f of data.files || []) {
      console.log(`${f.modifiedTime} | ${f.id} | ${f.name} (${f.mimeType})`);
    }

    const folderRes = await driveApi(token, `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent("trashed = false and mimeType = 'application/vnd.google-apps.folder' and name contains 'ラハイナ'")}&fields=files(id,name)`);
    const folders = await folderRes.json();
    console.log('--- Folders ---', folders.files);

    for (const folder of folders.files || []) {
      const childrenRes = await driveApi(token, `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(`trashed = false and '${folder.id}' in parents`)}&fields=files(id,name,mimeType,modifiedTime)`);
      const children = await childrenRes.json();
      console.log(`--- Folder ${folder.name} (${folder.id}) contents ---`);
      for (const f of children.files || []) {
        console.log(`  ${f.modifiedTime} | ${f.id} | ${f.name} (${f.mimeType})`);
      }
    }
  } catch (err) {
    console.error(err);
  }
}

main();
