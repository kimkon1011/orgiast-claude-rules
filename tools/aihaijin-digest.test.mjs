import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { main, parseArgs, jstDate, undigestedMessages, chunkMessages, dedupeCandidates, appendMarkdown, notificationBody, extractionPrompt, parseCandidates, publishCandidates, runCommand, THREAD_ID, CHUNK_LIMIT } from './aihaijin-digest.mjs';
import { main as register } from './register-aihaijin-digest.mjs';

const message = (key = 'a', text = '同じ失敗が続いたら検査を追加する。手戻りを減らしたとの報告。') => ({ key, text, sender: '投稿者A', time: '2026-10-10' });
const candidate = (title = '失敗時の検査追加', source = message()) => ({ title, summary: '同じ失敗が続いた時に検査を追加したとの報告です。自社で手戻りと品質を計測します。', sender: source.sender, date: source.time, evidence: source.text.slice(0, 20), target: 'playbook' });
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); };
function fixture(t, messages = [message()]) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aihaijin-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const stateFile = path.join(home, '.claude', 'aihaijin-digest-state.json');
  const repo = path.join(home, 'repo with spaces'); fs.mkdirSync(repo);
  write(path.join(home, '.claude/messenger-export', `${THREAD_ID}.jsonl`), messages.map(m => JSON.stringify(m)).join('\n'));
  const calls = [], notices = [], publications = [], prompts = [], errors = [];
  const deps = { home, stateFile, now: () => Date.parse('2026-10-25T18:00:00Z'), stderr: text => errors.push(text), stdout: () => {},
    run: async (command, args, options) => {
      calls.push({ command, args, options });
      if (args.includes('--prompt-file')) { prompts.push(fs.readFileSync(args.at(-1), 'utf8')); return JSON.stringify([candidate()]); }
      if (args[0] === 'show') return args[1].includes('LEARNING') ? '# 学び台帳\n## 既存の学び\n' : '# 運用\n## 既存の改善\n';
      return '';
    },
    notify: async body => { notices.push(body); return { delivered: 'dm' }; },
    publish: async input => { publications.push(input); return { candidates: input.candidates, prUrl: 'https://github.com/o/r/pull/1' }; },
  };
  return { home, repo, stateFile, calls, notices, publications, prompts, errors, deps, state: () => JSON.parse(fs.readFileSync(stateFile, 'utf8')), run: (args = []) => main(['--repo', repo, ...args], deps) };
}

test('引数・JST日付・未反映の差分（初回は全件）', () => {
  assert.equal(jstDate('2026-10-25T15:20:00Z'), '2026-10-26');
  assert.equal(parseArgs([], { home: '/home/x', env: { AIHAIJIN_REPO: '/tmp/repo' } }).repo, path.resolve('/tmp/repo'));
  assert.equal(parseArgs([], { home: '/home/x', env: {} }).repo, path.resolve('/home/x/Downloads/orgiast-claude-rules'));
  assert.throws(() => parseArgs(['--repo']));
  assert.throws(() => parseArgs(['--unknown']));
  assert.equal(undigestedMessages([message(), message()]).length, 1);
  assert.deepEqual(undigestedMessages([message()], ['a']), []);
  assert.deepEqual(undigestedMessages([{ ...message('b'), time: '2026-10-20' }, message()]).map(m => m.key), ['a', 'b']);
  assert.deepEqual(undigestedMessages([{ ...message('b'), time: '昨日' }, message()]).map(m => m.key), ['b', 'a']);
});

test('チャンクはJSONとして40,000字以内。長い1投稿も切り捨てず順序を保つ', () => {
  const messages = [message('a', '前半'.repeat(15000)), message('b', '😀"\n'.repeat(20000)), message('c', '')];
  const chunks = chunkMessages(messages);
  assert.ok(chunks.length > 2);
  assert.ok(chunks.every(chunk => JSON.stringify(chunk).length <= CHUNK_LIMIT));
  for (const m of messages) assert.equal(chunks.flat().filter(part => part.key === m.key).map(part => part.text).join(''), m.text);
  assert.deepEqual(chunkMessages([]), []);
  assert.throws(() => chunkMessages([message()], 2));
});

