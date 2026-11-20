#!/usr/bin/env node
/**
 * event-reminder.mjs — イベントリマインダー機能
 *
 * AIエージェント向けのイベントリマインダー機能。
 * 開催日時と現在日時から適切なリマインダー種別を判定し、メッセージを生成する。
 *
 * 使い方:
 *   node tools/event-reminder.mjs --help
 *   node tools/event-reminder.mjs --check "2026-12-01" --name "展示会"
 *   node tools/event-reminder.mjs --filter '[{"name":"展示会","date":"2026-12-01"}]'
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// 機能1: リマインダー種別判定
// ---------------------------------------------------------------------------

/**
 * 開催日までの残日数からリマインダー種別を判定する。
 *
 * @param {number} daysUntil - 開催日までの残日数（整数）。負数は過去を表す。
 * @returns {"past" | "today" | "urgent" | "soon" | "upcoming"} 判定結果
 *   - "past": 期限切れ（daysUntil < 0）
 *   - "today": 当日（daysUntil === 0）
 *   - "urgent": 緊急（daysUntil <= 3）
 *   - "soon": 間近（daysUntil <= 7）
 *   - "upcoming": 予定（上記以外）
 * @throws {Error} daysUntil が Number でない場合
 */
export function determineReminderType(daysUntil) {
  if (typeof daysUntil !== 'number' || !Number.isFinite(daysUntil)) {
    throw new Error(`determineReminderType: daysUntil は有限の数値である必要があります (received: ${typeof daysUntil})`);
  }
  if (daysUntil < 0) return 'past';
  if (daysUntil === 0) return 'today';
  if (daysUntil <= 3) return 'urgent';
  if (daysUntil <= 7) return 'soon';
  return 'upcoming';
}

// ---------------------------------------------------------------------------
// 機能2: リマインダーメッセージ生成
// ---------------------------------------------------------------------------

/**
 * リマインダー種別に応じたメッセージを生成する。
 *
 * @param {object} params - 入力パラメータ
 * @param {string} params.eventName - イベント名
 * @param {string} params.eventDate - イベント開催日（ISO 8601 文字列）
 * @param {"past"|"today"|"urgent"|"soon"|"upcoming"} params.reminderType - リマインダー種別
 * @returns {{ subject: string, body: string }} 件名と本文
 * @throws {Error} 必須パラメータが不足している場合
 */
export function generateReminderMessage({ eventName, eventDate, reminderType }) {
  if (!eventName || !eventDate || !reminderType) {
    throw new Error('generateReminderMessage: eventName, eventDate, reminderType は必須です');
  }

  /** 開催日までの残日数（メッセージ内で使う場合のみ計算） */
  const now = new Date();
  const target = new Date(eventDate);
  const diffMs = target.getTime() - now.getTime();
  const daysUntil = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

  /** 日付表示用（YYYY/MM/DD） */
  const dateStr = `${target.getFullYear()}/${String(target.getMonth() + 1).padStart(2, '0')}/${String(target.getDate()).padStart(2, '0')}`;

  switch (reminderType) {
    case 'urgent': {
      const d = Math.max(daysUntil, 1);
      return {
        subject: `【緊急】${eventName} まであと${d}日`,
        body: [
          `イベント「${eventName}」（${dateStr}）の開催まであと${d}日です。`,
          '',
          '以下の準備項目をご確認ください：',
          '  • 参加者リストの最終確認',
          '  • 配布資料・サンプルの準備状況',
          '  • 会場設営・備品の手配',
          '  • 交通手段・宿泊の手配',
          '  • 当日のスケジュール共有',
          '',
          '準備が整っていない項目があれば、至急対応をお願いします。',
        ].join('\n'),
      };
    }
    case 'today': {
      return {
        subject: `【本日】${eventName} 開催日`,
        body: [
          `本日は「${eventName}」（${dateStr}）の開催日です。`,
          '',
          '当日の確認事項：',
          '  • 開場時間・受付準備',
          '  • スタッフの役割確認',
          '  • 配布物・機材の最終チェック',
          '  • 緊急連絡先の共有',
          '',
          '円滑な運営をお祈りします。',
        ].join('\n'),
      };
    }
    case 'soon': {
      const d = Math.max(daysUntil, 1);
      return {
        subject: `【間近】${eventName} まであと${d}日`,
        body: [
          `イベント「${eventName}」（${dateStr}）の開催まであと${d}日です。`,
          '',
          '準備状況をご確認ください：',
          '  • 参加受付の状況確認',
          '  • 資料・機材の準備進捗',
          '  • スタッフへの周知',
          '  • 天候・交通情報の確認',
          '',
          '引き続き準備を進めてください。',
        ].join('\n'),
      };
    }
    case 'upcoming': {
      return {
        subject: `【予定】${eventName} のご案内`,
        body: [
          `イベント「${eventName}」を${dateStr}に開催予定です。`,
          '',
          '日程をあらかじめご確認ください。',
          '詳細が決まり次第、改めてご案内します。',
        ].join('\n'),
      };
    }
    case 'past': {
      return {
        subject: `【終了】${eventName} 開催済み`,
        body: [
          `イベント「${eventName}」（${dateStr}）は開催済みです。`,
          '',
          '振り返り項目：',
          '  • 参加者数・アンケート結果の集計',
          '  • 良かった点・改善点の記録',
          '  • 次回イベントへの反映',
          '  • 経費・精算の処理',
          '',
          'お疲れさまでした。',
        ].join('\n'),
      };
    }
    default: {
      throw new Error(`generateReminderMessage: 未知の reminderType "${reminderType}"`);
    }
  }
}

