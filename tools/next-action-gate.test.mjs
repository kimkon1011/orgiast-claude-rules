import assert from 'node:assert/strict';
import test from 'node:test';
import { judgeNextAction, reportsCloseSteps, SESSION_PHRASES } from './next-action-gate.mjs';

// 自動セッション（CLAUDE_HEADLESS=1）の中でテストを走らせても、このファイルは通常セッションの
// 判定を検証する。ヘッドレスでは起床手段の検査をskipする仕様なので、環境変数を外しておかないと
// AUTOPILOT-NO-SESSION-WAKEUP を期待する4件が undefined で落ちる（2026-10-25 実測）。
// ヘッドレス側の挙動は末尾のテストが明示的に '1' を設定して検証し、終了時に元へ戻す。
delete process.env.CLAUDE_HEADLESS;

const body = '調査と実装と検証が完了しました。'.repeat(15);
const twoLineFooter = '次に kim がすること: なし\nこの後の自動進行: なし（完了）';
const footer = `${twoLineFooter}\nこのセッション: /session-close は不要なので、このセッションを閉じてよい`;

test('3行が末尾に揃っていればpass', () => {
  assert.equal(judgeNextAction(`${body}\n${footer}`).decision, 'pass');
});

test('3行の各行間に空行1つまで許容する', () => {
  const spaced = '次に kim がすること: なし\n\nこの後の自動進行: なし（完了）\n\nこのセッション: /session-close は不要なので、このセッションを閉じてよい';
  assert.equal(judgeNextAction(`${body}\n${spaced}`).decision, 'pass');
});

test('前バージョンで正解だった2行だけならblock', () => {
  assert.equal(judgeNextAction(`${body}\n${twoLineFooter}`).decision, 'block');
});

test('1行目だけならblock', () => {
  assert.equal(judgeNextAction(`${body}\n次に kim がすること: なし`).decision, 'block');
});

test('3行とも無ければblock', () => {
  assert.equal(judgeNextAction(body).decision, 'block');
});

test('3行が本文途中にあればblock', () => {
  assert.equal(judgeNextAction(`${body}\n${footer}\n追加説明です。`).decision, 'block');
});

test('kimの作業が2件ならblock', () => {
  const result = judgeNextAction(`${body}\n次に kim がすること: 承認、送信\nこの後の自動進行: Codex が確認後すぐ結果をチャットで通知します\nこのセッション: まだ閉じない（作業中）`);
  assert.equal(result.decision, 'block');
  assert.equal(result.code, 'NEXT-ACTION-MULTIPLE');
});

const openActionReport = (action, prefix = '') => `${prefix}${body}\n次に kim がすること: ${action}\nこの後の自動進行: なし（完了）\nこのセッション: ${SESSION_PHRASES.delete}`;

test('マージ依頼とリンクの確認依頼はNEXT-ACTION-OPENでblock', () => {
  for (const action of ['PR #893 をマージする', '上のリンクを開いて内容を確認する']) {
    assert.equal(judgeNextAction(openActionReport(action)).code, 'NEXT-ACTION-OPEN', action);
  }
});

test('なしと人にしかできない操作はNEXT-ACTION-OPENでblockしない', () => {
  for (const action of ['なし', '請求書の支払いを銀行で行う', 'OAuth の同意画面を開いて許可する']) {
    assert.notEqual(judgeNextAction(openActionReport(action)).code, 'NEXT-ACTION-OPEN', action);
  }
});

test('5文字以上の例外マーカーが本文にあればNEXT-ACTION-OPENでblockしない', () => {
  const result = judgeNextAction(openActionReport('PR #893 をマージする', '[NEXT-ACTION-OPEN-OK: 本人の操作が必須なため]\n'));
  assert.notEqual(result.code, 'NEXT-ACTION-OPEN');
});

test('唯一の恒久策を kim に渡す実文はblock', () => {
  const text = `${body}\n次に kim がすること: 本PCで gh auth login を1回実行する（唯一の恒久策）\nこの後の自動進行: なし（完了）\nこのセッション: ${SESSION_PHRASES.delete}`;
  const result = judgeNextAction(text);
  assert.equal(result.decision, 'block');
  assert.equal(result.code, 'NEXT-ACTION-DEFERRAL');
});

