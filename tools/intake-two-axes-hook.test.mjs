import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { additionalContext, isExternalKnowledgeIntake } from './intake-two-axes-hook.mjs';

test('取り込み報告の2軸と未完了条件・正本を案内する', () => {
  assert.ok(additionalContext.startsWith('[INTAKE-TWO-AXES]'));
  for (const text of ['A軸', 'B軸', '未完了', '2軸の表', '既存と重複', '本丸', '宝', 'protocols/INTAKE-TWO-AXES.md']) {
    assert.ok(additionalContext.includes(text), text);
  }
  assert.doesNotMatch(additionalContext, /[\r\n]/);
});

test('外部知見の取り込み依頼と強い指標で発火する', () => {
  for (const text of ['オープンチャット共有を取り込んで', 'この記事のノウハウをルール化して', '他社のルール資料を取り込んで', '司令塔AI-OS', '司令塔', 'AI-OS', 'オープンチャット', 'noteの学びを反映して', 'Substackの知見を取り込んで', '動画のノウハウを吸収して']) {
    assert.equal(isExternalKnowledgeIntake(text), true, text);
  }
});

test('取り込み文脈がない依頼や非文字列では発火しない', () => {
  for (const text of ['このファイル読んで', 'テストを直して', '要約して', 'この記事を要約して', 'ルール化して', 'notebookを導入して', '', undefined, null, 42, {}, []]) {
    assert.equal(isExternalKnowledgeIntake(text), false);
  }
});

function runHook(input) {
  return spawnSync(process.execPath, [fileURLToPath(new URL('./intake-two-axes-hook.mjs', import.meta.url))], {
    input, encoding: 'utf8', timeout: 5000,
  });
}

test('該当するpromptはUserPromptSubmitのJSONでcontextを出力する', () => {
  const result = runHook(JSON.stringify({ prompt: '他社のルール資料を取り込んで' }));
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  const output = JSON.parse(result.stdout);
  assert.equal(output.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.equal(output.hookSpecificOutput.additionalContext, additionalContext);
});

test('非該当・欠落・非文字列のpromptと不正入力は無出力で終了する', () => {
  for (const input of ['', '  ', '{', 'null', '{}', '{"prompt":"テストを直して"}', '{"prompt":42}', '{"prompt":{}}']) {
    const result = runHook(input);
    assert.equal(result.status, 0, input);
    assert.equal(result.stdout, '', input);
    assert.equal(result.stderr, '', input);
  }
});