test('題名の正規化と既存項目との重複除去', () => {
  assert.equal(dedupeCandidates([candidate('ＡＩ の改善！'), candidate('aiの改善'), candidate('新規')], ['AIの改善']).length, 1);
  assert.equal(dedupeCandidates([candidate('---')]).length, 0);
});

test('Markdownはtarget別に出典と報告値の注意を付け、候補0件では追記しない', () => {
  assert.equal(appendMarkdown([], '2026-10-25'), '');
  const candidates = Object.keys({ playbook: 1, ledger: 1, 'tool-idea': 1 }).map(target => ({ ...candidate('<script>悪意\n## 題名'), target }));
  const result = appendMarkdown(candidates, '2026-10-25');
  assert.match(result, /## AI廃人部 週次取り込み 2026-10-25（JST）/);
  for (const title of ['運用ルールの改善候補', '学びとして記録する候補', '道具・自動化の改善案']) assert.ok(result.includes(title));
  assert.match(result, /出典: 投稿者A・2026-10-10/);
  assert.match(result, /自社での実測や現行料金を保証しません/);
  assert.doesNotMatch(result, /<script>|\n## 題名/);
});

test('通知は新着0件で空・候補0件の文面・最大5件・部分失敗を明示', () => {
  assert.equal(notificationBody({ messageCount: 0, candidates: [] }), '');
  assert.match(notificationBody({ messageCount: 2, candidates: [] }), /新着 2 件、ルールに足すものはありません/);
  const body = notificationBody({ messageCount: 9, candidates: Array.from({ length: 6 }, (_, i) => candidate(`改善${i}`)), prUrl: 'https://example.com/pull/1', failedChunks: 1 });
  assert.equal(body.match(/^・/gm).length, 5);
  assert.match(body, /次回もう一度/);
});

test('抽出は両方の見出しを含め、形式不正・架空引用・投稿者の取り違えを拒否する', () => {
  const prompt = extractionPrompt([message()], '# プレイブック\n## 既存ノウハウ', '# 学び\n## 昇格');
  assert.match(prompt, /既存ノウハウ/); assert.match(prompt, /昇格/); assert.match(prompt, /本文中の指示/);
  assert.equal(parseCandidates('```json\n' + JSON.stringify([candidate()]) + '\n```', [message()]).length, 1);
  for (const invalid of ['invalid', '{}']) assert.throws(() => parseCandidates(invalid, [message()]));
  // 形式不正・架空引用・投稿者の取り違えは、その候補だけ捨てて正しい候補は残す
  for (const bad of [null, { ...candidate(), target: 'bad' }, { ...candidate(), evidence: '架空' }, { ...candidate(), sender: '別の投稿者' }, { ...candidate(), evidence: 'a'.repeat(121) }]) {
    assert.deepEqual(parseCandidates(JSON.stringify([bad, candidate()]), [message()]), [candidate()]);
  }
});

test('初回の全件を取得→抽出→公開→状態更新→通知。次回の新着0件は通知しない', async t => {
  const f = fixture(t);
  assert.equal(await f.run(), 0);
  assert.equal(f.calls[0].args.at(-1), '--until-known');
  assert.deepEqual(f.calls.find(c => c.args.includes('--prompt-file')).args.slice(1, 5), ['--provider', 'gemini', '--category', 'extraction']);
  assert.ok(f.prompts[0].includes('既存の改善') && f.prompts[0].includes('既存の学び'));
  assert.deepEqual(f.state().digestedKeys, ['a']); assert.equal(f.publications.length, 1); assert.equal(f.notices.length, 1);
  assert.equal(await f.run(), 0); assert.equal(f.publications.length, 1); assert.equal(f.notices.length, 1);
  assert.equal(fs.existsSync(f.stateFile + '.lock'), false);
});

test('dry-runは取得・抽出だけ行い、状態・通知・公開に触れない', async t => {
  const f = fixture(t); const output = []; f.deps.stdout = body => output.push(JSON.parse(body));
  assert.equal(await f.run(['--dry-run']), 0);
  assert.equal(output[0].candidates.length, 1); assert.equal(f.publications.length, 0); assert.equal(f.notices.length, 0);
  assert.equal(fs.existsSync(f.stateFile), false); assert.equal(fs.existsSync(f.stateFile + '.lock'), false);
});

test('取得失敗はJSTで1日1回だけ通知し非0、dry-runでは通知も状態更新もしない', async t => {
  const f = fixture(t); f.deps.run = async () => { throw new Error('login expired'); };
  assert.equal(await f.run(['--dry-run']), 1); assert.equal(f.notices.length, 0); assert.equal(fs.existsSync(f.stateFile), false);
  assert.equal(await f.run(), 1); assert.equal(await f.run(), 1);
  assert.deepEqual(f.state().digestedKeys, []); assert.equal(f.notices.length, 1);
  assert.equal(f.notices[0], 'AI廃人部の週次取り込みが止まっています。こちらで直します。');
  f.deps.now = () => Date.parse('2026-10-26T18:00:00Z');
  assert.equal(await f.run(), 1); assert.equal(f.notices.length, 2);
});

test('通知配送がnoneなら送信済み日時にせず、次回再試行する', async t => {
  const f = fixture(t); let calls = 0;
  f.deps.run = async () => { throw new Error('login expired'); };
  f.deps.notify = async () => { calls += 1; return { delivered: 'none' }; };
  assert.equal(await f.run(), 1); assert.equal(await f.run(), 1);
  assert.equal(calls, 2); assert.equal(fs.existsSync(f.stateFile), false);
});

test('JSON解析は1回再試行し、成功したら反映済みにする', async t => {
  const f = fixture(t), run = f.deps.run; let attempts = 0;
  f.deps.run = async (...args) => args[1].includes('--prompt-file') && ++attempts === 1 ? 'invalid' : run(...args);
  assert.equal(await f.run(), 0); assert.equal(attempts, 2); assert.deepEqual(f.state().digestedKeys, ['a']);
});

test('一部のチャンクが2回失敗しても成功分だけを反映済みにする', async t => {
  const messages = [message('a', 'あ'.repeat(20000)), message('b', 'い'.repeat(20000))];
  const f = fixture(t, messages), run = f.deps.run; let attempts = 0;
  f.deps.run = async (...args) => {
    if (args[1].includes('--prompt-file')) { attempts += 1; return attempts === 1 ? '[]' : 'invalid'; }
    return run(...args);
  };
  assert.equal(await f.run(), 1); assert.equal(attempts, 3); assert.deepEqual(f.state().digestedKeys, ['a']);
  assert.equal(f.publications.length, 0); assert.match(f.notices[0], /次回もう一度/);
});

test('長い1投稿の断片が失敗したら、そのキーも途中の候補も未反映のまま', async t => {
  const m = message('long', 'あ'.repeat(60000)); const f = fixture(t, [m]), run = f.deps.run; let calls = 0;
  f.deps.run = async (...args) => {
    if (args[1].includes('--prompt-file')) return ++calls === 1 ? JSON.stringify([candidate('長い投稿', m)]) : 'invalid';
    return run(...args);
  };
  assert.equal(await f.run(), 1); assert.deepEqual(f.state().digestedKeys, []); assert.equal(f.publications.length, 0);
});

test('公開失敗時は状態を進めず、候補0件なら公開なしでキーを保存する', async t => {
  const f = fixture(t); f.deps.publish = async () => { throw new Error('push failed'); };
  assert.equal(await f.run(), 1); assert.equal(fs.existsSync(f.stateFile), false); assert.equal(f.notices.length, 0);
  const run = f.deps.run; f.deps.run = async (...args) => args[1].includes('--prompt-file') ? '[]' : run(...args);
  assert.equal(await f.run(), 0); assert.deepEqual(f.state().digestedKeys, ['a']); assert.match(f.notices[0], /足すものはありません/);
});

test('完了通知の配送失敗後は、新着0件でも再送して二重公開しない', async t => {
  const f = fixture(t), notify = f.deps.notify; f.deps.notify = async () => ({ delivered: 'none' });
  assert.equal(await f.run(), 1); assert.deepEqual(f.state().digestedKeys, ['a']); assert.ok(f.state().pendingNotification);
  f.deps.notify = notify; assert.equal(await f.run(), 0); assert.equal(f.publications.length, 1); assert.equal(f.notices.length, 1); assert.equal(f.state().pendingNotification, '');
});

test('破損した状態ファイル・並行実行ロックは取得前に止める', async t => {
  const f = fixture(t); write(f.stateFile, '{broken');
  assert.equal(await f.run(), 1); assert.equal(fs.readFileSync(f.stateFile, 'utf8'), '{broken'); assert.equal(f.calls.length, 0);
  fs.rmSync(f.stateFile); write(f.stateFile + '.lock', '');
  fs.utimesSync(f.stateFile + '.lock', new Date(f.deps.now()), new Date(f.deps.now()));
  assert.equal(await f.run(), 1); assert.equal(f.calls.length, 0);
});

test('runCommandは引数配列をシェルへ渡さず、非0を拒否する', async () => {
  const literal = 'space $HOME `echo danger` ; 日本語';
  assert.equal((await runCommand(process.execPath, ['-e', 'console.log(process.argv[1])', literal])).trim(), literal);
  await assert.rejects(runCommand(process.execPath, ['-e', 'process.exit(3)']), /exit 3/);
});

async function publishingFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aihaijin-git-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'clone with spaces'), origin = path.join(root, 'origin.git');
  const git = (args, cwd = root) => runCommand('git', args, { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: path.join(root, 'empty-config'), GIT_CONFIG_NOSYSTEM: '1' } });
  await git(['init', '--bare', origin]); await git(['init', '-b', 'main', repo]);
  await git(['config', 'user.email', 'digest@example.invalid'], repo); await git(['config', 'user.name', 'Digest Test'], repo);
  await git(['config', 'core.hooksPath', path.join(root, 'no-hooks')], repo);
  write(path.join(repo, 'rules/ai-ops-playbook.md'), '# 既存\n');
  await git(['add', '.'], repo); await git(['commit', '-m', 'initial'], repo); await git(['remote', 'add', 'origin', origin], repo); await git(['push', '-u', 'origin', 'main'], repo);
  write(path.join(repo, 'rules/ai-ops-playbook.md'), '# 利用者の未コミット作業\n');
  const calls = [], errors = []; let prs = [], failCreate = false;
  const run = async (command, args, options) => {
    calls.push({ command, args, options });
    if (command === 'git') return git(args, options.cwd);
    if (command === process.execPath) throw new Error('checks pending');
    assert.equal(command, 'gh');
    if (args[1] === 'list') return JSON.stringify(prs);
    if (args[1] === 'create') {
      if (failCreate) throw new Error('connection lost before create');
      const body = fs.readFileSync(args[args.indexOf('--body-file') + 1], 'utf8');
      prs = [{ number: 42, url: 'https://github.com/o/r/pull/42', state: 'OPEN', body }];
      return prs[0].url;
    }
    if (args[1] === 'checks') return '';
    if (args[1] === 'view') return JSON.stringify({ url: prs[0].url, state: 'OPEN', headRefName: 'chore/aihaijin-digest-20261025' });
    throw new Error(`unexpected gh ${args}`);
  };
  return { repo, git, calls, errors, run, failCreate: value => { failCreate = value; }, input: { repo, candidates: [candidate()], date: '2026-10-25', keys: ['a'] } };
}