test('恒久策として gh auth login を求める実文はblock', () => {
  const text = `${body}\n次に kim がすること: 恒久策として gh auth login を本PCで1回だけ実行すると移送が不要になります\nこの後の自動進行: なし（完了）\nこのセッション: ${SESSION_PHRASES.delete}`;
  const result = judgeNextAction(text);
  assert.equal(result.decision, 'block');
  assert.equal(result.code, 'NEXT-ACTION-DEFERRAL');
});

test('2026-10-15 e738f943 の原文（GCM 登録依頼＋着地の先送り）はblock', () => {
  const text = `${body} 本PCの修正は main に着地する必要があります。\n次に kim がすること: この PC で \`gh auth login\`（または GCM に GitHub 資格情報を登録）を1回実行する — これが無い限り本PCの修正は main に着地しません。\nこの後の自動進行: 次回の自動セッションが next-session.md の 4b を先頭から拾う\nこのセッション: ${SESSION_PHRASES.pending}`;
  const result = judgeNextAction(text);
  assert.equal(result.decision, 'block');
  assert.equal(result.code, 'NEXT-ACTION-DEFERRAL');
});

test('本文の着地語と nextAction の修正語が揃う実文はblock', () => {
  const text = `${body} この PC で認証しない限り本PCの修正は main に着地しません。\n次に kim がすること: 本PCの修正を完了させる\nこの後の自動進行: なし（完了）\nこのセッション: ${SESSION_PHRASES.delete}`;
  const result = judgeNextAction(text);
  assert.equal(result.decision, 'block');
  assert.equal(result.code, 'NEXT-ACTION-DEFERRAL');
});

test('具体的なcommitのmainマージ判断をkimに渡す文はblock', () => {
  const text = `${body}\n次に kim がすること: \`f94ee7a\` を main にマージするか判断してください\nこの後の自動進行: なし（完了）\nこのセッション: ${SESSION_PHRASES.delete}`;
  const result = judgeNextAction(text);
  assert.equal(result.decision, 'block');
  assert.equal(result.code, 'NEXT-ACTION-DEFERRAL');
});

test('PR番号だけのマージ判断確認はblockしない', () => {
  const text = `${body}\n恒久策: 一回限り: Vercel Preview の目視確認が必要\n次に kim がすること: PR #14 を確認（マージ判断のみ）。Vercel Previewでの動作確認も可能です\nこの後の自動進行: なし（完了）\nこのセッション: ${SESSION_PHRASES.delete}`;
  assert.equal(judgeNextAction(text).decision, 'pass');
});

test('印刷所への電話は正当な人専用タスクとしてpass', () => {
  const text = `${body}\n恒久策: 一回限り: 今回の納期は本人から印刷所への電話確認が必要\n次に kim がすること: 印刷所へ電話して納期を確認する\nこの後の自動進行: なし（完了）\nこのセッション: ${SESSION_PHRASES.delete}`;
  assert.equal(judgeNextAction(text).decision, 'pass');
});

test('次に kim がすることが「なし」なら先送り判定せずpass', () => {
  assert.equal(judgeNextAction(`${body}\n${footer}`).decision, 'pass');
});

test('本文に着地語がない修正版PDFの物理操作はpass', () => {
  const text = `${body}\n恒久策: 一回限り: 本人手元の原本への初回同封が必要\n次に kim がすること: 修正版のPDFを印刷して同封する\nこの後の自動進行: なし（完了）\nこのセッション: ${SESSION_PHRASES.delete}`;
  assert.equal(judgeNextAction(text).decision, 'pass');
});

test('待ち状態と完了表記が矛盾すればblock', () => {
  const result = judgeNextAction(`${body} Codex の完了通知待ちです。\n${footer}`);
  assert.equal(result.decision, 'block');
  assert.equal(result.code, 'AUTOPILOT-CONTRADICTION');
});

test('このセッションの値が定型文のどれでもなければblock', () => {
  const result = judgeNextAction(`${body}\n${twoLineFooter}\nこのセッション: たぶん大丈夫`);
  assert.equal(result.decision, 'block');
  assert.equal(result.code, 'SESSION-INVALID');
});

test('このセッションの値が空ならblock', () => {
  const result = judgeNextAction(`${body}\n${twoLineFooter}\nこのセッション:`);
  assert.equal(result.decision, 'block');
  assert.equal(result.code, 'SESSION-EMPTY');
});

