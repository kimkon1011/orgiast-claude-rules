import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { judgeDeliverableDriveLink as judge, registerDeliverableCheck } from './deliverable-drive-link-gate.mjs';
import { run } from './stop-gate-runner.mjs';
import { registerStopViolation } from './lib/stop-recheck.mjs';
import { classifyHandoff } from './past-log-search-gate.mjs';

const incident = '出勤の申し出の書面を作り、端末に送りました。\n【最終まとめ】\n① 報告\n完了\n② 確認事項\nなし\n**③ やること**\n- 今日中に、裁判所への2枚を FAX 048-839-8614 へ送ってください。\n- 明日 11/5 に、出勤の申し出を FAX 048-643-5793 へ送ってください。';
const links = '\nhttps://drive.google.com/file/d/a/view?authuser=x@example.com\nhttps://docs.google.com/document/d/b/edit?authuser=x@example.com';
const toolUses = [{ name: 'SendUserFile', input: { files: ['C:/Users/x/a.pdf', 'C:/Users/x/b.pdf'] } }];

test('実害文と③にURLを追加した修正版', () => {
  assert.equal(judge({ text: incident }).decision, 'block');
  const linkedIncident = incident
    .replace('048-839-8614 へ送ってください。', '048-839-8614 へ送ってください。 https://drive.google.com/file/d/a/view?authuser=x@example.com')
    .replace('048-643-5793 へ送ってください。', '048-643-5793 へ送ってください。 https://docs.google.com/document/d/b/edit?authuser=x@example.com');
  assert.equal(judge({ text: linkedIncident }).decision, 'pass');
  assert.equal(judge({ text: links + incident }).decision, 'block');
});
test('SendUserFileの異なる2ファイルには2本必要', () => {
  assert.equal(judge({ text: links.split('\n')[1], toolUses }).decision, 'block');
  assert.equal(judge({ text: links, toolUses }).decision, 'pass');
  assert.equal(judge({ text: 'C:/Users/x/a.pdf' + links, toolUses }).files.length, 2);
});
test('コードブロックと引用内の絶対パスも対象', () => {
  for (const file of ['C:\\Users\\x\\Documents\\a.pdf', 'c:/Users/x/a.xlsx', '/c/Users/x/a.png', '/mnt/c/Users/x/a.html']) {
    assert.equal(judge({ text: '```\n' + file + '\n```' }).decision, 'block');
    assert.equal(judge({ text: '「' + file + '」' }).decision, 'block');
  }
});
test('通常報告・引用・アップロード失敗証拠', () => {
  assert.equal(judge({ text: 'テストは全件成功しました。' }).decision, 'pass');
  for (const text of ['「端末に送りました」', '『添付しました』', '“チャットに送りました”', '【最終まとめ】\n③ 「PDFを提出してください」']) assert.equal(judge({ text }).decision, 'pass');
  assert.equal(judge({ text: incident + '\n[DRIVE-UPLOAD-FAILED: rclone: 403 insufficientPermissions for folder]' }).decision, 'pass');
  assert.equal(judge({ text: incident + '\n[DRIVE-UPLOAD-FAILED: failed]' }).decision, 'block');
});
test('③だけでも発火し、次の見出しのURLは数えない', () => {
  const text = '【最終まとめ】\n③ やること\nPDFを印刷してください。';
  assert.equal(judge({ text }).decision, 'block');
  assert.equal(judge({ text: text + '\n① 報告' + links }).decision, 'block');
  assert.equal(judge({ text: text + links }).decision, 'block');
  assert.equal(judge({ text: text.replace('ください。', 'ください。 https://drive.google.com/file/d/a/view') }).decision, 'pass');
});

test('②で確認してもらう成果物にも同じ単位のDrive URLが必要', () => {
  const text = `【最終まとめ】
**① 報告**
31件を移動しました。
**② kim の確認事項**
- チラシ初稿と告知画像3枚を、このまま 11/5 17:00 の打ち合わせで森田社長に見せてよいですか？
**③ kim がやること**
- 上の2つの確認事項に返信する。`;
  assert.equal(judge({ text }).decision, 'block');
  assert.equal(judge({ text: text.replace('見せてよいですか？', '見せてよいですか？ https://drive.google.com/file/d/example/view?authuser=kim@orgiast.jp kim@orgiast.jp で開いてください') }).decision, 'block');
  assert.equal(judge({ text: text.replace('見せてよいですか？', '見せてよいですか？ https://drive.google.com/file/d/flyer/view?authuser=kim@orgiast.jp https://drive.google.com/file/d/images/view?authuser=kim@orgiast.jp kim@orgiast.jp で開いてください') }).decision, 'pass');
});

