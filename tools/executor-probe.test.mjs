import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert/strict';
import {
    detectCodex,
    detectProviders,
    chooseExecutors,
    buildDelegationBlock
} from './executor-probe.mjs';

describe('detectCodex', () => {
    it('WSL未導入時はusable:false', () => {
        const runSync = () => ({ status: 0, stdout: 'Copyright...\nwsl.exe [Argument]' });
        const result = detectCodex({ runSync });
        assert.equal(result.usable, false);
        assert.match(result.reason, /WSL/);
    });

    it('distroあり + codex成功でusable:true', () => {
        const runSync = (cmd, args) => {
            if (args && args.includes('-l')) {
                return { status: 0, stdout: 'Ubuntu\nDebian' };
            }
            return { status: 0, stdout: 'codex 1.0.0' };
        };
        const result = detectCodex({ runSync });
        assert.equal(result.usable, true);
        assert.equal(result.via, 'wsl');
        assert.equal(result.distro, 'Ubuntu');
    });

    it('distroあり + codex失敗でusable:false', () => {
        const runSync = (cmd, args) => {
            if (args && args.includes('-l')) {
                return { status: 0, stdout: 'Ubuntu' };
            }
            return { status: 1, stdout: '' };
        };
        const result = detectCodex({ runSync });
        assert.equal(result.usable, false);
        assert.match(result.reason, /codex/);
    });

    it('UbuntuとDebianでUbuntuを優先', () => {
        const runSync = (cmd, args) => {
            if (args && args.includes('-l')) {
                return { status: 0, stdout: 'Debian\nUbuntu' };
            }
            return { status: 0, stdout: 'ok' };
        };
        const result = detectCodex({ runSync });
        assert.equal(result.distro, 'Ubuntu');
    });
});

describe('detectProviders', () => {
    it('BOM付きファイルでも鍵を認識', () => {
        const homeDir = '/home/test';
        const exists = () => true;
        const readFile = () => '\uFEFFOPENROUTER_API_KEY=abc123';
        const result = detectProviders({ homeDir, exists, readFile });
        assert.deepEqual(result, ['openrouter']);
    });

    it('空の値は認識しない', () => {
        const homeDir = '/home/test';
        const exists = () => true;
        const readFile = () => 'DEEPSEEK_API_KEY=';
        const result = detectProviders({ homeDir, exists, readFile });
        assert.deepEqual(result, []);
    });
});

describe('chooseExecutors', () => {
    it('codex使用不可 + openrouterあり → openrouter', () => {
        const codex = { usable: false, reason: 'test' };
        const providers = ['openrouter'];
        const result = chooseExecutors(codex, providers);
        const impl = result[0];
        assert.equal(impl.provider, 'openrouter');
        assert.match(impl.command, /--out/);
    });

    it('codex使用可 → codex', () => {
        const codex = { usable: true, reason: '' };
        const providers = [];
        const result = chooseExecutors(codex, providers);
        const impl = result[0];
        assert.equal(impl.provider, 'codex');
    });
});

describe('buildDelegationBlock', () => {
    it('先頭行が見出し', () => {
        const plan = [];
        const result = buildDelegationBlock(plan);
        assert.match(result, /^## 委譲ルート/);
    });

    it('利用不可を含む', () => {
        const plan = [{ role: '実装', provider: '', command: '', note: 'テスト' }];
        const result = buildDelegationBlock(plan);
        assert.match(result, /利用不可/);
    });

    it('各roleの行が含まれる', () => {
        const plan = [
            { role: '実装', provider: 'codex', command: 'cmd1', note: '' },
            { role: '分類・量産', provider: 'groq', command: 'cmd2', note: 'note' },
            { role: '長文脈', provider: '', command: '', note: 'なし' }
        ];
        const result = buildDelegationBlock(plan);
        assert.match(result, /実装:/);
        assert.match(result, /分類・量産:/);
        assert.match(result, /長文脈:/);
    });
});
