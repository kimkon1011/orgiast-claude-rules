#!/usr/bin/env node
/**
 * meet-cue.mjs — Meet カンペ CLI 本体
 * Bot が Google Meet に参加し、打合せ中の社員へ「言うこと・資料」をリアルタイム指示する
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

export function getLlmAskPath(baseUrl = import.meta.url) {
  return fileURLToPath(new URL('./llm-ask.mjs', baseUrl));
}

import { isEntry } from './is-entry.mjs';
import { askJev, main as jevMain } from './jev.mjs';
import { addItem } from './kim-inbox.mjs';
import { runHumanLogin } from './lib/human-login.mjs';

import {
  CaptionAssembler,
  CueTracker,
  STANDARD_CARDS,
  buildJevState,
  buildJevQuestions,
  parseJevResponse,
  parseSimulateTranscript,
  runDecisionRound,
  formatJstSessionDate,
  sanitizeCardData,
} from './lib/meet-cue-core.mjs';

import {
  setupCueDocument,
  insertCueToDocument,
  getDocsToken,
  findHeaderInsertIndex,
} from './lib/meet-cue-doc.mjs';

import {
  startMeetBot,
  checkPlaywrightAvailable,
  checkProfileLoggedIn,
} from './lib/meet-cue-browser.mjs';

const execFileAsync = promisify(execFile);
const homeDir = () => process.env.ORGIAST_HOME || os.homedir();
const meetCueBaseDir = (home = homeDir()) => path.join(home, '.claude', 'meet-cue');

export function copyProfileFromChrome(profileName, { home = homeDir(), localAppData = process.env.LOCALAPPDATA, isCookiesLocked } = {}) {
  const userDataDir = path.join(localAppData || path.join(os.homedir(), 'AppData', 'Local'), 'Google', 'Chrome', 'User Data');
  const srcProfileDir = path.join(userDataDir, profileName);
  const destDir = path.join(home, '.claude', 'browser-profiles', 'meet-bot-seisaku');

  if (!fs.existsSync(srcProfileDir)) {
    return { ok: false, reason: 'profile_not_found', code: 1 };
  }

  // Check Cookies file lock
  const cookiesFiles = [
    path.join(srcProfileDir, 'Network', 'Cookies'),
    path.join(srcProfileDir, 'Cookies'),
  ];
  let cookiesLocked = false;

  if (typeof isCookiesLocked === 'boolean') {
    cookiesLocked = isCookiesLocked;
  } else {
    for (const cFile of cookiesFiles) {
      if (fs.existsSync(cFile)) {
        try {
          const fd = fs.openSync(cFile, 'r+');
          fs.closeSync(fd);
        } catch (err) {
          if (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES' || err.code === 'EXDEV') {
            cookiesLocked = true;
            break;
          }
        }
      }
    }
  }

  if (cookiesLocked) {
    console.error(`[meet-cue login] Chrome が起動中のため Cookies がロックされています (${profileName})`);
    return { ok: false, reason: 'chrome_running', code: 75 };
  }

  try {
    fs.mkdirSync(destDir, { recursive: true });

    const copyRecursiveSync = (src, dest) => {
      const stats = fs.statSync(src);
      const name = path.basename(src);

      if (/cache/i.test(name) || name === 'Code Cache' || name === 'GPUCache' || name === 'Service Worker' || name === 'CacheStorage') {
        return;
      }

      if (stats.isDirectory()) {
        fs.mkdirSync(dest, { recursive: true });
        for (const child of fs.readdirSync(src)) {
          copyRecursiveSync(path.join(src, child), path.join(dest, child));
        }
      } else {
        fs.copyFileSync(src, dest);
      }
    };

    copyRecursiveSync(srcProfileDir, path.join(destDir, profileName));

    const loginInfo = {
      ok: true,
      account: 'seisaku-team@orgiast.jp',
      profile: profileName,
      profileDir: path.join(destDir, profileName),
      at: new Date().toISOString(),
    };
    const loginFile = path.join(home, '.claude', 'meet-cue', 'bot-login.json');
    fs.mkdirSync(path.dirname(loginFile), { recursive: true });
    fs.writeFileSync(loginFile, JSON.stringify(loginInfo, null, 2), 'utf8');

    console.log(`[meet-cue login] Chrome プロファイル "${profileName}" の複製に成功しました。`);
    return { ok: true, code: 0, loginInfo };
  } catch (err) {
    console.error(`[meet-cue login] 複製エラー: ${err.message}`);
    return { ok: false, reason: err.message, code: 1 };
  }
}

export function generateSessionId() {
  const d = new Date();
  const dateStr = formatJstSessionDate(d);
  const randStr = randomBytes(2).toString('hex');
  return `${dateStr}-${randStr}`;
}

export function saveLatestSessionId(sessionId, home = homeDir()) {
  const dir = meetCueBaseDir(home);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'latest'), sessionId, 'utf8');
}

export function getLatestSessionId(home = homeDir()) {
  const latestPath = path.join(meetCueBaseDir(home), 'latest');
  if (fs.existsSync(latestPath)) {
    return fs.readFileSync(latestPath, 'utf8').trim();
  }
  return null;
}

export async function generateCardsFromBrief(brief = '', home = homeDir()) {
  if (!brief.trim()) return [...STANDARD_CARDS];

  const prompt = `打合せ事前情報から、面談中に役立つカンペカード（5〜10枚）をJSON配列で作成してください。
数字・実績・社名は brief に書かれているものだけを使う。無ければ data は空文字。推測で数字を作らない。

フォーマット:
[
  {
    "id": "card-custom-1",
    "title": "カードタイトル",
    "trigger": "このカードを出す条件や発言キーワード",
    "say": "社員がそのまま言える1〜2文（60字以内）",
    "data": "briefに書かれた根拠となる数字や実績1つ（無ければ空文字）",
    "material_url": ""
  }
]

事前情報:
${brief}`;

  const promptFile = path.join(os.tmpdir(), `meet-cue-prompt-${Date.now()}.txt`);
  fs.writeFileSync(promptFile, prompt, 'utf8');

  try {
    const { stdout } = await execFileAsync(process.execPath, [
      getLlmAskPath(),
      '--provider', 'gemini',
      '--prompt-file', promptFile,
    ], { timeout: 15000, windowsHide: true });

    fs.rmSync(promptFile, { force: true });

    const jsonMatch = stdout.match(/\[\s*\{[\s\S]*\}\s*\]/);
    if (jsonMatch) {
      const generated = JSON.parse(jsonMatch[0]);
      if (Array.isArray(generated) && generated.length > 0) {
        // Sanitize generated cards data
        const sanitizedGenerated = generated.map(c => sanitizeCardData(c, brief));

        // Combine generated cards with standard cards
        const combined = [...sanitizedGenerated, ...STANDARD_CARDS];
        // Deduplicate by ID
        const seen = new Set();
        return combined.filter(c => {
          if (!c.id || seen.has(c.id)) return false;
          seen.add(c.id);
          return true;
        });
      }
    }
  } catch (e) {
    console.error('meet-cue: llm-ask カード生成警告:', e.message);
  } finally {
    fs.rmSync(promptFile, { force: true });
  }

  return [...STANDARD_CARDS];
}

export async function generateHelpCue({ brief = '', captionsText = '' } = {}) {
  const prompt = `お客様とのGoogle Meet打合せ中に助け舟が必要です。直近の字幕と打合せ概要を踏まえ、今社員が発言すべき適切なセリフと根拠をJSONオブジェクトで1点出力してください。
数字・実績・社名は brief に書かれているものだけを使う。無ければ data は空文字。推測で数字を作らない。

フォーマット:
{
  "say": "社員がそのまま言える1〜2文（60字以内目安）",
  "data": "briefに書かれた根拠となる数字や実績1つ（無ければ空文字）"
}

打合せ概要:
${brief || 'なし'}

直近の字幕:
${captionsText}`;

  const promptFile = path.join(os.tmpdir(), `meet-cue-gen-${Date.now()}.txt`);
  fs.writeFileSync(promptFile, prompt, 'utf8');

  try {
    const { stdout } = await execFileAsync(process.execPath, [
      getLlmAskPath(),
      '--provider', 'groq',
      '--prompt-file', promptFile,
    ], { timeout: 8000, windowsHide: true });

    const jsonMatch = stdout.match(/\{\s*"say"[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.say) {
        const cue = {
          say: parsed.say,
          data: parsed.data || '',
          material_url: '',
        };
        return sanitizeCardData(cue, brief);
      }
    }
  } catch {
    /* fallback ignore */
  } finally {
    fs.rmSync(promptFile, { force: true });
  }

  return {
    say: 'ご質問ありがとうございます。詳細につきましては、社内確認の上本日中に追ってご回答させていただきます。',
    data: '',
    material_url: '',
  };
}

