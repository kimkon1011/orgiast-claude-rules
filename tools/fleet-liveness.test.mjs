import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyFleet, formatLiveness, loadPcMap, TOOL_INTRODUCED, toSheetState, splitDiscordContent, postToDiscordWebhook } from './fleet-liveness.mjs';

const now = new Date('2026-08-27T03:00:00.000Z');
const message = (label, hostname, timestamp, email = 'person@example.com') => ({
  timestamp,
  content: `**💻 Claude Code ローカル利用トークン** — ${label}\n🖥 hostname=${hostname} / user=u / git=${email}`,
});

test('toSheetState は6状態をシート表記へ変換する', () => {
  assert.deepEqual(Object.fromEntries(['alive', 'discord-mute', 'broken', 'never', 'legacy-manual', 'uncertain'].map((state) => [state, toSheetState(state)])), {
    alive: '生存', 'discord-mute': 'Discord不通', broken: '停止', never: '報告実績なし', 'legacy-manual': '手入力のみ', uncertain: '要確認',
  });
});

test('4状態を理由付きで分離し never を異常に数えない', () => {
  const sheet = [
    { pcName: 'sheet-only', label: 'SHEET', reportedAt: '2026-08-25 12:00' },
    { pcName: 'both', label: 'BOTH', reportedAt: '2026-08-27 11:00' },
    { pcName: 'never-pc', label: 'NEVER', reportedAt: '' },
  ];
  const discord = [
    message('old', 'old-host', '2026-08-18T03:00:00.000Z'),
    message('BOTH', 'both-host', '2026-08-27T02:00:00.000Z'),
  ];
  const result = classifyFleet({ discord, sheet, now });
  assert.equal(result.items.find((x) => x.name === 'sheet-only').state, 'discord-mute');
  const broken = result.items.find((x) => x.name === 'old');
  assert.equal(broken.state, 'broken');
  assert.match(broken.reason, /2026-08-18/);
  assert.equal(result.items.find((x) => x.name === 'both').state, 'alive');
  assert.equal(result.items.find((x) => x.name === 'never-pc').state, 'never');
  assert.equal(result.counts.never, 1);
  assert.equal(result.counts.broken, 1);
  assert.doesNotMatch(result.items.find((x) => x.state === 'never').reason, /無音|異常/);
});

test('片方失敗を明示して取得できた経路だけで判定する', () => {
  const result = classifyFleet({ discord: [message('pc', 'host', '2026-08-18T03:00:00Z')], sheet: null, now, errors: { sheet: 'timeout' } });
  assert.equal(result.items[0].state, 'broken');
  assert.match(result.warnings[0], /シートの取得に失敗（timeout）/);
  assert.equal(result.unavailable, false);
});

test('両方失敗は unavailable', () => {
  const result = classifyFleet({ discord: null, sheet: null, now, errors: { discord: '401', sheet: 'timeout' } });
  assert.equal(result.unavailable, true);
  assert.equal(result.warnings.length, 2);
});

test('Markdown は状態別見出し、最終報告日、次アクションを含みメールをマスクする', () => {
  const result = classifyFleet({ discord: [message('person@example.com', 'host', '2026-08-18T03:00:00Z')], sheet: [], now });
  const text = formatLiveness(result);
  assert.match(text, /✅ 生存/);
  assert.match(text, /📡 Discordにだけ届かない/);
  assert.match(text, /🚨 壊れて停止/);
  assert.match(text, /◻️ 報告実績なし/);
  assert.match(text, /2026-08-18/);
  assert.match(text, /p\*\*\*@example\.com/);
  assert.match(text, /keyserve/);
});

test('対応表を読み、壊れたファイルは空として扱う', async () => {
  assert.deepEqual(await loadPcMap('/repo', async () => '{"_note":"説明","_pending":{"HP":"確認中"},"HP":{"sheetName":"東邦2階HP"}}'), { HP: { sheetName: '東邦2階HP' } });
  assert.deepEqual(await loadPcMap('/repo', async () => { throw new Error('missing'); }), {});
  assert.deepEqual(await loadPcMap('/repo', async () => '{broken'), {});
});

