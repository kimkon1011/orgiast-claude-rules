import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { judge, formatReason } from './url-account-gate.mjs';

const studio = 'https://aistudio.google.com/prompts/new_chat';
const account = '（**kim@orgiast.jp** で開く）';
const gate = fileURLToPath(new URL('./url-account-gate.mjs', import.meta.url));

test('AI Studio の手渡しはアカウントが必須', () => {
  assert.deepEqual(judge(`こちらを開いてください: ${studio}`), { triggered: true, missing: [studio], urls: [studio] });
  assert.deepEqual(judge(`こちらを開いてください: ${studio}${account}`), { triggered: true, missing: [], urls: [studio] });
});

test('全体宣言は離れた複数 URL にも適用', () => {
  for (const phrase of ['すべて', '全部', 'いずれも', 'どの URL も', '以下の URL は']) {
    assert.deepEqual(judge(`${phrase} **seisaku-team@orgiast.jp** で開く\n\n\n\nhttps://github.com/org/a\nhttps://github.com/org/b`).missing, []);
  }
  assert.deepEqual(judge('以下の URL はすべて **seisaku-team@orgiast.jp** で開く\nhttps://github.com/org/a\nhttps://github.com/org/b').missing, []);
  assert.deepEqual(judge(`全部 kim@orgiast.jp の所有です\n\n\n${studio}`).missing, [studio]);
});

test('公開出典・ローカル URL は対象外', () => {
  for (const url of ['https://example.com/blog/post', 'https://raw.githubusercontent.com/org/repo/main/settings/file', 'http://localhost:3000/admin', 'http://127.0.0.1:3000/dashboard', 'https://dev.local/login', 'https://github.com.example.org/blog', 'https://play.google.com/store/apps', 'https://www.agoda.com/hotel']) {
    assert.equal(judge(url).triggered, false, url);
  }
});

for (const host of ['aistudio.google.com', 'ai.studio', 'console.cloud.google.com', 'admin.google.com', 'mail.google.com', 'github.com', 'vercel.com', 'supabase.com', 'npmjs.com', 'x.com', 'twitter.com', 'discord.com', 'dash.cloudflare.com', 'platform.openai.com', 'chatgpt.com', 'console.anthropic.com', 'claude.ai', 'notion.so', 'slack.com', 'figma.com', 'canva.com', 'beds24.com', 'admin.booking.com', 'airbnb.com', 'airbnb.jp', 'ycs.agoda.com', 'console.firebase.google.com', 'developer.apple.com', 'appstoreconnect.apple.com']) {
  test(`対象ドメインとサブドメイン: ${host}`, () => {
    for (const url of [`https://${host}/`, `https://sub.${host}/`]) assert.deepEqual(judge(url).missing, [url]);
  });
}

test('管理パス・サービス限定パス', () => {
  for (const suffix of ['/admin', '/console', '/dashboard', '/settings', '/login', '/signin', '/account']) {
    const url = `https://example.org/team${suffix}`;
    assert.deepEqual(judge(url).missing, [url]);
  }
  for (const url of ['https://play.google.com/console/u/0', 'https://agoda.com/ycs/']) assert.deepEqual(judge(url).missing, [url]);
  assert.equal(judge('https://example.org/blog?next=/admin').triggered, false);
});

test('Workspace は明示アカウントのある URL のみ免除', () => {
  for (const host of ['docs.google.com', 'drive.google.com', 'sheets.google.com', 'script.google.com']) {
    const url = `https://${host}/document/d/123`;
    assert.deepEqual(judge(url).missing, [url]);
    assert.equal(judge(`${url}?authuser=1`).triggered, false);
    assert.equal(judge(`https://${host}/a/orgiast.jp/document/d/123`).triggered, false);
    assert.deepEqual(judge(`${url}?q=authuser=1`).missing, [`${url}?q=authuser=1`]);
  }
});