// ---------------------------------------------------------------------------
// 機能3: 通知対象イベントのフィルタリング
// ---------------------------------------------------------------------------

/**
 * イベント一覧を処理し、リマインダー情報付きの配列を返す。
 *
 * @param {Array<{ name: string, date: string }>} events - イベント一覧
 *   - name: イベント名
 *   - date: ISO 8601 日付文字列
 * @param {Date} [now] - 基準日時（省略時は new Date()）
 * @returns {Array<{ event: object, reminderType: string, daysUntil: number, message: { subject: string, body: string } }>}
 *   各イベントにリマインダー情報を付与した配列。空配列入力時は空配列を返す。
 */
export function filterEventsForReminder(events, now) {
  if (!Array.isArray(events)) {
    throw new Error('filterEventsForReminder: events は配列である必要があります');
  }
  const baseDate = now || new Date();

  return events.map((event) => {
    if (!event.name || !event.date) {
      throw new Error(`filterEventsForReminder: 各イベントには name と date が必要です (received: ${JSON.stringify(event)})`);
    }
    const target = new Date(event.date);
    const diffMs = target.getTime() - baseDate.getTime();
    const daysUntil = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
    const reminderType = determineReminderType(daysUntil);
    const message = generateReminderMessage({
      eventName: event.name,
      eventDate: event.date,
      reminderType,
    });
    return { event, reminderType, daysUntil, message };
  });
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/**
 * コマンドラインから実行されたときのエントリポイント。
 *
 * オプション:
 *   --help        ヘルプ表示
 *   --check <ISO日付> [--name <イベント名>]
 *                  特定日付のリマインダー種別とメッセージを表示
 *   --filter <JSON文字列>
 *                  イベント配列のJSONを渡してフィルタリング結果を表示
 *
 * @param {string[]} [argv] - コマンドライン引数
 * @returns {string} 出力文字列
 */
export function main(argv = process.argv) {
  if (argv.includes('--help') || argv.length <= 2) {
    return [
      '使い方:',
      '  node tools/event-reminder.mjs [options]',
      '',
      'オプション:',
      '  --help                   このヘルプを表示',
      '  --check <ISO日付>        指定日のリマインダー種別を判定',
      '    [--name <イベント名>]  イベント名（省略時は"イベント"）',
      '  --filter <JSON>          イベント配列のJSONを渡して処理',
      '',
      '例:',
      '  node tools/event-reminder.mjs --check 2026-12-01 --name 展示会',
      '  node tools/event-reminder.mjs --filter \'[{"name":"展示会","date":"2026-12-01"}]\'',
    ].join('\n');
  }

  const checkIdx = argv.indexOf('--check');
  if (checkIdx >= 0 && argv[checkIdx + 1]) {
    const dateStr = argv[checkIdx + 1];
    const nameIdx = argv.indexOf('--name');
    const eventName = nameIdx >= 0 && argv[nameIdx + 1] ? argv[nameIdx + 1] : 'イベント';

    const now = new Date();
    const target = new Date(dateStr);
    const diffMs = target.getTime() - now.getTime();
    const daysUntil = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
    const reminderType = determineReminderType(daysUntil);
    const message = generateReminderMessage({ eventName, eventDate: dateStr, reminderType });

    return [
      `イベント: ${eventName}`,
      `開催日: ${dateStr}`,
      `残日数: ${daysUntil}日`,
      `種別: ${reminderType}`,
      `件名: ${message.subject}`,
      `---`,
      message.body,
    ].join('\n');
  }

  const filterIdx = argv.indexOf('--filter');
  if (filterIdx >= 0 && argv[filterIdx + 1]) {
    try {
      const events = JSON.parse(argv[filterIdx + 1]);
      const results = filterEventsForReminder(events);
      return JSON.stringify(results, null, 2);
    } catch (err) {
      return `エラー: ${err.message}`;
    }
  }

  return '不明なオプションです。--help を参照してください。';
}

// ---------------------------------------------------------------------------
// モジュールエントリ
// ---------------------------------------------------------------------------

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const output = main();
  process.stdout.write(output + '\n');
}