test('対応表で Discord とシートを1台に統合する', () => {
  const result = classifyFleet({
    discord: [message('HP', 'hp-host', '2026-08-18T03:00:00Z')],
    sheet: [{ pcName: '東邦2階HP', label: '', reportedAt: '' }],
    pcMap: { HP: { sheetName: '東邦2階HP', person: '木下真弓' } }, now,
  });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].name, '東邦2階HP（HP）');
  assert.equal(result.items[0].state, 'broken');
});

test('legacy-manual は導入日前だけで境界日は broken', () => {
  assert.equal(TOOL_INTRODUCED, '2026-08-20');
  const result = classifyFleet({ discord: [], sheet: [
    { pcName: 'legacy', reportedAt: '2026-08-19' },
    { pcName: 'boundary', reportedAt: '2026-08-20' },
  ], now });
  assert.equal(result.items.find((x) => x.name === 'legacy').state, 'legacy-manual');
  assert.equal(result.items.find((x) => x.name === 'boundary').state, 'broken');
  assert.equal(result.counts.broken, 1);
});

test('未対応の hostname 衝突は勝手に統合しない', () => {
  const result = classifyFleet({
    discord: [message('kim開発機', 'DESKTOP-2D0R4LI', '2026-08-27T02:00:00Z')],
    sheet: [{ pcName: '作業用004民泊用', hostname: 'DESKTOP-2D0R4LI', reportedAt: '2026-08-15' }], now,
  });
  assert.equal(result.items.length, 2);
  const uncertain = result.items.find((x) => x.state === 'uncertain');
  assert.match(uncertain.reason, /作業用004民泊用.*DESKTOP-2D0R4LI.*kim開発機/);
  assert.equal(result.items.find((x) => x.state === 'alive').name, 'kim開発機');
  assert.match(formatLiveness(result), /kim の判断待ち/);
});

test('名字/person一致は未確定候補として出し、state別の次アクションを示す', () => {
  const sheet = [
    { pcName: '金功勇PC' },
    { pcName: '古川PC' },
    { label: 'kim-PC', hostname: 'KIM', reportedAt: '2026-08-27 11:00' },
    { label: '古川龍慶のノートブックコンピュータ', hostname: 'FURU', reportedAt: '2026-08-27 11:00' },
    { pcName: '作業用999' },
  ];
  const result = classifyFleet({ discord: [], sheet, pcMap: {
    'kim-PC': { hostname: 'KIM', person: '金功勇' },
    '作業用999': { sheetName: '作業用999', installedAt: '2026-09-03' },
  }, now });
  assert.ok(result.candidates.some((candidate) => candidate.manual === '古川PC'));
  assert.ok(result.candidates.some((candidate) => candidate.manual === '金功勇PC'));
  const text = formatLiveness(result);
  assert.match(text, /installed-pending: 次回 03:15/);
  // 「手書き行なし」は稼働状態と別軸で数える(machine-only という state は廃止)
  assert.match(text, /手書き行なし \d+台: 機械報告はあるが手書き一覧に行が無い/);
  assert.match(text, /古川PC↔古川龍慶のノートブックコンピュータ の同一判定は kim の回答が必要/);
});