test('バックグラウンド実行中なのに閉じてよいならblock', () => {
  const text = `${body} Codex がバックグラウンドで実行中です。 /session-close 実行済み。\n次に kim がすること: なし\nこの後の自動進行: Codex が完了時にチャットで通知します\nこのセッション: /session-close は終わっているので、このセッションを閉じてよい`;
  const result = judgeNextAction(text);
  assert.equal(result.decision, 'block');
  assert.equal(result.code, 'SESSION-BACKGROUND-CONTRADICTION');
});

test('待ち語が無く、もう削除してよいならpass', () => {
  assert.equal(judgeNextAction(`${body}\n${footer}`).decision, 'pass');
});

test('待ち語があり、起床手段があればまだ閉じないでpass', () => {
  const text = `${body} 結果待ちです。\n次に kim がすること: なし\nこの後の自動進行: 処理完了時に Codex がチャットで通知します\nこのセッション: まだ閉じない（作業中）`;
  assert.equal(judgeNextAction(text, row('assistant', [{ type: 'tool_use', name: 'Agent', input: { run_in_background: true } }])).decision, 'pass');
});

test('session-close実行証拠なしで閉じてよいならblock', () => {
  const text = `${body}\n次に kim がすること: なし\nこの後の自動進行: なし（完了）\nこのセッション: /session-close は終わっているので、このセッションを閉じてよい`;
  const result = judgeNextAction(text);
  assert.equal(result.decision, 'block');
  assert.equal(result.code, 'SESSION-CLOSE-NO-EVIDENCE');
});

test('会話にsession-close実行証拠があれば閉じてよいがpass', () => {
  const text = `${body}\n次に kim がすること: なし\nこの後の自動進行: なし（完了）\nこのセッション: /session-close は終わっているので、このセッションを閉じてよい`;
  const transcript = JSON.stringify({ type: 'user', message: { role: 'user', content: '<command-name>/session-close</command-name>' } });
  assert.equal(judgeNextAction(text, transcript).decision, 'pass');
});

test('200文字未満の短い応答はpass', () => {
  assert.equal(judgeNextAction('承知しました。').decision, 'pass');
});

test('ツールで作業したターンは短文でもフッター必須（No response requested. で終わった 2026-10-23 実害）', () => {
  const worked = [
    JSON.stringify({ type: 'user', message: { role: 'user', content: '原因を調べて' } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } }),
  ].join('\n');
  const result = judgeNextAction('No response requested.', worked);
  assert.equal(result.decision, 'block');
  assert.equal(result.code, 'NEXT-ACTION-FOOTER');
  assert.equal(judgeNextAction('', worked).decision, 'pass');
});

test('末尾が疑問符の質問応答はpass', () => {
  assert.equal(judgeNextAction(`${body}この方針で進めてもよいですか？`).decision, 'pass');
});

test('環境変数で無効化できる', () => {
  const previous = process.env.ORGIAST_NEXT_ACTION_GATE;
  try {
    process.env.ORGIAST_NEXT_ACTION_GATE = '0';
    assert.equal(judgeNextAction(body).decision, 'pass');
  } finally {
    if (previous === undefined) delete process.env.ORGIAST_NEXT_ACTION_GATE;
    else process.env.ORGIAST_NEXT_ACTION_GATE = previous;
  }
});

const closedText = `${body}\n${twoLineFooter}\nこのセッション: /session-close は終わっているので、このセッションを閉じてよい`;
const row = (role, content, extra = {}) => JSON.stringify({ type: role, message: { role, content }, ...extra });

test('本文でsession-close完了を明記すればpass', () => {
  for (const report of ['/session-close 実行済み。', '`/session-close` を実行しました。', '/session-close を完了しました。']) {
    assert.equal(judgeNextAction(`${report}\n${closedText}`).decision, 'pass', report);
  }
});

test('session-close予定・未実行・失敗は実行証拠にならない', () => {
  for (const report of ['/session-close 実行予定です。', '/session-close を実行していません。', '/session-close 実行に失敗しました。', '/session-close 完了待ちです。', '/session-close 実行済みではありません。']) {
    const text = `${report}\n${closedText.replace('なし（完了）', '私が手続き完了後にこの画面で報告します')}`;
    assert.equal(judgeNextAction(text).code, 'SESSION-CLOSE-NO-EVIDENCE', report);
  }
});

test('会話中の本文でsession-close完了を報告していればpass', () => {
  const transcript = row('assistant', [{ type: 'text', text: '/session-close を実行しました。' }]);
  assert.equal(judgeNextAction(closedText, transcript).decision, 'pass');
});

