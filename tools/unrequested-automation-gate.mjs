#!/usr/bin/env node
export const GATE_CONTRACT = {"name":"unrequested-automation-gate","remedies":[{"kind":"command","ref":"Write the requester and date into the same added block (REQUESTED-BY: <who> YYYY-MM-DD), or ask kim first. Emergency bypass: UNREQUESTED_AUTOMATION_GATE=off."}]};
import fs from 'node:fs';
import path from 'node:path';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';
import { isEntry } from './is-entry.mjs';

const DATE = '\\d{4}[-/]\\d{1,2}[-/]\\d{1,2}';
const ORIGIN_PATTERNS = [
  new RegExp(`REQUESTED-BY\\s*[:：]\\s*\\S{1,20}[^\\r\\n]{0,30}?${DATE}`, 'i'),
  new RegExp(`(?:依頼元|依頼者)\\s*[:：]\\s*\\S{1,20}[^\\r\\n]{0,30}?${DATE}`),
  // 日本語の実例形式: 「user 指定 2026-10-22」「kim 依頼 2026/11/11」
  new RegExp(`\\S{1,20}?\\s*(?:指定|依頼|指示|要望)\\s*[（(]?\\s*${DATE}`),
  // 日付が先に来る形式: 「2026-10-22 user 指定」
  new RegExp(`${DATE}[^\\r\\n]{0,20}?(?:指定|依頼|指示|要望)`),
];

function hasOriginMarker(text) {
  if (!text || typeof text !== 'string') return false;
  return ORIGIN_PATTERNS.some((re) => re.test(text));
}

const DELIVERY_SIGNALS = [
  { name: 'Discord', re: /DISCORD_WEBHOOK|discord\.com\/api\/webhooks|discordUsername|sendDiscord|postDiscord|send_message/i },
  { name: 'Slack', re: /hooks\.slack\.com|chat\.postMessage/i },
  { name: 'LINE', re: /api\.line\.me|pushMessage|broadcast/i },
  { name: 'メール', re: /nodemailer|users\.messages\.send|sendMail\(|gmail-draft\.mjs/i },
  { name: 'メンション・宛先', re: /@everyone|@here|<@|"recipients"|"mentions"|notifyUsers/i },
  { name: '通知語', re: /リマインド|アナウンス|お知らせ|通知を送|連絡を送/ },
];

const RECURRING_SIGNALS = [
  { name: 'cron設定', re: /"crons"|cronExpression|node-cron|schedule\.scheduleJob/i },
  { name: 'schedule/cron (yml)', re: /^\s*schedule\s*:|^\s*-\s*cron\s*:/m },
  { name: 'cron式リテラル', re: /["'][\d*/,\-]+\s+[\d*/,\-]+\s+[\d*/,\-]+\s+[\d*/,\-]+\s+[\d*/,\-]+["']/ },
  { name: 'OSスケジューラ', re: /schtasks|Register-ScheduledTask|create_scheduled_task|CronCreate|fireAt/i },
  { name: '設定ファイルの日付キー', re: /"(?:day|startDay|dailyFrom|dailyTo|months|bonusMonths|deadlineDay|everyMonth|interval)"\s*:/ },
];

const EXCLUSION_RE = /(?:^|\/)(?:orgiast-claude-rules|nightly-repo|\.claude|node_modules|\.next|dist|build)(?:\/|$)|\.test\.[^/]+$|\.md$|\.lock$|package-lock\.json$/i;

function makeDenyReason(delNameStr, recNameStr, filePath) {
  return `人へ自動で届く通知・定期実行を新しく追加しています（検知: ${delNameStr} + ${recNameStr} / ${filePath}）。
kim が依頼していない自動投稿の再発防止ゲートです（2026-11-11 実害: 依頼なく追加された「銀行残高の同期リマインド」が毎月10日に Discord #経理チームへ投稿されていた）。
次のどちらかをしてください。
1) 依頼があるなら、その設定の同じ追加ブロックに依頼元を書く: 「REQUESTED-BY: <誰が> YYYY-MM-DD」または「<誰が> 指定 YYYY-MM-DD」（実例: keiri-hub/src/data/cashRecurring.json の reminder.cycles「18日から月末まで毎日送る(user 指定 2026-10-22)」）
2) 依頼が無いなら kim に可否を聞く: AskUserQuestion で1行聞くか、node tools/kim-inbox.mjs --add --kind ask --text "<自動通知の内容と宛先>を追加してよいか" で積む。許可が出るまで追加しない。
依頼元が書けない自動通知は、そもそも作ってはいけない。
緊急解除: UNREQUESTED_AUTOMATION_GATE=off`;
}

export function evaluate(input) {
  if (!input) return undefined;
  if (process.env.UNREQUESTED_AUTOMATION_GATE === 'off') return undefined;

  const { tool_name, tool_input, cwd } = input;
  if (!['Write', 'Edit', 'MultiEdit', 'Bash', 'PowerShell'].includes(tool_name)) {
    return undefined;
  }

  if (tool_name === 'Bash' || tool_name === 'PowerShell') {
    const command = tool_input?.command;
    if (typeof command !== 'string') return undefined;

    const isSched = /schtasks[\s\S]*\/create/i.test(command) ||
                    /Register-ScheduledTask/i.test(command) ||
                    /New-ScheduledTaskTrigger/i.test(command);
    const isDelivery = /discord|slack|line|mail|notify|リマインド/i.test(command);
    const hasOrigin = hasOriginMarker(command);

    if (isSched && isDelivery && !hasOrigin) {
      return makeDenyReason('配信通知キーワード', 'スケジュールタスク新規作成', tool_input?.file_path || command);
    }
    return undefined;
  }

  // Write / Edit / MultiEdit
  if (typeof tool_input?.file_path !== 'string') return undefined;

  const file = path.resolve(cwd || process.cwd(), tool_input.file_path);
  const normFile = file.replaceAll('\\', '/');
  if (EXCLUSION_RE.test(normFile)) {
    return undefined;
  }

  let edits;
  if (tool_name === 'MultiEdit') {
    if (!Array.isArray(tool_input.edits)) return undefined;
    edits = tool_input.edits;
  } else if (tool_name === 'Write') {
    edits = [{ new_string: tool_input.content, old_string: '' }];
  } else if (tool_name === 'Edit') {
    edits = [tool_input];
  } else {
    return undefined;
  }

  let existing = '';
  try {
    existing = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }

  if (hasOriginMarker(existing)) {
    return undefined;
  }

  for (const e of edits) {
    const added = String(e?.new_string || '');
    const old = String(e?.old_string || '');

    const addedDelSignals = DELIVERY_SIGNALS.filter((sig) => sig.re.test(added) && !sig.re.test(old));
    const addedRecSignals = RECURRING_SIGNALS.filter((sig) => sig.re.test(added) && !sig.re.test(old));
    const addedHasOrigin = hasOriginMarker(added);

    if (addedDelSignals.length > 0 && addedRecSignals.length > 0 && !addedHasOrigin) {
      const delNameStr = addedDelSignals.map((s) => s.name).join(', ');
      const recNameStr = addedRecSignals.map((s) => s.name).join(', ');
      return makeDenyReason(delNameStr, recNameStr, tool_input.file_path);
    }
  }

  return undefined;
}

if (isEntry(import.meta.url)) {
  try {
    const raw = await readStdinWithTimeout();
    if (raw) {
      const reason = evaluate(JSON.parse(raw));
      if (reason) {
        console.log(
          JSON.stringify({
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason: reason,
            },
          })
        );
      }
    }
  } catch {
    /* 壊れた入力・読めないファイルでは通す（fail open） */
  }
}
