#!/usr/bin/env node
/**
 * Morning automation: candidates CSV → filter → fetch → extract → tier → drafts → shortlist → sheet → inbox → deadlines.
 *
 *   node tools/daily-pipeline.mjs [--date YYYY-MM-DD] [--dry-run] [--limit N]
 *     [--seen-file PATH] [--no-inbox] [--no-sheet] [--tag SUFFIX]
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PYTHON = 'C:\\Users\\kimko\\AppData\\Local\\Programs\\Python\\Python313\\python.exe';
const LLM = 'C:\\Users\\kimko\\.claude\\nightly-repo\\tools\\llm-ask.mjs';
const KIM_INBOX = 'C:\\Users\\kimko\\.claude\\nightly-repo\\tools\\kim-inbox.mjs';
const LEDGER = 'C:\\Users\\kimko\\.claude\\nightly-repo\\tools\\deadline-ledger.mjs';
const SA_KEY = path.join(os.homedir(), '.claude', 'keys', 'aujust-sheets-reader.json');
const SA_EMAIL = 'aujust-sheets-reader@aujust-sales-automation.iam.gserviceaccount.com';
const PROVIDERS = ['deepseek', 'openrouter', 'kimi'];
const SHEET_COLS = ['発見日', 'tier', '案件名', '発注者', '金額', '参加申込期限', '提出期限', '必要資格', '提出方法', '公告URL', '下書きの場所', '金さんの判断'];

const args = process.argv.slice(2);
function flag(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}
function has(name) {
  return args.includes(name);
}

function jstToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

const date = flag('--date') || jstToday();
const tag = flag('--tag') || '';
const dateTag = tag ? `${date}-${tag}` : date;
const dryRun = has('--dry-run');
const noInbox = has('--no-inbox');
const noSheet = has('--no-sheet');
const limit = flag('--limit') ? Number(flag('--limit')) : Infinity;
const seenFile = path.resolve(root, flag('--seen-file') || 'data/state/seen.json');
const profile = JSON.parse(fs.readFileSync(path.join(root, 'config/company-profile.json'), 'utf8'));
const keywords = profile.businessKeywords || [];
const maxNotices = profile.maxNoticesPerDay || 40;
const maxLlm = profile.maxLlmCallsPerDay || 60;
const maxDrafts = profile.maxDraftsPerDay || 3;
const localities = profile.registeredLocalities || [];
const zensho = profile.zenshoQualification || {};

const started = Date.now();
const failures = [];
let llmCalls = 0;
const stats = {
  date,
  dateTag,
  dryRun,
  newCount: 0,
  keywordHits: 0,
  llmClassifyPlanned: 0,
  llmClassifyHits: 0,
  fetchPlanned: 0,
  extractPlanned: 0,
  draftPlanned: 0,
  askPlanned: 0,
  tiers: { A: 0, B: 0, C: 0, 除外: 0 },
  llmCalls: 0,
  failures: [],
};

function log(...xs) {
  console.log(...xs);
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cur = '';
  let inQ = false;
  const s = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQ) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQ = false;
      } else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') {
      row.push(cur);
      cur = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cur);
      if (row.some((x) => x.trim())) rows.push(row);
      row = [];
      cur = '';
    } else cur += c;
  }
  if (cur.length || row.length) {
    row.push(cur);
    if (row.some((x) => x.trim())) rows.push(row);
  }
  return rows;
}

function loadSeen() {
  if (!fs.existsSync(seenFile)) return {};
  return JSON.parse(fs.readFileSync(seenFile, 'utf8'));
}

function saveSeen(seen) {
  if (dryRun) return;
  fs.mkdirSync(path.dirname(seenFile), { recursive: true });
  fs.writeFileSync(seenFile, JSON.stringify(seen, null, 2) + '\n', 'utf8');
}

function matchKeyword(title) {
  for (const kw of keywords) {
    if (kw && title.includes(kw)) return kw;
  }
  return '';
}

function fitScore(title, keyword) {
  const high = ['展示会', 'ブース', '設営', '動画制作', '映像制作', 'イベント運営', '式典'];
  const mid = ['イベント', '会場', '運営', '映像', '動画', '学会', '出展', 'オンライン配信', '会議運営'];
  const t = title || '';
  if (high.some((k) => t.includes(k) || keyword === k)) return '高';
  if (mid.some((k) => t.includes(k) || keyword === k)) return '中';
  return '低';
}

function localityCovered(org, regionText) {
  const blob = `${org || ''} ${regionText || ''}`;
  return localities.some((loc) => loc && blob.includes(loc));
}

function assignTier(rec, businessOk) {
  if (!businessOk) return 'C';
  const fetchOk = String(rec.fetch_status || '').includes('200');
  if (!fetchOk || !rec.fetched_files?.length) return 'C';
  if (rec.deadline_passed) return 'C';
  const zenshoBlock = rec.zensho_required && zensho.status !== 'active';
  const localBlock = rec.local_reg_required && !localityCovered(rec.org, rec.region_requirement);
  const regionBlock = !!rec.region_restricted;
  if (zenshoBlock || localBlock || regionBlock) return 'B';
  return 'A';
}

function slugify(no, title, keyword) {
  const base = (keyword || title || 'job')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
    .toLowerCase();
  const ascii = base.replace(/[^\x00-\x7F]/g, '') || 'job';
  return `${String(no).padStart(2, '0')}-${ascii}`.replace(/-+/g, '-');
}

function hashUrl(url) {
  return crypto.createHash('sha256').update(url).digest('hex').slice(0, 12);
}

function askLlm(promptText, max = 4000) {
  if (llmCalls >= maxLlm) {
    failures.push('maxLlmCallsPerDay reached');
    return null;
  }
  const tmp = path.join(root, 'data', 'state', `_llm-prompt-${Date.now()}.md`);
  fs.mkdirSync(path.dirname(tmp), { recursive: true });
  fs.writeFileSync(tmp, promptText, 'utf8');
  llmCalls++;
  stats.llmCalls = llmCalls;
  for (const provider of PROVIDERS) {
    const r = spawnSync(
      process.execPath,
      [LLM, '--provider', provider, '--prompt-file', tmp, '--no-fallback', '--max', String(max), '--per-provider-timeout-ms', '180000'],
      { cwd: root, encoding: 'utf8', timeout: 200000, maxBuffer: 20 * 1024 * 1024 },
    );
    if (r.status === 0 && r.stdout.trim().length > 10) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* keep */
      }
      return r.stdout.trim();
    }
    log(`llm ${provider} failed status=${r.status}`);
  }
  failures.push('LLM classify/draft providers all failed');
  return null;
}

