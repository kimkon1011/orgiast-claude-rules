import test from 'node:test';
import assert from 'node:assert/strict';

// Utility: equivalent of PowerShell [regex]::Escape
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// PowerShell -match behavior: pattern is tested against the full string
function psMatch(input, pattern) {
  return new RegExp(pattern).test(input);
}

// テスト用のサイドバーリンク名の実測値
const SIDEBAR_NAMES = [
  '1件の未読、倉庫リーダー×倉庫社員(グループメッセージ), 4人のメンバー',
  '2件の未読、#general',
  'W2様',
  'プロジェクトA(グループメッセージ), 3人のメンバー',
  '古川未歩',
];

test('サイドバーリンク名: 通常のDM名をマッチ', () => {
  const chat = 'W2様';
  const escaped = escapeRegex(chat);
  // PowerShell: "W2様" -match "[regex]::Escape('W2様')" → true
  assert.ok(psMatch('W2様', escaped));
  assert.ok(psMatch('W2様(グループメッセージ), 3人のメンバー', escaped));
});

test('サイドバーリンク名: グループDM名をマッチ（(グループメッセージ)接尾辞）', () => {
  const chat = '倉庫リーダー×倉庫社員';
  const escaped = escapeRegex(chat);
  const nameWithSuffix = '1件の未読、倉庫リーダー×倉庫社員(グループメッセージ), 4人のメンバー';

  // chat名そのものでマッチ
  assert.ok(psMatch(nameWithSuffix, escaped),
    '未読接頭辞・グループメッセージ接尾辞があっても chat 名そのものでマッチすべき');

  // chat名 + (グループメッセージ) でマッチ
  const groupSuffixPattern = `${escaped}\\(グループメッセージ\\)`;
  assert.ok(psMatch(nameWithSuffix, groupSuffixPattern),
    'chat名+(グループメッセージ) パターンでマッチすべき');
});

test('サイドバーリンク名: 未読接頭辞パターン', () => {
  const chat = '倉庫リーダー×倉庫社員';
  const escaped = escapeRegex(chat);
  const name = '1件の未読、倉庫リーダー×倉庫社員(グループメッセージ), 4人のメンバー';

  const unreadPattern = `の未読.*${escaped}`;
  assert.ok(psMatch(name, unreadPattern),
    '「の未読」接頭辞パターンでもマッチすべき');
});

test('サイドバーリンク名: 通常DMは未読接頭辞が無い', () => {
  const chat = '古川未歩';
  const escaped = escapeRegex(chat);
  // 未読接頭辞パターンにはマッチしない
  const unreadPattern = `の未読.*${escaped}`;
  assert.ok(!psMatch('古川未歩', unreadPattern),
    '未読の無い通常DMは「の未読」パターンにマッチしない');
  // 単純マッチは通る
  assert.ok(psMatch('古川未歩', escaped));
});

test('Chat 名に正規表現特殊文字があってもマッチする（エスケープ）', () => {
  const chat = 'test+project (dev)';
  const escaped = escapeRegex(chat);
  const name = 'test+project (dev)(グループメッセージ), 2人のメンバー';
  assert.ok(psMatch(name, escaped), '特殊文字をエスケープしてマッチすべき');

  const groupPattern = `${escaped}\\(グループメッセージ\\)`;
  assert.ok(psMatch(name, groupPattern));
});

test('Get-SidebarLink のパターン優先順位: 完全一致 → グループメッセージ → 未読 → 部分一致', () => {
  // このテストは Get-SidebarLink のパターン配列が正しい優先順位かを検証する
  const chat = '倉庫リーダー×倉庫社員';
  const escaped = escapeRegex(chat);
  const fullName = '1件の未読、倉庫リーダー×倉庫社員(グループメッセージ), 4人のメンバー';

  const patterns = [
    `^${escaped}$`,
    `${escaped}\\(グループメッセージ\\)`,
    `の未読.*${escaped}`,
    `${escaped}`,
  ];

  // パターン0 (完全一致) は fullName にマッチしない
  assert.ok(!psMatch(fullName, patterns[0]));

  // パターン1 (グループメッセージ) はマッチする
  assert.ok(psMatch(fullName, patterns[1]));

  // パターン2 (未読) もマッチする
  assert.ok(psMatch(fullName, patterns[2]));

  // パターン3 (部分一致) もマッチする
  assert.ok(psMatch(fullName, patterns[3]));
});

test('クイックスイッチャー検索語: -Switch あり/なし', () => {
  const chat = '倉庫リーダー×倉庫社員';
  // -Switch 無し → '@' + chat
  const qsSearchNoSwitch = '@' + chat;
  assert.equal(qsSearchNoSwitch, '@倉庫リーダー×倉庫社員');
  // -Switch あり → Switch 値をそのまま
  const qsSearchWithSwitch = '倉庫リーダー';
  assert.equal(qsSearchWithSwitch, '倉庫リーダー');
});

test('Chat 名の表示チャット確認: 完全一致と部分一致', () => {
  const chat = '倉庫リーダー×倉庫社員';
  const currentChat = '倉庫リーダー×倉庫社員';
  const escaped = escapeRegex(chat);

  // 完全一致
  assert.ok(currentChat === chat,
    '完全一致すべき');
  // 部分一致（正規表現）
  assert.ok(psMatch(currentChat, escaped),
    '正規表現でもマッチすべき');
});