test('対象外の報告と成果物を参照しない返信は通す', () => {
  assert.equal(judge({ text: '【最終まとめ】\n① 報告\n- チラシを保存しました。\n② 確認事項\nなし\n③ やること\nなし' }).decision, 'pass');
  assert.equal(judge({ text: '【最終まとめ】\n② 確認事項\n- 日程は明日でよいですか？\n③ やること\n- 上の2つの確認事項に返信する。' }).decision, 'pass');
});

test('確認用見出しと③後のClaude側予定は成果物単位にしない', () => {
  const text = `【最終まとめ】
① 報告
完了
② kim の確認事項
【kim 確認用の全文】
- チラシを見てください。 https://drive.google.com/file/d/flyer/view?authuser=kim@example.com
③ kim がやること
- チラシを確認して返信してください。 https://drive.google.com/file/d/flyer/view?authuser=kim@example.com

- **次に kim がすること:** チラシを見て返信する https://drive.google.com/file/d/flyer/view?authuser=kim@example.com
- **この後の自動進行:** 返信を受けたら、チラシを直すか「このままでOK」を記録
- **このセッション:** 作業結果を記録する`;
  assert.equal(judge({ text }).decision, 'pass');
  assert.equal(judge({ text: text.replace(/- \*\*次に kim がすること:[\s\S]*/, '障害時アナログ運営: チラシを確認して手動修正する') }).decision, 'pass');
  assert.equal(judge({ text: '【最終まとめ】\n② 確認事項\n【確認用画像】\n③ やること\nなし' }).decision, 'pass');
  assert.equal(judge({ text: '【最終まとめ】\n② 確認事項\n確認用です。確認してください。\n③ やること\nなし' }).decision, 'pass');
  assert.equal(judge({ text: '【最終まとめ】\n② 確認事項\n確認用画像を確認してください。\n③ やること\nなし' }).decision, 'block');
});

test('③後でも次にkimがする成果物確認はURL必須', () => {
  const text = `【最終まとめ】
① 報告
完了
② 確認事項
なし
③ kim がやること
なし

- **次に kim がすること:** チラシを見て返信する
- **この後の自動進行:** 返信を受けたらチラシを直す`;
  assert.equal(judge({ text }).decision, 'block');
});

test('runner: reply-only・既存cap後でも同じターン2回までblockし、3回目は専用cap', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'deliverable-test-'));
  const previous = process.env.ORGIAST_HOME;
  process.env.ORGIAST_HOME = home;
  t.after(() => { if (previous === undefined) delete process.env.ORGIAST_HOME; else process.env.ORGIAST_HOME = previous; fs.rmSync(home, { recursive: true, force: true }); });
  const text = '端末に送りました。\n次に kim がすること: 返信してください';
  assert.equal(classifyHandoff(text), 'reply-only');
  const input = { session_id: 'deliverable', assistant_text: text };
  for (let i = 0; i < 6; i++) registerStopViolation({ input, assistantText: text, blockedBy: ['other'], home });
  for (let i = 0; i < 2; i++) {
    const result = await run(input, { raw: '', assistantText: text });
    assert.equal(result.decision, 'block');
    assert.deepEqual(result.record.blockedBy, ['deliverable-drive-link-gate']);
  }
  const capped = await run(input, { raw: '', assistantText: text });
  assert.equal(capped.decision, undefined);
  assert.equal(capped.record.verdict, 'pass_cap');
  assert.match(capped.systemMessage, /3回書き直しても Drive URL がありません/);
  const ledger = fs.readFileSync(path.join(home, '.claude/stop-gate-runner-ledger.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(ledger.at(-1).verdict, 'deliverable-cap');
  const raw = [
    { type: 'user', message: { role: 'user', content: 'ファイルを作成' } },
    { type: 'assistant', message: { role: 'assistant', content: toolUses.map(tool => ({ type: 'tool_use', ...tool })) } },
  ].map(JSON.stringify).join('\n');
  const toolResult = await run({ session_id: 'tools', assistant_text: links.split('\n')[1] }, { raw });
  assert.equal(toolResult.decision, 'block');
});

test('専用カウントは合格でリセットし、別セッションへ持ち越さない', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'deliverable-streak-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const check = (sessionId, blocked) => registerDeliverableCheck({ home, sessionId, blocked });
  assert.equal(check('a', true).count, 1);
  assert.equal(check('a', true).count, 2);
  assert.equal(check('b', true).count, 1);
  assert.equal(check('a', false).count, 0);
  assert.equal(check('a', true).count, 1);
});

