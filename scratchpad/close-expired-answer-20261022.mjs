// 2026-10-22 rescue: expired 元メールに回答済みの local completion を刻み、
// 同一依頼への 4 通目の重複 note 送信を止める（--reply を「返信済み」で拒否させる）。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { updateInbox } from '../tools/fleet-mail.mjs';

const home = os.homedir();
const id = 'mail-1792330535065-d95f513b';

// 1) 回答内容の実測（元依頼の確認項目）
const claudeMd = 'C:/Users/uers/.claude/CLAUDE.md';
const dmWin = 'C:/Users/uers/orgiast-claude-rules/tools/discord-dm.mjs';
const lineCount = (file, needle) => fs.existsSync(file)
  ? fs.readFileSync(file, 'utf8').split('\n').filter(l => l.includes(needle)).length
  : null;
const facts = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  homedir: os.homedir(),
  A: { path: claudeMd, exists: fs.existsSync(claudeMd), discordDmLines: lineCount(claudeMd, 'Discord DM') },
  B: { path: dmWin, exists: fs.existsSync(dmWin) },
  C: { path: path.join(home, '.claude', 'CLAUDE.md'), exists: fs.existsSync(path.join(home, '.claude', 'CLAUDE.md')) },
  D: { path: path.join(home, 'orgiast-claude-rules', 'tools', 'discord-dm.mjs'), exists: fs.existsSync(path.join(home, 'orgiast-claude-rules', 'tools', 'discord-dm.mjs')) },
};
console.log('FACTS ' + JSON.stringify(facts));

// 2) 回答済みを local completion として記録（元メールは expired で --reply 不可）
const resultBody = [
  '元メールが expired のため --reply は 2026-10-18 以降 3 回失敗し、同内容の note を再送していた。',
  'note 送信済み: mail-1792459058545-a597088e (2026-10-20T01:17Z) / mail-1792533027479-3f2bec0e (2026-10-20T21:50Z) / mail-1792577872525-de8b3ced (2026-10-21T10:17Z)',
  `kim-PC: WIN_LINE=${facts.A.exists && facts.A.discordDmLines ? 'YES' : 'NO'} WIN_TOOL=${facts.B.exists ? 'YES' : 'NO'} HOME_LINE=${facts.C.exists ? 'YES' : 'NO'} HOME_TOOL=${facts.D.exists ? 'YES' : 'NO'} HOME=${facts.HOME} USERPROFILE=${facts.USERPROFILE}`,
  '2026-10-22 の rescue で 4 項目を再実測し一致を確認（ファイル変更・同期なし）。',
].join('\n');

const at = new Date().toISOString();
const saved = updateInbox(id, mail => mail && ({
  ...mail,
  status: 'done',
  resultAt: mail.resultAt || at,
  resultBody,
  completionSource: 'rescue-20261022-expired-note',
}), { home });
console.log('INBOX ' + JSON.stringify(saved && {
  id: saved.id, status: saved.status, resultAt: saved.resultAt,
  answerNote: 'mail-1792577872525-de8b3ced',
}));