test('会話の例示・ツール引数・別セッション・末尾自己申告は証拠にしない', () => {
  const command = '<command-name>/session-close</command-name>';
  for (const transcript of [
    row('user', `実行例: ${command}`),
    row('assistant', command),
    row('assistant', [{ type: 'tool_use', name: 'Bash', input: { command: `echo '${command}'` } }]),
    row('user', command, { isSidechain: true }),
    row('assistant', closedText),
    command,
  ]) assert.equal(judgeNextAction(closedText, transcript).code, 'SESSION-CLOSE-NO-EVIDENCE', transcript);
});

test('Skillの成功したsession-close呼び出しを会話から検出する', () => {
  const use = row('assistant', [{ type: 'tool_use', name: 'Skill', id: 'close-1', input: { skill: 'session-close' } }]);
  const result = row('user', [{ type: 'tool_result', tool_use_id: 'close-1', content: '完了しました' }]);
  assert.equal(judgeNextAction(closedText, `${use}\n${result}`).decision, 'pass');
  for (const transcript of [use, `${result}\n${use}`, `${use}\n${row('user', [{ type: 'tool_result', tool_use_id: 'other', content: '完了しました' }])}`, `${use}\n${row('user', [{ type: 'tool_result', tool_use_id: 'close-1', is_error: true, content: '失敗' }])}`, `${use}\n${row('user', [{ type: 'tool_result', tool_use_id: 'close-1', content: 'Permission denied' }])}`]) {
    assert.equal(judgeNextAction(closedText, transcript).code, 'SESSION-CLOSE-NO-EVIDENCE');
  }
});

test('定型文以外（旧表記・表記ゆれ・理由の付け足し）はblock', () => {
  for (const state of ['閉じてよい', '閉じてよい（/session-close 実行済み）', 'まだ閉じない（結果待ち）', 'もう削除してよい（残すものは無い）', 'アーカイブしてよい', 'アーカイブしてよい(/session-close 実行済み)', 'アーカイブしてよい（/session-close 実行済み）', 'アーカイブしてよい（/session-close 不要）', 'まだアーカイブしない（/session-close 未実行）', '/session-close は終わっているので、このセッションを閉じてよい。', 'まだアーカイブしない（Codex の結果待ち）']) {
    const text = `/session-close を実行しました。\n${body}\n${twoLineFooter}\nこのセッション: ${state}`;
    assert.equal(judgeNextAction(text).code, 'SESSION-INVALID', state);
  }
});

test('定型文はそれぞれpass', () => {
  for (const state of [SESSION_PHRASES.closed, SESSION_PHRASES.delete, SESSION_PHRASES.pending, SESSION_PHRASES.open]) {
    const text = `/session-close を実行しました。\n${body}\n${twoLineFooter}\nこのセッション: ${state}`;
    assert.equal(judgeNextAction(text).decision, 'pass', state);
  }
});

test('pendingはバックグラウンド語があってもpass', () => {
  const text = `${body} Codex がバックグラウンドで実行中です。\n次に kim がすること: なし\nこの後の自動進行: 処理の完了時に私がこの画面で報告します\nこのセッション: ${SESSION_PHRASES.pending}`;
  assert.equal(judgeNextAction(text, row('assistant', [{ type: 'tool_use', name: 'Agent', input: { run_in_background: true } }])).decision, 'pass');
});

test('3行の順序違い・2つ以上の空行・行間の説明をblock', () => {
  const lines = footer.split('\n');
  for (const invalid of [[lines[1], lines[0], lines[2]].join('\n'), lines.join('\n\n\n'), lines.join('\n説明です\n')]) {
    assert.equal(judgeNextAction(`${body}\n${invalid}`).code, 'NEXT-ACTION-FOOTER');
  }
  assert.equal(judgeNextAction(`${body}\r\n${lines.join('\r\n \t\r\n')}`).decision, 'pass');
});

test('指定された各バックグラウンド語と閉じる・削除の矛盾をblock', () => {
  for (const word of ['バックグラウンド', '実行中', '完了通知', 'Codex が', '走っている']) {
    for (const state of [SESSION_PHRASES.closed, SESSION_PHRASES.delete]) {
      const text = `${body} ${word}\n次に kim がすること: なし\nこの後の自動進行: 処理の完了時に私がこの画面で報告します\nこのセッション: ${state}`;
      assert.equal(judgeNextAction(text).code, 'SESSION-BACKGROUND-CONTRADICTION', `${word}: ${state}`);
    }
  }
});

