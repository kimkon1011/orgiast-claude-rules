import { uploadReport } from './report-upload.mjs';
import { reason } from './common.mjs';

// A failed upload must not prevent delivery of the local report location.
export async function reportLocation(file, { upload = uploadReport, keyPath, log = console.error } = {}) {
  try {
    const result = await upload(file, { keyPath });
    const url = new URL(result.url);
    if (url.protocol !== 'https:' || url.hostname !== 'drive.google.com') throw new Error('Invalid Drive URL');
    return result.url;
  } catch (e) {
    log(`internal-audit: Driveアップロード失敗。ローカル保存先で通知: ${reason(e)}`);
    return file;
  }
}
