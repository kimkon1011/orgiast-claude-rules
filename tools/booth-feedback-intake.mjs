#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseEnvText } from './env-kv.mjs';
import { isEntry } from './is-entry.mjs';
import { firstBlockBounds, sectionFrom } from './auto-session.mjs';

const MARKER = '<!-- NEXT-SESSION v1 -->';

export function readLedger(text) {
  try {
    const parsed = JSON.parse(String(text));
    if (parsed?.version === 1 && parsed.items && typeof parsed.items === 'object' && !Array.isArray(parsed.items)) return parsed;
  } catch {}
  return { version: 1, items: {} };
}

function oneLine(value, limit) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return typeof limit === 'number' ? text.slice(0, limit) : text;
}

export function formatTodo(item, sheetUrl, number) {
  const key = oneLine(item.key);
  const title = oneLine(item.title) || '無題';
  const body = oneLine(item.body, 100);
  const detail = body ? `${body}。` : '';
  return `${number}. **[FB:${key}] ${title}**（ブース制作アプリ 不具合要望 / ${oneLine(item.ts) || '日時不明'} / ${oneLine(item.source) || '取得元不明'}）— ${detail}**着手可否は kim 判断待ち**。シート: ${oneLine(sheetUrl)}`;
}

function todoSectionRange(block) {
  const section = sectionFrom(block, '残TODO');
  if (!section) return null;
  const start = block.indexOf(section);
  return { start, end: start + section.length, section };
}

export function injectFeedbackTodos(md, items, sheetUrl) {
  const source = String(md ?? '');
  const fresh = items.filter((item) => item?.key && !source.includes(`[FB:${item.key}]`));
  if (!fresh.length) return { text: source, injected: [] };
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const bounds = firstBlockBounds(source);
  const block = source.slice(bounds.start, bounds.end);
  const range = todoSectionRange(block);
  if (range) {
    const numbers = [...range.section.matchAll(/^\s*(\d+)[.)、]\s+/gm)].map((match) => Number(match[1]));
    const firstNumber = numbers.length ? Math.max(...numbers) + 1 : 1;
    const lines = fresh.map((item, index) => formatTodo(item, sheetUrl, firstNumber + index)).join(newline);
    const changedSection = `${range.section}${newline}${lines}`;
    const changedBlock = block.slice(0, range.start) + changedSection + block.slice(range.end);
    return { text: source.slice(0, bounds.start) + changedBlock + source.slice(bounds.end), injected: fresh };
  }
  const lines = fresh.map((item, index) => formatTodo(item, sheetUrl, index + 1)).join(newline);
  const addition = `## 残TODO（自動取込）${newline}${lines}`;
  const separator = block && !block.endsWith('\n') && !block.endsWith('\r') ? newline + newline : block.endsWith(newline + newline) ? '' : newline;
  const changedBlock = block + separator + addition + (bounds.end < source.length ? newline : '');
  return { text: source.slice(0, bounds.start) + changedBlock + source.slice(bounds.end), injected: fresh };
}

export async function fetchJson(url, options = {}, fetchImpl = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetchImpl(url, { ...options, redirect: 'follow', signal: controller.signal });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { throw new Error(`JSONでない応答: ${oneLine(text, 200)}`); }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return data;
  } finally { clearTimeout(timer); }
}

function defaultIo() {
  return {
    read: (file) => fs.readFileSync(file, 'utf8'),
    write: (file, text) => fs.writeFileSync(file, text, 'utf8'),
    now: () => new Date(),
    stdout: (text) => console.log(text),
    stderr: (text) => console.error(text),
  };
}

