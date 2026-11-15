import fs from 'node:fs';
import path from 'node:path';

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n');
}

function isUserRequest(entry) {
  if (entry?.type !== 'user' || entry?.message?.role !== 'user') return false;
  const content = entry.message.content;
  if (Array.isArray(content) && content.length && content.every(part => part?.type === 'tool_result')) return false;
  const text = textOf(content).trim();
  return Boolean(text) && !text.startsWith('<');
}

export function isSyntheticApiError(entry) {
  return entry?.type === 'assistant' && entry?.message?.role === 'assistant' &&
    (entry?.isApiErrorMessage === true || entry?.message?.model === '<synthetic>');
}

function isRealEntry(entry) {
  if (!entry || typeof entry !== 'object' || entry.isSidechain) return false;
  if (entry.type !== 'user' && entry.type !== 'assistant') return false;
  return true;
}

function hasToolUse(entry) {
  return entry?.type === 'assistant' && Array.isArray(entry.message?.content) &&
    entry.message.content.some(part => part?.type === 'tool_use');
}

function hasToolResult(entry) {
  return entry?.type === 'user' && Array.isArray(entry.message?.content) &&
    entry.message.content.some(part => part?.type === 'tool_result');
}

function hasAssistantText(entry) {
  if (entry?.type !== 'assistant' || isSyntheticApiError(entry)) return false;
  return Boolean(textOf(entry.message?.content).trim());
}

function readTail(file, maxBytes = 512 * 1024) {
  const stat = fs.statSync(file);
  const length = Math.min(stat.size, maxBytes);
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, buffer, 0, length, stat.size - length); } finally { fs.closeSync(fd); }
  const text = buffer.toString('utf8');
  return stat.size > length ? text.slice(text.indexOf('\n') + 1) : text;
}

function parseEntries(text) {
  const entries = [];
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (!entry?.isSidechain) entries.push(entry);
    } catch { /* 壊れた行は無視する。 */ }
  }
  return entries;
}

export function findUnansweredRequest(transcriptPath, { readFile = readTail, statSync = fs.statSync, mtimeMs, now = Date.now() } = {}) {
  let raw;
  try { raw = readFile(transcriptPath); } catch { return null; }

  // readTail は末尾 512KB だけを読むため、巨大な transcript（例: 実データ
  // 4832b083 の 2.1MB）では最後の user 依頼が窓の外になり userIndex<0 で検出漏れになる。
  // 入手した raw の行数が実際のファイル行数より少なければ（=tail が partial なので）
  // 全文へフォールバックする（ただしテストで注入された readFile はそのまま尊重）。
  let text = raw;
  let realEntries = [];
  let userIndex = -1;
  const rebase = () => {
    const entries = parseEntries(text);
    realEntries = entries.filter(isRealEntry);
    for (let i = realEntries.length - 1; i >= 0; i--) {
      if (isUserRequest(realEntries[i])) { userIndex = i; break; }
    }
  };
  rebase();
  if (userIndex < 0) {
    try {
      const fullStat = statSync(transcriptPath);
      const rawLen = Buffer.byteLength(raw, 'utf8');
      if (fullStat.size > rawLen + 1) {
        const full = fs.readFileSync(transcriptPath, 'utf8');
        text = full;
        rebase();
      }
    } catch { /* フォールバック失敗は握りつぶす */ }
  }
  if (userIndex < 0) return null;

  const userEntry = realEntries[userIndex];
  const requestText = textOf(userEntry.message.content).replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!requestText) return null;

  const after = realEntries.slice(userIndex + 1).filter(entry => entry?.type === 'assistant');
  if (after.length > 0 && after.every(entry => isSyntheticApiError(entry))) {
    const errorEntry = after.at(-1);
    const errorAt = errorEntry?.timestamp || userEntry?.timestamp || '';
    if (!Number.isFinite(Date.parse(errorAt))) return null;
    return {
      sessionId: path.basename(transcriptPath, '.jsonl'),
      cwd: userEntry?.cwd || entries.findLast(entry => entry?.cwd)?.cwd || '',
      transcriptPath,
      requestText,
      errorAt,
      error: errorEntry?.error || '',
      apiError: errorEntry?.apiError || '',
      apiErrorStatus: errorEntry?.apiErrorStatus ?? '',
    };
  }

  let fileMtime = mtimeMs;
  if (typeof fileMtime !== 'number') {
    try { fileMtime = statSync(transcriptPath).mtimeMs; } catch { fileMtime = 0; }
  }
  const lastReal = realEntries.at(-1);
  const lastTime = Date.parse(lastReal?.timestamp || userEntry?.timestamp || '');
  if (!fileMtime && Number.isFinite(lastTime)) fileMtime = lastTime;

  const elapsedMs = now - fileMtime;
  const isOldEnough = elapsedMs >= 45 * 60 * 1000;
  const isNotExpired = elapsedMs <= 7 * 86400 * 1000;

  if (isOldEnough && isNotExpired) {
    let silentStop = false;
    let lastToolUseIndex = -1;
    for (let i = realEntries.length - 1; i >= 0; i--) {
      if (hasToolUse(realEntries[i])) { lastToolUseIndex = i; break; }
    }
    if (lastToolUseIndex >= 0) {
      const afterToolUse = realEntries.slice(lastToolUseIndex + 1);
      const toolResultFound = afterToolUse.some(hasToolResult);
      const assistantTextFound = afterToolUse.some(hasAssistantText);
      if (!toolResultFound && !assistantTextFound) {
        silentStop = true;
      }
    }

    if (!silentStop) {
      const assistantTextAfterUser = after.some(hasAssistantText);
      if (!assistantTextAfterUser) {
        silentStop = true;
      }
    }

    if (silentStop) {
      const errorAt = lastReal?.timestamp || userEntry?.timestamp || '';
      if (!Number.isFinite(Date.parse(errorAt))) return null;
      return {
        sessionId: path.basename(transcriptPath, '.jsonl'),
        cwd: userEntry?.cwd || entries.findLast(entry => entry?.cwd)?.cwd || '',
        transcriptPath,
        requestText,
        errorAt,
        error: 'silent_stop',
        apiError: '',
        apiErrorStatus: '',
        kind: 'silent-stop',
      };
    }
  }

  return null;
}

export function errorKind(found) {
  return [found?.error, found?.apiError, found?.apiErrorStatus].filter(value => value !== '' && value != null).join(' / ') || 'unknown';
}

