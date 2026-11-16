import test from 'node:test';
import assert from 'node:assert/strict';
import { getFreeMemoryMb, getCpuUsagePct } from './session-load.mjs';
import { getLoadGuardStatus } from '../reopen-lost-sessions.mjs';

test('Windows CIM の KB を MB に変換し閾値直下を丸めない', () => {
  for (const kb of [0, 4194303, 4194304, 29360128]) {
    assert.equal(getFreeMemoryMb(() => String(kb), { platform: 'win32' }), kb / 1024);
  }
  assert.equal(getFreeMemoryMb(() => ({ status: 0, stdout: '4194304' }), { platform: 'win32' }), 4096);
});

test('メモリ取得失敗・空出力・不正値は null、他 OS は os.freemem', () => {
  for (const value of ['', '123junk', '-1', 'NaN', { status: 1, stdout: '4194304' }, { error: new Error('timeout') }]) {
    assert.equal(getFreeMemoryMb(() => value, { platform: 'win32' }), null);
  }
  assert.equal(getFreeMemoryMb(() => { throw Error('CIM'); }, { platform: 'win32' }), null);
  assert.equal(getFreeMemoryMb(() => assert.fail(), { platform: 'linux', freemem: () => 5 * 1024 ** 3 }), 5120);
});

test('Node 標準の sys/idle/irq で CPU を測り、取得不能は null', async () => {
  let calls = 0;
  const cpu = await getCpuUsagePct({ cpusImpl: () => [{ times: { user: 90 * calls, nice: 0, sys: 0, idle: 10 * calls++, irq: 0 } }], wait: async () => {} });
  assert.equal(cpu, 90);
  assert.equal(await getCpuUsagePct({ cpusImpl: () => [], wait: async () => {} }), null);
  assert.equal(await getCpuUsagePct({ cpusImpl: () => { throw Error('CPU'); } }), null);
});

async function guard({ mb = 28672, cpu = 10, count = 35, env = {} } = {}) {
  let calls = 0;
  return getLoadGuardStatus({ platform: 'win32', env, wait: async () => {},
    cpusImpl: () => [{ times: { user: cpu * calls, nice: 0, sys: 0, idle: (100 - cpu) * calls++, irq: 0 } }],
    spawn: (_command, args) => ({ status: 0, stdout: String(args.at(-1)).includes('FreePhysicalMemory')
      ? (mb === null ? '' : String(mb * 1024)) : JSON.stringify(Array.from({ length: count }, () => ({ Name: 'claude.exe' }))) }),
  });
}

test('35本・空き28GBは許可、4GB/CPU90%/60本の境界を守る', async () => {
  assert.equal((await guard()).triggered, false);
  assert.equal((await guard({ mb: 4096, cpu: 89.9 })).triggered, false);
  assert.equal((await guard({ mb: 4096 - 1 / 1024 })).reason, 'freeMem');
  assert.equal((await guard({ cpu: 90 })).reason, 'cpuPct');
  assert.equal((await guard({ count: 60 })).reason, 'claudeCount');
  assert.equal((await guard({ mb: 1, cpu: 99, count: 60 })).reason, 'freeMem,cpuPct,claudeCount');
});

test('メモリ取得不能は本数だけへフォールバックし env 上書きを維持', async () => {
  const fallback = await guard({ mb: null, cpu: 99 });
  assert.equal(fallback.mode, 'count-only');
  assert.equal(fallback.triggered, false);
  assert.equal((await guard({ mb: null, count: 60 })).reason, 'claudeCount');
  assert.equal((await guard({ env: { REOPEN_MAX_CLAUDE: '30' } })).reason, 'claudeCount');
  assert.equal((await guard({ mb: 2048, cpu: 95, env: { REOPEN_MIN_FREE_MEM_MB: '1024', REOPEN_MAX_CPU: '99' } })).triggered, false);
});