test('台帳に無いPCと台帳外アカウント・アカウント不一致を検出する', async () => {
  const { detectLedgerGaps } = await import('./fleet-liveness.mjs');
  const pcMap = { 'kim-PC': { hostname: 'DESKTOP-1', account: 'kim@orgiast.jp', aliases: ['kim-alias'] } };
  const sheet = [
    { label: 'kim-PC', hostname: 'DESKTOP-1', reportedAt: '2026-10-13 09:00', claudeAccount: 'cr@orgiast.jp' },
    { label: 'Yuko-MacBook-Air', hostname: 'Yukos-MacBook-Air.local', reportedAt: '2026-10-13 09:00', claudeAccount: 'cr@orgiast.jp' },
    { pcName: '手書きだけ' },
  ];
  const gaps = detectLedgerGaps({ discord: null, sheet, pcMap });
  assert.deepEqual(gaps.unregistered.map((pc) => pc.name), ['Yuko-MacBook-Air']);
  assert.equal(gaps.unregistered[0].claudeAccount, 'cr@orgiast.jp');
  assert.equal(gaps.offLedgerAccounts[0].account, 'cr@orgiast.jp');
  assert.deepEqual(gaps.accountMismatches.map((m) => m.name), ['kim-PC']);
  assert.deepEqual(detectLedgerGaps({ sheet, pcMap: {} }).unregistered, []);
});

test('インストーラ初報告は台帳照合だけに含め、空の台帳では警告しない', async () => {
  const { detectLedgerGaps } = await import('./fleet-liveness.mjs');
  const pcMap = { known: { hostname: 'known-PC', account: 'known@example.com' } };
  const installBeacons = [
    { hostname: 'new-PC', claudeAccount: 'new@example.com', lastSeenAt: '2026-10-15T00:00:00Z' },
    { hostname: 'known-PC', claudeAccount: 'new@example.com', lastSeenAt: '2026-10-15T00:00:00Z' },
  ];
  const gaps = detectLedgerGaps({ discord: null, sheet: [], pcMap, installBeacons });
  assert.deepEqual(gaps.unregistered.map(row => row.name), ['new-PC']);
  assert.deepEqual(gaps.offLedgerAccounts[0].pcs, ['new-PC', 'known-PC']);
  assert.equal(gaps.accountMismatches[0].name, 'known-PC');
  assert.deepEqual(detectLedgerGaps({ pcMap: {}, installBeacons }), { unregistered: [], offLedgerAccounts: [], accountMismatches: [] });
  const base = classifyFleet({ discord: [], sheet: [], pcMap, now });
  const withBeacons = classifyFleet({ discord: [], sheet: [], pcMap, now, installBeacons });
  assert.deepEqual(withBeacons.items, base.items);
  assert.deepEqual(withBeacons.counts, base.counts);
});

test('splitDiscordContent: 本文が2000文字以内なら分割しない', () => {
  const text = '短い本文';
  assert.deepEqual(splitDiscordContent(text, 2000), [text]);
});

test('splitDiscordContent: 2000文字超で複数チャンクに分割し各チャンクがmaxLen未満', () => {
  const line = 'あ'.repeat(500); // 500文字
  const lines = [];
  for (let i = 0; i < 10; i++) lines.push(`${line}`);
  const text = lines.join('\n'); // 約5000文字
  const chunks = splitDiscordContent(text, 2000);
  assert.ok(chunks.length >= 3);
  for (let i = 0; i < chunks.length; i++) {
    assert.ok(chunks[i].length <= 2000, `chunk[${i}] length=${chunks[i].length} exceeds 2000`);
  }
});

test('splitDiscordContent: 2通目以降に継続見出しが付く', () => {
  const line = 'x'.repeat(1500);
  const text = `${line}\n${line}`; // 約3001文字
  const chunks = splitDiscordContent(text, 2000);
  assert.ok(chunks.length >= 2);
  assert.match(chunks[1], /^（続き \d+\/\d+）\n/);
});

test('splitDiscordContent: コードフェンスを閉じ忘れない', () => {
  // フェンスが2000文字超で分割され、閉じ忘れがないケース
  const text = '```\n' + 'a'.repeat(1900) + '\n```';
  const chunks = splitDiscordContent(text, 2000);
  for (const chunk of chunks) {
    const fences = chunk.split('```').length - 1;
    assert.equal(fences % 2, 0, `コードフェンスが閉じていない: chunk="${chunk.slice(0, 50)}"...`);
  }
});

