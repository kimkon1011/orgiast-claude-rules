import { getDriveToken } from '../tools/lib/drive-auth.mjs';
import { writeFileSync } from 'node:fs';
const ID = '1rTaqIMkw3mFv5S04E-e_Gi5JTaAeGrZ4v95-1eh2fbM';
const scopes = ['https://www.googleapis.com/auth/forms.body.readonly', 'https://www.googleapis.com/auth/drive'];
let lastErr;
for (const scope of scopes) {
  try {
    const token = await getDriveToken({ scope });
    const res = await fetch(`https://forms.googleapis.com/v1/forms/${ID}`, { headers: { Authorization: `Bearer ${token}` } });
    const text = await res.text();
    if (!res.ok) { lastErr = `${scope}: ${res.status} ${text.slice(0, 400)}`; console.error(lastErr); continue; }
    writeFileSync(new URL('./form.json', import.meta.url), text);
    console.log('OK via', scope, 'bytes', text.length);
    process.exit(0);
  } catch (e) { lastErr = `${scope}: ${e.message}`; console.error(lastErr); }
}
process.exit(1);
