#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';
import { clean, parseDismissId, loadRelayConfig, runGh, relayRequest } from './feedback-to-issues.mjs';

const GITHUB_ISSUE_OR_PR = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/(?:issues|pull)\/(\d+)/i;

function repositoryName(entry) {
  if (typeof entry === 'string') return entry;
  return entry?.nameWithOwner || entry?.full_name || null;
}

export function pickCommentTarget(reply, searchResults) {
  const urls = Array.isArray(reply?.replied_to_urls) ? reply.replied_to_urls : [];
  for (const url of urls) {
    const match = GITHUB_ISSUE_OR_PR.exec(clean(url));
    if (match) return { repo: match[1], number: Number(match[2]) };
  }
  const results = Array.isArray(searchResults) ? searchResults : [];
  if (results.length !== 1) return null;
  const repo = repositoryName(results[0]?.repository);
  const number = Number(results[0]?.number);
  return repo && Number.isInteger(number) ? { repo, number } : null;
}

function toJst(isoText) {
  const date = new Date(isoText);
  if (Number.isNaN(date.getTime())) return clean(isoText);
  try {
    const formatted = new Intl.DateTimeFormat('ja-JP', {
      timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(date);
    return `${formatted} JST`;
  } catch {
    return clean(isoText);
  }
}

export function buildReplyComment(reply) {
  const lines = [
    `kim からの実行指示（Discord DM 返信 / ${toJst(reply?.created_at)}）`,
    '',
    clean(reply?.content) || '（本文なし）',
    '',
    `<!-- feedback-reply:${clean(reply?.reply_id)} -->`,
  ];
  return lines.join('\n');
}

export function hasAlreadyCommented(comments, replyId) {
  const marker = `<!-- feedback-reply:${clean(replyId)} -->`;
  return (Array.isArray(comments) ? comments : []).some((comment) => String(comment?.body ?? '').includes(marker));
}

function repliesUrls(base, limit) {
  const list = new URL(base);
  list.pathname = `${list.pathname.replace(/\/$/, '')}/replies`;
  list.search = '';
  list.searchParams.set('limit', String(limit));
  const ack = new URL(base);
  ack.pathname = `${ack.pathname.replace(/\/$/, '')}/replies/ack`;
  ack.search = '';
  return { list, ack };
}

function increment(reasons, reason) {
  reasons[reason] = (reasons[reason] || 0) + 1;
}

async function findSearchResults(reply) {
  const messageId = clean(reply?.replied_to_message_id);
  if (!messageId) return [];
  const search = runGh(['search', 'issues', `feedback-dm:${messageId}`, '--json', 'repository,number', '--limit', '5']);
  if (search.error || search.status !== 0) return [];
  try {
    const parsed = JSON.parse(search.stdout || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function fetchExistingComments(target) {
  const view = runGh(['issue', 'view', String(target.number), '--repo', target.repo, '--json', 'comments']);
  if (view.error || view.status !== 0) return [];
  try {
    const parsed = JSON.parse(view.stdout || '{}');
    return Array.isArray(parsed.comments) ? parsed.comments : [];
  } catch {
    return [];
  }
}

export async function main(args = process.argv.slice(2)) {
  const dry = args.includes('--dry');
  const dismissId = parseDismissId(args);
  const limitIndex = args.indexOf('--limit');
  const requestedLimit = limitIndex >= 0 ? Number.parseInt(args[limitIndex + 1], 10) : 20;
  const limit = Number.isInteger(requestedLimit) && requestedLimit > 0 ? requestedLimit : 20;
  const config = loadRelayConfig();
  if (!config.url || !config.secret) {
    console.log('feedback-replies: 中継が未設定なのでスキップ');
    return 0;
  }
  const urls = repliesUrls(config.url, limit);

  if (dismissId !== null) {
    if (!dismissId) {
      console.error('feedback-replies: --dismiss には message_id を指定する');
      return 1;
    }
    if (dry) {
      console.log(`feedback-replies: 対象外予定（--dry） message_id=${dismissId}`);
      return 0;
    }
    try {
      const ack = await relayRequest(urls.ack, config.secret, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message_id: dismissId }),
      });
      if (ack.acked !== true) throw new Error('acked=true ではない応答');
    } catch (error) {
      console.error(`feedback-replies: 対象外化に失敗 message_id=${dismissId} (${error.message})`);
      return 1;
    }
    console.log(`feedback-replies: 対象外にしました message_id=${dismissId}`);
    return 0;
  }

  const probe = runGh(['--version']);
  if (probe.error || probe.status !== 0) {
    console.log('feedback-replies: gh が無いのでスキップ');
    return 0;
  }

  let items;
  try {
    const data = await relayRequest(urls.list, config.secret);
    if (!Array.isArray(data.items)) throw new Error('items が配列ではない応答');
    items = data.items;
  } catch (error) {
    console.error(`feedback-replies: 中継からの取得に失敗 (${error.message})`);
    return 1;
  }

  const selected = items.slice(0, limit);
  const overLimit = Math.max(0, items.length - limit);
  const reasons = {};
  let commented = 0;
  let acked = 0;

  for (const reply of selected) {
    const replyId = clean(reply?.reply_id) || '不明';
    // URL 判定を最優先し、無ければマーカー検索の結果で決める(0件/複数件は推測しない)。
    let target = pickCommentTarget(reply, []);
    if (!target) target = pickCommentTarget(reply, await findSearchResults(reply));
    if (!target) {
      console.log(`feedback-replies: 貼り先が特定できない(0件 or 複数件)のでスキップ reply_id=${replyId}`);
      increment(reasons, '貼り先不明');
      continue;
    }
    if (dry) {
      console.log(`feedback-replies: コメント予定 repo=${target.repo}#${target.number} reply_id=${replyId}`);
      continue;
    }

    const comments = await fetchExistingComments(target);
    if (hasAlreadyCommented(comments, reply.reply_id)) {
      console.log(`feedback-replies: 既にコメント済みなので ack のみ repo=${target.repo}#${target.number} reply_id=${replyId}`);
    } else {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-reply-'));
      const bodyFile = path.join(tempDir, 'body.md');
      let posted = false;
      try {
        fs.writeFileSync(bodyFile, buildReplyComment(reply), 'utf8');
        const result = runGh(['issue', 'comment', String(target.number), '--repo', target.repo, '--body-file', bodyFile]);
        if (result.error || result.status !== 0) throw new Error(clean(result.stderr) || result.error?.message || `gh exit ${result.status}`);
        posted = true;
        commented += 1;
        console.log(`feedback-replies: コメント済み repo=${target.repo}#${target.number} reply_id=${replyId}`);
      } catch (error) {
        console.error(`feedback-replies: コメント失敗 reply_id=${replyId} (${error.message})`);
        increment(reasons, 'コメント失敗');
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
      if (!posted) continue;
    }

    try {
      const ack = await relayRequest(urls.ack, config.secret, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message_id: reply.reply_id }),
      });
      if (ack.acked !== true) throw new Error('acked=true ではない応答');
      acked += 1;
    } catch (error) {
      console.warn(`feedback-replies: コメントは投稿したが ack に失敗（次回重複コメントの可能性） reply_id=${replyId} (${error.message})`);
      increment(reasons, 'ack失敗');
    }
  }

  if (overLimit > 0) console.log(`feedback-replies: 上限を超えた ${overLimit}件は次回に回します`);
  const skipped = Object.values(reasons).reduce((sum, count) => sum + count, 0);
  const details = Object.entries(reasons).map(([reason, count]) => `${reason}:${count}`).join(', ') || 'なし';
  // dry-run と未 ack の項目はすべて中継に残るため、取得範囲内の残件として明示する。
  const remaining = dry ? items.length : items.length - acked;
  console.log(`コメント: ${dry ? 0 : commented}件 / スキップ: ${skipped}件（${details}）/ 残り: ${remaining}件`);
  return 0;
}

if (isEntry(import.meta.url)) process.exitCode = await main();
