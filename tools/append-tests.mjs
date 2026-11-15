import { readFileSync, writeFileSync } from 'fs';

const orig = readFileSync('tools/next-action-gate.test.mjs', 'utf8');
const lines = orig.split('\n');

// Find last });
let lastEnd = 0;
for (let i = lines.length - 1; i >= 0; i--) {
  if (lines[i].trim() === '});') {
    lastEnd = i;
    break;
  }
}

const keep = lines.slice(0, lastEnd + 1).join('\n');

const newTests = `

test('ACTION_LABEL_PATTERN expansion: method/plan/pattern/means/route/option detected as labels', () => {
  for (const action of ['方法C', 'プランB', 'パターンA', '手段2', 'ルートX', 'オプション3']) {
    assert.equal(judgeNextAction(inlineReport(action, inlineContent)).code, 'NEXT-ACTION-LABEL-ONLY', action);
  }
  for (const action of ['方法C（Google パスワードマネージャーで管理）', 'プランB（全員参加で毎週実施する振り返り）']) {
    withOpenCheck(input => assert.equal(judgeNextAction(inlineReport(action, inlineContent), '', input).decision, 'pass', action));
  }
});

test('NEXT-ACTION-LABEL-UNDEFINED: body label without explanation blocks', () => {
  const text = \`\${body}\\n恒久策: 一回限り: 判断が必要\\n方法C でよいか\\n次に kim がすること: なし\\nこの後の自動進行: なし（完了）\\nこのセッション: \${SESSION_PHRASES.delete}\`;
  const result = judgeNextAction(text);
  assert.equal(result.decision, 'block');
  assert.equal(result.code, 'NEXT-ACTION-LABEL-UNDEFINED');
  const overridden = \`[NEXT-ACTION-LABEL-OK: 本人が指定したラベルのため]\\n\${text}\`;
  withOpenCheck(input => assert.equal(judgeNextAction(overridden, '', input).decision, 'pass'));
});

test('NEXT-ACTION-LABEL-UNDEFINED: C requires A and B in body', () => {
  const cOnly = \`\${body}\\n恒久策: 一回限り: 判断が必要\\n方法C（Google パスワードマネージャーで管理）で運用する\\n次に kim がすること: なし\\nこの後の自動進行: なし（完了）\\nこのセッション: \${SESSION_PHRASES.delete}\`;
  assert.equal(judgeNextAction(cOnly).code, 'NEXT-ACTION-LABEL-UNDEFINED');
  const allThree = \`\${body}\\n恒久策: 一回限り: 判断が必要\\n方法A（月1回の棚卸し）方法B（週1回の棚卸し）方法C（Google パスワードマネージャーで管理）\\n次に kim がすること: なし\\nこの後の自動進行: なし（完了）\\nこのセッション: \${SESSION_PHRASES.delete}\`;
  withOpenCheck(input => assert.equal(judgeNextAction(allThree, '', input).decision, 'pass'));
});

test('stop_hook_active checks LABEL-ONLY with 3-then-pass', () => {
  const text = \`\${body}\\n【kim 確認用の全文】\\nA案: 採用する。B案: 提案内容を保留する。\\n次に kim がすること: B案\\nこの後の自動進行: なし\\nこのセッション: まだ閉じない（作業中・2099-12-31 23:59 まで待つ）\`;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-label-'));
  const prevHome = process.env.ORGIAST_HOME;
  process.env.ORGIAST_HOME = home;
  try {
    fs.mkdirSync(path.join(home, '.claude'));
    const input = { session_id: 's_sh_label', stop_hook_active: true };
    const r1 = judgeNextAction(text, '', input);
    assert.equal(r1.decision, 'block');
    assert.equal(r1.code, 'NEXT-ACTION-LABEL-ONLY');
    const r2 = judgeNextAction(text, '', input);
    assert.equal(r2.decision, 'block');
    const r3 = judgeNextAction(text, '', input);
    assert.equal(r3.decision, 'pass');
  } finally {
    if (prevHome === undefined) delete process.env.ORGIAST_HOME;
    else process.env.ORGIAST_HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('stop_hook_active checks body label violations', () => {
  const text = \`\${body}\\n方法C でよいか\\n次に kim がすること: なし\\nこの後の自動進行: なし（完了）\\nこのセッション: まだ閉じない（作業中・2099-12-31 23:59 まで待つ）\`;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-body-'));
  const prevHome = process.env.ORGIAST_HOME;
  process.env.ORGIAST_HOME = home;
  try {
    fs.mkdirSync(path.join(home, '.claude'));
    const input = { session_id: 's_sh_body', stop_hook_active: true };
    const r1 = judgeNextAction(text, '', input);
    assert.equal(r1.decision, 'block');
    assert.equal(r1.code, 'NEXT-ACTION-LABEL-UNDEFINED');
  } finally {
    if (prevHome === undefined) delete process.env.ORGIAST_HOME;
    else process.env.ORGIAST_HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
`;

writeFileSync('tools/next-action-gate.test.mjs', keep + newTests);
console.log('OK');