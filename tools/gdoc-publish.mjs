#!/usr/bin/env node
/**
 * kim 向け Doc を作成/同一 ID で置換し、リンクを Docs API から読み戻して検証する。
 * node tools/gdoc-publish.mjs --title "題名" --file 本文.md [--folder ID] [--update ID] [--private]
 * --authuser <開く人のメール> は必須。他人宛は --share <相手のメール> を付ける（--share-role で権限指定）。
 * --private を付けるとマイドライブ直下に作成し、共有権限がないことを確認する。
 * 認証は lib/drive-auth.mjs の既存 DWD 鍵 (GOOGLE_SA_KEY) と drive scope を再利用。
 * 本文は ■ / 1. 等の通常テキスト。Markdown の見出し・リンク・太字・コードは表示文字に変換。
 * --update は単一タブの本文を置換。folder 省略時は既存の配置を保持する。
 */
import { shareAndRecord, shareRecipients } from './lib/drive-share.mjs';
import { workspaceUrl } from './lib/workspace-url.mjs';
import { readFileSync } from 'node:fs';
import { getDriveToken, driveApi } from './lib/drive-auth.mjs';
import { isEntry } from './is-entry.mjs';
import { ensureKimEditor } from './lib/kim-editor.mjs';
import { randomUUID } from 'node:crypto';

export const DEFAULT_FOLDER = '1uA0J3kPfL7O5t0Ro1jSfi2xDEJE-Y0si';

export function containsSecret(text) {
  if (typeof text !== 'string') return false;
  return /^[ \t]*[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|ACCESS_KEY|CLIENT_SECRET)[A-Z0-9_]*\s*=\s*\S{8,}/m.test(text) ||
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text) ||
    /sk-[A-Za-z0-9_-]{20,}/.test(text) ||
    /ghp_[A-Za-z0-9]{20,}/.test(text) ||
    /xox[bp]-[A-Za-z0-9-]{10,}/.test(text) ||
    /AIza[0-9A-Za-z_-]{30,}/.test(text);
}

const DOCS = 'https://docs.googleapis.com/v1/documents';
const DRIVE = 'https://www.googleapis.com/drive/v3/files';

export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--private') {
      if (args.private) throw new Error(`不正な引数: ${flag}`);
      args.private = true;
      continue;
    }
    const val = argv[i + 1];
    if (!['--title', '--file', '--folder', '--update', '--authuser', '--share', '--share-role'].includes(flag) ||
        !val?.trim() || val.startsWith('--') || flag.slice(2) in args) {
      throw new Error(`不正な引数: ${flag}`);
    }
    args[flag.slice(2)] = val;
    i++;
  }
  if (!args.title || !args.file) throw new Error('--title と --file は必須です');
  if (args.private && args.share) {
    const err = new Error('--private と --share は併用できません');
    err.exitCode = 2;
    throw err;
  }
  return args;
}

/** Docs のインデックスは UTF-16、本文先頭は 1。JS の length/slice と同じ単位。 */
export function renderDocument(source) {
  source = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (!source.trim()) throw new Error('空の本文は公開できません');
  if (/[\u0000-\u0008\u000c-\u001f]/.test(source)) throw new Error('本文に未対応の制御文字があります');
  let text = '';
  const links = [], headings = [];
  function inline(value) {
    // Markdown リンクを先に認識し、表示ラベルだけにリンクを付ける。
    const tokens = /\[([^\]\n]+)\]\((https?:\/\/(?:[^\s()]|\([^()\s]*\))+)\)|https?:\/\/\S+|\*\*([^\n]+?)\*\*|`([^`\n]+)`/g;
    let cursor = 0;
    for (const match of value.matchAll(tokens)) {
      text += value.slice(cursor, match.index);
      const startIndex = text.length + 1;
      if (match[2]) {
        text += match[1].replace(/\*\*(.*?)\*\*|`([^`]+)`/g, (_, bold, code) => bold ?? code);
        links.push({ startIndex, endIndex: text.length + 1, url: match[2] });
      } else if (match[3] !== undefined || match[4] !== undefined) {
        inline(match[3] ?? match[4]);
      } else {
        text += match[0];
        links.push({ startIndex, endIndex: text.length + 1, url: match[0] });
      }
      cursor = match.index + match[0].length;
    }
    text += value.slice(cursor);
  }
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const heading = lines[i].match(/^#{1,6}[ \t]+(.+)$/);
    const startIndex = text.length + 1;
    inline(heading ? heading[1] : lines[i]);
    if (heading) headings.push({ startIndex, endIndex: text.length + 1 });
    if (i < lines.length - 1) text += '\n';
  }
  // 文書末尾には必ず改行があるので、入力も1つ補い読み戻しを厳密に比較する。
  if (!text.endsWith('\n')) text += '\n';
  return { text, links, headings };
}

