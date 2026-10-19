import { getDriveToken, driveApi } from './tools/lib/drive-auth.mjs';
const ID = '1rTaqIMkw3mFv5S04E-e_Gi5JTaAeGrZ4v95-1eh2fbM';
const scopes = ['https://www.googleapis.com/auth/forms.body.readonly', 'https://www.googleapis.com/auth/drive.readonly', 'https://www.googleapis.com/auth/drive'];
for (const scope of scopes) {
  try {
    const token = await getDriveToken({ scope });
    const res = await driveApi(token, `https://forms.googleapis.com/v1/forms/${ID}`);
    const json = await res.json();
    console.error('scope ok:', scope);
    console.log(JSON.stringify(json, null, 1));
    process.exit(0);
  } catch (e) {
    console.error('fail', scope, String(e.message).slice(0, 300));
  }
}
process.exit(1);