function parseClassify(out, candidates) {
  const hits = [];
  const text = out || '';
  for (const c of candidates) {
    const no = c.no;
    const reYes = new RegExp(`(?:^|\\n)\\s*${no}\\s*[|:：,、\\s]+(?:YES|はい|対象|当社)`, 'i');
    if (reYes.test(text) || (text.includes(c.url) && /YES|はい|対象/.test(text.slice(Math.max(0, text.indexOf(c.url) - 40), text.indexOf(c.url) + c.url.length + 40)))) {
      hits.push(c);
    }
  }
  // Fallback: lines "NO|..." vs "YES|..." with URL
  if (!hits.length) {
    for (const line of text.split(/\r?\n/)) {
      if (!/YES|対象|はい/i.test(line)) continue;
      const m = line.match(/https?:\/\/\S+/);
      if (!m) continue;
      const found = candidates.find((c) => c.url === m[0].replace(/[)>\]].*$/, ''));
      if (found) hits.push(found);
    }
  }
  return hits;
}

function runPythonExtract(baseDir) {
  const r = spawnSync(PYTHON, [path.join(root, 'tools/build_extract.py'), baseDir, date], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120000,
  });
  if (r.status !== 0) {
    failures.push(`build_extract failed: ${r.stderr || r.stdout}`);
    return null;
  }
  log(r.stdout.trim());
  const p = path.join(baseDir, 'extract.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function runProcessNotices(listPath) {
  const r = spawnSync(
    PYTHON,
    [path.join(root, 'tools/process_notices.py'), '--date', dateTag, '--list', listPath, '--root', root],
    { cwd: root, encoding: 'utf8', timeout: 600000, maxBuffer: 20 * 1024 * 1024 },
  );
  if (r.status !== 0) {
    failures.push(`process_notices failed: ${(r.stderr || r.stdout || '').slice(0, 800)}`);
    return false;
  }
  log(r.stdout.slice(-2000));
  return true;
}

