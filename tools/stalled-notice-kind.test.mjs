import test from 'node:test';
import assert from 'node:assert/strict';
import { decideStalledNoticeKind } from './lib/stalled-notice-kind.mjs';

test('承認ワードが reason にある → ask', () => {
  assert.equal(decideStalledNoticeKind({ reason: 'kim の承認が必要です' }), 'ask');
});

test('第三者からの返信待ち → info', () => {
  assert.equal(
    decideStalledNoticeKind({ reason: '辻さんからフリガナの返信を待ち、確認後に企業登録を実行する' }),
    'info',
  );
});

test('他セッションが着手中 → info', () => {
  assert.equal(
    decideStalledNoticeKind({ reason: '他の2並行セッションが着手しているため待機' }),
    'info',
  );
});

test('未知の理由（天候） → ask（安全側）', () => {
  assert.equal(decideStalledNoticeKind({ reason: '天候により会場の下見ができない' }), 'ask');
});

test('承認語と info パターンが両方ある → ask（承認語優先）', () => {
  assert.equal(
    decideStalledNoticeKind({ reason: '佐藤さんから回答待ち。入金の承認も要る' }),
    'ask',
  );
});

test('nextStep に判断ワード → ask', () => {
  assert.equal(
    decideStalledNoticeKind({ reason: '自動進行の完了', nextStep: '削除してよいか確認が必要' }),
    'ask',
  );
});

test('reason に作業途中 → info', () => {
  assert.equal(decideStalledNoticeKind({ reason: '作業が途中で時間切れになった' }), 'info');
});

test('reason に期限超過 → info', () => {
  assert.equal(decideStalledNoticeKind({ reason: '期限を超過したため続きから再開' }), 'info');
});

test('先方からの回答待ち → info', () => {
  assert.equal(
    decideStalledNoticeKind({ reason: '先方から回答待ちの状態' }),
    'info',
  );
});

test('契約の承認 → ask', () => {
  assert.equal(decideStalledNoticeKind({ reason: '契約の承認が必要です' }), 'ask');
});

test('nextStep に決裁 → ask', () => {
  assert.equal(decideStalledNoticeKind({ nextStep: '決裁が必要です' }), 'ask');
});

// 追加のテストケース（実データから）
test('PRの競合解消には担当者のレビュー・マージ指示が必要で自動処理できない → info', () => {
  assert.equal(
    decideStalledNoticeKind({ reason: 'PRの競合解消には担当者のレビュー・マージ指示が必要で自動処理できない' }),
    'info',
  );
});

test('辻さんのフリガナが未確定のため、企業登録と求人票提出ができない → info', () => {
  assert.equal(
    decideStalledNoticeKind({ reason: '辻さんのフリガナが未確定のため、企業登録と求人票提出ができない' }),
    'info',
  );
});

test('kim の入金が必要（Gemini の残高不足） → ask', () => {
  assert.equal(
    decideStalledNoticeKind({ reason: 'kim の入金が必要（Gemini の残高不足）' }),
    'ask',
  );
});

test('rescue ブランチを削除してよいか kim の許可が要る → ask', () => {
  assert.equal(
    decideStalledNoticeKind({ reason: 'rescue ブランチを削除してよいか kim の許可が要る' }),
    'ask',
  );
});

test('Codex のバックグラウンド実行が完了していないため、実行結果の確認と PR の着地が必要 → info', () => {
  assert.equal(
    decideStalledNoticeKind({ reason: 'Codex のバックグラウンド実行が完了していないため、実行結果の確認と PR の着地が必要' }),
    'info',
  );
});

test('Codex 実行中の自動進行が残っているため → info', () => {
  assert.equal(
    decideStalledNoticeKind({ reason: 'Codex 実行中の自動進行が残っているため' }),
    'info',
  );
});

test('セッション終了処理と本番反映コマンドの実行が委譲ゲートに阻まれている → info', () => {
  assert.equal(
    decideStalledNoticeKind({ reason: 'セッション終了処理と本番反映コマンドの実行が委譲ゲートに阻まれている' }),
    'info',
  );
});

