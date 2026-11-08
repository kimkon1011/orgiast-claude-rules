import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

// discord-post.ps1 の Normalize-DiscordText を pwsh で実行し、Discord UIA が返す実測テキストで比較が通るかを確かめる。
const src = fs.readFileSync(new URL('./discord-post.ps1', import.meta.url), 'utf8');
const fnLine = src.split(/\r?\n/).find((line) => line.startsWith('function Normalize-DiscordText'));
const pwsh = process.platform === 'win32' ? 'pwsh.exe' : 'pwsh';
const hasPwsh = (() => { try { execFileSync(pwsh, ['-NoProfile', '-Command', '1'], { stdio: 'ignore' }); return true; } catch { return false; } })();

function same(a, b) {
  const script = `${fnLine}\n$a = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(a).toString('base64')}'))\n$b = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(b).toString('base64')}'))\nif ((Normalize-DiscordText $a) -eq (Normalize-DiscordText $b)) { 'SAME' } else { 'DIFF' }`;
  return execFileSync(pwsh, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' }).trim() === 'SAME';
}

const body = '川村さん　確認しました。\n\n【売値】\n・売上422.7万円\n\n【回答】\n・OKです';

test('Normalize-DiscordText is defined in discord-post.ps1', () => {
  assert.ok(fnLine, 'function line not found');
  assert.match(src, /Normalize-DiscordText \$cur/);
  assert.match(src, /Normalize-DiscordText \$pasted\) -ne \(Normalize-DiscordText \$body\)/);
});

test('blank lines that Discord returns as U+FEFF match the body (2026-10-20 failure)', { skip: !hasPwsh }, () => {
  assert.equal(same(body.replace(/\n\n/g, '\n﻿\n'), body), true);
});

test('U+FFFC object characters do not cause a mismatch', { skip: !hasPwsh }, () => {
  assert.equal(same(body.replace(/\n\n/g, '\n￼\n'), body), true);
});

test('zero-width space inside a word is ignored', { skip: !hasPwsh }, () => {
  assert.equal(same(body.replace('確認', '確​認'), body), true);
});

test('CRLF and repeated spaces are ignored', { skip: !hasPwsh }, () => {
  assert.equal(same(body.replace(/\n/g, ' \r\n  '), body), true);
});

test('a changed number is still rejected', { skip: !hasPwsh }, () => {
  assert.equal(same(body.replace('422.7', '999'), body), false);
});

test('an input box holding only invisible characters counts as empty', { skip: !hasPwsh }, () => {
  assert.equal(same('￼﻿​ \r\n', ''), true);
});
