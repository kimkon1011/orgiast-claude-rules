/**
 * LINE/Beeper 画像添付のローカル保存と他AIによる文字起こし。
 * Claude API は使わない（Gemini / OpenRouter Gemini / Kimi）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { callWithFallback, executorCostUsd } from '../llm-fallback.mjs';
import { IMAGE_REPLY_CHAIN } from './autoreply-llm.mjs';
import { PROVIDERS, parseEnvText } from '../line-digest.mjs';
import { downloadAttachment as beeperDownloadAttachment, getChat as beeperGetChat } from '../beeper-api.mjs';

export const DEFAULT_MEDIA_OCR_DAILY_USD = 0.5;
export const MEDIA_OCR_PROMPT = [
  'この画像に写っている文字（型番・電圧・金額・日付・氏名・住所など）を省略せずそのまま書き出してください。',
  '読めない箇所は[不明]とし、推測で埋めないでください。',
  '最後に画像全体の説明を日本語1行で書いてください。',
  '出力形式（この2行だけ）:',
  '文字: <書き出した文字。改行は / でつなぐ>',
  '説明: <1行>',
].join('\n');

const LLM_PROVIDERS = {
  ...PROVIDERS,
  glm: { url: 'https://api.z.ai/api/coding/paas/v4/chat/completions', env: 'ZAI_API_KEY', file: 'zai.env', model: 'glm-5.3' },
  genspark: { url: 'https://www.genspark.ai/api/llm_proxy/v1/chat/completions', env: 'GSK_PROXY_KEY', file: 'genspark-proxy.env', model: 'gpt-5.6-luna' },
  mistral: { url: 'https://api.mistral.ai/v1/chat/completions', env: 'MISTRAL_API_KEY', file: 'mistral.env', model: 'open-mistral-nemo' },
};

const readText = (file) => {
  try { return fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return ''; throw e; }
};

export function isImageAttachment(attachment) {
  const type = String(attachment?.type || attachment?.mimeType || attachment?.mimetype || '').toLowerCase();
  const name = String(attachment?.file_name || attachment?.fileName || attachment?.name || attachment?.filename || '');
  if (type === 'img' || type.startsWith('image/') || type === 'image') return true;
  return /\.(jpe?g|png|gif|webp|bmp|heic|heif)$/i.test(name);
}

export function jstDayFromTs(ts) {
  const ms = typeof ts === 'number' ? ts : Date.parse(ts);
  if (!Number.isFinite(ms)) throw new Error('invalid timestamp for media day');
  return new Date(ms + 9 * 3600000).toISOString().slice(0, 10);
}

export function sniffImageMeta(buffer, attachment = {}) {
  const named = String(attachment.file_name || attachment.fileName || attachment.name || attachment.filename || '');
  const fromName = named.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
  const mimeHint = String(attachment.mimeType || attachment.mimetype || attachment.type || '').toLowerCase();
  if (Buffer.isBuffer(buffer) && buffer.length >= 3) {
    if (buffer[0] === 0xff && buffer[1] === 0xd8) return { ext: 'jpg', mime: 'image/jpeg' };
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e) return { ext: 'png', mime: 'image/png' };
    if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return { ext: 'gif', mime: 'image/gif' };
    if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
      return { ext: 'webp', mime: 'image/webp' };
    }
  }
  if (mimeHint.includes('png') || fromName === 'png') return { ext: 'png', mime: 'image/png' };
  if (mimeHint.includes('webp') || fromName === 'webp') return { ext: 'webp', mime: 'image/webp' };
  if (mimeHint.includes('gif') || fromName === 'gif') return { ext: 'gif', mime: 'image/gif' };
  if (mimeHint.includes('jpeg') || mimeHint.includes('jpg') || fromName === 'jpg' || fromName === 'jpeg') {
    return { ext: 'jpg', mime: 'image/jpeg' };
  }
  return { ext: fromName || 'bin', mime: mimeHint.startsWith('image/') ? mimeHint : 'application/octet-stream' };
}

export function mediaFilePath(storeDir, day, hubHash, index, ext) {
  return path.join(storeDir, 'media', day, `${hubHash}_${index}.${ext}`);
}

export function attachmentLabel(attachment) {
  return String(attachment?.type || 'file');
}

export function parseOcrText(raw) {
  const text = String(raw || '').trim();
  const letter = /(?:^|\n)\s*文字\s*[:：]\s*([\s\S]*?)(?=\n\s*説明\s*[:：]|$)/u.exec(text)?.[1]?.trim();
  const desc = /(?:^|\n)\s*説明\s*[:：]\s*(.+)$/mu.exec(text)?.[1]?.trim();
  if (letter || desc) {
    return {
      letter: (letter || text).replace(/\s+/g, ' ').trim(),
      description: (desc || '画像').replace(/\s+/g, ' ').trim(),
    };
  }
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  return {
    letter: (lines.slice(0, -1).join(' / ') || lines[0] || text).replace(/\s+/g, ' ').trim(),
    description: (lines.at(-1) || '画像').replace(/\s+/g, ' ').trim(),
  };
}

export function formatEnrichedAttachment({ type, savedPath, letter, description, error }) {
  const label = type || 'img';
  const head = `[添付: ${label} 保存先=${savedPath}]`;
  if (error) return `${head}\n[画像の読み取り失敗: ${String(error).slice(0, 200)}]`;
  return `${head}\n[画像の文字: ${letter}]\n[画像の説明: ${description}]`;
}

export function spendFilePath(home) {
  return path.join(home, '.claude', 'comms-hub', 'media-ocr-spend.json');
}

export function readMediaSpend(home, day) {
  try {
    const data = JSON.parse(fs.readFileSync(spendFilePath(home), 'utf8'));
    const value = Number(data?.[day] || 0);
    return Number.isFinite(value) ? value : 0;
  } catch (e) {
    if (e.code === 'ENOENT') return 0;
    throw e;
  }
}

export function addMediaSpend(home, day, usd) {
  const file = spendFilePath(home);
  let data = {};
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const next = Number(data[day] || 0) + Number(usd || 0);
  data[day] = Number(next.toFixed(6));
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file + '.tmp', JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
  return data[day];
}

export async function askImageOcr({ buffer, mime, home, fetchImpl = fetch, chain = IMAGE_REPLY_CHAIN, prompt = MEDIA_OCR_PROMPT } = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('empty image buffer');
  const dataUrl = `data:${mime || 'image/jpeg'};base64,${buffer.toString('base64')}`;
  const start = chain[0];
  const result = await callWithFallback({
    start,
    chain,
    fetchImpl,
    caller: 'comms-hub-media-ocr',
    cooldownFile: path.join(home, '.claude', 'provider-cooldown.json'),
    ledgerFile: path.join(home, '.claude', 'executor-usage.jsonl'),
    budgetFile: path.join(home, '.claude', 'provider-budget.json'),
    payloadFor(candidate) {
      const p = LLM_PROVIDERS[candidate.provider];
      if (!p || /claude|anthropic|fable/i.test(candidate.model || '')) return null;
      const imageCapable = IMAGE_REPLY_CHAIN.some(x => x.provider === candidate.provider)
        || (candidate.provider === 'openrouter' && /gemini|kimi|gpt-4o|vision/i.test(candidate.model || ''));
      if (!imageCapable) return null;
      const files = [path.join(home, '.claude', p.file)];
      if (candidate.provider === 'gemini') files.unshift(path.join(home, '.gemini', '.env'));
      const key = process.env[p.env] || files.map(f => parseEnvText(readText(f))[p.env]).find(Boolean);
      if (!key) return null;
      const body = {
        model: candidate.model || p.model,
        stream: false,
        max_tokens: 1200,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        }],
      };
      if (p.special === 'kimi') Object.assign(body, { reasoning_effort: 'none', temperature: 0.2 });
      return {
        url: p.url,
        init: {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...p.extraHeaders },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(60000),
        },
      };
    },
  });
  const json = await result.response.json();
  const content = json.choices?.[0]?.message?.content || '';
  const usage = json.usage || {};
  const usd = executorCostUsd({
    provider: result.candidate.provider,
    model: result.candidate.model,
    in: usage.prompt_tokens || 0,
    out: usage.completion_tokens || 0,
    ...((typeof usage.cost === 'number') ? { usd: usage.cost } : {}),
  }) ?? 0;
  return { ...parseOcrText(content), usd, provider: result.candidate.provider, model: result.candidate.model, raw: content };
}

export async function saveAndReadAttachment(attachment, {
  hubHash,
  index,
  day,
  storeDir,
  home = os.homedir(),
  dailyUsdLimit = DEFAULT_MEDIA_OCR_DAILY_USD,
  downloadAttachment = beeperDownloadAttachment,
  askImage = askImageOcr,
  fetchImpl,
  skipOcr = false,
  ocrReason,
} = {}) {
  const type = attachmentLabel(attachment) || 'img';
  let buffer;
  let meta;
  let savedPath;
  const preferredExt = sniffImageMeta(Buffer.alloc(0), attachment).ext;
  const candidatePath = mediaFilePath(storeDir, day, hubHash, index, preferredExt === 'bin' ? 'jpg' : preferredExt);
  const existing = (() => {
    if (fs.existsSync(candidatePath)) return candidatePath;
    const dir = path.dirname(candidatePath);
    if (!fs.existsSync(dir)) return null;
    const prefix = `${hubHash}_${index}.`;
    const hit = fs.readdirSync(dir).find(name => name.startsWith(prefix));
    return hit ? path.join(dir, hit) : null;
  })();

  let downloaded = false;
  if (existing) {
    savedPath = existing;
    buffer = fs.readFileSync(existing);
    meta = sniffImageMeta(buffer, attachment);
  } else {
    buffer = await downloadAttachment(attachment, { fetchImpl });
    if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
    meta = sniffImageMeta(buffer, attachment);
    savedPath = mediaFilePath(storeDir, day, hubHash, index, meta.ext === 'bin' ? 'jpg' : meta.ext);
    fs.mkdirSync(path.dirname(savedPath), { recursive: true, mode: 0o700 });
    if (!fs.existsSync(savedPath)) fs.writeFileSync(savedPath, buffer, { mode: 0o600 });
    downloaded = true;
  }

  if (skipOcr) {
    return {
      text: formatEnrichedAttachment({ type, savedPath, error: ocrReason || '読み取りスキップ' }),
      savedPath,
      downloaded,
      usd: 0,
      letter: '',
      description: '',
      error: ocrReason || '読み取りスキップ',
    };
  }

  const spent = readMediaSpend(home, day);
  if (spent >= dailyUsdLimit) {
    return {
      text: formatEnrichedAttachment({ type, savedPath, error: `日次上限 $${dailyUsdLimit} 超過` }),
      savedPath,
      downloaded,
      usd: 0,
      letter: '',
      description: '',
      error: `日次上限 $${dailyUsdLimit} 超過`,
    };
  }

  try {
    const ocr = await askImage({ buffer, mime: meta.mime, home, fetchImpl });
    if (ocr.usd > 0) addMediaSpend(home, day, ocr.usd);
    return {
      text: formatEnrichedAttachment({ type, savedPath, letter: ocr.letter, description: ocr.description }),
      savedPath,
      downloaded,
      usd: ocr.usd || 0,
      letter: ocr.letter,
      description: ocr.description,
      provider: ocr.provider,
      model: ocr.model,
    };
  } catch (e) {
    return {
      text: formatEnrichedAttachment({ type, savedPath, error: e.message || String(e) }),
      savedPath,
      downloaded,
      usd: 0,
      letter: '',
      description: '',
      error: e.message || String(e),
    };
  }
}

export async function formatMessageAttachments(attachments, options = {}) {
  if (!attachments?.length) return { text: '', results: [] };
  const lines = [];
  const results = [];
  let imageIndex = 0;
  for (const attachment of attachments) {
    if (!isImageAttachment(attachment)) {
      lines.push(`[添付: ${attachment.type || 'file'} ${attachment.file_name || attachment.name || ''}]`);
      continue;
    }
    // URL も download 差し替えも無いときは従来表記（単体テスト互換）。
    if (!attachment.srcURL && !attachment.url && !options.downloadAttachment && !options.forceEnrich) {
      lines.push(`[添付: ${attachment.type || 'file'} ${attachment.file_name || attachment.name || ''}]`);
      continue;
    }
    imageIndex += 1;
    const result = await saveAndReadAttachment(attachment, { ...options, index: imageIndex });
    lines.push(result.text);
    results.push(result);
  }
  return { text: lines.join('\n'), results };
}

const PENDING_IMG_LINE = /^\[添付:\s*(img|image)\b(?![^\]]*保存先=)[^\]]*\]\s*$/i;

export function findPendingImageEntries(dailyText) {
  const matches = [...dailyText.matchAll(/^\[hub:([a-f0-9]{64}):([^\]\r\n]+)\]\r?\n/gm)];
  const pending = [];
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index;
    const end = matches[i + 1]?.index ?? dailyText.length;
    const block = dailyText.slice(start, end);
    const bodyStart = start + matches[i][0].length;
    const body = dailyText.slice(bodyStart, end);
    const lines = body.split(/\r?\n/);
    const imgLineIndexes = [];
    for (let li = 0; li < lines.length; li++) {
      if (PENDING_IMG_LINE.test(lines[li])) imgLineIndexes.push(li);
    }
    if (!imgLineIndexes.length) continue;
    const header = lines[0] || '';
    const sender = /^\[[^\]]+\]\[[^\]]+\]\[([^\]]*)\]/.exec(header)?.[1] || '';
    const stamp = /^\[[^\]]+\]/.exec(header)?.[0]?.slice(1, -1) || '';
    const chat = /LINE（Beeper）:\s*(.+)\s*$/m.exec(body)?.[1]?.trim() || '';
    pending.push({
      hubHash: matches[i][1],
      ts: matches[i][2],
      stamp,
      sender,
      chat,
      blockStart: start,
      blockEnd: end,
      bodyStart,
      body,
      lines,
      imgLineIndexes,
    });
  }
  return pending;
}

export function replacePendingImageLines(entry, enrichedBlocks) {
  const lines = entry.lines.slice();
  let cursor = 0;
  for (const li of entry.imgLineIndexes) {
    const block = enrichedBlocks[cursor++];
    if (!block) continue;
    lines[li] = block;
  }
  return lines.join('\n');
}

/**
 * 日次ログの未処理 [添付: img ] を Beeper から取り直し、保存＋文字起こしで書き換える。
 */