// ===== 承認コンテキストのテスト（2026-11-15 GridBeyond実害） =====

test('承認コンテキスト: 梅竹松プラン承認依頼にURLなし→block', () => {
  const text = '梅・竹・松のパース、どれを載せるか決めてください。';
  assert.equal(judge({ text }).decision, 'block');
});

test('承認コンテキスト: 梅竹松プラン承認依頼に成果物ごとのURLと開き方があればpass', () => {
  const text = `梅のパース https://drive.google.com/file/d/ume/view?authuser=kim@orgiast.jp kim@orgiast.jp で開いてください
竹のパース https://drive.google.com/file/d/take/view?authuser=kim@orgiast.jp kim@orgiast.jp で開いてください
松のパース https://drive.google.com/file/d/matsu/view?authuser=kim@orgiast.jp kim@orgiast.jp で開いてください
どれを載せるか決めてください。`;
  assert.equal(judge({ text }).decision, 'pass');
});

test('承認コンテキスト: 複数成果物にURLが1本だけならblock', () => {
  const text = `梅のパース、竹のパース、松のパース、どれがよいですか？
https://drive.google.com/file/d/ume/view?authuser=kim@orgiast.jp kim@orgiast.jp で開いてください`;
  assert.equal(judge({ text }).decision, 'block');
});

test('承認コンテキスト: 3行以上離れたURLは不十分→block', () => {
  const text = `梅のパース、竹のパース、松のパース、どれがよいですか？


https://drive.google.com/file/d/ume/view?authuser=kim@orgiast.jp`;
  assert.equal(judge({ text }).decision, 'block');
});

test('承認コンテキスト: 引用内の承認文は対象外', () => {
  assert.equal(judge({ text: '「梅竹松のどれがよいですか？」' }).decision, 'pass');
  assert.equal(judge({ text: '『梅竹松のどれがよいですか？』' }).decision, 'pass');
});

test('承認コンテキスト: URLなし（理由: …）の明記でpass', () => {
  const text = '梅のパース、竹のパース、松のパース、どれを載せるか決めてください。URLなし（理由: 未生成のため）';
  assert.equal(judge({ text }).decision, 'pass');
});

test('承認コンテキスト: 成果物語が無い承認質問は対象外', () => {
  assert.equal(judge({ text: 'この内容でよいですか？' }).decision, 'pass');
  assert.equal(judge({ text: 'どちらがよいですか？' }).decision, 'pass');
  assert.equal(judge({ text: '承認してください' }).decision, 'pass');
  assert.equal(judge({ text: 'A案とB案、どちらがよいですか？' }).decision, 'pass');
});

test('承認コンテキスト: 提案書の確認依頼にURLなし→block', () => {
  assert.equal(judge({ text: '提案書を確認してください。' }).decision, 'block');
});

test('承認コンテキスト: 提案書の確認依頼にURLあり→pass', () => {
  assert.equal(judge({ text: '提案書を確認してください。 https://docs.google.com/document/d/proposal/edit?authuser=kim@orgiast.jp kim@orgiast.jp で開いてください' }).decision, 'pass');
});

test('承認コンテキスト: authuser欠落または開くアカウント案内欠落→block', () => {
  assert.equal(judge({ text: '提案書を確認してください。 https://docs.google.com/document/d/proposal/edit kim@orgiast.jp で開いてください' }).decision, 'block');
  assert.equal(judge({ text: '提案書を確認してください。 https://docs.google.com/document/d/proposal/edit?authuser=kim@orgiast.jp' }).decision, 'block');
  assert.equal(judge({ text: '提案書を確認してください。 https://docs.google.com/document/d/proposal/edit?authuser=other@orgiast.jp kim@orgiast.jp で開いてください' }).decision, 'block');
});

test('承認コンテキスト: メール本文の草案承認依頼→block', () => {
  assert.equal(judge({ text: 'メール本文の草案を確認してください。' }).decision, 'block');
});

test('承認コンテキスト: 見積の確認依頼にURLなし→block', () => {
  assert.equal(judge({ text: '見積もりを確認してください。' }).decision, 'block');
});

test('承認コンテキスト: A案・B案のパース選択依頼にURLなし→block', () => {
  assert.equal(judge({ text: 'A案とB案のパース、どちらがよいですか？' }).decision, 'block');
});