export async function main(argv = process.argv.slice(2)) {
  const command = argv[0];

  if (command === 'doctor') {
    const playwrightInfo = await checkPlaywrightAvailable();
    const profileDir = path.join(os.homedir(), '.claude', 'browser-profiles', 'meet-bot-seisaku');
    const loggedIn = await checkProfileLoggedIn(profileDir);

    let jevDoctor = { ok: false };
    try {
      jevDoctor = await jevMain(['doctor']);
    } catch { /* ignore */ }

    let dwdTokenOk = false;
    try {
      const token = await getDocsToken();
      dwdTokenOk = Boolean(token);
    } catch { /* ignore */ }

    const report = {
      playwrightAvailable: playwrightInfo.available,
      chromeExecutable: playwrightInfo.executablePath || null,
      botProfileLoggedIn: loggedIn,
      jev: jevDoctor,
      dwdToken: dwdTokenOk,
    };

    console.log(JSON.stringify(report, null, 2));
    return report;
  }

  if (command === 'login') {
    const { values } = parseArgs({
      args: argv.slice(1),
      allowPositionals: true,
      options: {
        'from-chrome-profile': { type: 'string' },
      },
    });

    if (values['from-chrome-profile']) {
      const profileName = values['from-chrome-profile'];
      const res = copyProfileFromChrome(profileName);
      if (!res.ok) {
        if (isEntry(import.meta.url)) process.exit(res.code || 1);
        return res;
      }
      return { ok: true, result: res };
    }

    const profileDir = path.join(os.homedir(), '.claude', 'browser-profiles', 'meet-bot-seisaku');
    console.log(`[meet-cue] プロファイル "${profileDir}" でログイン用ブラウザを起動します...`);

    const { available, chromium } = await checkPlaywrightAvailable();
    if (!available || !chromium) {
      console.error('Error: Chrome / Playwright が利用できません。');
      process.exit(1);
    }

    fs.mkdirSync(profileDir, { recursive: true });

    const result = await runHumanLogin({
      chromium,
      profileDir,
      url: 'https://accounts.google.com/ServiceLogin?continue=https://meet.google.com/',
      requiredCookies: ['SID', 'HSID', 'SSID'],
      cookieDomain: '.google.com',
      deps: { log: (m) => console.log(m) },
    });

    if (result.code === 0) {
      console.log('[meet-cue] ログイン処理を完了しました。');
      return { ok: true, result };
    } else {
      console.error(`[meet-cue] ログイン処理失敗 (code: ${result.code})`);
      if (isEntry(import.meta.url)) process.exit(result.code);
      return { ok: false, result };
    }
  }

  if (command === 'say') {
    const { values, positionals } = parseArgs({
      args: argv.slice(1),
      allowPositionals: true,
      options: {
        session: { type: 'string' },
        material: { type: 'string' },
        data: { type: 'string' },
      },
    });

    const sessionId = values.session || getLatestSessionId();
    if (!sessionId) {
      console.error('Error: セッション ID が指定されていないか、latest が存在しません。');
      process.exit(2);
    }

    const sessionDir = path.join(meetCueBaseDir(), sessionId);
    const sessionFile = path.join(sessionDir, 'session.json');

    if (!fs.existsSync(sessionFile)) {
      console.error(`Error: セッション情報が見つかりません (${sessionDir})`);
      process.exit(2);
    }

    const sessionData = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    const sayText = positionals[0] || values.say || '';

    if (!sayText) {
      console.error('Error: 送信するセリフが指定されていません。');
      process.exit(2);
    }

    const cue = {
      say: sayText,
      data: values.data || '',
      material_url: values.material || '',
    };

    console.log(`[meet-cue say] セッション ${sessionId} の Doc へ kim 指示を差し込み中...`);
    const result = await insertCueToDocument({
      docId: sessionData.docId,
      cue,
      isKim: true,
      insertIndex: sessionData.headerInsertIndex || 1,
    });

    console.log(`[meet-cue say] 差し込み完了 (${result.timestampStr}): 【kimより】${sayText}`);
    return { ok: true, result };
  }

  if (command === 'simulate') {
    const { values } = parseArgs({
      args: argv.slice(1),
      allowPositionals: true,
      options: {
        'transcript-file': { type: 'string' },
        brief: { type: 'string' },
        'brief-file': { type: 'string' },
        'cards-file': { type: 'string' },
        doc: { type: 'boolean' },
        staff: { type: 'string' },
        'no-cooldown': { type: 'boolean' },
      },
    });

    if (!values['transcript-file']) {
      console.error('Error: --transcript-file が必要です。');
      process.exit(2);
    }

    const transcriptContent = fs.readFileSync(values['transcript-file'], 'utf8');
    const parsedLines = parseSimulateTranscript(transcriptContent);

    let brief = values.brief || '';
    if (values['brief-file']) {
      brief = fs.readFileSync(values['brief-file'], 'utf8');
    }

    let cards = [...STANDARD_CARDS];
    if (values['cards-file']) {
      cards = JSON.parse(fs.readFileSync(values['cards-file'], 'utf8'));
    } else if (brief) {
      cards = await generateCardsFromBrief(brief);
    }

    let docInfo = null;
    if (values.doc) {
      console.log('[meet-cue simulate] カンペ Doc を作成中...');
      docInfo = await setupCueDocument({
        title: 'シミュレーション',
        staff: values.staff || 'seisaku-team@orgiast.jp',
      });
      console.log(`[meet-cue simulate] Doc 作成完了: ${docInfo.staffUrl}`);
    }

    const assembler = new CaptionAssembler();
    const tracker = values['no-cooldown']
      ? new CueTracker({ globalCooldownMs: 0, cardRepeatCooldownMs: 0 })
      : new CueTracker();
    let simulatedTime = Date.now();

    console.log(`[meet-cue simulate] ${parsedLines.length} 行の字幕シミュレーションを開始します...`);

    for (let i = 0; i < parsedLines.length; i++) {
      const line = parsedLines[i];
      simulatedTime += 4000;

      assembler.pushMutation({
        speaker: line.speaker,
        text: line.text,
        timestamp: simulatedTime,
      });

      assembler.tick(simulatedTime);

      await runDecisionRound({
        assembler,
        tracker,
        cards,
        brief,
        now: simulatedTime,
        askJev: (opts) => askJev({ ...opts, label: 'meet-cue-simulate' }),
        generateHelpCue,
        insertCue: docInfo ? async (cueToPresent) => {
          await insertCueToDocument({
            docId: docInfo.docId,
            cue: cueToPresent,
            insertIndex: docInfo.headerInsertIndex,
          });
        } : null,
        label: 'meet-cue-simulate',
        log: (decision, cueToPresent) => {
          console.log(`\n>>> カンペ発動 [${decision.phase}] -> ${cueToPresent.title || '助け舟'}`);
          console.log(`    【言うこと】${cueToPresent.say}`);
          if (cueToPresent.data) console.log(`    根拠: ${cueToPresent.data}`);
        },
      });
    }

    console.log('\n[meet-cue simulate] シミュレーション完了。出されたカンペ数:', tracker.history.length);
    return { ok: true, cuesCount: tracker.history.length };
  }

  if (command === 'start') {
    const { values } = parseArgs({
      args: argv.slice(1),
      allowPositionals: true,
      options: {
        url: { type: 'string' },
        staff: { type: 'string' },
        title: { type: 'string' },
        brief: { type: 'string' },
        'brief-file': { type: 'string' },
        'cards-file': { type: 'string' },
        'doc-id': { type: 'string' },
        mode: { type: 'string' },
        'max-minutes': { type: 'string' },
        'interval-sec': { type: 'string' },
        'debug-dom': { type: 'boolean' },
      },
    });

    if (!values.url || !values.staff) {
      console.error('Error: --url <Meet URL> と --staff <社員メール> は必須です。');
      console.error('使い方: node tools/meet-cue.mjs start --url <Meet URL> --staff <メール> [--title <名>] [--brief <本文>]');
      process.exit(2);
    }

    const sessionId = generateSessionId();
    const sessionDir = path.join(meetCueBaseDir(), sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });
    saveLatestSessionId(sessionId);

    console.log(`[meet-cue start] セッション開始: ${sessionId}`);

    let brief = values.brief || '';
    if (values['brief-file']) {
      brief = fs.readFileSync(values['brief-file'], 'utf8');
    }

    // 1. Setup or reuse Cue Doc
    let docInfo;
    if (values['doc-id']) {
      const docId = values['doc-id'];
      const headerInsertIndex = await findHeaderInsertIndex({ docId });
      docInfo = {
        docId,
        docName: values.title || '打合せ',
        staffUrl: `https://docs.google.com/document/d/${docId}/edit?authuser=${encodeURIComponent(values.staff)}`,
        kimUrl: `https://docs.google.com/document/d/${docId}/edit?authuser=kim@orgiast.jp`,
        headerInsertIndex,
      };
      console.log(`[meet-cue start] 既存 Doc ID を使用: ${docId} (headerInsertIndex: ${headerInsertIndex})`);
    } else {
      console.log(`[meet-cue start] カンペ Doc を作成中...`);
      docInfo = await setupCueDocument({
        title: values.title || '打合せ',
        staff: values.staff,
      });
    }

    console.log(`\n==================================================`);
    console.log(`カンペ Doc (社員用): ${docInfo.staffUrl}`);
    console.log(`カンペ Doc (kim用):   ${docInfo.kimUrl}`);
    console.log(`==================================================\n`);

    // 2. Prepare Cards
    let cards = [...STANDARD_CARDS];
    if (values['cards-file']) {
      cards = JSON.parse(fs.readFileSync(values['cards-file'], 'utf8'));
    } else if (brief) {
      console.log('[meet-cue start] 事前情報からカンペカードを生成中...');
      cards = await generateCardsFromBrief(brief);
    }

    fs.writeFileSync(path.join(sessionDir, 'cards.json'), JSON.stringify(cards, null, 2));

    const sessionState = {
      sessionId,
      url: values.url,
      staff: values.staff,
      title: values.title || '打合せ',
      docId: docInfo.docId,
      docName: docInfo.docName,
      staffUrl: docInfo.staffUrl,
      kimUrl: docInfo.kimUrl,
      headerInsertIndex: docInfo.headerInsertIndex,
      startTime: new Date().toISOString(),
    };

    fs.writeFileSync(path.join(sessionDir, 'session.json'), JSON.stringify(sessionState, null, 2));

    const assembler = new CaptionAssembler();
    const tracker = new CueTracker();
    const transcriptStream = fs.createWriteStream(path.join(sessionDir, 'transcript.jsonl'), { flags: 'a' });
    const cuesStream = fs.createWriteStream(path.join(sessionDir, 'cues.jsonl'), { flags: 'a' });

    let jevCallCount = 0;
    let newCharsSinceLastCheck = 0;

    // 3. Start Meet Bot
    const bot = await startMeetBot({
      url: values.url,
      mode: values.mode || 'profile',
      maxMinutes: parseInt(values['max-minutes'] || '120', 10),
      debugDom: Boolean(values['debug-dom']),
      sessionDir,
      onCaption: ({ speaker, text, timestamp }) => {
        const newlyFinalized = assembler.pushMutation({ speaker, text, timestamp });
        for (const line of newlyFinalized) {
          transcriptStream.write(JSON.stringify(line) + '\n');
          newCharsSinceLastCheck += line.text.length;
        }
      },
      log: console.log,
    });

    // Handle Ctrl+C
    let isTerminating = false;
    const cleanup = async () => {
      if (isTerminating) return;
      isTerminating = true;
      console.log('\n[meet-cue start] 終了処理を開始します...');

      await bot.stop();

      transcriptStream.end();
      cuesStream.end();

      const summary = {
        sessionId,
        title: values.title || '打合せ',
        staff: values.staff,
        startTime: sessionState.startTime,
        endTime: new Date().toISOString(),
        captionLineCount: assembler.finalizedLines.length,
        jevCallCount,
        presentedCuesCount: tracker.history.length,
        presentedCues: tracker.history,
        docUrl: docInfo.kimUrl,
      };

      fs.writeFileSync(path.join(sessionDir, 'summary.json'), JSON.stringify(summary, null, 2));

      // Add to kim-inbox
      try {
        await addItem(homeDir(), {
          kind: 'info',
          text: `【Meetカンペ完了】\n打合せ: ${values.title || '打合せ'}\n社員: ${values.staff}\n字幕行数: ${assembler.finalizedLines.length} / カンペ数: ${tracker.history.length}\nDoc (kim用): ${docInfo.kimUrl}`,
          source: 'meet-cue',
        });
      } catch (e) {
        console.error('meet-cue: kim-inbox 追加エラー:', e.message);
      }

      console.log(`[meet-cue start] セッション終了。まとめを保存しました (${sessionDir})`);
      process.exit(0);
    };

    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);

    // 4. Decision Loop
    const intervalSec = parseInt(values['interval-sec'] || '12', 10);
    const loopIntervalMs = intervalSec * 1000;

    const decisionLoop = async () => {
      while (!isTerminating) {
        await new Promise(r => setTimeout(r, loopIntervalMs));
        if (isTerminating) break;

        const now = Date.now();
        const newlyFinalized = assembler.tick(now);
        for (const line of newlyFinalized) {
          transcriptStream.write(JSON.stringify(line) + '\n');
          newCharsSinceLastCheck += line.text.length;
        }

        // Trigger Jev if interval passed or >= 60 new chars accumulated
        if (assembler.finalizedLines.length > 0 && (newCharsSinceLastCheck >= 60 || jevCallCount === 0)) {
          newCharsSinceLastCheck = 0;
          jevCallCount++;

          await runDecisionRound({
            assembler,
            tracker,
            cards,
            brief,
            now,
            askJev: (opts) => askJev({ ...opts, label: 'meet-cue-loop' }),
            generateHelpCue,
            insertCue: async (cueToPresent) => {
              await insertCueToDocument({
                docId: docInfo.docId,
                cue: cueToPresent,
                insertIndex: docInfo.headerInsertIndex,
              });
            },
            label: 'meet-cue-loop',
            onCue: async ({ timestamp, action, cue }) => {
              cuesStream.write(JSON.stringify({ timestamp, action, cue }) + '\n');
            },
            log: (decision, cueToPresent) => {
              console.log(`\n[meet-cue] カンペ差し込み [${decision.phase}]: ${cueToPresent.title || '助け舟'} -> "${cueToPresent.say}"`);
            },
          });
        }
      }
    };

    // Run decision loop concurrently with bot monitor
    Promise.race([bot.monitorPromise, decisionLoop()]).then(cleanup);
    return { ok: true, sessionId };
  }

  console.error('無効なサブコマンドです。使い方: start, say, simulate, login, doctor');
  process.exit(2);
}

if (isEntry(import.meta.url)) {
  main().catch(err => {
    console.error('meet-cue 致命的エラー:', err);
    process.exit(1);
  });
}