export async function backfillMedia({
  since,
  chatIds = [],
  home = os.homedir(),
  storeDir = path.join(home, '.claude', 'comms-hub', 'store'),
  dailyUsdLimit = DEFAULT_MEDIA_OCR_DAILY_USD,
  reportFile,
  downloadAttachment = beeperDownloadAttachment,
  askImage = askImageOcr,
  listMessages,
  getChat = beeperGetChat,
  fetchImpl,
  messageKey,
  log = console.error,
} = {}) {
  if (!Number.isFinite(since)) throw new Error('backfill-media requires --since');
  if (!chatIds.length) throw new Error('backfill-media requires at least one --chat');
  if (typeof messageKey !== 'function') throw new Error('messageKey required');
  if (typeof listMessages !== 'function') throw new Error('listMessages required');

  const chatTitles = new Set();
  for (const chatId of chatIds) {
    try {
      const chat = await getChat(chatId, { fetchImpl });
      if (chat?.title) chatTitles.add(String(chat.title));
    } catch (e) {
      log(`getChat failed for ${chatId}: ${String(e.message || e).slice(0, 120)}`);
    }
  }

  const dailyDir = path.join(storeDir, 'daily');
  const sinceDay = jstDayFromTs(since);
  const files = fs.readdirSync(dailyDir)
    .filter(name => /^\d{4}-\d{2}-\d{2}\.md$/.test(name) && name.slice(0, 10) >= sinceDay)
    .sort();

  const pendingByHash = new Map();
  for (const name of files) {
    const filePath = path.join(dailyDir, name);
    const text = fs.readFileSync(filePath, 'utf8');
    for (const entry of findPendingImageEntries(text)) {
      if (chatTitles.size && entry.chat && !chatTitles.has(entry.chat)) continue;
      pendingByHash.set(entry.hubHash, { ...entry, day: name.slice(0, 10), filePath, fileText: text });
    }
  }

  const messageByHash = new Map();
  for (const chatId of chatIds) {
    let cursor;
    let pages = 0;
    do {
      const page = await listMessages(chatId, { limit: 100, cursor, direction: cursor ? 'before' : undefined }, { fetchImpl });
      for (const msg of page.items || []) {
        if (msg.isDeleted || !msg.timestamp) continue;
        if (Date.parse(msg.timestamp) < since) continue;
        if (!msg.attachments?.some(isImageAttachment)) continue;
        const hubHash = messageKey({ source: 'line-chat', channelId: chatId, id: msg.id });
        if (!pendingByHash.has(hubHash)) continue;
        messageByHash.set(hubHash, { msg, chatId });
      }
      const oldest = page.items?.length ? page.items[page.items.length - 1] : null;
      cursor = page.oldestCursor;
      pages += 1;
      if (!oldest || !oldest.timestamp || Date.parse(oldest.timestamp) < since || !page.hasMore || pages >= 40) break;
    } while (cursor);
  }

  const reportRows = [];
  const filePatches = new Map(); // filePath -> Map(hubHash -> newBody)

  for (const [hubHash, entry] of pendingByHash) {
    const found = messageByHash.get(hubHash);
    if (!found) {
      reportRows.push({
        hubHash, day: entry.day, stamp: entry.stamp, sender: entry.sender, chat: entry.chat,
        status: 'message-not-found', letter: '', savedPath: '',
      });
      continue;
    }
    const imageAttachments = (found.msg.attachments || []).filter(isImageAttachment);
    const enriched = [];
    let imageIndex = 0;
    for (const attachment of imageAttachments) {
      imageIndex += 1;
      const day = entry.day;
      const spent = readMediaSpend(home, day);
      const skipOcr = spent >= dailyUsdLimit;
      const result = await saveAndReadAttachment(attachment, {
        hubHash, index: imageIndex, day, storeDir, home, dailyUsdLimit,
        downloadAttachment, askImage, fetchImpl, skipOcr,
        ocrReason: skipOcr ? `日次上限 $${dailyUsdLimit} 超過` : undefined,
      });
      enriched.push(result.text);
      reportRows.push({
        hubHash, day, stamp: entry.stamp, sender: entry.sender, chat: entry.chat,
        status: result.error ? `ocr-failed:${result.error}` : 'ok',
        letter: result.letter || '',
        description: result.description || '',
        savedPath: result.savedPath || '',
        usd: result.usd || 0,
        provider: result.provider || '',
      });
    }
    // 日次側の img 行数と Beeper 側の画像数がずれても、先頭から対応付ける。
    while (enriched.length < entry.imgLineIndexes.length) {
      enriched.push(formatEnrichedAttachment({
        type: 'img',
        savedPath: '(なし)',
        error: 'Beeper 側に対応する画像添付が足りない',
      }));
    }
    const newBody = replacePendingImageLines(entry, enriched);
    if (!filePatches.has(entry.filePath)) filePatches.set(entry.filePath, { original: entry.fileText, replacements: [] });
    filePatches.get(entry.filePath).replacements.push({ entry, newBody });
  }

  for (const [filePath, patch] of filePatches) {
    let text = patch.original;
    // 後ろから置換してオフセットずれを避ける
    const ordered = patch.replacements.sort((a, b) => b.entry.blockStart - a.entry.blockStart);
    for (const { entry, newBody } of ordered) {
      text = text.slice(0, entry.bodyStart) + newBody + text.slice(entry.blockEnd);
    }
    fs.writeFileSync(filePath + '.tmp', text, { mode: 0o600 });
    fs.renameSync(filePath + '.tmp', filePath);
  }

  if (reportFile) {
    const lines = [
      '# LINE 画像 OCR backfill 結果',
      '',
      `since: ${new Date(since).toISOString()}`,
      `chats: ${chatIds.join(', ')}`,
      `pending: ${pendingByHash.size}`,
      `matched: ${messageByHash.size}`,
      '',
      '| 日時 | 投稿者 | 保存先 | 書き出した文字 | 状態 |',
      '|---|---|---|---|---|',
      ...reportRows.map(r => `| ${r.stamp || r.day} | ${r.sender || ''} | ${r.savedPath || ''} | ${(r.letter || '').replace(/\|/g, '\\|')} | ${r.status} |`),
      '',
    ];
    const focus = reportRows.filter(r => /12:43/.test(r.stamp || '') && /河本/.test(r.sender || ''));
    if (focus.length) {
      lines.push('## 注目: 2026-11-16 12:43 河本哲平');
      for (const r of focus) {
        lines.push(`- 保存先: ${r.savedPath}`);
        lines.push(`- 書き出した文字: ${r.letter || '(なし)'}`);
        lines.push(`- 説明: ${r.description || ''}`);
        lines.push(`- 状態: ${r.status}`);
      }
      lines.push('');
    }
    fs.mkdirSync(path.dirname(reportFile), { recursive: true });
    fs.writeFileSync(reportFile, lines.join('\n'), 'utf8');
    log(`report written: ${reportFile}`);
  }

  return { pending: pendingByHash.size, matched: messageByHash.size, updatedFiles: filePatches.size, reportRows };
}

export function digestHub(...parts) {
  return crypto.createHash('sha256').update(parts.join(':')).digest('hex');
}
