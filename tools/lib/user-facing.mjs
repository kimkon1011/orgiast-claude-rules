export const RESEARCH_FIRST_CONTEXT = '[調査優先] この依頼は user に手作業・手順・判断を頼みうる場面です。user に頼む前の調査（過去ログ ~/.claude/projects/**/*.jsonl の Grep・find-session skill・memory の Grep・~/.claude/playbooks/<アプリ>.md）は回数無制限。調査10回は user 往復1回より安い。手順を書く前に、対象アプリ/サービス名で過去ログを検索し、過去に成功した実測手順を使うこと（一般知識で手順を書かない）。';
export function isUserFacingPrompt(prompt) {
  return /画面|スクショ|スクリーンショット|\[Image|\.(?:png|jpe?g|webp)\b|ボタン|タップ|押し|押せ|押す|クリック|表示され|出てきた|出ない|開けない|どこ(?:に|を|で)|どれ(?:を|に)|設定(?:画面|方法)?|手順|やり方|どうすれば|どうやって|ログイン|許可|アプリ|スマホ|Galaxy|iPhone|Android|どっち|どちら|どれがいい|選んで|決めて|おすすめ/i.test(String(prompt || ''));
}
export function isPastLogSearchToolUse(name, input = {}) {
  input ||= {};
  const target = /[\\/]\.claude[\\/](?:projects|playbooks|shared-memory)|[\\/]memory(?:[\\/]|$)/i;
  if (name === 'Grep') return target.test(input.path || '');
  if (name === 'Glob') return target.test(input.path || '') || target.test(input.pattern || '');
  if (name === 'Read') return target.test(input.file_path || '');
  if (name === 'Skill') return input.skill === 'find-session';
  if (['Bash', 'PowerShell'].includes(name)) return /\b(?:grep|rg|Select-String|findstr)\b|find-session/i.test(input.command || '') && /projects|playbooks|memory/i.test(input.command || '');
  return ['Agent', 'Task'].includes(name) && /jsonl|過去ログ|過去セッション|projects|memory|playbook/i.test(input.prompt || '');
}