test('一時worktreeでcommit/push/PR/既存マージ経路を通り、利用者の変更を保持して片付ける', async t => {
  const f = await publishingFixture(t);
  const result = await publishCandidates(f.input, { run: f.run, stderr: line => f.errors.push(line) });
  assert.equal(result.prUrl, 'https://github.com/o/r/pull/42');
  assert.match(f.errors[0], /PRを残します/);
  assert.equal(fs.readFileSync(path.join(f.repo, 'rules/ai-ops-playbook.md'), 'utf8'), '# 利用者の未コミット作業\n');
  assert.equal((await f.git(['branch', '--show-current'], f.repo)).trim(), 'main');
  const remote = await f.git(['show', 'origin/chore/aihaijin-digest-20261025:rules/ai-ops-playbook.md'], f.repo);
  assert.match(remote, /出典: 投稿者A/);
  assert.equal((await f.git(['worktree', 'list', '--porcelain'], f.repo)).match(/^worktree /gm).length, 1);
  assert.doesNotMatch(await f.git(['branch', '--list'], f.repo), /aihaijin-tmp/);
  assert.ok(f.calls.some(c => c.command === process.execPath && c.args[0].endsWith('pr-merge.mjs') && c.args[1] === '42'));
  const before = f.calls.filter(c => c.args[0] === 'push').length;
  assert.equal((await publishCandidates(f.input, { run: f.run })).prUrl, result.prUrl);
  assert.equal(f.calls.filter(c => c.args[0] === 'push').length, before);
});