test('splitDiscordContent: 1行がmaxLenを超える場合、文字数で強制分割される', () => {
  const longLine = 'a'.repeat(3000);
  const chunks = splitDiscordContent(longLine, 2000);
  assert.ok(chunks.length >= 2);
  assert.equal(chunks[0].length, 2000);
  // 2つ目以降には継続見出しが付く
  assert.match(chunks[1], /^（続き \d+\/\d+）\n/);
  assert.ok(chunks[1].length <= 2000);
  // 見出しを除いた本文が元データと一致
  const headerMatch = chunks[1].match(/^（続き \d+\/\d+）\n(.*)$/s);
  assert.ok(headerMatch);
  assert.equal(headerMatch[1], 'a'.repeat(1000));
});

test('postToDiscordWebhook: 本文が2000文字以内なら1回だけfetchする', async () => {
  let callCount = 0;
  const fetchImpl = async () => { callCount++; return { ok: true }; };
  const ok = await postToDiscordWebhook('https://hook.example.com', '短い本文', { fetchImpl });
  assert.equal(ok, true);
  assert.equal(callCount, 1);
});

test('postToDiscordWebhook: 本文が2000文字超なら複数回fetchし各チャンクが2000文字未満', async () => {
  const chunks = [];
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    chunks.push(body.content);
    return { ok: true };
  };
  const line = 'x'.repeat(1500);
  const text = `${line}\n${line}\n${line}`; // 約4503文字
  const ok = await postToDiscordWebhook('https://hook.example.com', text, { fetchImpl });
  assert.equal(ok, true);
  assert.ok(chunks.length >= 2);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 2000, `chunk length ${chunk.length} exceeds 2000`);
  }
});

test('postToDiscordWebhook: HTTP 400のときエラーメッセージにステータスとレスポンス本文を含む', async () => {
  const errors = [];
  const originalConsoleError = console.error;
  console.error = (msg) => { errors.push(msg); };
  try {
    const fetchImpl = async () => ({
      ok: false,
      status: 400,
      text: async () => '{"message": "Bad Request: content must be 2000 or fewer characters"}',
    });
    const ok = await postToDiscordWebhook('https://hook.example.com', 'x'.repeat(2500), { fetchImpl });
    assert.equal(ok, false);
    const errorMsg = errors.find((e) => e.includes('HTTP 400'));
    assert.ok(errorMsg, 'HTTP 400を含むエラーメッセージが必要');
    assert.ok(errorMsg.includes('Bad Request'), 'レスポンス本文を含む必要があります');
    assert.ok(errorMsg.includes('content must be 2000'), 'レスポンス本文の詳細を含む必要があります');
  } finally {
    console.error = originalConsoleError;
  }
});

test('postToDiscordWebhook: 送信失敗しても process.exitCode を変更しない', async () => {
  const originalExitCode = process.exitCode;
  try {
    const fetchImpl = async () => ({ ok: false, status: 400, text: async () => 'error body' });
    const ok = await postToDiscordWebhook('https://hook.example.com', 'x'.repeat(2500), { fetchImpl });
    assert.equal(ok, false);
    assert.equal(process.exitCode, originalExitCode, 'process.exitCode が変更されていないこと');
  } finally {
    process.exitCode = originalExitCode;
  }
});

test('postToDiscordWebhook: ネットワークエラーでも process.exitCode を変更しない', async () => {
  const originalExitCode = process.exitCode;
  try {
    const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
    const ok = await postToDiscordWebhook('https://hook.example.com', '短い本文', { fetchImpl });
    assert.equal(ok, false);
    assert.equal(process.exitCode, originalExitCode, 'process.exitCode が変更されていないこと');
  } finally {
    process.exitCode = originalExitCode;
  }
});
