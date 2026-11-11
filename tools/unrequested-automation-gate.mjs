#!/usr/bin/env node
export const GATE_CONTRACT = { "name": "unrequested-automation-gate", "remedies": [{ "kind": "repo-file", "ref": "tools/gate-remedies.md", "section": "unrequested-automation-gate" }] };

import fs from 'node:fs';
import path from 'node:path';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';
import { isEntry } from './is-entry.mjs';

const EXCLUDED_PATHS = /(?:^|\/)(?:orgiast-claude-rules|nightly-repo|\.claude|node_modules|\.next|dist|build)(?:\/|$)|\.test\.[^/]+$|\.md$|\.lock$|package-lock\.json$/i;

const DELIVERY_SIGNALS = [
  /DISCORD_WEBHOOK/i,
  /discord\.com\/api\/webhooks/i,
  /discordUsername/i,
  /sendDiscord/i,
  /postDiscord/i,
  /send_message/i,
  /\/channels\//i,
  /\/messages/i,
  /hooks\.slack\.com/i,
  /chat\.postMessage/i,
  /api\.line\.me/i,
  /pushMessage/i,
  /\bbroadcast\b/i,
  /nodemailer/i,
  /users\.messages\.send/i,
  /sendMail\(/i,
  /gmail-draft\.mjs/i,
  /@everyone/i,
  /@here/i,
  /<@/i,
  /"recipients"/i,
  /"mentions"/i,
  /notifyUsers/i,
  /リマインド/i,
  /アナウンス/i,
  /お知らせ/i,
  /通知を送/i,
  /連絡を送/i,
];

const SCHEDULE_SIGNALS = [
  /"crons"/i,
  /cronExpression/i,
  /node-cron/i,
  /schedule\.scheduleJob/i,
  /schedule:/i,
  /- cron:/i,
  /["'][\d*/,-]+\s+[\d*/,-]+\s+[\d*/,-]+\s+[\d*/,-]+\s+[\d*/,-]+["']/,
  /schtasks\s+\/create/i,
  /Register-ScheduledTask/i,
  /create_scheduled_task/i,
  /CronCreate/i,
  /fireAt/i,
  /"day"/i,
  /"startDay"/i,
  /"dailyFrom"/i,
  /"dailyTo"/i,
  /"months"/i,
  /"bonusMonths"/i,
  /"deadlineDay"/i,
  /"everyMonth"/i,
  /"interval"/i,
];

export function hasRequesterMarker(text) {
  if (!text) return false;
  const str = String(text);

  if (/REQUESTED-BY:\s*\S+\s+\d{4}[-/]\d{1,2}[-/]\d{1,2}/i.test(str)) {
    return true;
  }

  const lines = str.split(/\r?\n/);
  for (const line of lines) {
    if (/(?:依頼元|依頼者):[^\r\n]{1,30}?\d{4}[-/]\d{1,2}[-/]\d{1,2}/i.test(line)) {
      return true;
    }

    const dateMatch = line.match(/\d{4}[-/]\d{1,2}[-/]\d{1,2}/);
    if (dateMatch) {
      const actionMatch = line.match(/(?:指定|依頼|指示|要望)/);
      if (actionMatch) {
        const stripped = line.replace(/\d{4}[-/]\d{1,2}[-/]\d{1,2}/g, '').replace(/(?:指定|依頼|指示|要望)/g, '');
        const tokens = stripped.match(/[^\s(){}\[\]"':;,]+/g) || [];
        const validName = tokens.some(t => t.length >= 1 && t.length <= 20);
        if (validName) {
          return true;
        }
      }
    }
  }
  return false;
}

export function hasDeliverySignal(text) {
  if (!text) return false;
  const str = String(text);
  return DELIVERY_SIGNALS.some(pattern => pattern.test(str));
}

export function getDeliverySignalMatch(text) {
  if (!text) return null;
  const str = String(text);
  const matchedPattern = DELIVERY_SIGNALS.find(pattern => pattern.test(str));
  if (!matchedPattern) return null;
  const match = str.match(matchedPattern);
  return match ? match[0] : null;
}

export function hasScheduleSignal(text) {
  if (!text) return false;
  const str = String(text);
  return SCHEDULE_SIGNALS.some(pattern => pattern.test(str));
}

export function getScheduleSignalMatch(text) {
  if (!text) return null;
  const str = String(text);
  const matchedPattern = SCHEDULE_SIGNALS.find(pattern => pattern.test(str));
  if (!matchedPattern) return null;
  const match = str.match(matchedPattern);
  return match ? match[0] : null;
}

export function buildDenyReason(deliveryMatch, scheduleMatch, filePath) {
  const deliveryStr = deliveryMatch || '配達シグナル';
  const scheduleStr = scheduleMatch || '定期実行シグナル';
  const targetStr = filePath || '対象ファイル/コマンド';
  return `人へ自動で届く通知・定期実行を新しく追加しています（検知: ${deliveryStr} + ${scheduleStr} / ${targetStr}）。
kim が依頼していない自動投稿の再発防止ゲートです（2026-11-11 実害: 依頼なく追加された「銀行残高の同期リマインド」が毎月10日に Discord #経理チームへ投稿されていた）。
次のどちらかをしてください。
1) 依頼があるなら、その設定の同じ追加ブロックに依頼元を書く: 「REQUESTED-BY: <誰が> YYYY-MM-DD」または「<誰が> 指定 YYYY-MM-DD」（実例: keiri-hub/src/data/cashRecurring.json の reminder.cycles「18日から月末まで毎日送る(user 指定 2026-10-22)」）
2) 依頼が無いなら kim に可否を聞く: AskUserQuestion で1行聞くか、node tools/kim-inbox.mjs --add --kind ask --text "<自動通知の内容と宛先>を追加してよいか" で積む。許可が出るまで追加しない。
依頼元が書けない自動通知は、そもそも作ってはいけない（memory feedback-ask-before-adding-scope）。
緊急解除: UNREQUESTED_AUTOMATION_GATE=off`;
}

export function evaluate(input) {
  if (process.env.UNREQUESTED_AUTOMATION_GATE === 'off') return;
  const tool = input.tool_name;
  const args = input.tool_input || {};
  const cwd = input.cwd || process.cwd();

  if (['Write', 'Edit', 'MultiEdit'].includes(tool)) {
    if (typeof args.file_path !== 'string') return;
    const file = path.resolve(cwd, args.file_path);
    const normalized = file.replaceAll('\\', '/');
    if (EXCLUDED_PATHS.test(normalized)) return;

    const edits = tool === 'MultiEdit'
      ? (Array.isArray(args.edits) ? args.edits : [])
      : [tool === 'Write' ? { new_string: args.content, old_string: '' } : args];

    let existing = '';
    try { existing = fs.readFileSync(file, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }

    if (hasRequesterMarker(existing)) return;
    if (edits.some(e => hasRequesterMarker(e.new_string))) return;

    for (const edit of edits) {
      const newStr = edit.new_string || '';
      const oldStr = edit.old_string || '';

      const newHasDelivery = hasDeliverySignal(newStr);
      const newHasSchedule = hasScheduleSignal(newStr);
      if (newHasDelivery && newHasSchedule) {
        const oldHasDelivery = hasDeliverySignal(oldStr);
        const oldHasSchedule = hasScheduleSignal(oldStr);
        if (!(oldHasDelivery && oldHasSchedule)) {
          const deliveryMatch = getDeliverySignalMatch(newStr);
          const scheduleMatch = getScheduleSignalMatch(newStr);
          return buildDenyReason(deliveryMatch, scheduleMatch, path.basename(file));
        }
      }
    }
  }

  if (['Bash', 'PowerShell'].includes(tool) && typeof args.command === 'string') {
    const cmd = args.command;
    const isScheduleCreation = (
      (/schtasks/i.test(cmd) && /\/create/i.test(cmd)) ||
      /Register-ScheduledTask/i.test(cmd) ||
      /New-ScheduledTaskTrigger/i.test(cmd)
    );

    if (isScheduleCreation) {
      const isDeliveryCommand = /discord|slack|line|mail|notify|リマインド/i.test(cmd);
      if (isDeliveryCommand && !hasRequesterMarker(cmd)) {
        const deliveryMatch = cmd.match(/discord|slack|line|mail|notify|リマインド/i)?.[0];
        const scheduleMatch = cmd.match(/schtasks|\/create|Register-ScheduledTask|New-ScheduledTaskTrigger/i)?.[0];
        return buildDenyReason(deliveryMatch, scheduleMatch, 'command');
      }
    }
  }
}

if (isEntry(import.meta.url)) {
  try {
    const raw = await readStdinWithTimeout();
    if (raw) {
      const reason = evaluate(JSON.parse(raw));
      if (reason) {
        console.log(JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: reason
          }
        }));
      }
    }
  } catch {
    /* Fail open on malformed input or unavailable files. */
  }
}