test('200文字の境界と半角疑問符の除外を維持する', () => {
  assert.equal(judgeNextAction('あ'.repeat(199)).reason, 'short-response');
  assert.equal(judgeNextAction('あ'.repeat(200)).code, 'NEXT-ACTION-FOOTER');
  assert.equal(judgeNextAction(`${body}?`).reason, 'question');
});

// session-close SKILL.md §7.1: 閉じ際の「誰が・何を・どの順で」3行は、定型3行フッターを持たなくても
// それ自体が次の一手の指示なので通す（block すると余分な1ターンでログが書き戻る）。
test('§7.1の閉じ際3行はフッター無しでもpass', () => {
  const closing = `${body}\n1. 私（Claude）が close-session.mjs --session abc123 を実行します（これがこのタブへの最後の送信です）\n2. 新しいタブで Enter を1回押してください\n3. 続けて、この古いタブを ✕ で閉じてください。**/clear は使わないでください**`;
  const result = judgeNextAction(closing);
  assert.equal(result.decision, 'pass', JSON.stringify(result));
  assert.equal(result.reason, 'close-steps');
});

test('§7.1の3要素が欠けた長文は従来どおりblock', () => {
  const partial = `${body}\nclose-session.mjs で退避します。✕ で閉じてください。`;
  assert.equal(judgeNextAction(partial).code, 'NEXT-ACTION-FOOTER');
});

test('§7.1の3語に言及しただけ（番号付き3行が無い）長文は閉じ際とみなさない', () => {
  const mention = `${body}\nclose-session.mjs と ✕ と /clear の扱いを直したレポートです。`;
  assert.equal(reportsCloseSteps(mention), false);
  assert.equal(judgeNextAction(mention).code, 'NEXT-ACTION-FOOTER');
});

test('短文でもフッターがあれば定型外の「このセッション」を block する', () => {
  const text = 'PR はマージ済みです。\n\n次に kim がすること: なし\nこの後の自動進行: なし（完了）\nこのセッション: 目的完了。セッション判定: 閉じてOKです';
  assert.ok(text.length < 200);
  const r = judgeNextAction(text);
  assert.equal(r.decision, 'block');
  assert.equal(r.code, 'SESSION-INVALID');
});

test('短文でもフッターが定型どおりなら pass する', () => {
  const text = `作業は完了しました。\n\n次に kim がすること: なし\nこの後の自動進行: なし（完了）\nこのセッション: ${SESSION_PHRASES.pending}`;
  assert.ok(text.length < 200);
  assert.equal(judgeNextAction(text).decision, 'pass');
});

test('フッター欠落の block 理由に定型4文を載せる', () => {
  const r = judgeNextAction('あ'.repeat(250));
  assert.equal(r.code, 'NEXT-ACTION-FOOTER');
  for (const phrase of Object.values(SESSION_PHRASES)) assert.ok(r.reason.includes(phrase));
});

const warehouseAction = '3448 ハンマーをアンカーセットに入れる';
const permanentReport = (action, fix = '') => `${fix}\n次に kim がすること: ${action}\nこの後の自動進行: なし（完了）\nこのセッション: ${SESSION_PHRASES.delete}`;
const dispatch = row('assistant', [{ type: 'tool_use', name: 'Bash', input: { command: 'node tools/discord-dm.mjs 澤田武 --body-file request.txt' } }]);
const implementedFix = '恒久策: tools/foo.mjs を追加し毎朝自動実行にした';

test('ハンマー同梱の手渡しに恒久策行がなければblock', () => {
  const result = judgeNextAction(permanentReport(warehouseAction));
  assert.equal(result.decision, 'block');
  assert.equal(result.code, 'PERMANENT-FIX-REQUIRED');
  assert.match(result.reason, /このターンで実装/);
});

test('恒久策は具体物と完了した対応が必要', () => {
  for (const fix of ['', '恒久策: 今後検討します', '恒久策: tools/foo.mjs を今後追加します', '恒久策: tools/foo.mjs を追加したい', '恒久策: tools/foo.mjs', '恒久策: 自動化を実装した', '恒久策: tools/foo.mjs を追加していません', '恒久策: 一回限り:   ']) {
    assert.equal(judgeNextAction(permanentReport('本人同意ボタンを押す', fix)).code, 'PERMANENT-FIX-REQUIRED', fix);
  }
});

