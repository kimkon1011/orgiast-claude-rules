import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
// fleet-fix-now.ps1 は各PCで kim が貼って動かす配布物。必須部分が消えると全PCで静かに壊れる
// （2026-10-12: PR #707 の置換で repo 更新部が消え、作業用011 が古い名簿のまま誤判定を続けた）。
const src = fs.readFileSync(new URL('./fleet-fix-now.ps1', import.meta.url), 'utf8');
const required = {
  'repo を clone/最新化する': /git clone --quiet|clone --quiet/,
  'origin/main に揃える': /reset -q --hard origin\/main|reset --hard origin\/main/,
  'git が無ければ導入する': /winget install --id Git\.Git/,
  '承諾を書く': /fleet-agent-optin\.json/,
  'setup --converge を実行する': /setup\.mjs'\) --converge/,
  '受信タスクを再登録する': /register-fleet-mail\.ps1/,
  'Codex の担当を名簿と照合する': /codexAccount/,
  'Codex をシークレットウィンドウでログインする': /--incognito/,
  'プランが free なら取り直す': /plan -eq 'free'/,
  '結果を kim-PC へ送る': /--send --to \$ReportTo/,
  '実行版を報告する': /version=/,
};
for (const [name, re] of Object.entries(required)) test(`fleet-fix-now に必須部分がある: ${name}`, () => assert.match(src, re));
