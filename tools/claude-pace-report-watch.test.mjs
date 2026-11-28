#!/usr/bin/env node
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { jstDate, checkReport, buildWarning, main, REPO, REPORT_PATH } from './claude-pace-report-watch.mjs';

describe('jstDate', () => {
  it('日付を JST の YYYY-MM-DD で返す', () => {
    assert.equal(jstDate(Date.parse('2026-11-27T16:00:00Z')), '2026-11-28');
  });
  it('深夜の UTC でも JST では翌日になる', () => {
    assert.equal(jstDate(Date.parse('2026-11-28T08:00:00Z')), '2026-11-28');
  });
  it('JST 午前の時刻は同じ日', () => {
    assert.equal(jstDate(Date.parse('2026-11-28T22:45:00+09:00')), '2026-11-28');
  });
});

describe('checkReport', () => {
  it('報告がある（200 + size > 0）→ exists: true', async () => {
    const fetchImpl = async () => ({ status: 200, ok: true, json: async () => ({ size: 1234 }) });
    const result = await checkReport('2026-11-28', { fetchImpl });
    assert.equal(result.exists, true);
    assert.equal(result.size, 1234);
  });

  it('報告が無い（404）→ exists: false', async () => {
    const fetchImpl = async () => ({ status: 404, ok: false });
    const result = await checkReport('2026-11-28', { fetchImpl });
    assert.equal(result.exists, false);
    assert.ok(result.reason.includes('404'));
  });

  it('size が 0 → 無い扱い', async () => {
    const fetchImpl = async () => ({ status: 200, ok: true, json: async () => ({ size: 0 }) });
    const result = await checkReport('2026-11-28', { fetchImpl });
    assert.equal(result.exists, false);
    assert.ok(result.reason.includes('0'));
  });

  it('size が無い（null）→ 無い扱い', async () => {
    const fetchImpl = async () => ({ status: 200, ok: true, json: async () => ({ }) });
    const result = await checkReport('2026-11-28', { fetchImpl });
    assert.equal(result.exists, false);
  });

  it('取得に失敗（throw）→ exists: null、断定しない', async () => {
    const fetchImpl = async () => { throw new Error('network error'); };
    const result = await checkReport('2026-11-28', { fetchImpl });
    assert.equal(result.exists, null);
    assert.ok(result.reason.includes('取得失敗'));
  });

  it('HTTP 500 → 断定しない', async () => {
    const fetchImpl = async () => ({ status: 500, ok: false });
    const result = await checkReport('2026-11-28', { fetchImpl });
    assert.equal(result.exists, null);
    assert.ok(result.reason.includes('500'));
  });
});

describe('buildWarning', () => {
  it('exists=false のとき「ありません」を含む', () => {
    const msg = buildWarning('2026-11-28', { exists: false, reason: 'GitHub API が 404' }, 'host-a');
    assert.ok(msg.includes('ありません'));
    assert.ok(msg.includes('2026-11-28'));
    assert.ok(msg.includes(REPORT_PATH));
    assert.ok(msg.includes(REPO));
  });

  it('exists=null のとき「分かっていません」を含む', () => {
    const msg = buildWarning('2026-11-28', { exists: null, reason: '取得失敗: Error' }, 'host-b');
    assert.ok(msg.includes('分かっていません'));
    assert.ok(msg.includes('取得失敗'));
  });
});

describe('main', () => {
  it('報告がある → ok:true、addItem が呼ばれない', async () => {
    let addCalls = 0;
    const result = await main(['--date', '2026-11-28'], {
      fetchImpl: async () => ({ status: 200, ok: true, json: async () => ({ size: 1234 }) }),
      addItem: async () => { addCalls++; },
      print: () => {},
    });
    assert.equal(result.ok, true);
    assert.equal(addCalls, 0);
  });

  it('報告が無い → ok:false、addItem が1回呼ばれる', async () => {
    let addCalls = 0;
    const captured = [];
    const result = await main(['--date', '2026-11-28'], {
      fetchImpl: async () => ({ status: 404, ok: false }),
      addItem: async (home, opts) => {
        addCalls++;
        captured.push({ kind: opts.kind, text: opts.text, source: opts.source });
      },
      print: () => {},
    });
    assert.equal(result.ok, false);
    assert.equal(addCalls, 1);
    assert.equal(captured[0].kind, 'ask');
    assert.ok(captured[0].text.includes('2026-11-28'));
    assert.ok(captured[0].text.includes(REPORT_PATH));
    assert.equal(captured[0].source, 'claude-pace-report-watch');
  });

  it('size 0 → 無い扱いで addItem が呼ばれる', async () => {
    let addCalls = 0;
    const result = await main(['--date', '2026-11-28'], {
      fetchImpl: async () => ({ status: 200, ok: true, json: async () => ({ size: 0 }) }),
      addItem: async () => { addCalls++; },
      print: () => {},
    });
    assert.equal(result.ok, false);
    assert.equal(addCalls, 1);
  });

  it('取得失敗 → 断定しない警告', async () => {
    const captured = [];
    const result = await main(['--date', '2026-11-28'], {
      fetchImpl: async () => { throw new Error('timeout'); },
      addItem: async (home, opts) => { captured.push(opts.text); },
      print: () => {},
    });
    assert.equal(result.ok, false);
    assert.equal(result.warned, true);
    assert.ok(captured[0].includes('分かっていません'));
  });

  it('HTTP 500 → 断定しない', async () => {
    const captured = [];
    const result = await main(['--date', '2026-11-28'], {
      fetchImpl: async () => ({ status: 500, ok: false }),
      addItem: async (home, opts) => { captured.push(opts.text); },
      print: () => {},
    });
    assert.equal(result.ok, false);
    assert.ok(captured[0].includes('分かっていません'));
  });

  it('--dry-run を付けたら addItem が呼ばれず本文が print される', async () => {
    let addCalls = 0;
    let printed = '';
    const result = await main(['--date', '2026-11-28', '--dry-run'], {
      fetchImpl: async () => ({ status: 404, ok: false }),
      addItem: async () => { addCalls++; },
      print: (msg) => { printed = msg; },
    });
    assert.equal(result.ok, false);
    assert.equal(result.dryRun, true);
    assert.equal(addCalls, 0);
    assert.ok(printed.includes('2026-11-28'));
  });

  it('--date で日付を指定できる', async () => {
    let addCalls = 0;
    const result = await main(['--date', '2026-11-27'], {
      fetchImpl: async () => ({ status: 200, ok: true, json: async () => ({ size: 999 }) }),
      addItem: async () => { addCalls++; },
      print: () => {},
    });
    assert.equal(result.ok, true);
    assert.equal(result.date, '2026-11-27');
    assert.equal(result.size, 999);
  });
});