test('恒久策があっても倉庫依頼の実行痕跡がなければblock', () => {
  const result = judgeNextAction(permanentReport(warehouseAction, implementedFix));
  assert.equal(result.decision, 'block');
  assert.equal(result.code, 'WAREHOUSE-DISPATCH-REQUIRED');
  assert.match(result.reason, /倉庫担当へ Claude が依頼する/);
});

test('倉庫作業を依頼してkimの次の作業から外せばpass', () => {
  assert.equal(judgeNextAction(permanentReport('なし', '倉庫担当へ依頼済み。'), dispatch).decision, 'pass');
});

test('具体物の実装と初回だけの理由をそれぞれ認める', () => {
  for (const fix of [implementedFix, '恒久策: 一回限り: OAuth 初回同意は本人のブラウザ操作が必須', '恒久策: PR #895 で自動化を実装した', '恒久策: 澤田さんへ定期回収を依頼送信した', '恒久策: memory.md に運用ルールを追加済み', '恒久策: 倉庫運用.md にルールを追加したので今後は自動で担当へ依頼する', '恒久策: ツール名: Scheduler を設定した']) {
    assert.equal(judgeNextAction(permanentReport('本人同意ボタンを押す', fix)).decision, 'pass', fix);
  }
});

test('なし系と括弧付きの報告待ちは恒久策不要', () => {
  for (const action of ['なし', '無し', 'ありません', '不要', '返信不要', 'なし（結果の報告を待つだけ）']) {
    assert.equal(judgeNextAction(permanentReport(action)).decision, 'pass', action);
  }
  assert.equal(judgeNextAction(permanentReport('なし（完了）本人同意ボタンを押す')).code, 'PERMANENT-FIX-REQUIRED');
});

test('例外には空白を除く10文字以上の理由が必要で倉庫検査は免除しない', () => {
  for (const reason of ['', '短い理由', '         理由']) {
    assert.equal(judgeNextAction(permanentReport('本人同意ボタンを押す', `[PERMANENT-FIX-OK: ${reason}]`)).code, 'PERMANENT-FIX-REQUIRED');
  }
  const override = '[PERMANENT-FIX-OK: 本人の明示的な同意操作だけは代行できないため]';
  assert.equal(judgeNextAction(permanentReport('本人同意ボタンを押す', override)).decision, 'pass');
  assert.equal(judgeNextAction(permanentReport(warehouseAction, override)).code, 'WAREHOUSE-DISPATCH-REQUIRED');
});

test('本文の例示や引用は恒久策・例外・手渡しと解釈しない', () => {
  for (const fix of [`> ${implementedFix}`, `\`\`\`text\n${implementedFix}\n\`\`\``, '> [PERMANENT-FIX-OK: 本人の明示的な同意操作だけは代行できないため]']) {
    assert.equal(judgeNextAction(permanentReport('本人同意ボタンを押す', fix)).code, 'PERMANENT-FIX-REQUIRED');
  }
  assert.equal(judgeNextAction(`> 次に kim がすること: ${warehouseAction}\n${footer}`).decision, 'pass');
});

test('今ターンのBash・Discord送信tool_useを認める', () => {
  const text = permanentReport(warehouseAction, implementedFix);
  for (const transcript of [dispatch, ...['send_dm', 'send_message'].map(name => row('assistant', [{ type: 'tool_use', name: `mcp__claude_ai_Discord__${name}`, input: { recipient: '澤田武', content: '同梱をお願いします' } }]))]) {
    assert.equal(judgeNextAction(text, `${row('user', '倉庫作業を手配して')}\n${transcript}\n${row('user', [{ type: 'tool_result', tool_use_id: 'dm', content: 'delivered' }])}`).decision, 'pass');
  }
});

