import { notifyOwner } from './notify-owner.mjs';
import { discordAllowed } from './lib/kim-discord-allowlist.mjs';

const sampleText = `【作業用011・cr@orgiast.jp の Claude Code】プロジェクト: CLAUDE.md配布 ／ セッションの目的: テスト ／ 作業ID: 123
✅ 自動進行が完了しました
✅ 完了: テスト完了`;

console.log('--- Checking discordAllowed directly ---');
console.log('discordAllowed result:', discordAllowed(sampleText));

console.log('\n--- Running notifyOwner kind=done-requested ---');
const res1 = await notifyOwner('cr@orgiast.jp', sampleText, {
  kind: 'done-requested',
  session: { owner: 'cr@orgiast.jp' }
});
console.log('res1:', res1);

console.log('\n--- Running notifyOwner kind=automatic ---');
const res2 = await notifyOwner('cr@orgiast.jp', sampleText, {
  kind: 'automatic',
  session: { owner: 'cr@orgiast.jp' }
});
console.log('res2:', res2);