// clasp OAuth トークンを Drive API クライアントとして使いシート作成
async function createSheetViaClaspDriveApi() {
  const claspRc = path.join(os.homedir(), '.clasprc.json');
  if (!fs.existsSync(claspRc)) throw new Error('CLASPRC not found; cannot create sheet');
  const rc = JSON.parse(fs.readFileSync(claspRc, 'utf8'));
  const creds = rc.tokens?.default;
  if (!creds?.refresh_token) throw new Error('CLASPRC has no refresh_token');
  const refreshRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: creds.client_id,
      client_secret: creds.client_secret,
      refresh_token: creds.refresh_token,
      grant_type: 'refresh_token',
    }),
  });
  const refreshData = await refreshRes.json();
  if (!refreshRes.ok) throw new Error(`Clasp refresh: ${JSON.stringify(refreshData)}`);
  const claspToken = refreshData.access_token;

  // Drive API で spreadsheet MIME のファイルを作成
  const createRes = await fetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: { Authorization: `Bearer ${claspToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '官公庁入札 候補台帳', mimeType: 'application/vnd.google-apps.spreadsheet' }),
  });
  const file = await createRes.json();
  if (!createRes.ok) throw new Error(`Drive create: ${JSON.stringify(file)}`);
  const spreadsheetId = file.id;

  // CSV アップロードでヘッダー行を初期化
  const csvHeader = '﻿' + SHEET_COLS.join(',') + '\n';
  await fetch(`https://www.googleapis.com/upload/drive/v3/files/${spreadsheetId}?uploadType=media`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${claspToken}`, 'Content-Type': 'text/csv' },
    body: csvHeader,
  });

  // SA と kim@ を writer に追加
  for (const email of [SA_EMAIL, 'kim@orgiast.jp']) {
    await fetch(`https://www.googleapis.com/drive/v3/files/${spreadsheetId}/permissions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${claspToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'user', role: 'writer', emailAddress: email }),
    });
  }
  // anyone reader
  await fetch(`https://www.googleapis.com/drive/v3/files/${spreadsheetId}/permissions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${claspToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'anyone', role: 'reader', allowFileDiscovery: false }),
  });

  // シート名を '候補台帳' にリネーム（SA の Sheets API を使用）
  const saToken = await getSAToken('https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive');
  const metaRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties`, {
    headers: { Authorization: `Bearer ${saToken}` },
  });
  const meta = await metaRes.json();
  if (metaRes.ok && meta.sheets?.[0]) {
    const sheetNumId = meta.sheets[0].properties.sheetId;
    await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests: [{ updateSheetProperties: { properties: { title: '候補台帳', sheetId: sheetNumId }, fields: 'title' } }] }),
    });
  }

  const url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;
  const cfgPath = path.join(root, 'config/sheet.json');
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify({ spreadsheetId, url, sheetTitle: '候補台帳', createdWith: 'clasp-drive-api-fallback' }, null, 2) + '\n', 'utf8');
  log('sheet created via clasp Drive API', url);
  return { spreadsheetId, url, created: true, token: saToken };
}

// SA の JWT トークン取得（DWD/sub なし）
function getSAToken(scope) {
  const key = JSON.parse(fs.readFileSync(SA_KEY, 'utf8'));
  const now = Math.floor(Date.now() / 1000);
  const payload = JSON.stringify({ iss: SA_EMAIL, scope, aud: 'https://oauth2.googleapis.com/token', exp: now + 3600, iat: now });
  const header = JSON.stringify({ alg: 'RS256', typ: 'JWT' });
  const b64 = (s) => Buffer.from(s).toString('base64url');
  const sig = crypto.createSign('RSA-SHA256').update(`${b64(header)}.${b64(payload)}`).sign(key.private_key, 'base64url');
  const jwt = `${b64(header)}.${b64(payload)}.${sig}`;
  return fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
  }).then(r => r.json()).then(d => { if (!d.access_token) throw new Error(`SA token: ${JSON.stringify(d)}`); return d.access_token; });
}

async function ensureSheet() {
  const cfgPath = path.join(root, 'config/sheet.json');
  if (fs.existsSync(cfgPath)) {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    return { spreadsheetId: cfg.spreadsheetId, url: cfg.url || `https://docs.google.com/spreadsheets/d/${cfg.spreadsheetId}/edit`, created: false };
  }
  try {
    // まず SA 自身の identity で Sheets API 作成を試行
    const token = await getSAToken('https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive');
    const createRes = await fetch('https://sheets.googleapis.com/v4/spreadsheets', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ properties: { title: '官公庁入札 候補台帳' }, sheets: [{ properties: { title: '候補台帳' } }] }),
    });
    const sheet = await createRes.json();
    if (!createRes.ok) throw new Error(`Sheet create SA: ${JSON.stringify(sheet)}`);
    const spreadsheetId = sheet.spreadsheetId;
    await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/候補台帳!A1`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ range: '候補台帳!A1', majorDimension: 'ROWS', values: [SHEET_COLS] }),
    });
    await fetch(`https://www.googleapis.com/drive/v3/files/${spreadsheetId}/permissions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'user', role: 'writer', emailAddress: 'kim@orgiast.jp' }),
    });
    const permRes = await fetch(`https://www.googleapis.com/drive/v3/files/${spreadsheetId}/permissions?fields=permissions(id,emailAddress,role)`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const perms = await permRes.json();
    const url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;
    fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
    fs.writeFileSync(cfgPath, JSON.stringify({ spreadsheetId, url, sheetTitle: '候補台帳', permissions: perms.permissions || [] }, null, 2) + '\n', 'utf8');
    log('sheet created via SA identity', url);
    return { spreadsheetId, url, created: true, permissions: perms.permissions, token };
  } catch (e) {
    log('SA sheet create failed:', e.message);
    log('falling back to clasp OAuth + Drive API');
    return createSheetViaClaspDriveApi();
  }
}