export async function runIntake({ args = [], home = process.env.ORGIAST_HOME || os.homedir(), io = defaultIo(), fetchImpl = fetch } = {}) {
  const claudeDir = path.join(home, '.claude');
  let env = {};
  try { env = parseEnvText(io.read(path.join(claudeDir, 'booth-feedback.env'))); } catch {}
  if (!env.BOOTH_FEEDBACK_URL || !env.BOOTH_FEEDBACK_TOKEN) {
    io.stderr('booth-feedback: BOOTH_FEEDBACK_URL/TOKEN 未設定のため取得しません(~/.claude/booth-feedback.env)');
    return 0;
  }
  const resolveIndex = args.indexOf('--resolve');
  const isResolve = resolveIndex >= 0;
  const json = args.includes('--json');
  try {
    if (isResolve) {
      const key = args[resolveIndex + 1];
      if (!key) throw new Error('--resolve に key が必要です');
      const statusIndex = args.indexOf('--status');
      const noteIndex = args.indexOf('--note');
      const status = statusIndex >= 0 ? args[statusIndex + 1] : 'done';
      const note = noteIndex >= 0 ? args[noteIndex + 1] : '';
      const result = await fetchJson(env.BOOTH_FEEDBACK_URL, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: env.BOOTH_FEEDBACK_TOKEN, action: 'resolveFeedback', key, status, note }),
      }, fetchImpl);
      if (!result?.ok) throw new Error(result?.error || 'API が ok:false を返しました');
      const ledgerFile = path.join(claudeDir, 'booth-feedback-ledger.json');
      let ledgerText = '';
      try { ledgerText = io.read(ledgerFile); } catch {}
      const ledger = readLedger(ledgerText);
      ledger.items[key] = { ...(ledger.items[key] ?? {}), lastStatus: status, resolvedAt: io.now().toISOString() };
      io.write(ledgerFile, `${JSON.stringify(ledger, null, 2)}\n`);
      io.stdout(json ? JSON.stringify({ ok: true, key, status, result }) : `booth-feedback: resolved ${key} -> ${status}`);
      return 0;
    }

    const endpoint = new URL(env.BOOTH_FEEDBACK_URL);
    endpoint.searchParams.set('token', env.BOOTH_FEEDBACK_TOKEN);
    endpoint.searchParams.set('action', 'feedback');
    const data = await fetchJson(endpoint, {}, fetchImpl);
    if (!data?.ok) throw new Error(data?.error || 'API が ok:false を返しました');
    const items = Array.isArray(data.items) ? data.items : [];
    if (args.includes('--list')) {
      io.stdout(json ? JSON.stringify(data) : items.map((item) => `[${item.kind || '不明'}] ${item.key} ${item.title || '無題'} (${item.ts || '日時不明'})`).join('\n') || 'booth-feedback: open=0');
      return 0;
    }
    const ledgerFile = path.join(claudeDir, 'booth-feedback-ledger.json');
    let ledgerText = '';
    try { ledgerText = io.read(ledgerFile); } catch {}
    const ledger = readLedger(ledgerText);
    const nextFile = path.join(claudeDir, 'next-session.md');
    let before = '';
    try { before = io.read(nextFile); } catch {}
    const validItems = items.filter((item) => item?.key);
    const existingInText = validItems.filter((item) => before.includes(`[FB:${item.key}]`));
    const missingFromText = validItems.filter((item) => !before.includes(`[FB:${item.key}]`));
    const reinjectedItems = missingFromText.filter((item) => ledger.items[item.key]?.injectedAt);
    const reinjectedKeys = new Set(reinjectedItems.map((item) => item.key));
    const candidates = missingFromText;
    const result = injectFeedbackTodos(before, candidates, data.sheetUrl || '');
    const reinjected = result.injected.filter((item) => reinjectedKeys.has(item.key)).length;
    const newlyInjected = result.injected.length - reinjected;
    const already = existingInText.length;
    const duplicateInText = candidates.length - result.injected.length;
    const dryRun = args.includes('--dry-run');
    if (dryRun) {
      const output = { open: items.length, new: newlyInjected, reinjected, injected: result.injected.length, skippedAlreadyInjected: already, skippedExistingText: duplicateInText, preview: result.text === before ? '' : result.text };
      io.stdout(json ? JSON.stringify(output) : `booth-feedback: open=${items.length} new=${newlyInjected} reinjected=${reinjected} would-inject=${result.injected.length}\n${output.preview}`);
      return 0;
    }
    if (result.text !== before) io.write(nextFile, result.text);
    const now = io.now().toISOString();
    for (const item of items) {
      const previous = ledger.items[item.key] ?? {};
      ledger.items[item.key] = { ...previous, firstSeen: previous.firstSeen || now, title: item.title || previous.title || '', lastStatus: item.status || previous.lastStatus || '' };
    }
    for (const item of result.injected) {
      if (reinjectedKeys.has(item.key)) {
        ledger.items[item.key].injectedAt = now;
        ledger.items[item.key].reinjectedCount = (Number(ledger.items[item.key].reinjectedCount) || 0) + 1;
      } else {
        ledger.items[item.key].injectedAt ||= now;
      }
    }
    io.write(ledgerFile, `${JSON.stringify(ledger, null, 2)}\n`);
    const summary = { open: items.length, new: newlyInjected, reinjected, injected: result.injected.length, skippedAlreadyInjected: already, skippedExistingText: duplicateInText };
    io.stdout(json ? JSON.stringify(summary) : `booth-feedback: open=${items.length} new=${newlyInjected} reinjected=${reinjected} injected=${result.injected.length} (skipped: already-injected ${already + duplicateInText})`);
    return 0;
  } catch (error) {
    io.stderr(`booth-feedback: ${isResolve ? '更新' : '取得'}に失敗 (${oneLine(error?.message || error, 240)})`);
    return isResolve ? 1 : 0;
  }
}

if (isEntry(import.meta.url)) {
  const code = await runIntake({ args: process.argv.slice(2) });
  process.exitCode = code;
}
