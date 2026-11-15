#!/usr/bin/env node
import { ensureKimEditor } from './lib/kim-editor.mjs';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';
import { redactSecrets } from './redact-secrets.mjs';
import { isEntry } from './is-entry.mjs';
import os from 'node:os';
import { resolveOwner } from './lib/fleet-owner.mjs';

export const HOOK_MATCHER = 'mcp__.*(?:Google_Drive|google_drive|Google_Sheets|google_sheets|Google_Docs|google_docs|Google_Slides|google_slides).*';
export function isCreation(name = '') {
  return /(?:drive|sheets|docs|slides)/i.test(name) && /(?:create|copy)(?:_file|_document|_spreadsheet|_presentation|Document|Spreadsheet|Presentation|File)(?:$|_)/i.test(name);
}
export function extractCreatedFiles(value) {
  const files = new Map();
  function visit(node) {
    if (typeof node === 'string') {
      try { visit(JSON.parse(node)); } catch {
        for (const m of node.matchAll(/https:\/\/(?:docs|drive)\.google\.com\/(?:document\/|spreadsheets\/|presentation\/|file\/)?d\/([\w-]+)/g)) files.set(m[1], { id: m[1] });
      }
    } else if (Array.isArray(node)) node.forEach(visit);
    else if (node && typeof node === 'object') {
      const id = node.fileId || node.documentId || node.spreadsheetId || node.presentationId || node.id;
      if (typeof id === 'string' && /^[\w-]+$/.test(id) && !node.permissionId && node.type !== 'user') {
        files.set(id, { id, actingUser: node.owners?.find(o => o.emailAddress)?.emailAddress });
      }
      for (const [key, child] of Object.entries(node)) if (!['owners', 'permissions', 'sheets', 'slides', 'tabs'].includes(key)) visit(child);
    }
  }
  visit(value);
  return [...files.values()];
}
export async function handle(input, { ensure = ensureKimEditor } = {}) {
  if (!isCreation(input?.tool_name) || input.tool_response?.isError) return null;
  try {
    const files = extractCreatedFiles(input.tool_response);
    if (!files.length) throw new Error('作成結果から fileId を取得できません');
    for (const file of files.filter(f => f.actingUser?.toLowerCase() !== 'kim@orgiast.jp')) await ensure(file.id, { created: true, actingUser: file.actingUser || input.tool_input?.actingUser || input.tool_input?.impersonate || resolveOwner({ home: process.env.ORGIAST_HOME || os.homedir() }) || undefined });
    return null;
  } catch (error) {
    return { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: `kim 編集権限の付与に失敗: ${redactSecrets(error.message)}。その場で直すこと` } };
  }
}
export async function main() {
  const result = await handle(JSON.parse(await readStdinWithTimeout(1000)));
  if (result) console.log(JSON.stringify(result));
}

if (isEntry(import.meta.url)) await main();
