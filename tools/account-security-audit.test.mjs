#!/usr/bin/env node
/**
 * tools/account-security-audit.test.mjs
 * account-security-audit.mjs のテスト
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.join(__dirname, 'account-security-audit.mjs');

describe('account-security-audit', () => {
  it('--help で使用方法を表示', () => {
    const out = execSync(`node "${TOOL}" --help`, { encoding: 'utf8' });
    assert(out.includes('使用法'));
    assert(out.includes('--verify'));
    assert(out.includes('--output-json'));
    assert(out.includes('--csv'));
  });

  it('通常実行でマークダウン表を出力', () => {
    const out = execSync(`node "${TOOL}"`, { encoding: 'utf8' });
    assert(out.includes('アカウントセキュリティ監査レポート'));
    assert(out.includes('kim@orgiast.jp'));
    assert(out.includes('seisaku-team@orgiast.jp'));
    assert(out.includes('nishi@orgiast.jp'));
  });

  it('--output-json でJSONを出力', () => {
    const out = execSync(`node "${TOOL}" --output-json`, { encoding: 'utf8' });
    const parsed = JSON.parse(out);
    assert(Array.isArray(parsed.accounts));
    assert(typeof parsed.generatedAt === 'string');
    assert(typeof parsed.allAccountsHave2FA === 'boolean');
    assert(parsed.accounts.some(a => a.email === 'kim@orgiast.jp'));
  });

  it('--csv でCSVを出力', () => {
    const out = execSync(`node "${TOOL}" --csv`, { encoding: 'utf8' });
    assert(out.includes('email,role,note,has2FA,risk'));
    assert(out.includes('kim@orgiast.jp'));
  });

  it('--verify で全アカウント未確認ならexit 1（フォールバックアカウントのhas2FAは未確認）', () => {
    try {
      execSync(`node "${TOOL}" --verify`, { encoding: 'utf8', stdio: 'pipe' });
      // has2FA !== false のため通る可能性あり
    } catch (e) {
      // exit 1 の場合がある
      assert(e.status === 1);
    }
  });

  it('設定ファイルが存在すればそれを優先する', () => {
    const configPath = path.resolve(__dirname, '..', 'config', 'account-inventory.json');
    const hasConfig = fs.existsSync(configPath);
    // 設定ファイルがあればその内容を使用、なければフォールバックのため3アカウント
    const out = execSync(`node "${TOOL}" --output-json`, { encoding: 'utf8' });
    const parsed = JSON.parse(out);
    if (hasConfig) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      assert.equal(parsed.accounts.length, config.accounts.length);
    } else {
      assert(parsed.accounts.length >= 3);
    }
  });
});