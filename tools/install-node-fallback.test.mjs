import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// 回帰テスト: install-orgiast.ps1 の Node.js 導入。
// 背景(2026-11-02 DELL 実機): winget の Node MSI は管理者昇格(UAC)を要求するため、
// Claude が代理実行する非対話・非昇格のインストールでは黙って失敗し、
// Codex CLI / hook 登録 / 一部スケジュールが連鎖的に落ちた。
// ここが消えると「Node が入っていない PC が静かに増える」ため、
// フォールバックの順序・昇格不要・PATH 恒久反映をソースで固定する。
const dir = path.resolve(import.meta.dirname);
const source = fs.readFileSync(path.join(dir, 'install-orgiast.ps1'), 'utf8');
// コメント行を除いた本体だけを見る(説明文に同じ語が出ても誤検知しない)。
const code = source
  .split(/\r?\n/)
  .filter((line) => !line.trim().startsWith('#'))
  .join('\n');

const FALLBACK = 'function Install-NodeUserScope';
const callAt = code.indexOf('[void](Install-NodeUserScope)');
const fnStart = code.indexOf(FALLBACK);
const fnBody = fnStart >= 0 && callAt > fnStart
  ? code.slice(fnStart, code.lastIndexOf('\nif (-not (Have node)) {', callAt))
  : '';

test('winget(MSI)を先に試し、それでも入らないときだけユーザー領域zipへフォールバックする', () => {
  const wingetAt = code.indexOf('winget install --id OpenJS.NodeJS.LTS');
  assert.ok(wingetAt >= 0, 'winget の Node.js 導入が消えている');
  assert.ok(callAt > wingetAt, 'zip フォールバックが winget より先に走っている');
  // ガード: 外側の「node が無い」ブロックの中で、winget 後に再度 Have node を確認してから呼ぶ。
  assert.match(
    code,
    /if \(-not \(Have node\)\) \{\s*Warn "Node\.js が無いので導入します"[\s\S]*?winget install --id OpenJS\.NodeJS\.LTS[\s\S]*?if \(-not \(Have node\)\) \{\s*Warn[\s\S]*?\[void\]\(Install-NodeUserScope\)/,
    'win で入った場合に zip を落とさないガードが壊れている',
  );
});

test('フォールバックは管理者昇格を使わず %LOCALAPPDATA%\\Programs\\nodejs へ展開する', () => {
  assert.ok(fnBody, `${FALLBACK} が見つからない`);
  assert.match(fnBody, /Join-Path \$env:LOCALAPPDATA 'Programs\\nodejs'/);
  // UAC を出す経路(-Verb RunAs / runas)に戻ると、非昇格の代理実行で元の不具合が再発する。
  assert.doesNotMatch(fnBody, /-Verb\s+RunAs|Start-Process[^\n]*RunAs/i);
});

test('展開した Node をユーザーPATHへ恒久追加し、現セッションにも反映する', () => {
  assert.match(fnBody, /SetEnvironmentVariable\('Path',[^\n]*'User'\)/);
  assert.match(fnBody, /\$env:Path \+= ";\$dstRoot"/);
  // ユーザーPATHが未設定(null)だと TrimEnd で例外→catch で「失敗」扱いになる回帰を防ぐ。
  assert.match(fnBody, /if \(\$userPath\) \{/);
});

test('公式zip の URL は LTS と CPU アーキテクチャから組み立て、一時ファイルは必ず消す', () => {
  assert.match(fnBody, /https:\/\/nodejs\.org\/dist\/index\.json/);
  assert.match(fnBody, /node-\$lts-win-\$arch\.zip/);
  assert.match(fnBody, /'arm64'/);
  assert.match(fnBody, /'x64'/);
  assert.match(fnBody, /finally \{[\s\S]*Remove-Item \$tmp -Recurse -Force/);
});

test('既にユーザー領域に展開済みなら再ダウンロードしない(冪等)', () => {
  assert.match(fnBody, /Test-Path \(Join-Path \$dstRoot 'node\.exe'\)/);
});

test('フォールバック後も「入りませんでした」の案内は残す', () => {
  assert.match(code, /Node\.js が入りませんでした。会社担当\(kim\)に連絡してください/);
});
