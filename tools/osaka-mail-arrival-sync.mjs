#!/usr/bin/env node
// 大阪事務所 LINE（Beeper）の郵便到着写真を、到着確認スプレッドシートへ追記する。
// 社外送信・LINE 返信はしない。重複は元メッセージIDで防ぐ。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export function resolveToolsDir({ env = process.env, existsSyncFn = fs.existsSync } = {}) {
  if (existsSyncFn(path.join(here, 'beeper-api.mjs'))) return here;
  const home = env.ORGIAST_HOME || os.homedir();
  const candidates = [
    env.ORGIAST_REPO && path.join(env.ORGIAST_REPO, 'tools'),
    path.join(home, '.claude', 'nightly-repo', 'tools'),
  ].filter(Boolean);
  for (const dir of candidates) {
    if (existsSyncFn(path.join(dir, 'beeper-api.mjs'))) return dir;
  }
  throw new Error('nightly-repo/tools が見つかりません');
}

async function loadTools(toolsDir = resolveToolsDir()) {
  const toUrl = (name) => pathToFileURL(path.join(toolsDir, name));
  const [
    beeper,
    envKv,
    isEntryMod,
    driveAuth,
    driveFiles,
    driveUpload,
    sheetsDwd,
    workspaceUrlMod,
    kimEditor,
    notifyMod,
    ledger,
  ] = await Promise.all([
    import(toUrl('beeper-api.mjs')),
    import(toUrl('env-kv.mjs')),
    import(toUrl('is-entry.mjs')),
    import(toUrl('lib/drive-auth.mjs')),
    import(toUrl('lib/drive-files.mjs')),
    import(toUrl('drive-upload.mjs')),
    import(toUrl('lib/sheets-dwd.mjs')),
    import(toUrl('lib/workspace-url.mjs')),
    import(toUrl('lib/kim-editor.mjs')),
    import(toUrl('notify-kim.mjs')),
    import(toUrl('gemini-usage-ledger.mjs')),
  ]);
  return {
    listMessages: beeper.listMessages,
    downloadAttachment: beeper.downloadAttachment,
    readEnvValue: envKv.readEnvValue,
    upsertEnvValue: envKv.upsertEnvValue,
    isEntry: isEntryMod.isEntry,
    getDriveToken: driveAuth.getDriveToken,
    driveApi: driveAuth.driveApi,
    findOrCreateFolder: driveFiles.findOrCreateFolder,
    findByTitle: driveFiles.findByTitle,
    upload: driveUpload.upload,
    createSheetsClient: sheetsDwd.createSheetsClient,
    quoteTab: sheetsDwd.quoteTab,
    workspaceUrl: workspaceUrlMod.workspaceUrl,
    ensureKimEditor: kimEditor.ensureKimEditor,
    KIM_EMAIL: kimEditor.KIM_EMAIL,
    notifyKim: notifyMod.notifyKim,
    recordGeminiUsage: ledger.recordGeminiUsage,
    geminiUsage: ledger.geminiUsage,
    toolsDir,
  };
}

export const DEFAULT_CHAT_ID = '!by64OedAHphJcRpIsHSG:beeper.local';
export const DEFAULT_CHAT_TITLE = '大阪事務所(ｶﾌｪ)×制作';
export const SHEET_TITLE = '大阪事務所 郵便到着確認';
export const TAB_TITLE = '到着一覧';
export const PHOTO_FOLDER_NAME = '大阪事務所 郵便到着写真';
export const PARENT_FOLDER_NAME = '大阪事務所 郵便到着確認';
export const AUTHUSER = 'kim@orgiast.jp';
export const TASK_NAME = 'OrgiastOsakaMailArrival';
export const CLUSTER_WINDOW_MS = 3 * 60 * 1000;
export const HEADER = Object.freeze([
  '受信日時',
  '差出人',
  '宛先・宛名',
  '種類',
  '運送会社',
  '追跡番号',
  '写真リンク',
  '投稿者',
  '元メッセージID',
  '本文・メモ',
  '確認状況',
  '取込日時',
]);

export const ARRIVAL_TEXT_RE = /郵便|届[きいいた]|到着|宅配|宅急便|ゆうパック|レターパック|書留|荷物|代引|段ボール|封筒|ゆうメール/;

