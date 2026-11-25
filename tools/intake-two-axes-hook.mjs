#!/usr/bin/env node
import { isEntry } from './is-entry.mjs';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';

export const additionalContext = '[INTAKE-TWO-AXES] 外部知見の取り込み報告は A軸（安全・手順・再発防止）と B軸（コスト削減・速度・自動ロード量・人手削減・売上/発信）の2軸の表で出す。B軸が空欄なら未完了として自分で埋め直す。「既存と重複」と判定した項目も B軸で再確認する（思想が既存でも実装が無い＝コストが払われ続けている場合がある）。資料の著者が「本丸」「宝」と呼ぶものが抽出に入っていなければ偏りの合図。B軸の設問: これは何回/何分の手作業を消すか、毎回ロードされるトークンを増やすか減らすか、落とすと売上・発信のどこが痩せるか。正本は protocols/INTAKE-TWO-AXES.md。';

// 外部ソースと取り込み語の組み合わせ、または単独の強い指標で判定する。
const externalSource = /オープンチャット|オフ会|共有された|他社|外部|資料|ニュース|\bnote\b|\bSubstack\b|マキモノ|Genspark|マニュアル|記事|動画|セミナー|勉強会|ポッドキャスト|登壇/i;
const intakeVerb = /取り込|反映|ルール化|組み込|吸収|導入|インプット|ノウハウ|学び|知見/;
const strongIndicator = /司令塔|AI-OS|オープンチャット/i;

export function isExternalKnowledgeIntake(text) {
  if (typeof text !== 'string') return false;
  return strongIndicator.test(text) || (externalSource.test(text) && intakeVerb.test(text));
}

async function main() {
  try {
    const raw = await readStdinWithTimeout();
    if (!raw.trim()) return;
    const data = JSON.parse(raw);
    if (!isExternalKnowledgeIntake(data?.prompt ?? '')) return;
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext } }));
  } catch {}
}

if (isEntry(import.meta.url)) await main();
