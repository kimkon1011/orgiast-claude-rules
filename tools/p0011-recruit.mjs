#!/usr/bin/env node
/**
 * P-0011: 課題募集の外部企業協力拡大 — 募集管理ツール
 *
 * 使用方法:
 *   node tools/p0011-recruit.mjs --list                    # 現在のターゲット一覧表示
 *   node tools/p0011-recruit.mjs --phase init              # 初回打診文生成
 *   node tools/p0011-recruit.mjs --phase followup          # フォローアップ対象一覧
 *   node tools/p0011-recruit.mjs --phase summary           # 募集状況サマリー
 *   node tools/p0011-recruit.mjs --add "企業名" --email "..."  # 新規ターゲット追加
 *   node tools/p0011-recruit.mjs --status <id> <status>    # ステータス更新
 *
 * データファイル: data/p0011-target-companies.csv
 *   列: id,company,contact_person,email,phone,score,status,notes,first_contact,last_followup
 *   ステータス: pending(未��診), contacted(打診済み), replied(返信あり),
 *               confirmed(参加確定), declined(辞退), no_response(未返信)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const CSV_PATH = join(DATA_DIR, 'p0011-target-companies.csv');
const SUMMARY_PATH = join(__dirname, '..', 'outputs', 'p0011-summary.md');

// CSV の読み込み
function loadCSV() {
  if (!existsSync(CSV_PATH)) {
    return [];
  }
  const raw = readFileSync(CSV_PATH, 'utf-8').trim();
  if (!raw) return [];
  const lines = raw.split('\n');
  const headers = lines[0].split(',');
  return lines.slice(1).map((line, i) => {
    const vals = line.split(',');
    const obj = {};
    headers.forEach((h, j) => { obj[h.trim()] = (vals[j] || '').trim(); });
    obj._index = i + 1;
    return obj;
  });
}

// CSV の保存
function saveCSV(rows) {
  const headers = ['id','company','contact_person','email','phone','score','status','notes','first_contact','last_followup'];
  const lines = [headers.join(',')];
  rows.forEach(r => {
    lines.push(headers.map(h => r[h] || '').join(','));
  });
  writeFileSync(CSV_PATH, lines.join('\n') + '\n', 'utf-8');
}

// 新しい ID 生成
function nextId(rows) {
  const nums = rows.map(r => parseInt(r.id?.replace(/\D/g, '') || '0', 10));
  const max = nums.length ? Math.max(...nums) : 0;
  return `C${String(max + 1).padStart(3, '0')}`;
}

// 一覧表示
function listCompanies(rows) {
  if (rows.length === 0) {
    console.log('ターゲット企業が登録されていません。 --add で追加してください。');
    return;
  }
  console.log('\n=== ターゲット企業一覧 ===\n');
  console.log('ID\t企業名\t\t\t担当者\t\tスコア\tステータス');
  console.log('-'.repeat(80));
  rows.forEach(r => {
    const name = (r.company || '').padEnd(24).slice(0, 24);
    const person = (r.contact_person || '未特定').padEnd(12).slice(0, 12);
    console.log(`${r.id}\t${name}\t${person}\t${r.score || '-'}\t${r.status || 'pending'}`);
  });
  console.log(`\n合計: ${rows.length}社`);
}

// 初回打診文の生成（プレースホルダ）
function generateInitDrafts(rows) {
  const pending = rows.filter(r => (r.status || 'pending') === 'pending');
  if (pending.length === 0) {
    console.log('打診待ちの企業がありません。');
    return;
  }
  console.log('\n=== 初回打診文（下書き） ===\n');
  pending.forEach(r => {
    const person = r.contact_person && r.contact_person !== '未特定'
      ? `${r.contact_person} 様`
      : 'ご担当者様';
    console.log(`--- ${r.company}（${r.id}） ---`);
    console.log(`件名: 【ご相談】「食×AI ビジネスアイデアピッチ」課題提供企業としてのご参加のお願い`);
    console.log(``);
    console.log(`${r.company}\n${person}`);
    console.log(``);
    console.log(`株式会社オージャストの金功勇です。`);
    console.log(`この度、株式会社エイト主催の「食×AI ビジネスアイデアピッチ」を開催する運びとなり、`);
    console.log(`貴社に課題提供企業としてのご参加をご検討いただけないかと思い、ご連絡いたしました。`);
    console.log(``);
    console.log(`【課題提供企業の役割】`);
    console.log(`・自社の課題（テーマ）を1つ提示いただきます（文面は弊社で下書き可能）`);
    console.log(`・当日のご出席と、参加者ピッチの審査（会場のエイトスペース・原宿にお越しいただき、登壇者・参加者の皆さまと交流していただけます。もちろんオンラインのみでのご参加も可能です）`);
    console.log(`・賞の設定（内容・金額は自由。目安1万円〜10万円）`);
    console.log(``);
    console.log(`【参加メリ���ト】`);
    console.log(`・優秀な人材・起業志望者へのアプローチ機会`);
    console.log(`・自社課題に対する外部の視点からの解決案を入手`);
    console.log(`・イベントを通じた自社の先進的な取り組みのPR`);
    console.log(`・参加費・出展費はかかりません`);
    console.log(``);
    console.log(`ご不明点はお気軽にご連絡ください。`);
    console.log(`株式会社オージャスト\n金功勇\nseisaku-team@orgiast.jp\n`);
  });
}

// フォローアップ対象
function listFollowupTargets(rows) {
  const targets = rows.filter(r => {
    const status = r.status || 'pending';
    return status === 'contacted' || status === 'pending';
  });
  if (targets.length === 0) {
    console.log('フォローアップ対象はありません。');
    return;
  }
  console.log('\n=== フォローアップ対象 ===\n');
  targets.forEach(r => {
    const daysSince = r.last_followup
      ? Math.floor((Date.now() - new Date(r.last_followup).getTime()) / 86400000)
      : '未連絡';
    console.log(`${r.id}\t${r.company}\tステータス: ${r.status}\t最終接触: ${daysSince}日前`);
  });
}

// サマリー出力
function generateSummary(rows) {
  const total = rows.length;
  const statusCounts = {};
  rows.forEach(r => {
    const s = r.status || 'pending';
    statusCounts[s] = (statusCounts[s] || 0) + 1;
  });
  const summary = `# P-0011 募集状況サマリー
生成日時: ${new Date().toISOString()}

## 全体状況
- ターゲット企業数: ${total}社
${Object.entries(statusCounts).map(([k, v]) => `- ${statusLabel(k)}: ${v}社`).join('\n')}

## ステータス定義
| ステータス | 意味 |
|-----------|------|
| pending | 未打診 |
| contacted | 打診済み（返信待ち） |
| replied | 返信あり（調整中） |
| confirmed | 参加確定 |
| declined | 辞退 |
| no_response | 未返信（期限切れ） |
`;
  if (!existsSync(join(__dirname, '..', 'outputs'))) {
    mkdirSync(join(__dirname, '..', 'outputs'), { recursive: true });
  }
  writeFileSync(SUMMARY_PATH, summary, 'utf-8');
  console.log(`サマリーを出力しました: ${SUMMARY_PATH}`);
}

function statusLabel(s) {
  const labels = {
    pending: '未打診',
    contacted: '打診済み',
    replied: '返信あり',
    confirmed: '参加確定',
    declined: '辞退',
    no_response: '未返信',
  };
  return labels[s] || s;
}

// メイン
function main() {
  const args = process.argv.slice(2);
  const rows = loadCSV();

  if (args.includes('--list')) {
    listCompanies(rows);
    return;
  }

  if (args.includes('--phase')) {
    const phaseIdx = args.indexOf('--phase') + 1;
    const phase = args[phaseIdx];
    switch (phase) {
      case 'init':
        generateInitDrafts(rows);
        break;
      case 'followup':
        listFollowupTargets(rows);
        break;
      case 'summary':
        generateSummary(rows);
        break;
      default:
        console.error(`不明なフェーズ: ${phase}`);
        process.exit(1);
    }
    return;
  }

  if (args.includes('--add')) {
    const nameIdx = args.indexOf('--add') + 1;
    const emailIdx = args.indexOf('--email');
    const scoreIdx = args.indexOf('--score');
    const name = args[nameIdx];
    if (!name) { console.error('企業名を指定してください'); process.exit(1); }
    const newRow = {
      id: nextId(rows),
      company: name,
      contact_person: '',
      email: emailIdx >= 0 ? args[emailIdx + 1] || '' : '',
      phone: '',
      score: scoreIdx >= 0 ? args[scoreIdx + 1] || 'B' : 'B',
      status: 'pending',
      notes: '',
      first_contact: '',
      last_followup: '',
    };
    rows.push(newRow);
    saveCSV(rows);
    console.log(`追加しました: ${newRow.id} - ${name}`);
    return;
  }

  if (args.includes('--status')) {
    const idIdx = args.indexOf('--status') + 1;
    const id = args[idIdx];
    const newStatus = args[idIdx + 1];
    if (!id || !newStatus) { console.error('ID とステータスを指定してください'); process.exit(1); }
    const row = rows.find(r => r.id === id);
    if (!row) { console.error(`ID ${id} が見つかりません`); process.exit(1); }
    const validStatuses = ['pending','contacted','replied','confirmed','declined','no_response'];
    if (!validStatuses.includes(newStatus)) {
      console.error(`無効なステータス: ${newStatus}。有効: ${validStatuses.join(', ')}`);
      process.exit(1);
    }
    row.status = newStatus;
    row.last_followup = new Date().toISOString().slice(0, 10);
    saveCSV(rows);
    console.log(`更新しました: ${row.id} ${row.company} → ${newStatus}`);
    return;
  }

  // デフォルト: ヘルプ
  console.log(`
使用方法:
  node tools/p0011-recruit.mjs --list                    # 一覧表示
  node tools/p0011-recruit.mjs --phase init              # 初回打診文生成
  node tools/p0011-recruit.mjs --phase followup          # フォローアップ対象
  node tools/p0011-recruit.mjs --phase summary           # サマリー出力
  node tools/p0011-recruit.mjs --add "企業名" --email "..."  # 新規追加
  node tools/p0011-recruit.mjs --status <id> <status>    # ステータス更新
`);
}

main();