test('前後2行は許可、3行離れたアカウントは不可', () => {
  for (const distance of [0, 1, 2, 3]) {
    for (const lines of [[studio, account], [account, studio]]) {
      assert.deepEqual(judge(lines.join('\n'.repeat(distance))).missing, distance <= 2 ? [] : [studio]);
    }
  }
  assert.deepEqual(judge(`${studio}\n\n\nhttps://github.com/org/repo ${account}`).missing, [studio]);
});

test('メール・太字名・ランチャーでアカウントを指定', () => {
  for (const annotation of ['kim@orgiast.jp', '（**kim の Google アカウント** で開く）', '**kim** のアカウント', 'open-url-as.ps1 -Account kim']) {
    assert.deepEqual(judge(`${studio} ${annotation}`).missing, []);
  }
  for (const annotation of ['**開いてください**', 'アカウントで開く', 'open-url-as.ps1']) assert.deepEqual(judge(`${studio} ${annotation}`).missing, [studio]);
});

test('コードフェンスを無視し、例外もフェンス外のみ有効', () => {
  assert.equal(judge(`\x60\x60\x60text\n${studio}\n\x60\x60\x60`).triggered, false);
  assert.equal(judge(`${studio}\n[URL-ACCOUNT-OK]`).triggered, false);
  assert.deepEqual(judge(`${studio}\n\x60\x60\x60\n[URL-ACCOUNT-OK]\nkim@orgiast.jp\n\x60\x60\x60`).missing, [studio]);
  assert.deepEqual(judge(`${studio}\n\x60\x60\x60\nx\nx\n\x60\x60\x60\n${account}`).missing, [studio]);
});

test('Markdown・日本語句読点と URL ごとの判定', () => {
  assert.deepEqual(judge(`[こちら](${studio})。`).urls, [studio]);
  assert.deepEqual(judge(`${studio}、https://github.com/org/repo。`).missing, [studio, 'https://github.com/org/repo']);
  assert.deepEqual(judge(`${studio} ${account}\n\n\n${studio}`).missing, [studio]);
});

test('理由に規約番号と全 URL を含む', () => {
  const reason = formatReason([studio, 'https://github.com/org/repo']);
  for (const text of ['[URL-ACCOUNT]', '§1.5.0', studio, 'https://github.com/org/repo', '[URL-ACCOUNT-OK]']) assert.ok(reason.includes(text));
});

function invoke(t, text, { runner = false, input = {} } = {}) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'url-account-test-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const transcript = path.join(home, 'transcript.jsonl');
  writeFileSync(transcript, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } }) + '\n');
  return spawnSync(process.execPath, [runner ? fileURLToPath(new URL('./stop-gate-runner.mjs', import.meta.url)) : gate], {
    input: JSON.stringify({ transcript_path: transcript, ...input }), encoding: 'utf8', timeout: 20000,
    env: { ...process.env, ORGIAST_HOME: home, ORGIAST_HANDOFF_AUDIT: 'off' },
  });
}

test('CLI: 未指定なら stderr と exit 2', t => {
  const result = invoke(t, studio);
  assert.ifError(result.error);
  assert.equal(result.status, 2, result.stderr);
  assert.equal(result.stdout, '');
  assert.ok(result.stderr.includes('[URL-ACCOUNT]'));
  assert.ok(result.stderr.includes(studio));
});

test('CLI: 明示・ループ防止・空本文は通過', t => {
  for (const [text, input] of [[`${studio}${account}`, {}], [studio, { stop_hook_active: true }], ['', {}]]) {
    const result = invoke(t, text, { input });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, '');
  }
});

test('runner に登録され、アカウント追記で当該理由が消える', t => {
  for (const [text, blocked] of [[studio, true], [`${studio}${account}`, false]]) {
    const result = invoke(t, text, { runner: true });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    const output = result.stdout ? JSON.parse(result.stdout) : {};
    assert.equal((output.reason || '').includes('[URL-ACCOUNT]'), blocked);
    if (blocked) assert.equal(output.decision, 'block');
  }
});