async function appendSheetRows(spreadsheetId, rows, tokenHint) {
  let token = tokenHint;
  if (!token) {
    const key = JSON.parse(fs.readFileSync(SA_KEY, 'utf8'));
    const now = Math.floor(Date.now() / 1000);
    const payload = JSON.stringify({
      iss: SA_EMAIL,
      scope: 'https://www.googleapis.com/auth/spreadsheets',
      aud: 'https://oauth2.googleapis.com/token',
      exp: now + 3600,
      iat: now,
    });
    const header = JSON.stringify({ alg: 'RS256', typ: 'JWT' });
    const b64 = (s) => Buffer.from(s).toString('base64url');
    const sig = crypto.createSign('RSA-SHA256').update(`${b64(header)}.${b64(payload)}`).sign(key.private_key, 'base64url');
    const jwt = `${b64(header)}.${b64(payload)}.${sig}`;
    const tokRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
    });
    const tok = await tokRes.json();
    if (!tokRes.ok) throw new Error(JSON.stringify(tok));
    token = tok.access_token;
  }
  if (!rows.length) return;
  await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/候補台帳!A:L:append?valueInputOption=USER_ENTERED`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ majorDimension: 'ROWS', values: rows }),
  });
}

function writeShortlist(tiers, byTier) {
  const out = path.join(root, `reports/shortlist-${dateTag}.md`);
  const mdEscape = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const lines = [
    `# 官公庁入札 候補一覧（${dateTag}）`,
    '',
    `- 対象: 候補CSV ${date} の未処理URL。キーワード一致 ${stats.keywordHits} 件、LLM分類 ${stats.llmClassifyHits} 件、取得 ${stats.fetchPlanned} 件。`,
    `- 原文: \`data/notices/${dateTag}/\`（raw / txt / extract.json）。`,
    `- 前提: 全省庁統一資格 status=${zensho.status || 'unknown'}。登録名簿: ${localities.join('・') || 'なし'}。`,
    '',
    '## 結論',
    '',
    `A ${byTier.A.length} 件 / B ${byTier.B.length} 件 / C ${byTier.C.length} 件。`,
    '',
    '## A. 今から提出を検討できる、または条件付きで間に合う',
    '',
    '| # | 案件名（原文） | 発注者 | 金額目安（原文） | 締切（原文） | 適合度 | 必要資格（原文の要点） | 提出方法 | 提出可否 | 公告URL | 下書き |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  byTier.A.forEach((r, i) => {
    const deadline = [r.apply_deadline, r.submit_deadline].filter(Boolean).join(' / ') || '不明';
    lines.push(
      `| A${i + 1} | ${mdEscape(r.title)} | ${mdEscape(r.org)} | ${mdEscape(r.amount_text || '金額不明')} | ${mdEscape(deadline)} | ${r.fit || ''} | ${mdEscape((r.qualification || '').slice(0, 120))} | ${mdEscape((r.submit_method || '').slice(0, 80))} | ${r.tierNote || ''} | ${r.url} | ${r.draftPath || ''} |`,
    );
  });
  lines.push('', '## B. 金額は大きいが、今は提出できない（理由つき・次回のための参考）', '', '| 案件名 | 発注者 | 金額（原文） | 締切（原文） | 適合度 | 提出できない理由（原文） |', '|---|---|---|---|---|---|');
  for (const r of byTier.B) {
    const deadline = [r.apply_deadline, r.submit_deadline].filter(Boolean).join(' / ') || '';
    lines.push(`| ${mdEscape(r.title)} | ${mdEscape(r.org)} | ${mdEscape(r.amount_text || '')} | ${mdEscape(deadline)} | ${r.fit || ''} | ${mdEscape(r.tierNote || '')} |`);
  }
  lines.push('', '## C. 取得できなかった公告（理由）', '', '| 案件 | 理由 |', '|---|---|');
  for (const r of byTier.C) {
    lines.push(`| ${mdEscape(r.title || r.url)} | ${mdEscape(r.tierNote || r.notes || r.fetch_status || '')} |`);
  }
  lines.push('');
  if (!dryRun) fs.writeFileSync(out, lines.join('\n'), 'utf8');
  return out;
}

