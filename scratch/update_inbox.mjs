import fs from 'fs';

const file = 'C:/Users/uers/.claude/secretary-state/inbox-items.json';
const items = JSON.parse(fs.readFileSync(file, 'utf8'));

const now = new Date().toISOString();
const note = "2026-09-26 06:02 JST 秘書ラン: Gmail is:unread newer_than:3d=201threads実照会→前回ラン(05:24)以降の新着はbot系(Grok ToS/GCP支払/GitHub merge×8/CI失敗/勤怠打刻申請/GAS失敗/Drive所有権移転2件/採用エントリー2件)のみで、既存高優先度20件との重複を除くと新規の高優先度案件0(社保/退職手続きフォルダ所有権・GASのRhino廃止・勤怠申請・採用エントリーは内部運用扱いでmediumだが上限20枠を既存highが占有のため今回は非掲載)。Phase B: pending 20件をthreads.get(format=metadata)で全実照会→kim@orgiast.jp送信0件(返信検出0、1件は権限エラーで未確認)。Discord: 1 guild/386ch中可読8ch、ヒューマン発信0(該当メンションは全て学会協賛ナビ日次KPI bot等の自動投稿)。Drive: sharedWithMe検索で新規共有ファイルなし(既存ファイルの更新のみ)。Phase C: 学習0";

for (const item of items) {
  item.updatedAt = now;
  item.replyCheckedAt = now;
  item.replyCheckNote = note;
}

fs.writeFileSync(file, JSON.stringify(items, null, 2) + '\n', 'utf8');
console.log('wrote', items.length, 'items');