test('kim の 6 件の判断依頼（質問への回答）が未完了で、機械で自動処理できる作業は残っていないため → ask', () => {
  assert.equal(
    decideStalledNoticeKind({ reason: 'kim の 6 件の判断依頼（質問への回答）が未完了で、機械で自動処理できる作業は残っていないため' }),
    'ask',
  );
});

test('GAS 本体の復旧には白川絵美さんの Apps Script 権限が必要であり、kim の権限では対応できない → info', () => {
  assert.equal(
    decideStalledNoticeKind({ reason: 'GAS 本体の復旧には白川絵美さんの Apps Script 権限が必要であり、kim の権限では対応できない' }),
    'info',
  );
});

test('APIの利用制限に達したため、セッションを続行できない → info', () => {
  assert.equal(
    decideStalledNoticeKind({ reason: 'APIの利用制限に達したため、セッションを続行できない', nextStep: '制限が解除されるまで待機する' }),
    'info',
  );
});

test('依存パッケージのインストールには権限が必要 → info', () => {
  assert.equal(
    decideStalledNoticeKind({ reason: 'sqlite3 の再ビルド（npm rebuild sqlite3 / npm i yallist）が必要だが、依存パッケージのインストールには権限が必要' }),
    'info',
  );
});

const realDataCases = [
  {
    name: '引き継ぎ方法を1行で返信する → ask',
    reason: '引き継ぎの判断が必要',
    nextStep: '「待つ」か「<名前>さんに頼む」と1行で返信する',
    expected: 'ask',
  },
  {
    name: '委譲ゲートの解消に金さんの承認を得る → ask',
    reason: 'セッション終了処理と本番反映コマンドの実行が委譲ゲートに阻まれている',
    nextStep: '金さんの承認を得て、WSLのバージョン変更（案A）またはCodexの設定変更（案B）を実施する',
    expected: 'ask',
  },
  {
    name: 'API利用制限の解除に金さんの承認を得る → ask',
    reason: 'APIの利用制限に達したため、セッションを続行できない',
    nextStep: '金さんの承認を得て、APIの利用制限を解除するか、制限が解除されるまで待機する',
    expected: 'ask',
  },
  {
    name: '依存パッケージのインストールをkimへ承認依頼する → ask',
    reason: 'sqlite3 の再ビルド（npm rebuild sqlite3 / npm i yallist）が必要だが、依存パッケージのインストールには権限が必要',
    nextStep: 'kim への承認依頼（kim-inbox 登録）',
    expected: 'ask',
  },
  {
    name: '担当者にPRの競合解消を依頼する → info',
    reason: 'PRの競合解消には担当者のレビュー・マージ指示が必要で自動処理できない',
    nextStep: '担当者にPRの競合解消を依頼し、完了報告を受けたら再開する',
    expected: 'info',
  },
  {
    name: '辻さんのフリガナ返信を待つ → info',
    reason: '辻さんのフリガナが未確定のため、企業登録と求人票提出ができない',
    nextStep: '辻さんからフリガナの返信を待ち、確認後、ENWSへの企業登録と求人票2本の提出を実行する',
    expected: 'info',
  },
  {
    name: 'Codexバックグラウンド実行の完了待ち → info',
    reason: 'Codex のバックグラウンド実行が完了していないため、実行結果の確認と PR の着地が必要',
    nextStep: '',
    expected: 'info',
  },
  {
    name: 'Codex実行中の自動進行が残っている → info',
    reason: 'Codex 実行中の自動進行が残っているため',
    nextStep: '',
    expected: 'info',
  },
  {
    name: 'Codexの実装結果のread-backが必要 → info',
    reason: 'Codexの実装結果のread-backが必要',
    nextStep: '',
    expected: 'info',
  },
  {
    name: '白川絵美さんにGAS本体の復旧を依頼する → info',
    reason: 'GAS 本体の復旧には白川絵美さんの Apps Script 権限が必要であり、kim の権限では対応できない',
    nextStep: '白川絵美さんに GAS 本体の復旧を依頼する',
    expected: 'info',
  },
];

for (const { name, reason, nextStep, expected } of realDataCases) {
  test(name, () => {
    assert.equal(decideStalledNoticeKind({ reason, nextStep }), expected);
  });
}
