import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { getDriveToken, driveApi } from '../tools/lib/drive-auth.mjs';
import { searchGmail } from '../tools/gmail-search.mjs';

async function main() {
  const evidence = {
    timestamp: new Date().toISOString(),
    task: 'next-session.md:a1deae0c0001310214c1',
    description: '[ラハイナ] 伊藤氏LINE返答・資料受領・PayPay準備書更新',
    status: 'BLOCKED_WAITING_ON_EXTERNAL_INPUT',
    findings: {},
  };

  // 1. Gmail Check
  evidence.findings.gmail = {};
  for (const user of ['kim@orgiast.jp', 'seisaku-team@orgiast.jp', 'nishi@orgiast.jp']) {
    try {
      const res = await searchGmail({ user, query: 'in:anywhere ito@k-ikou.co.jp', max: 5 });
      evidence.findings.gmail[user] = {
        totalEstimate: res.estimate,
        messages: res.messages.map(m => ({ id: m.id, date: m.date, subject: m.subject, labels: m.labels })),
      };
    } catch (e) {
      evidence.findings.gmail[user] = { error: e.message };
    }
  }

  // 2. Draft Check
  try {
    const draftRes = await searchGmail({ user: 'seisaku-team@orgiast.jp', query: 'in:drafts to:ito@k-ikou.co.jp', max: 2, withBody: true });
    evidence.findings.draft = {
      count: draftRes.estimate,
      messages: draftRes.messages.map(m => ({
        id: m.id,
        date: m.date,
        subject: m.subject,
        to: m.to,
        snippet: m.snippet,
      })),
    };
  } catch (e) {
    evidence.findings.draft = { error: e.message };
  }

  // 3. Drive Check
  try {
    const token = await getDriveToken();
    const folderRes = await driveApi(token, `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent("trashed = false and mimeType = 'application/vnd.google-apps.folder' and name contains 'ラハイナPJ'")}&fields=files(id,name)`);
    const folders = await folderRes.json();
    evidence.findings.driveFolders = [];
    for (const folder of folders.files || []) {
      const childrenRes = await driveApi(token, `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(`trashed = false and '${folder.id}' in parents`)}&fields=files(id,name,mimeType,modifiedTime)`);
      const children = await childrenRes.json();
      evidence.findings.driveFolders.push({
        folderId: folder.id,
        folderName: folder.name,
        files: children.files || [],
      });
    }
  } catch (e) {
    evidence.findings.drive = { error: e.message };
  }

  // 4. Calendar Check
  try {
    const token = await getDriveToken({ scope: 'https://www.googleapis.com/auth/calendar.readonly', impersonate: 'kim@orgiast.jp' });
    const timeMin = new Date('2026-10-26T00:00:00+09:00').toISOString();
    const timeMax = new Date('2026-10-26T23:59:59+09:00').toISOString();
    const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}&singleEvents=true&orderBy=startTime`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();
    evidence.findings.calendarEvents = (data.items || []).filter(e => e.summary && e.summary.includes('ラハイナ')).map(e => ({
      id: e.id,
      summary: e.summary,
      start: e.start,
      hangoutLink: e.hangoutLink,
    }));
  } catch (e) {
    evidence.findings.calendar = { error: e.message };
  }

  mkdirSync('evidence', { recursive: true });
  const outPath = 'C:\\Users\\kimko\\.claude\\nightly-repo\\evidence\\stall-sweeper-20261026-lahaina.json';
  const jsonStr = JSON.stringify(evidence, null, 2);
  writeFileSync(outPath, jsonStr, 'utf8');

  const hash = createHash('sha256').update(readFileSync(outPath)).digest('hex');
  console.log('Evidence file created at:', outPath);
  console.log('SHA256:', hash);
}

main().catch(console.error);
