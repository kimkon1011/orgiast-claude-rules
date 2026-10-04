import fs from 'node:fs';
import path from 'node:path';
import {main} from '../../../tools/feedback-done-notify.mjs';
const dir=path.dirname(new URL(import.meta.url).pathname);
const summaries={
 ff1d3b5c:'次回連絡日を一括削除できるようにしました。本番反映済みです。',
 '6323be60':'返信送信の翌日に次回連絡日を自動更新します。将来の手動・相手指定日は保護します。本番反映済みです。',
 '63a2b1f4':'Gmailの全ページ取得と7日間検索に対応し、トミナガ案件の既存4通の反映を確認しました。本番反映済みです。',
 '14beb3ad':'新規案件登録のエラー画面を改善し、外部連携が失敗しても登録は完了し、失敗理由を日本語で表示するようにしました。本番反映済みです。',
 '8cca7287':'新規案件登録の「エラー識別子」画面を改善し、入力不備を該当欄に日本語で表示するようにしました。本番反映済みです。',
 '9b1d6ba9':'リブース案件でも見積・実施計画書を生成できるようにしました。本番反映済みです。',
 '00caf01e':'案件IDでフォルダを特定して見積・実施計画書を作成し、別案件のリンク混入を読み戻しで確認するようにしました。本番反映済みです。',
 b9beb973:'見積作成時に案件フォルダ配下の制作フォルダを作成・再利用するようにしました。本番反映済みです。過去案件の不足分の一括作成は別途対応します。',
 '40ba3003':'生成する案件フォルダに社員・アシスタント・制作チームの編集権限を自動付与するようにしました。本番反映済みです。過去案件への一括付与は別途対応します。',
};
const rows=JSON.parse(fs.readFileSync(path.join(dir,'done-sales.json')));
for(const row of rows){const summary=summaries[row.id.slice(0,8)];if(!summary||row.status!=='done'||row.submitter_email!=='m.kanau@orgiast.jp')throw Error('unexpected row');const args=['--recipient-only','--state-home',dir,'--message-id',row.id,'--summary',summary];if(process.argv.includes('--dry'))args.push('--dry');const result=await main(args,{home:'/mnt/c/Users/uers'});if(result)throw Error('notify exit '+result);}