test('承認コンテキスト: A案・B案のパース選択依頼にURLあり→pass', () => {
  assert.equal(judge({ text: 'A案のパース https://drive.google.com/file/d/a/view?authuser=kim@orgiast.jp kim@orgiast.jp で開いてください\nB案のパース https://drive.google.com/file/d/b/view?authuser=kim@orgiast.jp kim@orgiast.jp で開いてください\nどちらがよいですか？' }).decision, 'pass');
});

test('承認コンテキスト: コードブロック内は対象外', () => {
  const text = '```\n梅竹松のどれがよいですか？\n```';
  assert.equal(judge({ text }).decision, 'pass');
});

test('承認コンテキスト: 既存の通すケースを壊さない', () => {
  assert.equal(judge({ text: '【最終まとめ】\n① 報告\n- チラシを保存しました。\n② 確認事項\nなし\n③ やること\nなし' }).decision, 'pass');
  assert.equal(judge({ text: 'テストは全件成功しました。' }).decision, 'pass');
  assert.equal(judge({ text: '【最終まとめ】\n② 確認事項\n- 日程は明日でよいですか？\n③ やること\n- 上の2つの確認事項に返信する。' }).decision, 'pass');
});

const approvalUrl = (id, account = 'kim@orgiast.jp') => `https://drive.google.com/file/d/${id}/view?authuser=${account}`;
const openAccount = 'kim@orgiast.jp で開いてください';

test('GridBeyond: 草案Docだけでは梅竹松のパースと提案書PDFを承認できない', () => {
  const text = `梅・竹・松のどれを載せるか／金額／メール本文を承認してください。
提案書PDF
メール本文の草案Doc ${approvalUrl('draft')} ${openAccount}`;
  assert.equal(judge({ text }).decision, 'block');
  const fixed = `次の成果物と金額を承認してください。
梅パース画像 ${approvalUrl('ume')} ${openAccount}
竹パース画像 ${approvalUrl('take')} ${openAccount}
松パース画像 ${approvalUrl('matsu')} ${openAccount}
提案書PDF ${approvalUrl('proposal')} ${openAccount}
メール本文の草案Doc ${approvalUrl('draft')} ${openAccount}`;
  assert.equal(judge({ text: fixed }).decision, 'pass');
  assert.match(judge({ text }).reason, /成果物ごとの実物URL.*同じ行/);
  assert.match(judge({ text }).reason, /見つからなければ Drive へアップし直す/);
});

test('全承認語・行末の成果物語・全角案名を検出する', () => {
  for (const action of ['承認', 'よいですか', 'いいですか', '送ってよい', 'どれ', '選んで', '確認してください', 'OK', '判断']) {
    for (const item of ['梅竹松パース', 'A案B案のパース', '案12の画像', '案ＮのPDF', 'Ａ案のデザイン', 'パース', '提案書', '見積', 'スライド', 'メール本文', '草案', 'PDF', '画像', 'Doc']) {
      assert.equal(judge({ text: `${action}\n${item}` }).decision, 'block', `${action}: ${item}`);
    }
  }
});

test('同じ行と直後1〜2行のURLを認め、3行後・引用で距離が縮むURLは拒否', () => {
  for (const gap of ['', '\n', '\n\n']) {
    assert.equal(judge({ text: `PDFを承認してください ${gap}${approvalUrl('pdf')} ${openAccount}` }).decision, 'pass');
  }
  for (const gap of ['\n\n\n', '\n『引用\n引用\n引用』\n']) {
    assert.equal(judge({ text: `PDFを承認してください ${gap}${approvalUrl('pdf')} ${openAccount}` }).decision, 'block');
  }
  assert.equal(judge({ text: `${openAccount}\nPDFを承認してください ${approvalUrl('pdf')}` }).decision, 'pass');
});

test('次の成果物のURLや例外理由は流用できない', () => {
  for (const following of [`草案 ${approvalUrl('draft')} ${openAccount}`, '草案 URLなし（理由: 未作成）']) {
    assert.equal(judge({ text: `承認してください\n提案書PDF\n${following}` }).decision, 'block');
  }
  assert.equal(judge({ text: `承認してください\n提案書PDF\n## 別件\n${approvalUrl('draft')} ${openAccount}` }).decision, 'block');
});

