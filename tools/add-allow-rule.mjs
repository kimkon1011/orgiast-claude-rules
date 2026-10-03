#!/usr/bin/env node
// allow-rules.json に許可ルールを1本足して converge するだけのツール。
// 追加する内容を必ず画面に出してから書き込む（無言で権限を広げない）。
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'

const RULES = 'C:/Users/uers/Downloads/orgiast-claude-rules/tools/allow-rules.json'
const rule = process.argv[2]
if (!rule) { console.error('使い方: node add-allow-rule.mjs "<allow ルール1行>"'); process.exit(2) }

console.log('--- これから Claude Code に許可する操作 ---')
console.log(rule)
console.log('------------------------------------------')

const json = JSON.parse(fs.readFileSync(RULES, 'utf8'))
if (!Array.isArray(json.allow)) { console.error('allow 配列が見つかりません'); process.exit(1) }

if (json.allow.includes(rule)) {
  console.log('既に登録済みでした（変更なし）')
} else {
  json.allow.unshift(rule)
  fs.writeFileSync(RULES, `${JSON.stringify(json, null, 2)}\n`)
  console.log(`追加しました: allow ${json.allow.length} 本`)
}

console.log('\nsetup --converge で settings.json へ配布します...')
execFileSync('node', ['C:/Users/uers/Downloads/orgiast-claude-rules/tools/setup.mjs', '--converge'], { stdio: 'inherit' })

const settings = fs.readFileSync('C:/Users/uers/.claude/settings.json', 'utf8')
console.log(settings.includes(rule) ? '\n[OK] settings.json に反映されました' : '\n[NG] settings.json に見当たりません')
