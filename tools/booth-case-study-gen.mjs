#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const VERSION = '1.0.0';
const defaults = { data: 'data/booth-projects.json', output: 'docs/case-studies' };

function usage() {
  return `booth-case-study-gen v${VERSION}

Usage: node tools/booth-case-study-gen.mjs [options]

Options:
  --data <path>       Project JSON (default: ${defaults.data})
  --output <dir>      Output directory (default: ${defaults.output})
  --dry-run           Generate deterministic placeholder copy without an LLM
  --company-intro     Also generate company-intro.md
  --version           Print version
  --help              Print this help`;
}

function parseArgs(argv) {
  const options = { ...defaults, dryRun: false, companyIntro: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--data' || arg === '--output') {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`${arg} には値が必要です。`);
      options[arg.slice(2)] = argv[++i];
    } else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--company-intro') options.companyIntro = true;
    else if (arg === '--version') options.version = true;
    else if (arg === '--help') options.help = true;
    else throw new Error(`不明なオプションです: ${arg}`);
  }
  return options;
}

function yamlString(value) {
  return JSON.stringify(String(value));
}

function dateFor(project) {
  const match = project.period.match(/(\d{4})年(?:(\d{1,2})月)?/);
  return match ? `${match[1]}-${String(match[2] || 1).padStart(2, '0')}-01` : new Date().toISOString().slice(0, 10);
}

