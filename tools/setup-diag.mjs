// setup.mjs converge 経路の診断ログ。RUNNER_TEMP がある CI でのみ出力。
// 使い方: const diag = createConvergeDiag(); diag.begin('step-name'); ... diag.end('step-name');
import fs from 'node:fs';
import path from 'node:path';

function resolvePath() {
  const runnerTemp = process.env.RUNNER_TEMP;
  if (!runnerTemp) return null;
  const dir = path.join(runnerTemp, 'clean-install-logs');
  try {
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, 'setup-steps.log');
  } catch {
    return null;
  }
}

export function createConvergeDiag() {
  const filePath = resolvePath();
  if (!filePath) {
    return {
      active: false,
      begin() {},
      end() {},
      write() {},
      execFileSyncFail() {},
      setupProcessHandlers() {},
      getCurrentStep() { return ''; },
    };
  }

  let currentStep = 'init';
  const startedAt = Date.now();

  function log(msg) {
    try {
      fs.appendFileSync(filePath, msg + '\n', 'utf8');
    } catch {
      // 診断の書き込み失敗は握りつぶす
    }
  }

  log(`[${new Date().toISOString()}] converge diag started`);

  return {
    active: true,

    /** ステップ開始を記録 */
    begin(name) {
      currentStep = name;
      const elapsed = Date.now() - startedAt;
      log(`[${elapsed}ms] begin: ${name}`);
    },

    /** ステップ終了を記録 */
    end(name, status = 'ok', extra = '') {
      currentStep = name + '(done)';
      const elapsed = Date.now() - startedAt;
      log(`[${elapsed}ms] end: ${name} status=${status}${extra ? ' ' + extra : ''}`);
    },

    /** 任意のメッセージを追記 */
    write(msg) {
      const elapsed = Date.now() - startedAt;
      log(`[${elapsed}ms] ${msg}`);
    },

    /** execFileSync 失敗の詳細を記録 */
    execFileSyncFail(description, { status, signal, stderr } = {}) {
      const elapsed = Date.now() - startedAt;
      const lines = [`[${elapsed}ms] execFileSync FAIL: ${description}`];
      if (status !== undefined && status !== null) lines.push(`  status=${status}`);
      if (signal) lines.push(`  signal=${signal}`);
      if (stderr) {
        const s = String(stderr).slice(0, 500);
        lines.push(`  stderr=${s}`);
      }
      log(lines.join('\n'));
    },

    getCurrentStep() { return currentStep; },

    /** process 終了/例外ハンドラを追加（CI の診断用、本処理に影響させない） */
    setupProcessHandlers() {
      // exit: process.exitCode 確定後に発火
      process.on('exit', (code) => {
        const elapsed = Date.now() - startedAt;
        log(`[${elapsed}ms] process.exit: code=${code} lastStep=${currentStep}`);
      });

      // unhandledRejection: ログしてから元の挙動（exit 1）を維持する
      process.on('unhandledRejection', (reason, promise) => {
        const elapsed = Date.now() - startedAt;
        const msg = reason?.stack || reason?.message || String(reason);
        log(`[${elapsed}ms] unhandledRejection at ${currentStep}: ${msg.slice(0, 1000)}`);
        process.exitCode = 1;
      });
    },
  };
}