test('過去ターン・別会話・本文や検索での言及・dry-runは依頼送信でない', () => {
  const text = permanentReport(warehouseAction, implementedFix);
  for (const transcript of [
    `${dispatch}\n${row('user', '次の倉庫作業を手配して')}`,
    row('assistant', JSON.parse(dispatch).message.content, { isSidechain: true }),
    row('user', JSON.parse(dispatch).message.content),
    row('assistant', 'node tools/discord-dm.mjs 澤田武 --body-file request.txt を実行した'),
    ...['rg discord-dm.mjs tools', 'echo node tools/discord-dm.mjs 澤田武', 'node tools/discord-dm.mjs 澤田武 --dry-run', 'node tools/discord-dm.mjs --help'].map(command => row('assistant', [{ type: 'tool_use', name: 'Bash', input: { command } }])),
  ]) assert.equal(judgeNextAction(text, transcript).code, 'WAREHOUSE-DISPATCH-REQUIRED', transcript);
});

test('短文・質問でも明示した次の作業には恒久策が必要', () => {
  assert.equal(judgeNextAction(`次に kim がすること: ${warehouseAction}`).code, 'PERMANENT-FIX-REQUIRED');
  assert.equal(judgeNextAction('次に kim がすること: 本人同意ボタンを押せますか？').code, 'PERMANENT-FIX-REQUIRED');
});

const promiseText = `確認を続けます。\n次に kim がすること: なし\nこの後の自動進行: 私が毎時進捗を確認して変化時に報告します\nこのセッション: ${SESSION_PHRASES.open}`;
const use = (name, input = {}) => row('assistant', [{ type: 'tool_use', name, input }]);
const cron = use('CronCreate', { cron: '17 * * * *', recurring: true });

test('自動進行の約束だけではblock、CronCreateがあればpass', () => {
  assert.equal(judgeNextAction(promiseText).code, 'AUTOPILOT-NO-SESSION-WAKEUP');
  assert.equal(judgeNextAction(promiseText, cron).decision, 'pass');
  assert.equal(judgeNextAction(promiseText, `${cron}\n${row('user', '続けて')}`).decision, 'pass');
});

test('CronDelete後はblock、再作成後はpass', () => {
  const deleted = `${cron}\n${use('CronDelete', { id: 'job-1' })}`;
  assert.equal(judgeNextAction(promiseText, deleted).code, 'AUTOPILOT-NO-SESSION-WAKEUP');
  assert.equal(judgeNextAction(promiseText, `${deleted}\n${cron}`).decision, 'pass');
});

test('空・なし・なしで始まる値には起床手段は不要', () => {
  for (const value of ['', 'なし', 'なし（完了）', 'なし。作業完了']) {
    assert.equal(judgeNextAction(promiseText.replace('私が毎時進捗を確認して変化時に報告します', value)).decision, 'pass', value);
  }
});

test('現在ターンのAgentと明示的なバックグラウンドシェルはpass', () => {
  for (const transcript of [use('Agent'), use('Agent', { run_in_background: true }), use('Bash', { run_in_background: true }), use('PowerShell', { run_in_background: true })]) {
    assert.equal(judgeNextAction(promiseText, transcript).decision, 'pass');
    assert.equal(judgeNextAction(promiseText, `${transcript}\n${row('user', '新たな依頼')}`).code, 'AUTOPILOT-NO-SESSION-WAKEUP');
    assert.equal(judgeNextAction(promiseText, `${transcript}\n${row('user', [{ type: 'tool_result', content: 'started' }])}`).decision, 'pass');
    assert.equal(judgeNextAction(promiseText, `${transcript}\n${row('user', '<task-notification>終了</task-notification>', { isMeta: true })}`).decision, 'pass');
  }
});

test('前景実行・文章中の言及・sidechain・不正JSONは証拠にならない', () => {
  for (const transcript of [use('Agent', { run_in_background: false }), use('Bash'), use('PowerShell', { run_in_background: false }), row('assistant', 'CronCreate を実行予定'), row('user', [{ type: 'tool_use', name: 'CronCreate' }]), row('assistant', [{ type: 'tool_use', name: 'CronCreate' }], { isSidechain: true }), 'invalid\nnull']) {
    assert.equal(judgeNextAction(promiseText, transcript).code, 'AUTOPILOT-NO-SESSION-WAKEUP');
  }
});

test('subagentsとheadlessでは起床手段の検査をskipする', () => {
  assert.equal(judgeNextAction(promiseText, '', { transcript_path: 'project/subagents/agent.jsonl' }).decision, 'pass');
  const previous = process.env.CLAUDE_HEADLESS;
  try {
    process.env.CLAUDE_HEADLESS = '1';
    assert.equal(judgeNextAction(promiseText).decision, 'pass');
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_HEADLESS;
    else process.env.CLAUDE_HEADLESS = previous;
  }
});