test('push後のPR作成失敗もworktreeを削除し、再実行で同じブランチを回収する', async t => {
  const f = await publishingFixture(t); f.failCreate(true);
  await assert.rejects(publishCandidates(f.input, { run: f.run }), /connection lost/);
  assert.equal((await f.git(['worktree', 'list', '--porcelain'], f.repo)).match(/^worktree /gm).length, 1);
  f.failCreate(false);
  const result = await publishCandidates(f.input, { run: f.run, stderr: () => {} });
  assert.equal(result.prUrl, 'https://github.com/o/r/pull/42');
  assert.equal(f.calls.filter(c => c.args[0] === 'push').length, 1);
  const remote = await f.git(['show', 'origin/chore/aihaijin-digest-20261025:rules/ai-ops-playbook.md'], f.repo);
  assert.equal(remote.match(/#### 失敗時の検査追加/g).length, 1);
});

test('登録はプロファイルのあるWindowsだけ。convergeのmanifestから到達できる', t => {
  const f = fixture(t); const calls = [];
  const deps = { home: f.home, platform: 'win32', resolveRepo: () => f.repo, exec: (...args) => calls.push(args) };
  register(deps); assert.equal(calls.length, 0);
  fs.mkdirSync(path.join(f.home, '.claude/messenger-profile'));
  register({ ...deps, platform: 'linux' }); assert.equal(calls.length, 0);
  register(deps); assert.equal(calls.length, 1); assert.equal(calls[0][0], 'powershell.exe');
  assert.ok(calls[0][1].at(-1).endsWith('register-aihaijin-digest.ps1'));
  const manifest = JSON.parse(fs.readFileSync(new URL('./setup-manifest.json', import.meta.url), 'utf8'));
  const item = manifest.items.find(item => item.id === 'task:aihaijin-digest');
  assert.deepEqual(item.repair, ['register-aihaijin-digest.mjs']);
  assert.equal(item.spec.ifPresent, '.claude/messenger-profile');
  const mf = path.join(f.home, 'manifest.json'); write(mf, JSON.stringify({ version: 1, items: [item] }));
  fs.rmdirSync(path.join(f.home, '.claude/messenger-profile'));
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./setup.mjs', import.meta.url)), '--verify', '--json', '--home', f.home, '--manifest', mf], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).items[0].status, 'NOTICE');
});

test('定期登録はBOM・日曜03:20・10分遅延・2時間上限・非表示bootstrap・解除対応', () => {
  const bytes = fs.readFileSync(new URL('./register-aihaijin-digest.ps1', import.meta.url));
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  const source = bytes.toString('utf8');
  for (const pattern of [/\[switch\]\$Unregister/, /Unregister-ScheduledTask/, /OrgiastAihaijinDigest/, /-Weekly -WeeksInterval 1 -DaysOfWeek Sunday -At '03:20'/, /-RandomDelay \(New-TimeSpan -Minutes 10\)/, /-ExecutionTimeLimit \(New-TimeSpan -Hours 2\)/, /-MultipleInstances IgnoreNew/, /nightly-bootstrap.ps1/, /New-HiddenScheduledTaskAction/, /messenger-profile/]) assert.match(source, pattern);
});