function writeKimAsk(aRows) {
  const out = path.join(root, `reports/kim-ask-${dateTag}.md`);
  const body = [
    `【金さんへの確認（1回の返信で済みます）】官公庁入札 ${date} 分、どれを進めるか選んでください。`,
    '',
    ...aRows.map((r, i) => {
      const deadline = [r.apply_deadline, r.submit_deadline].filter(Boolean).join(' / ') || '不明';
      return [
        `${i + 1}: ${r.org}「${r.title}」`,
        `・金額: ${r.amount_text || '不明'}`,
        `・締切: ${deadline}`,
        `・必要資格: ${(r.qualification || '').slice(0, 160) || '不明'}`,
        `・提出方法: ${(r.submit_method || '').slice(0, 120) || '不明'}`,
        `・下書き: ${r.draftPath || 'なし'}`,
        `・公告URL: ${r.url}`,
        `・選択肢: 進める／見送る`,
        '',
      ].join('\n');
    }),
    '返事の例: 「1を進める」 または 「全部見送り」',
    '',
  ].join('\n');
  if (!dryRun) fs.writeFileSync(out, body, 'utf8');
  return { path: out, body };
}

function parseWarekiToIso(value) {
  if (!value) return '';
  const m = String(value).match(/令和\s*([８９89])\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (!m) {
    const w = String(value).match(/20\d{2}[-/年]\d{1,2}[-/月]\d{1,2}/);
    if (!w) return '';
    const n = w[0].replace(/[年月]/g, '-').replace(/日/, '').replace(/\//g, '-');
    const [y, mo, d] = n.split('-').map(Number);
    if (y && mo && d) return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    return '';
  }
  const y = Number(m[1].replace('８', '8').replace('９', '9')) + 2018;
  return `${y}-${String(Number(m[2])).padStart(2, '0')}-${String(Number(m[3])).padStart(2, '0')}`;
}

async function registerDeadlines(aRows) {
  const mod = await import(`file:///${LEDGER.replace(/\\/g, '/')}`);
  const { createLedger, loadConfig, isDuplicate, nextId, withLedgerLock, normalizeSeed } = mod;
  const home = os.homedir();
  await withLedgerLock(home, async () => {
    const config = loadConfig(home);
    const ledger = createLedger({ config });
    const all = [...(await ledger.read()), ...(await ledger.read('候補'))];
    const seeds = [];
    for (const r of aRows) {
      for (const [kindKey, field] of [
        ['apply', r.apply_deadline],
        ['submit', r.submit_deadline],
      ]) {
        const due = parseWarekiToIso(field);
        if (!due) continue;
        const sourceId = `orgiast-bid:${hashUrl(r.url)}:${kindKey}`;
        const seed = normalizeSeed({
          title: `${r.title}（${kindKey === 'apply' ? '参加申込' : '提出'}）`,
          kind: '提出',
          company: r.org || '',
          due,
          source: 'orgiast-bid',
          sourceId,
          action: '官公庁入札の提出・申込確認',
          quote: field,
          notes: r.url,
          status: '未着手',
        });
        if (isDuplicate(seed, all)) continue;
        seed.id = nextId([...all, ...seeds]);
        seeds.push(seed);
      }
    }
    if (seeds.length) {
      await ledger.append(seeds);
      all.push(...seeds);
    }
    log(`deadline registered: ${seeds.length}`);
  });
}

async function main() {
  const csvPath = path.join(root, `data/candidates-${date}.csv`);
  if (!fs.existsSync(csvPath)) {
    console.error(`missing CSV: ${csvPath}`);
    process.exit(1);
  }
  const seen = loadSeen();
  const table = parseCsv(fs.readFileSync(csvPath, 'utf8'));
  const header = table[0] || [];
  const idx = Object.fromEntries(header.map((h, i) => [h.trim(), i]));
  const urlCol = idx['公告URL'];
  if (urlCol == null) {
    console.error('CSV missing 公告URL column');
    process.exit(1);
  }

  const fresh = [];
  for (const cells of table.slice(1)) {
    const url = (cells[urlCol] || '').trim();
    if (!url.startsWith('http')) continue;
    if (seen[url]) continue;
    fresh.push({
      title: cells[idx['案件名']] || '',
      org: cells[idx['発注機関']] || '',
      format: cells[idx['入札形式']] || '',
      noticeDate: cells[idx['公告日']] || date,
      url,
      keywordCsv: cells[idx['合致キーワード']] || '',
    });
  }
  stats.newCount = fresh.length;
  let work = fresh.slice(0, Number.isFinite(limit) ? limit : fresh.length);

  const keywordHits = [];
  const others = [];
  for (const row of work) {
    const kw = matchKeyword(row.title) || (row.keywordCsv || '').trim();
    if (kw) {
      row.keyword = kw;
      row.nameFilter = 'keyword';
      keywordHits.push(row);
    } else {
      others.push(row);
    }
  }
  stats.keywordHits = keywordHits.length;
  stats.llmClassifyPlanned = others.length;

  let llmHits = [];
  if (others.length) {
    if (dryRun) {
      log(`[dry-run] skip LLM classify for ${others.length}`);
    } else if (llmCalls >= maxLlm) {
      failures.push('maxLlmCallsPerDay before classify');
    } else {
      const numbered = others.map((r, i) => ({ ...r, no: String(i + 1).padStart(3, '0') }));
      const prompt = [
        'あなたは株式会社オージャスト（展示会ブース・イベント設営・式典・映像/動画制作・学会出展・会場運営）の案件判定係です。',
        '各行について当社の業務として検討する価値があるなら YES、無いなら NO と答えてください。',
        '出力形式（1行1件）: <番号>|YESまたはNO|<短い理由>',
        '',
        ...numbered.map((r) => `${r.no}|${r.org}|${r.title}|${r.url}`),
      ].join('\n');
      const out = askLlm(prompt, 6000);
      if (out) {
        llmHits = parseClassify(out, numbered).map((r) => ({ ...r, nameFilter: 'llm', keyword: r.keyword || 'llm' }));
        stats.llmClassifyHits = llmHits.length;
        // mark all scanned as seen later
        for (const r of others) {
          if (!llmHits.find((h) => h.url === r.url)) {
            r.nameFilter = 'llm-scan';
            r.tier = '除外';
          }
        }
      }
    }
  }

  let selected = [...keywordHits, ...llmHits];
  if (selected.length > maxNotices) selected = selected.slice(0, maxNotices);
  stats.fetchPlanned = selected.length;
  stats.extractPlanned = selected.length;

  // Dry-run draft/ask estimate (without extract we approximate A drafts from keywordHits)
  if (dryRun) {
    stats.draftPlanned = Math.min(maxDrafts, selected.length);
    stats.askPlanned = selected.length > 0 ? 0 : 0; // unknown until tier; report 0 for safety unless we assume
    // For dry-run with seen-full day, new=0 ask=0. With new items, askPlanned = 1 if any selected (optimistic A)
    // Spec: print askPlanned — use min(1, selected) as planned ask if any selected (pipeline would ask only if A>=1)
    stats.askPlanned = selected.length >= 1 ? 1 : 0;
    // Actually for 2026-11-20 all seen → new 0 ask 0. For 11-19 with limit, selected may be >0.
    // Better: askPlanned = selected.length >= 1 ? 1 : 0 is OK for dry-run estimate of "might ask".
    // User said dry-run for 11-20 → new 0 ask 0. For limit 5 on 11-19, print planned counts.
    log(
      JSON.stringify(
        {
          newCount: stats.newCount,
          keywordHits: stats.keywordHits,
          llmClassifyPlanned: stats.llmClassifyPlanned,
          fetchPlanned: stats.fetchPlanned,
          extractPlanned: stats.extractPlanned,
          draftPlanned: stats.draftPlanned,
          askPlanned: stats.askPlanned,
          workLimited: work.length,
        },
        null,
        2,
      ),
    );
    appendRunLog();
    return;
  }

  // Persist llm-scan exclusions into seen
  for (const r of others) {
    if (llmHits.find((h) => h.url === r.url)) continue;
    seen[r.url] = {
      firstSeen: date,
      nameFilter: 'llm-scan',
      keyword: '',
      tier: '除外',
      title: r.title,
      org: r.org,
      applyDeadline: '',
      submitDeadline: '',
      askedKim: false,
      askedOn: '',
      draftPath: '',
    };
  }

  const noticesDir = path.join(root, 'data/notices', dateTag);
  fs.mkdirSync(noticesDir, { recursive: true });
  const listLines = selected.map((r, i) => {
    const no = String(i + 1).padStart(2, '0');
    r.no = no;
    return `${no}|${r.noticeDate || date}|${r.format || ''}|${r.org}|${r.title}|${r.url}|${r.keyword || ''}`;
  });
  const listPath = path.join(noticesDir, 'list.txt');
  fs.writeFileSync(listPath, listLines.join('\n') + (listLines.length ? '\n' : ''), 'utf8');

  if (selected.length) {
    if (llmCalls >= maxLlm) {
      failures.push('maxLlmCallsPerDay before fetch stage stop');
    } else {
      const ok = runProcessNotices(listPath);
      if (!ok) log('fetch stage failed; continuing');
    }
  }

  let extract = [];
  if (selected.length && fs.existsSync(path.join(noticesDir, 'fetch-manifest.json'))) {
    extract = runPythonExtract(noticesDir) || [];
  }

  const byUrl = Object.fromEntries(extract.map((e) => [e.url, e]));
  const enriched = [];
  for (const r of selected) {
    const ex = byUrl[r.url] || {
      no: r.no,
      org: r.org,
      title: r.title,
      url: r.url,
      fetch_status: 'missing',
      fetched_files: [],
      apply_deadline: '',
      submit_deadline: '',
      amount_text: '',
      qualification: '',
      submit_method: '',
      zensho_required: false,
      local_reg_required: false,
      region_restricted: false,
      deadline_passed: false,
      notes: 'extract missing',
      region_requirement: '',
    };
    const businessOk = true; // selected already passed filter
    const tier = assignTier(ex, businessOk);
    let tierNote = '';
    if (tier === 'C') {
      if (ex.deadline_passed) tierNote = '期限経過';
      else if (!String(ex.fetch_status || '').includes('200')) tierNote = ex.fetch_status || '取得失敗';
      else tierNote = ex.notes || 'C';
    } else if (tier === 'B') {
      const reasons = [];
      if (ex.zensho_required && zensho.status !== 'active') reasons.push('全省庁統一資格が必要だが期限切れ/未取得');
      if (ex.local_reg_required && !localityCovered(ex.org, ex.region_requirement)) reasons.push('自治体名簿が必要で未登録');
      if (ex.region_restricted) reasons.push('地域制限');
      tierNote = reasons.join('；') || '資格・地域で提出不可';
    } else {
      tierNote = '今から検討可';
    }
    const fit = fitScore(ex.title || r.title, r.keyword || '');
    const slug = slugify(r.no, ex.title || r.title, r.keyword);
    enriched.push({ ...ex, ...r, title: ex.title || r.title, org: ex.org || r.org, tier, tierNote, fit, slug, draftPath: '' });
  }

  const byTier = { A: [], B: [], C: [] };
  for (const r of enriched) {
    byTier[r.tier]?.push(r);
    stats.tiers[r.tier] = (stats.tiers[r.tier] || 0) + 1;
  }

  // Drafts for A with fit 高/中
  const draftCandidates = byTier.A.filter((r) => r.fit === '高' || r.fit === '中').slice(0, maxDrafts);
  stats.draftPlanned = draftCandidates.length;
  if (draftCandidates.length && llmCalls < maxLlm) {
    const jobs = {};
    const txtDir = path.join(noticesDir, 'txt');
    for (const r of draftCandidates) {
      const files = fs.existsSync(txtDir)
        ? fs.readdirSync(txtDir).filter((f) => f.startsWith(r.no) && f.endsWith('.txt'))
        : [];
      if (!files.length) {
        failures.push(`no txt for draft ${r.slug}`);
        continue;
      }
      jobs[r.slug] = files;
      r.draftPath = `reports/drafts/${dateTag}/${r.slug}/`;
    }
    if (Object.keys(jobs).length) {
      const jobsFile = path.join(noticesDir, 'draft-jobs.json');
      fs.writeFileSync(jobsFile, JSON.stringify(jobs, null, 2), 'utf8');
      const bp = spawnSync(
        process.execPath,
        [path.join(root, 'tools/build_draft_prompts.mjs'), '--date', dateTag, '--jobs-file', jobsFile, '--txt-dir', txtDir],
        { cwd: root, encoding: 'utf8', timeout: 60000 },
      );
      if (bp.status !== 0) failures.push(`build_draft_prompts: ${(bp.stderr || bp.stdout || '').slice(0, 500)}`);
      else if (llmCalls >= maxLlm) {
        failures.push('maxLlmCallsPerDay before drafts');
      } else {
        const rd = spawnSync(
          process.execPath,
          [path.join(root, 'tools/run_draft_llms.mjs'), '--date', dateTag, ...Object.keys(jobs)],
          { cwd: root, encoding: 'utf8', timeout: 900000, maxBuffer: 20 * 1024 * 1024 },
        );
        llmCalls += Object.keys(jobs).length * 2;
        stats.llmCalls = llmCalls;
        log(rd.stdout || '');
        if (rd.status !== 0) failures.push(`run_draft_llms status=${rd.status}`);
      }
    }
  } else if (draftCandidates.length && llmCalls >= maxLlm) {
    failures.push('maxLlmCallsPerDay stop before drafts');
  }

  const shortlistPath = writeShortlist(stats.tiers, byTier);
  log('shortlist', shortlistPath);

  // Update seen
  for (const r of enriched) {
    seen[r.url] = {
      firstSeen: date,
      nameFilter: r.nameFilter || 'keyword',
      keyword: r.keyword || '',
      tier: r.tier,
      title: r.title,
      org: r.org,
      applyDeadline: r.apply_deadline || '',
      submitDeadline: r.submit_deadline || '',
      askedKim: false,
      askedOn: '',
      draftPath: r.draftPath || '',
      extractNo: r.no,
    };
  }

  // Sheet
  let sheetMeta = null;
  if (!noSheet) {
    try {
      sheetMeta = await ensureSheet();
      const rows = enriched.map((r) => [
        date,
        r.tier,
        r.title,
        r.org,
        r.amount_text || '',
        r.apply_deadline || '',
        r.submit_deadline || '',
        (r.qualification || '').slice(0, 200),
        (r.submit_method || '').slice(0, 120),
        r.url,
        r.draftPath || '',
        '',
      ]);
      await appendSheetRows(sheetMeta.spreadsheetId, rows, sheetMeta.token);
      log('sheet appended', rows.length, sheetMeta.url);
    } catch (e) {
      failures.push(`sheet: ${e.message}`);
      log('sheet error (continue):', e.message);
    }
  }

  // Inbox ask
  stats.askPlanned = byTier.A.length >= 1 ? 1 : 0;
  if (byTier.A.length >= 1 && !noInbox) {
    const ask = writeKimAsk(byTier.A);
    const r = spawnSync(process.execPath, [KIM_INBOX, '--add', '--kind', 'ask', '--body-file', ask.path, '--source', 'orgiast-bid-daily'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 60000,
    });
    if (r.status !== 0) failures.push(`kim-inbox ask: ${(r.stderr || r.stdout || '').slice(0, 400)}`);
    else {
      for (const a of byTier.A) {
        if (seen[a.url]) {
          seen[a.url].askedKim = true;
          seen[a.url].askedOn = date;
        }
      }
      log('kim-inbox ask added');
    }
  }

  // Deadlines
  if (byTier.A.length) {
    try {
      await registerDeadlines(byTier.A);
    } catch (e) {
      failures.push(`deadline: ${e.message}`);
      log('deadline error (continue):', e.message);
    }
  }

  saveSeen(seen);

  if (failures.length && !noInbox) {
    const failBody = path.join(root, `reports/pipeline-fail-${dateTag}.md`);
    fs.writeFileSync(failBody, `【info】orgiast-bid daily-pipeline ${dateTag} 失敗\n\n` + failures.map((f) => `- ${f}`).join('\n') + '\n', 'utf8');
    const r = spawnSync(process.execPath, [KIM_INBOX, '--add', '--kind', 'info', '--body-file', failBody, '--source', 'orgiast-bid-daily'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 60000,
    });
    if (r.status !== 0) log('fail inbox info failed', r.stderr || r.stdout);
  }

  stats.failures = failures;
  stats.llmCalls = llmCalls;
  stats.seconds = Math.round((Date.now() - started) / 1000);
  appendRunLog();
  log(
    JSON.stringify(
      {
        dateTag,
        newCount: stats.newCount,
        keywordHits: stats.keywordHits,
        llmClassifyHits: stats.llmClassifyHits,
        fetched: selected.length,
        extract: extract.length,
        tiers: stats.tiers,
        drafts: draftCandidates.length,
        ask: stats.askPlanned,
        noticesDir,
        shortlistPath,
        sheet: sheetMeta?.url || null,
        failures,
      },
      null,
      2,
    ),
  );
  if (failures.length) process.exitCode = 1;
}

function appendRunLog() {
  const line = {
    at: new Date().toISOString(),
    date,
    dateTag,
    dryRun,
    newCount: stats.newCount,
    keywordHits: stats.keywordHits,
    llmClassifyPlanned: stats.llmClassifyPlanned,
    llmClassifyHits: stats.llmClassifyHits,
    fetchPlanned: stats.fetchPlanned,
    extractPlanned: stats.extractPlanned,
    draftPlanned: stats.draftPlanned,
    askPlanned: stats.askPlanned,
    tiers: stats.tiers,
    llmCalls: stats.llmCalls || llmCalls,
    failures,
    seconds: Math.round((Date.now() - started) / 1000),
  };
  const p = path.join(root, 'data/pipeline-runs.jsonl');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, JSON.stringify(line) + '\n', 'utf8');
}

main().catch((e) => {
  console.error('FATAL', e);
  failures.push(String(e.message || e));
  appendRunLog();
  process.exit(1);
});