function documentBody(doc) {
  if (doc.tabs?.length) {
    if (doc.tabs.length !== 1 || doc.tabs[0].childTabs?.length) {
      throw new Error('複数タブの Doc は本文全体を置換できません');
    }
    return { body: doc.tabs[0].documentTab?.body, tabId: doc.tabs[0].tabProperties?.tabId };
  }
  return { body: doc.body };
}

export function buildRequests(rendered, doc) {
  const { body, tabId } = documentBody(doc);
  const endIndex = body?.content?.at(-1)?.endIndex;
  if (!Number.isInteger(endIndex) || endIndex < 2) throw new Error('Doc の本文範囲を取得できません');
  const tab = tabId ? { tabId } : {};
  const range = (startIndex, endIndex) => ({ startIndex, endIndex, ...tab });
  const requests = [];
  // Docs の最後の改行は削除不可。削除+挿入+書式を1回の atomic batch にまとめる。
  if (endIndex > 2) requests.push({ deleteContentRange: { range: range(1, endIndex - 1) } });
  const insertedText = rendered.text.slice(0, -1);
  if (insertedText) requests.push({ insertText: { location: { index: 1, ...tab }, text: insertedText } });
  const all = range(1, rendered.text.length + 1);
  // 残った最終段落から古いリンク/見出し/箇条書きを引き継がない。
  requests.push({ updateTextStyle: { range: all, textStyle: {}, fields: 'link' } });
  requests.push({ deleteParagraphBullets: { range: all } });
  requests.push({ updateParagraphStyle: { range: all, paragraphStyle: { namedStyleType: 'NORMAL_TEXT' }, fields: 'namedStyleType' } });
  for (const heading of rendered.headings) requests.push({ updateParagraphStyle: {
    range: { ...heading, ...tab }, paragraphStyle: { namedStyleType: 'HEADING_2' }, fields: 'namedStyleType',
  } });
  for (const { startIndex, endIndex, url } of rendered.links) requests.push({ updateTextStyle: {
    range: range(startIndex, endIndex), textStyle: { link: { url } }, fields: 'link',
  } });
  return requests;
}

/** 全リンクの全文字に正しい URL が付いていることを検証（同一 URL の複数出現も別々に）。 */
export function verifyReadBack(rendered, doc) {
  const { body } = documentBody(doc);
  const runs = (body?.content ?? []).flatMap(p => p.paragraph?.elements ?? []).filter(e => e.textRun);
  const text = runs.map(e => e.textRun.content).join('');
  if (text !== rendered.text) throw new Error('read-back: 本文が一致しません');
  for (const link of rendered.links) {
    let cursor = link.startIndex;
    for (const run of runs) {
      if (run.endIndex <= cursor) continue;
      if (run.startIndex > cursor || run.textRun.textStyle?.link?.url !== link.url) break;
      cursor = Math.min(link.endIndex, run.endIndex);
      if (cursor === link.endIndex) break;
    }
    if (cursor !== link.endIndex) throw new Error(`read-back: リンク未設定または不一致 (${link.startIndex}..${link.endIndex})`);
  }
  return { linkCount: rendered.links.length };
}

export function renderHtml(rendered) {
  const escape = s => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  let html = '', cursor = 0;
  for (const link of rendered.links) {
    html += escape(rendered.text.slice(cursor, link.startIndex - 1));
    html += `<a href="${escape(link.url)}">${escape(rendered.text.slice(link.startIndex - 1, link.endIndex - 1))}</a>`;
    cursor = link.endIndex - 1;
  }
  html += escape(rendered.text.slice(cursor));
  return `<!doctype html><html><head><meta charset="UTF-8"></head><body><pre>${html}</pre></body></html>`;
}