function placeholder(project) {
  const summary = `${project.client}様の「${project.event}」出展に向け、${project.boothSize}の展示ブースを企画・制作しました。${project.description}`;
  const meta = `${project.client}様の${project.event}出展事例。${project.boothSize}で${project.highlights[0]}を実現した、株式会社オージャストの展示会ブース制作実績です。`.slice(0, 120);
  const full = `## プロジェクト概要

${summary}

## ご相談の背景

来場者へ事業の価値を短時間で伝えながら、具体的な商談につながる場をつくることが今回のテーマでした。限られた会期とスペースを有効に使えるよう、展示内容、接客方法、会場内の見え方を整理して計画しました。

## オージャストの提案

${project.description}

特に重視したのは、${project.highlights.join('、')}です。来場者が立ち止まり、展示を理解し、担当者との会話へ自然に進める一連の体験として設計しました。

## 設計・施工のポイント

${project.highlights.map((item) => `### ${item}\n\n展示会場での視認性と運用のしやすさを両立するため、来場者とスタッフ双方の動きを確認しながら細部を調整しました。`).join('\n\n')}

## 成果

${project.results}

企画から設計、グラフィック、施工、会期中の運用までを一貫して支援することで、ブランドの伝わり方と現場の使いやすさを両立しました。`;
  return { summary, full, meta };
}

function promptText(project) {
  return `あなたは株式会社オージャストの展示会ブース事例を執筆する日本語編集者です。次の案件データから、誇張や未記載の数値を加えず、JSONのみを返してください。キーは summary（約80語）、full（800〜1200語のMarkdown）、meta（120文字以内）です。fullには「プロジェクト概要」「ご相談の背景」「提案」「設計・施工のポイント」「成果」の見出しを含め、自然で端正な日本語にしてください。案件データ: ${JSON.stringify(project)}`;
}

function normalizeResponse(response) {
  const raw = typeof response === 'string' ? response : response?.text ?? response?.content ?? response?.output_text;
  if (typeof raw !== 'string') throw new Error('prompt 関数からテキスト応答を取得できませんでした。');
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const parsed = JSON.parse(cleaned);
  if (!parsed.summary || !parsed.full || !parsed.meta) throw new Error('LLM応答に必要なキーがありません。');
  return parsed;
}

async function loadPrompt() {
  try {
    const routing = await import('./provider-routing.mjs');
    return typeof routing.prompt === 'function' ? routing.prompt : null;
  } catch {
    return null;
  }
}

function caseMarkdown(project, copy) {
  const services = project.services.join('、');
  return `---
title: ${yamlString(project.title)}
description: ${yamlString(copy.meta.slice(0, 120))}
date: ${yamlString(dateFor(project))}
projectId: ${yamlString(project.projectId)}
---

# ${project.title}

${copy.summary}

| 項目 | 内容 |
| --- | --- |
| クライアント | ${project.client} |
| 業界 | ${project.industry} |
| 展示会 | ${project.event} |
| ブース規模 | ${project.boothSize} |
| 実施時期 | ${project.period} |
| 対応範囲 | ${services} |

${copy.full.trim()}

## プロジェクトギャラリー

${project.imagePaths.map((imagePath, index) => `![${project.title} ${index + 1}](${imagePath})`).join('\n\n')}
`;
}

async function generateCopy(project, prompt, dryRun) {
  if (dryRun || !prompt) return placeholder(project);
  try {
    return normalizeResponse(await prompt(promptText(project)));
  } catch (error) {
    console.warn(`[警告] ${project.projectId}: LLM生成に失敗したためプレースホルダーを使用します（${error.message}）`);
    return placeholder(project);
  }
}

function validateProjects(value) {
  const fields = ['projectId', 'title', 'client', 'industry', 'event', 'boothSize', 'period', 'services', 'description', 'highlights', 'results', 'imagePaths', 'projectUrl'];
  if (!Array.isArray(value) || value.length === 0) throw new Error('案件データは1件以上の配列である必要があります。');
  for (const [index, project] of value.entries()) {
    for (const field of fields) if (!(field in project)) throw new Error(`案件 ${index + 1} に ${field} がありません。`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return console.log(usage());
  if (options.version) return console.log(VERSION);

  const dataPath = path.resolve(options.data);
  const outputDir = path.resolve(options.output);
  let projects;
  try {
    projects = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
    validateProjects(projects);
    fs.mkdirSync(outputDir, { recursive: true });
  } catch (error) {
    throw new Error(`入力データを準備できません: ${error.message}`);
  }

  const prompt = options.dryRun ? null : await loadPrompt();
  if (!options.dryRun && !prompt) console.warn('[警告] provider-routing.mjs に prompt 関数がないため dry-run 相当で生成します。');

  const generated = [];
  for (const project of projects) {
    const copy = await generateCopy(project, prompt, options.dryRun);
    const filename = `${project.projectId}-case-study.md`;
    try {
      fs.writeFileSync(path.join(outputDir, filename), caseMarkdown(project, copy), 'utf8');
      generated.push({ ...project, filename, description: copy.meta });
    } catch (error) {
      throw new Error(`${filename} を書き込めません: ${error.message}`);
    }
  }

  const index = `---\ntitle: "展示会ブース制作事例"\ndescription: "株式会社オージャストの展示会ブース制作事例一覧"\n---\n\n# 展示会ブース制作事例\n\n${generated.map((item) => `- [${item.title}（${item.client}）](./${item.filename}) — ${item.event}／${item.boothSize}`).join('\n')}\n`;
  fs.writeFileSync(path.join(outputDir, 'index.md'), index, 'utf8');

  if (options.companyIntro) {
    const introPrompt = `株式会社オージャストの会社紹介を、次の展示会ブース制作事例に基づいて600〜800字の日本語Markdownで作成してください。未記載の実績や数値は加えないでください。${JSON.stringify(projects)}`;
    let intro = `# 株式会社オージャストについて\n\n株式会社オージャストは、展示会ブースの企画・設計からグラフィック制作、施工、運営支援までを一貫して手がける制作会社です。\n\n${projects.map((project) => `- **${project.client}様**：${project.event}（${project.boothSize}）で、${project.highlights[0]}を実現しました。`).join('\n')}\n\n業界や展示目的に合わせ、来場者に伝わる空間と現場で運用しやすい動線を丁寧に設計します。`;
    if (!options.dryRun && prompt) {
      try {
        const response = await prompt(introPrompt);
        intro = typeof response === 'string' ? response : response?.text ?? response?.content ?? response?.output_text ?? intro;
      } catch (error) {
        console.warn(`[警告] 会社紹介のLLM生成に失敗したためプレースホルダーを使用します（${error.message}）`);
      }
    }
    fs.writeFileSync(path.join(outputDir, 'company-intro.md'), `${intro.trim()}\n`, 'utf8');
  }

  console.log(`${generated.length}件の事例を ${outputDir} に生成しました。`);
}

main().catch((error) => {
  console.error(`[エラー] ${error.message}`);
  process.exitCode = 1;
});
