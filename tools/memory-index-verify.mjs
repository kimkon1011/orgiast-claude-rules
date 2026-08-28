#!/usr/bin/env node
// 目的: memory-index-compact --move-hooks の適用結果を、変換側とは別実装で独立検証する。
// 変換ツール自身の assert は「生産側のモデル」で測るので、壊れ方が同じなら両方すり抜ける
// ([[feedback-verify-must-measure-the-producers-model]])。ここは索引と本文を素で読み直して照合する。
//
// 使い方:
//   node tools/memory-index-verify.mjs --before <MEMORY.md.bak-...> --after <MEMORY.md> [--body-backup <dir>] [--strict-added]
// 判定:
//   1. before のエントリ(タイトル+リンク先)が1つも消えていない
//      (増えている分は before 取得後の追記とみなし注記どまり。--strict-added で失敗にする)
//   2. before の hook 全文が、リンク先 .md の本文に存在する
//   3. before の wikilink `[[slug]]` が、リンク先 .md の本文に存在する
//   4. after の索引に hook / wikilink が1つも残っていない
//   5. --body-backup があれば、本文が「追記のみ」で変更されている(既存内容の削除・書き換えが無い)
// 1つでも破れたら exit 1。

import fs from 'node:fs';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';

const ENTRY_LINE_RE = /^\s*-\s+\[/;
const MERGED_SEPARATOR_RE = / ／ (?=\[[^\]]+\]\([^)]+\.md\))/;
const ENTRY_RE = /^\[([^\]]+)\]\(([^)]+\.md)\)(.*)$/;
const WIKILINK_RE = /\[\[([^\]]+)\]\]/g;
const HOOK_SEPARATOR = ' — ';

const normalize = (text) => text.replace(/[\s　]+/g, ' ').trim();

export function parseIndex(text) {
  const entries = [];
  for (const line of text.split(/\r?\n/)) {
    if (!ENTRY_LINE_RE.test(line)) continue;
    for (const part of line.replace(/^\s*-\s+/, '').split(MERGED_SEPARATOR_RE)) {
      const match = part.match(ENTRY_RE);
      if (!match) continue;
      const tail = match[3];
      const separatorIndex = tail.indexOf(HOOK_SEPARATOR);
      entries.push({
        title: match[1],
        file: match[2],
        hook: separatorIndex < 0 ? '' : normalize(tail.slice(separatorIndex + HOOK_SEPARATOR.length).replace(WIKILINK_RE, ' ')),
        wikilinks: [...tail.matchAll(WIKILINK_RE)].map((item) => item[1]),
      });
    }
  }
  return entries;
}

export function verify({ before, after, directory, bodyBackupDir, strictAdded = false }) {
  const problems = [];
  const beforeEntries = parseIndex(before);
  const afterEntries = parseIndex(after);
  const key = (entry) => `${entry.title}|${entry.file}`;
  const afterKeys = new Set(afterEntries.map(key));
  const beforeKeys = new Set(beforeEntries.map(key));

  // 「消えた」は情報の喪失なので常に失敗。「増えた」は before を撮ってから別セッションが
  // memory を追記しただけのことが多く、既定では警告に留める(常時赤の検査は読まれなくなる)。
  // 変換の純粋性そのものを検査したいときだけ --strict-added で失敗にする。
  const notes = [];
  for (const entry of beforeEntries) if (!afterKeys.has(key(entry))) problems.push(`エントリが消えた: ${key(entry)}`);
  for (const entry of afterEntries) {
    if (beforeKeys.has(key(entry))) continue;
    (strictAdded ? problems : notes).push(`エントリが増えた(before 取得後の追記と思われる): ${key(entry)}`);
  }

  const bodies = new Map();
  const readBody = (file) => {
    if (bodies.has(file)) return bodies.get(file);
    const full = path.join(directory, file);
    const body = fs.existsSync(full) ? normalize(fs.readFileSync(full, 'utf8')) : null;
    bodies.set(file, body);
    return body;
  };

  for (const entry of beforeEntries) {
    const body = readBody(entry.file);
    if (body === null) { problems.push(`リンク先が存在しない: ${entry.file}`); continue; }
    if (entry.hook && !body.includes(entry.hook)) problems.push(`hook が本文に無い: ${entry.file} :: ${entry.hook.slice(0, 60)}`);
    for (const slug of entry.wikilinks) if (!body.includes(`[[${slug}]]`)) problems.push(`wikilink が本文に無い: ${entry.file} :: [[${slug}]]`);
  }

  const residual = afterEntries.filter((entry) => entry.hook || entry.wikilinks.length);
  for (const entry of residual) problems.push(`索引に hook/wikilink が残っている: ${entry.file}`);

  let appendOnlyChecked = 0;
  if (bodyBackupDir) {
    for (const name of fs.readdirSync(bodyBackupDir).filter((item) => item.endsWith('.md'))) {
      const old = fs.readFileSync(path.join(bodyBackupDir, name));
      const current = fs.readFileSync(path.join(directory, name));
      appendOnlyChecked += 1;
      if (current.length < old.length || !current.subarray(0, old.length).equals(old)) problems.push(`本文が追記のみでない: ${name}`);
    }
  }

  return {
    problems,
    notes,
    stats: {
      entriesBefore: beforeEntries.length,
      entriesAfter: afterEntries.length,
      hooksChecked: beforeEntries.filter((entry) => entry.hook).length,
      wikilinksChecked: beforeEntries.reduce((sum, entry) => sum + entry.wikilinks.length, 0),
      appendOnlyChecked,
      bytesBefore: Buffer.byteLength(before, 'utf8'),
      bytesAfter: Buffer.byteLength(after, 'utf8'),
    },
  };
}

function optionValue(argv, name, required = true) {
  const index = argv.indexOf(name);
  if (index < 0) {
    if (required) throw new Error(`${name} が必要です`);
    return undefined;
  }
  if (!argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error(`${name} の値が必要です`);
  return argv[index + 1];
}

export function run(argv = process.argv.slice(2)) {
  const beforeFile = path.resolve(optionValue(argv, '--before'));
  const afterFile = path.resolve(optionValue(argv, '--after'));
  const bodyBackup = optionValue(argv, '--body-backup', false);
  const result = verify({
    before: fs.readFileSync(beforeFile, 'utf8'),
    after: fs.readFileSync(afterFile, 'utf8'),
    directory: path.dirname(afterFile),
    bodyBackupDir: bodyBackup ? path.resolve(bodyBackup) : undefined,
    strictAdded: argv.includes('--strict-added'),
  });
  const { stats } = result;
  console.log(`エントリ: ${stats.entriesBefore} -> ${stats.entriesAfter}`);
  console.log(`照合: hook ${stats.hooksChecked}件 / wikilink ${stats.wikilinksChecked}件 / 追記のみ検査 ${stats.appendOnlyChecked}ファイル`);
  console.log(`バイト: ${stats.bytesBefore} B -> ${stats.bytesAfter} B`);
  console.log(`24.4KB(24985B) 未満: ${stats.bytesAfter < 24985 ? 'OK' : 'NG'} / 17.1KB(17510B) 以下: ${stats.bytesAfter <= 17510 ? 'OK' : 'NG'}`);
  for (const note of result.notes) console.log(`注記: ${note}`);
  if (result.problems.length) {
    console.error(`\n検証 NG (${result.problems.length}件):`);
    for (const problem of result.problems) console.error(`- ${problem}`);
    throw new Error('独立検証に失敗しました');
  }
  console.log('検証 OK: 情報の欠落なし');
  return result;
}

if (isEntry(import.meta.url)) {
  try {
    run();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