export function stripHtml(text) {
  return String(text || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

export function toJst(value) {
  const d = value ? new Date(value) : new Date();
  if (Number.isNaN(d.getTime())) return '';
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  const p2 = (n) => String(n).padStart(2, '0');
  return `${jst.getUTCFullYear()}-${p2(jst.getUTCMonth() + 1)}-${p2(jst.getUTCDate())} ${p2(jst.getUTCHours())}:${p2(jst.getUTCMinutes())}`;
}

export function isOwnAccount(message) {
  if (!message) return false;
  if (message.isSender === true) return true;
  return /kimkon1011|オージャスト金/.test(String(message.senderName || ''));
}

export function isClusterable(message) {
  if (!message || message.isDeleted || message.type === 'REACTION') return false;
  if (message.type === 'IMAGE' && (message.attachments?.length || message.attachment)) return true;
  if (message.type === 'TEXT' && stripHtml(message.text).length > 0) return true;
  return false;
}

export function clusterArrivals(messages, { windowMs = CLUSTER_WINDOW_MS } = {}) {
  const items = [...(messages || [])]
    .filter(isClusterable)
    .sort((a, b) => {
      const ta = new Date(a.timestamp).getTime();
      const tb = new Date(b.timestamp).getTime();
      if (ta !== tb) return ta - tb;
      return Number(a.sortKey || 0) - Number(b.sortKey || 0);
    });
  const clusters = [];
  for (const message of items) {
    const last = clusters[clusters.length - 1];
    const prev = last?.messages[last.messages.length - 1];
    const sameSender = last && last.senderName === (message.senderName || '');
    const close = prev && (new Date(message.timestamp).getTime() - new Date(prev.timestamp).getTime()) <= windowMs;
    if (sameSender && close) last.messages.push(message);
    else clusters.push({ senderName: message.senderName || '', messages: [message] });
  }
  return clusters.filter((cluster) => {
    const hasImage = cluster.messages.some((m) => m.type === 'IMAGE');
    const arrivalText = cluster.messages.some((m) => ARRIVAL_TEXT_RE.test(stripHtml(m.text)));
    const onlyOwnText = !hasImage && cluster.messages.every(isOwnAccount);
    return (hasImage || arrivalText) && !onlyOwnText;
  });
}

export function clusterMessageIds(cluster) {
  return [...new Set((cluster.messages || []).map((m) => String(m.id)).filter(Boolean))].sort();
}

export function alreadyLogged(ids, existingIdSet) {
  return (ids || []).some((id) => existingIdSet.has(String(id)));
}

export function collectLoggedMessageIds(rows) {
  const ids = new Set();
  for (const row of rows || []) {
    const cell = String(row[8] || '');
    for (const part of cell.split(/[,，\s]+/)) {
      if (part) ids.add(part);
    }
  }
  return ids;
}

export function parseVisionJson(raw) {
  const text = String(raw || '').trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : text).trim();
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('vision JSON が見つかりません');
  const parsed = JSON.parse(body.slice(start, end + 1));
  const flag = parsed.is_arrival ?? parsed.isArrival;
  return {
    isArrival: flag === true || flag === 'true' || flag === 1 || flag === '1',
    sender: String(parsed.sender || parsed.from || '').trim(),
    addressee: String(parsed.addressee || parsed.to || parsed.recipient || '').trim(),
    kind: String(parsed.kind || parsed.type || parsed.contents || '').trim(),
    carrier: String(parsed.carrier || parsed.courier || '').trim(),
    tracking: String(parsed.tracking || parsed.trackingNumber || parsed.inquiryNumber || '').trim(),
    notes: String(parsed.notes || parsed.memo || '').trim(),
    reason: String(parsed.reason || '').trim(),
  };
}

export function captionOf(cluster) {
  return (cluster.messages || [])
    .filter((m) => m.type === 'TEXT')
    .map((m) => stripHtml(m.text))
    .filter(Boolean)
    .join('\n');
}

export function receivedAtOf(cluster) {
  const times = (cluster.messages || []).map((m) => new Date(m.timestamp).getTime()).filter(Number.isFinite);
  return times.length ? new Date(Math.min(...times)).toISOString() : '';
}

export function buildRow({ cluster, extracted, photoUrls, ingestedAt }) {
  const ids = clusterMessageIds(cluster);
  const notes = [extracted.notes, captionOf(cluster)].filter(Boolean).join(' / ');
  return [
    toJst(receivedAtOf(cluster)),
    extracted.sender || '',
    extracted.addressee || '',
    extracted.kind || '',
    extracted.carrier || '',
    extracted.tracking || '',
    (photoUrls || []).join('\n'),
    cluster.senderName || '',
    ids.join(','),
    notes,
    '未確認',
    toJst(ingestedAt || new Date()),
  ];
}

export const VISION_PROMPT = `あなたは日本の郵便・宅配の荷札を読む担当です。写真は大阪事務所に届いた荷物の撮影です。
JSONだけを返してください。説明文やコードフェンスは不要です。
スキーマ:
{
  "is_arrival": true,
  "sender": "差出人（ご依頼主）の氏名または会社名。読めなければ空文字",
  "addressee": "宛先・宛名",
  "kind": "便種と品名。例: ゆうパック（梱包材料）、佐川（アルミ板）、中身の商品名。1枚に複数ある場合は「2件: … / …」",
  "carrier": "佐川急便 / ヤマト運輸 / 日本郵便 / 西濃運輸 / その他。不明なら空文字",
  "tracking": "問い合わせ番号や追跡番号。不明なら空文字",
  "notes": "代引き金額、発送日、特記。なければ空文字",
  "reason": "is_arrival が false のときだけ理由"
}
判定:
- 荷札・封筒・荷物・届いた中身の写真なら is_arrival を true。
- 作業依頼のスクリーンショット、関係ない会話写真、スタンプ風画像なら false。
- 開封後の中身だけでも、届いた物品の記録なら true。`;

export function visionUserContent(caption, images) {
  const parts = [{ type: 'text', text: `${VISION_PROMPT}\n\n投稿の本文:\n${caption || '（本文なし。写真のみ）'}` }];
  for (const image of images || []) {
    parts.push({ type: 'image_url', image_url: { url: `data:${image.mimeType || 'image/jpeg'};base64,${image.base64}` } });
  }
  return parts;
}

export function envPaths(home = os.homedir()) {
  const root = path.join(home, '.claude');
  return {
    envFile: path.join(root, 'osaka-mail-arrival.env'),
    stateFile: path.join(root, 'osaka-mail-arrival', 'state.json'),
    geminiEnv: path.join(root, 'gemini.env'),
    groqEnv: path.join(root, 'groq.env'),
    openrouterEnv: path.join(root, 'openrouter.env'),
    geminiDotEnv: path.join(home, '.gemini', '.env'),
  };
}

export function readJson(file, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

export async function sleep(ms, sleepFn = (value) => new Promise((resolve) => setTimeout(resolve, value))) {
  return sleepFn(ms);
}

export async function downloadWithRetry(downloadAttachment, attachment, { tries = 4, delayMs = 1500, sleepFn = sleep } = {}) {
  let lastError;
  for (let attempt = 0; attempt < tries; attempt += 1) {
    try {
      const bytes = await downloadAttachment(attachment);
      if (!bytes || !Buffer.from(bytes).length) throw new Error('empty attachment');
      return Buffer.from(bytes);
    } catch (error) {
      lastError = error;
      if (attempt < tries - 1) await sleepFn(delayMs * (attempt + 1));
    }
  }
  throw lastError || new Error('Beeper asset download failed');
}

export function parseArgs(argv) {
  const out = { live: false, backfill: false, dryRun: false, setup: false, register: false };
  for (const arg of argv) {
    if (arg === '--live') out.live = true;
    else if (arg === '--backfill') out.backfill = true;
    else if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--setup') out.setup = true;
    else if (arg === '--register') out.register = true;
    else throw new Error(`未知の引数: ${arg}`);
  }
  return out;
}

function loadKey(readEnvValue, file, key, env = process.env) {
  if (env[key]) return env[key];
  return readEnvValue(file, key) || '';
}

export async function extractWithCheapVision({ images, caption, tools, home = os.homedir(), fetchImpl = fetch }) {
  const paths = envPaths(home);
  const attempts = [
    { provider: 'gemini', url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', key: loadKey(tools.readEnvValue, paths.geminiEnv, 'GEMINI_API_KEY') || loadKey(tools.readEnvValue, paths.geminiDotEnv, 'GEMINI_API_KEY'), model: 'gemini-3.6-flash' },
    { provider: 'groq', url: 'https://api.groq.com/openai/v1/chat/completions', key: loadKey(tools.readEnvValue, paths.groqEnv, 'GROQ_API_KEY'), model: 'meta-llama/llama-4-scout-17b-16e-instruct' },
    { provider: 'openrouter', url: 'https://openrouter.ai/api/v1/chat/completions', key: loadKey(tools.readEnvValue, paths.openrouterEnv, 'OPENROUTER_API_KEY'), model: 'google/gemini-2.5-flash', headers: { 'HTTP-Referer': 'https://orgiast.jp', 'X-Title': 'orgiast' } },
  ].filter((item) => item.key);
  if (!attempts.length) throw new Error('安いAIの API キーがありません（gemini.env / groq.env / openrouter.env）');
  let lastError;
  for (const attempt of attempts) {
    const started = Date.now();
    try {
      const response = await fetchImpl(attempt.url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${attempt.key}`, 'Content-Type': 'application/json', ...(attempt.headers || {}) },
        body: JSON.stringify({
          model: attempt.model,
          temperature: 0,
          max_tokens: 800,
          messages: [{ role: 'user', content: visionUserContent(caption, images) }],
        }),
        signal: AbortSignal.timeout(60_000),
      });
      const raw = await response.text();
      if (!response.ok) throw new Error(`${attempt.provider} HTTP ${response.status}`);
      const json = JSON.parse(raw);
      const text = json.choices?.[0]?.message?.content || '';
      const extracted = parseVisionJson(text);
      if (attempt.provider === 'gemini' && tools.recordGeminiUsage) {
        try {
          tools.recordGeminiUsage({
            model: attempt.model,
            ...(tools.geminiUsage ? tools.geminiUsage({ usage: json.usage || {} }) : {}),
            source: 'osaka-mail-arrival',
            status: 'ok',
            secs: (Date.now() - started) / 1000,
          }, { home });
        } catch { /* 台帳失敗では本処理を止めない */ }
      }
      return { extracted, provider: attempt.provider, model: attempt.model };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('vision 抽出に失敗しました');
}

async function listAllMessages(listMessages, chatID, { maxPages = 30 } = {}) {
  const all = [];
  let cursor;
  for (let page = 0; page < maxPages; page += 1) {
    const args = { limit: 100 };
    if (cursor) args.cursor = cursor;
    const res = await listMessages(chatID, args);
    const items = res.items || res.messages || [];
    all.push(...items);
    if (!res.hasMore || !res.oldestCursor || items.length === 0) break;
    cursor = res.oldestCursor;
  }
  return all;
}

export async function setupResources(tools, { home = os.homedir(), impersonate = AUTHUSER } = {}) {
  const token = await tools.getDriveToken({ impersonate, scope: 'https://www.googleapis.com/auth/drive' });
  const parent = await tools.findOrCreateFolder(token, PARENT_FOLDER_NAME, 'root');
  await tools.ensureKimEditor(parent.id, { actingUser: impersonate, token, created: true });
  const photos = await tools.findOrCreateFolder(token, PHOTO_FOLDER_NAME, parent.id);
  await tools.ensureKimEditor(photos.id, { actingUser: impersonate, token, created: true });
  const existing = await tools.findByTitle(token, SHEET_TITLE, parent.id);
  let sheetId = existing.find((f) => f.id)?.id;
  if (!sheetId) {
    const created = await (await tools.driveApi(token, 'https://sheets.googleapis.com/v4/spreadsheets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        properties: { title: SHEET_TITLE },
        sheets: [{ properties: { title: TAB_TITLE, gridProperties: { frozenRowCount: 1, columnCount: HEADER.length } } }],
      }),
    })).json();
    sheetId = created.spreadsheetId;
    await tools.driveApi(token, `https://www.googleapis.com/drive/v3/files/${sheetId}?addParents=${parent.id}&removeParents=root&supportsAllDrives=true`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
  }
  await tools.ensureKimEditor(sheetId, { actingUser: impersonate, token, created: true });
  const sheets = tools.createSheetsClient();
  await sheets.ensure(sheetId, TAB_TITLE, [...HEADER]);
  const url = tools.workspaceUrl(`https://docs.google.com/spreadsheets/d/${sheetId}/edit`, AUTHUSER);
  const paths = envPaths(home);
  let envText = '';
  try { envText = fs.readFileSync(paths.envFile, 'utf8'); } catch { envText = ''; }
  const upsert = (key, value) => { envText = tools.upsertEnvValue(envText, key, value); };
  upsert('OSAKA_MAIL_CHAT_ID', DEFAULT_CHAT_ID);
  upsert('OSAKA_MAIL_CHAT_TITLE', DEFAULT_CHAT_TITLE);
  upsert('OSAKA_MAIL_SHEET_ID', sheetId);
  upsert('OSAKA_MAIL_PHOTO_FOLDER_ID', photos.id);
  upsert('OSAKA_MAIL_PARENT_FOLDER_ID', parent.id);
  upsert('OSAKA_MAIL_AUTHUSER', AUTHUSER);
  fs.mkdirSync(path.dirname(paths.envFile), { recursive: true });
  fs.writeFileSync(paths.envFile, envText.endsWith('\n') ? envText : `${envText}\n`, { encoding: 'utf8', mode: 0o600 });
  return { sheetId, sheetUrl: url, photoFolderId: photos.id, parentFolderId: parent.id, envFile: paths.envFile };
}

export function loadConfig(tools, home = os.homedir()) {
  const paths = envPaths(home);
  const chatID = tools.readEnvValue(paths.envFile, 'OSAKA_MAIL_CHAT_ID') || DEFAULT_CHAT_ID;
  const sheetId = tools.readEnvValue(paths.envFile, 'OSAKA_MAIL_SHEET_ID');
  const photoFolderId = tools.readEnvValue(paths.envFile, 'OSAKA_MAIL_PHOTO_FOLDER_ID');
  if (!sheetId || !photoFolderId) throw new Error('先に --setup を実行してください（シートまたは写真フォルダが未設定）');
  return { chatID, sheetId, photoFolderId, authuser: tools.readEnvValue(paths.envFile, 'OSAKA_MAIL_AUTHUSER') || AUTHUSER, paths };
}

async function uploadPhotos(tools, { images, folderId, prefix, as = AUTHUSER }) {
  const urls = [];
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'osaka-mail-'));
  try {
    for (let i = 0; i < images.length; i += 1) {
      const file = path.join(tmpDir, `${prefix}-${i + 1}.jpg`);
      fs.writeFileSync(file, images[i].bytes);
      const uploaded = await tools.upload({
        file,
        folder: folderId,
        name: `${prefix}-${i + 1}.jpg`,
        as,
        authuser: as,
        'keep-format': true,
      });
      urls.push(uploaded.url);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  return urls;
}

export async function syncArrivals({ tools, args, home = os.homedir(), now = new Date() } = {}) {
  const config = loadConfig(tools, home);
  const state = readJson(config.paths.stateFile, { processedIds: [], lastSuccessAt: null, lastError: null });
  const messages = await listAllMessages(tools.listMessages, config.chatID);
  const clusters = clusterArrivals(messages);
  const sheets = tools.createSheetsClient();
  await sheets.ensure(config.sheetId, TAB_TITLE, [...HEADER]);
  const existingRows = await sheets.get(config.sheetId, `${tools.quoteTab(TAB_TITLE)}!A2:L`);
  const logged = collectLoggedMessageIds(existingRows);
  for (const id of state.processedIds || []) logged.add(String(id));

  const pending = clusters.filter((cluster) => !alreadyLogged(clusterMessageIds(cluster), logged));
  const summary = { totalMessages: messages.length, clusters: clusters.length, pending: pending.length, appended: 0, skipped: 0, failed: 0, rows: [], errors: [] };

  for (const cluster of pending) {
    const ids = clusterMessageIds(cluster);
    const imageMessages = cluster.messages.filter((m) => m.type === 'IMAGE');
    const images = [];
    const downloadErrors = [];
    for (const message of imageMessages) {
      const attachments = message.attachments || (message.attachment ? [message.attachment] : []);
      for (const att of attachments) {
        try {
          const bytes = await downloadWithRetry(tools.downloadAttachment, att);
          images.push({ bytes, base64: Buffer.from(bytes).toString('base64'), mimeType: att.mimeType || 'image/jpeg' });
        } catch (error) {
          downloadErrors.push(`${message.id}: ${error.message}`);
          console.error(`osaka-mail-arrival: photo download failed message=${message.id}: ${error.message}`);
        }
        await sleep(400);
      }
    }
    if (!images.length && imageMessages.length) {
      summary.failed += 1;
      summary.errors = [...(summary.errors || []), ...downloadErrors];
      continue;
    }
    let extracted;
    if (images.length) {
      const vision = await extractWithCheapVision({ images, caption: captionOf(cluster), tools, home });
      extracted = vision.extracted;
    } else {
      extracted = {
        isArrival: ARRIVAL_TEXT_RE.test(captionOf(cluster)),
        sender: '',
        addressee: '',
        kind: '',
        carrier: '',
        tracking: '',
        notes: captionOf(cluster),
        reason: '',
      };
    }
    if (!extracted.isArrival) {
      summary.skipped += 1;
      state.processedIds = [...new Set([...(state.processedIds || []), ...ids])];
      continue;
    }
    let photoUrls = [];
    if (!args.dryRun && images.length) {
      photoUrls = await uploadPhotos(tools, {
        images,
        folderId: config.photoFolderId,
        prefix: `mail-${toJst(receivedAtOf(cluster)).replaceAll(/[: ]/g, '')}-${ids[0]}`,
        as: config.authuser,
      });
    }
    if (downloadErrors.length) extracted.notes = [extracted.notes, `写真取得失敗: ${downloadErrors.join('; ')}`].filter(Boolean).join(' / ');
    const row = buildRow({ cluster, extracted, photoUrls, ingestedAt: now });
    summary.rows.push(row);
    if (!args.dryRun) {
      await sheets.append(config.sheetId, `${tools.quoteTab(TAB_TITLE)}!A1`, [row]);
      summary.appended += 1;
      state.processedIds = [...new Set([...(state.processedIds || []), ...ids])];
      state.lastSuccessAt = now.toISOString();
      writeJson(config.paths.stateFile, state);
    }
  }

  if (!args.dryRun) {
    state.lastSuccessAt = now.toISOString();
    state.lastError = null;
    state.chatID = config.chatID;
    writeJson(config.paths.stateFile, state);
  }
  summary.sheetId = config.sheetId;
  summary.sheetUrl = tools.workspaceUrl(`https://docs.google.com/spreadsheets/d/${config.sheetId}/edit`, config.authuser);
  return summary;
}

export async function notifyFailure(tools, error, home = os.homedir()) {
  const paths = envPaths(home);
  const state = readJson(paths.stateFile, {});
  const message = `大阪事務所の郵便到着シート取込が止まりました。\n試した内容：Beeperの大阪事務所グループを読み、到着確認シートへ追記する定期処理を実行した。\n証拠：${error.message}\n必要な操作：000の ${TASK_NAME} と ~/.claude/osaka-mail-arrival/ の状態を確認する。`;
  try {
    await tools.notifyKim(message, { home, source: 'osaka-mail-arrival', kind: 'info' });
  } catch { /* 通知失敗でも本エラーを隠さない */ }
  state.lastError = { at: new Date().toISOString(), message: error.message };
  writeJson(paths.stateFile, state);
}

async function registerTask() {
  const { registerHourlyTask } = await import(pathToFileURL(path.join(resolveToolsDir(), 'lib/scheduled-task.mjs')).href);
  const script = fileURLToPath(import.meta.url);
  return registerHourlyTask(TASK_NAME, script, {
    intervalMinutes: 15,
    executionTimeLimitMinutes: 12,
    scriptArgs: ['--live'],
    initialDelayMinutes: 1,
    description: '大阪事務所LINEの郵便到着を到着確認スプレッドシートへ15分おきに追記',
  });
}

export async function main(argv = process.argv.slice(2), { toolsFactory = loadTools, home = os.homedir() } = {}) {
  const args = parseArgs(argv);
  if (args.register) {
    const result = await registerTask();
    console.log(JSON.stringify({ ok: true, task: TASK_NAME, result }, null, 2));
    return { registered: true };
  }
  const tools = await toolsFactory();
  try {
    if (args.setup) {
      const setup = await setupResources(tools, { home });
      console.log(JSON.stringify({ ok: true, setup }, null, 2));
      return setup;
    }
    const summary = await syncArrivals({ tools, args, home });
    console.log(JSON.stringify({ ok: true, dryRun: args.dryRun, ...summary, sample: summary.rows[0] || null }, null, 2));
    return summary;
  } catch (error) {
    if (args.live || args.backfill) await notifyFailure(tools, error, home);
    console.error(`osaka-mail-arrival: ${error.message}`);
    process.exitCode = 1;
    return { ok: false, error: error.message };
  }
}

export { loadTools };

if (isEntryFallback()) await main();

function isEntryFallback() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    const real = (target) => {
      try { return fs.realpathSync(target); } catch { return path.resolve(target); }
    };
    return real(fileURLToPath(import.meta.url)).toLowerCase() === real(entry).toLowerCase();
  } catch { return false; }
}
