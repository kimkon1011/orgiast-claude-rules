#!/usr/bin/env node

let raw = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) raw += chunk;

try {
  const input = JSON.parse(raw || '{}');
  const prompt = String(input.prompt || '');
  const intakeWord = /ナレッジ|取り込|組み込|知見|共有された|オープンチャット|オフ会|資料を読んで/;
  if (!intakeWord.test(prompt)) process.exit(0);

  const context = '[INTAKE-TWO-AXES] 外部知見の取り込みは A軸(安全・手順・再発防止) と B軸(コスト削減・速度・人手削減・売上/発信) の2軸を必ず両方出す。B軸が空の報告は未完了。「既存と重複」と判定した項目も B軸で再確認する（思想はあるが実装が無い＝コストが払われ続けている場合がある）。資料の著者が「本丸」「宝」と呼ぶものが抽出に入っていなければ抽出が偏っている合図。';
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } }));
} catch {}