test('異なる種類の成果物にも別URLが必要で、複合名は1件として扱う', () => {
  for (const items of ['パース画像と提案書PDF', '提案書／見積', 'メール本文、スライド', '案10・案11のパース']) {
    assert.equal(judge({ text: `承認してください。${items} ${approvalUrl('a')} ${openAccount}` }).decision, 'block');
    assert.equal(judge({ text: `承認してください。${items} ${approvalUrl('a')} ${approvalUrl('b')} ${openAccount}` }).decision, 'pass');
  }
  for (const item of ['提案書PDF', 'メール本文の草案Doc', '梅パース画像']) {
    assert.equal(judge({ text: `承認してください。${item} ${approvalUrl('a')} ${openAccount}` }).decision, 'pass');
  }
  assert.equal(judge({ text: `A案とB案のパースを選んで ${approvalUrl('a')} ${approvalUrl('a')}&usp=sharing ${openAccount}` }).decision, 'block');
});

test('引用ブロック・コード・日本語引用を承認検査から除外する', () => {
  for (const text of ['> PDFを承認してください', '~~~text\nPDFを承認してください\n~~~', '```js\nconst x = `PDFを承認してください`;\n```', '`PDFを承認してください`', '『PDFを承認してください』']) {
    assert.equal(judge({ text }).decision, 'pass', text);
  }
  for (const link of [`> ${approvalUrl('a')} ${openAccount}`, `\`${approvalUrl('a')} ${openAccount}\``]) {
    assert.equal(judge({ text: `PDFを承認してください\n${link}` }).decision, 'block');
  }
  const summary = `【最終まとめ】\n③ 確認事項\n提案書を承認してください ${approvalUrl('a')} ${openAccount}\n\n【kim 確認用の全文】\n> 提案書を添付してお送りします。確認してください。`;
  assert.equal(judge({ text: summary }).decision, 'pass');
});

test('URLなし例外は理由必須、アップロード失敗だけでは承認検査を免除しない', () => {
  assert.equal(judge({ text: '承認してください\nPDF URLなし（理由: 未生成の比較案）' }).decision, 'pass');
  assert.equal(judge({ text: '承認してください\nPDF URLなし（理由: ）' }).decision, 'block');
  assert.equal(judge({ text: 'PDFを承認してください\n[DRIVE-UPLOAD-FAILED: rclone: 403 insufficientPermissions for folder]' }).decision, 'block');
});

test('URLのauthuserはメール、開くアカウント案内と一致、URL内の文字列は成果物にしない', () => {
  for (const account of ['0', 'other@orgiast.jp', 'kim@orgiast']) {
    assert.equal(judge({ text: `PDFを承認してください ${approvalUrl('a', account)} ${openAccount}` }).decision, 'block');
  }
  assert.equal(judge({ text: `PDFを承認してください\n${approvalUrl('Doc-PDF')} ${openAccount}` }).decision, 'pass');
  assert.equal(judge({ text: `PDFを承認してください ${approvalUrl('a', 'kim%40orgiast.jp')}#preview ${openAccount}` }).decision, 'pass');
  assert.equal(judge({ text: `PDFを承認してください ${approvalUrl('a')} で開いてください` }).decision, 'block');
  assert.equal(judge({ text: `PDFを承認してください ${approvalUrl('a')} xkim@orgiast.jp で開いてください` }).decision, 'block');
  assert.equal(judge({ text: `A案とB案のパースを選んで https://drive.google.com/open?id=a&authuser=kim@orgiast.jp https://drive.google.com/open?id=b&authuser=kim@orgiast.jp ${openAccount}` }).decision, 'pass');
});

test('runner: 最終まとめなしの承認依頼も既存Stop登録からblockする', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-stop-'));
  const previous = process.env.ORGIAST_HOME;
  process.env.ORGIAST_HOME = home;
  t.after(() => { if (previous === undefined) delete process.env.ORGIAST_HOME; else process.env.ORGIAST_HOME = previous; fs.rmSync(home, { recursive: true, force: true }); });
  const text = '梅竹松のパースと提案書PDFを承認してください。';
  const result = await run({ session_id: 'approval', assistant_text: text }, { raw: '', assistantText: text });
  assert.equal(result.decision, 'block');
  assert.deepEqual(result.record.blockedBy, ['deliverable-drive-link-gate']);
});

test('承認見出しだけで発火し、Driveトップでは成果物を開けない', () => {
  const text = '【kim 確認用の全文】\n- 提案書PDF';
  assert.equal(judge({ text }).decision, 'block');
  assert.equal(judge({ text: `${text} https://drive.google.com/?authuser=kim@orgiast.jp ${openAccount}` }).decision, 'block');
  assert.equal(judge({ text: `${text} ${approvalUrl('proposal')} ${openAccount}` }).decision, 'pass');
});