export async function publishDocument({ title, source, folder, update, authuser, share, 'share-role': shareRole, private: isPrivate }, {
  getToken = getDriveToken, api = driveApi, ensure = ensureKimEditor, stderr = console.error,
} = {}) {
  if (containsSecret(source) && !isPrivate) {
    const err = new Error('秘密らしい行を含むため共有フォルダに置けません。--private を付けてください');
    err.exitCode = 3;
    throw err;
  }
  workspaceUrl('https://docs.google.com/', authuser);
  if (share) shareRecipients(share, shareRole);
  const rendered = renderDocument(source);
  const token = await getToken({ impersonate: 'kim@orgiast.jp' });
  const request = async (url, method = 'GET', body) => {
    try {
      return await (await api(token, url, {
        method, signal: AbortSignal.timeout(60_000),
        ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
      })).json();
    } catch (error) {
      if (url.startsWith(DOCS) && /\b403\b/.test(error.message) && /SERVICE_DISABLED|PERMISSION_DENIED/.test(error.message)) error.docsUnavailable = true;
      throw error;
    }
  };
  const parent = isPrivate ? 'root' : (folder ?? (update ? undefined : DEFAULT_FOLDER));
  if (parent && parent !== 'root') {
    const meta = await request(`${DRIVE}/${encodeURIComponent(parent)}?fields=mimeType,capabilities&supportsAllDrives=true`);
    if (meta.mimeType !== 'application/vnd.google-apps.folder' || !meta.capabilities?.canAddChildren) {
      throw new Error('指定フォルダに Doc を追加できません');
    }
  }
  let id = update;
  let fallback = false;
  try {
    if (!id) {
      id = (await request(DOCS, 'POST', { title })).documentId;
      if (!id) throw new Error('作成レスポンスに documentId がありません');
      await ensure(id, { actingUser: 'kim@orgiast.jp', token, api, created: !update });
    }
    const docEndpoint = `${DOCS}/${encodeURIComponent(id)}`;
    const doc = await request(`${docEndpoint}?includeTabsContent=true`);
    const requests = buildRequests(rendered, doc);
    if (!doc.revisionId) throw new Error('Doc の revisionId を取得できません');
    await request(`${docEndpoint}:batchUpdate`, 'POST', {
      requests, writeControl: { requiredRevisionId: doc.revisionId },
    });
  } catch (error) {
    if (!error.docsUnavailable) throw error;
    fallback = true;
    stderr('gdoc-publish: Docs API の 403 のため Drive 変換アップロードにフォールバックします');
    const boundary = `gdoc-${randomUUID()}`;
    const metadata = { name: title, mimeType: 'application/vnd.google-apps.document', appProperties: { orgiastAutomation: 'true' }, ...(!id && parent ? { parents: [parent] } : {}) };
    const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n${renderHtml(rendered)}\r\n--${boundary}--\r\n`;
    const created = await (await api(token, `https://www.googleapis.com/upload/drive/v3/files${id ? '/' + encodeURIComponent(id) : ''}?uploadType=multipart&supportsAllDrives=true&fields=id`, {
      method: id ? 'PATCH' : 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body, signal: AbortSignal.timeout(60_000),
    })).json();
    if (!created.id || (id && created.id !== id)) throw new Error('Drive 変換結果の ID が不正です');
    id = created.id;
    await ensure(id, { actingUser: 'kim@orgiast.jp', token, api, created: !update });
  }
  if (share) await shareAndRecord({ fileId: id, emails: share, role: shareRole, auth: token, name: title });
  // Docs API は親フォルダ/既存タイトル変更を扱わないため、Drive API で設定する。
  const params = new URLSearchParams({ fields: 'id', supportsAllDrives: 'true' });
  if (parent) {
    const meta = await request(`${DRIVE}/${encodeURIComponent(id)}?fields=parents&supportsAllDrives=true`);
    if (!meta.parents?.includes(parent)) params.set('addParents', parent);
    const remove = (meta.parents ?? []).filter(p => p !== parent);
    if (remove.length) params.set('removeParents', remove.join(','));
  }
  if (parent || update) await request(`${DRIVE}/${encodeURIComponent(id)}?${params}`, 'PATCH', { name: title });
  let verified;
  if (fallback) {
    const after = await (await api(token, `${DRIVE}/${encodeURIComponent(id)}/export?mimeType=text%2Fplain`, { signal: AbortSignal.timeout(60_000) })).text();
    const normalize = text => text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').replace(/\n$/, '');
    if (normalize(after) !== normalize(rendered.text)) throw new Error('read-back: 本文が一致しません');
    verified = { linkCount: rendered.links.length, verification: 'drive-text-export' };
  } else {
    const after = await request(`${DOCS}/${encodeURIComponent(id)}?includeTabsContent=true`);
    verified = verifyReadBack(rendered, after);
  }
  if (isPrivate) {
    const perms = await request(`${DRIVE}/${encodeURIComponent(id)}/permissions?supportsAllDrives=true&fields=permissions(id,role)`);
    const nonOwner = (perms.permissions ?? []).filter(p => p.role !== 'owner');
    if (nonOwner.length > 0) {
      const err = new Error('owner 以外の権限が存在します');
      err.exitCode = 4;
      throw err;
    }
  }
  return { id, url: workspaceUrl(`https://docs.google.com/document/d/${id}/edit`, authuser), ...verified, private: isPrivate };
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const { stdout = console.log, stderr = console.error, ...publishDependencies } = dependencies;
  try {
    const args = parseArgs(argv);
    const result = await publishDocument({ ...args, source: readFileSync(args.file, 'utf8') }, { ...publishDependencies, stderr });
    stderr(result.verification === 'drive-text-export' ? `read-back: 本文一致（Drive export）/ HTML リンク ${result.linkCount} 件を設定` : `read-back: 本文一致 / リンク ${result.linkCount}/${result.linkCount} 件 OK`);
    if (result.private) {
      stderr('read-back: 共有先は owner のみ');
    }
    stdout(`${args.authuser} で開いてください: ${result.url}`);
    return 0;
  } catch (error) {
    stderr(`gdoc-publish: ${error.message}`);
    return error.exitCode ?? 1;
  }
}

if (isEntry(import.meta.url)) process.exitCode = await main();
