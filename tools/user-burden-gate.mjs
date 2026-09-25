import { hasManualRequest } from './manual-request-fullsteps-gate.mjs';

const fencePattern = /```[^\n]*\n[\s\S]*?```|~~~[^\n]*\n[\s\S]*?~~~/g;
const backReference = /(?:前に送った|先ほどの|さっきの|上の|前述の|以前の|前回の)[^。！？\r\n]{0,60}?(?:[1１一]行|コマンド|手順|リンク|URL|処理|ファイル|ショートカット)/i;
const evidence = /拒否|classifier|OAuth|物理|支払[い]?|同意|権限|認証|アクセス拒否|403|禁止/i;
const operationCount = /[0-9０-９一二三四五六七八九十]+[ \t]*(?:クリック|回|操作|ステップ|タップ)/;

export const desktopLauncherPattern = /(?:[A-Z]:\\|\\\\)[^\r\n<>"`]*\\Desktop\\[^\r\n<>"`]*?\.cmd(?=$|[\s"`）)。，])/im;
const commandPattern = /\b(?:pwsh|powershell|cmd|bash|node|npm|npx|git)\b|\.ps1\b/i;
const explicitCommandRequest = /(?:コマンド|貼る|貼り付け)[^。\r\n]{0,40}(?:教えて|見せて|ください|知りたい|ほしい)|(?:教えて|見せて)[^。\r\n]{0,40}コマンド/;
const tried = /試した|試行|実行|拒否|失敗|403|classifier|不可|不能/i;
const directAttempt = /Claude|自身|直接|①|CLI|PowerShell|Bash/i;
const alternateAttempt = /MCP|CLI|定期ジョブ|fleet|自己修復|別経路|②/i;
export function judgeUserBurden(text, humanText = '') {
  const source = String(text || '');
  // コマンドや引用例を依頼・監査・例外宣言として解釈しない。
  const prose = source.replace(fencePattern, '').replace(/^[ \t]*>.*$/gm, '');
  const nextActions = [...prose.matchAll(/^[ \t]*(?:[-*][ \t]+)?(?:\*\*)?次に\s*kim\s*がすること(?:\*\*)?[ \t]*[:：][ \t]*(.*)$/gm)];
  const triggered = nextActions.some(([, value]) => {
    const action = value.replace(/\*\*/g, '').trim();
    return !/^なし(?:[。．.]?[ \t]*$|[ \t]*[（(][^\r\n]*[）)][。．.]?[ \t]*$)/.test(action);
  }) || desktopLauncherPattern.test(prose) || hasManualRequest(prose)
    || /(?:確認|選択|保存|送信|ダウンロード|インストール|再起動|操作|コピー|貼り付け)(?:し)?て[ \t]*(?:ください|下さい|ほしい|もらえ)/.test(prose)
    || /(?:開いて|押して|貼って|選んで|進んで)[ \t]*(?:ください|下さい|ほしい|もらえ)/.test(prose);
  if (!triggered) return { decision: 'pass', triggered: false, missing: [] };
  if (/\[BURDEN-OK\][ \t]+\S[^\r\n]*/.test(prose)) {
    return { decision: 'pass', triggered: true, missing: [], reason: 'burden-ok' };
  }

  const missing = [];
  const hasLauncher = desktopLauncherPattern.test(source);
  const explicit = explicitCommandRequest.test(String(humanText));
  if (commandPattern.test(source) && !hasLauncher && !explicit) {
    missing.push('tools/make-desktop-launcher.mjs でデスクトップのワンクリック・ファイルにして、その \\Desktop\\ の .cmd パスを示す。PowerShell への貼り付けは頼まない');
  }
  if (backReference.test(prose)) missing.push('遡り参照は禁止。依頼に必要なものを、この応答の中にすべて再掲するか、デスクトップのワンクリック・ショートカットにする');
  const hasFence = (source.match(fencePattern) || []).some(block => block.replace(/^(?:```|~~~)[^\n]*\n/, '').replace(/(?:```|~~~)$/, '').trim());
  if (!hasLauncher && !hasFence && !/https?:\/\/[^\s<>"`]+/i.test(source) && !/C:\\Users\\[^\\\r\n]+\\Desktop\\[^\s<>"`]+/i.test(source)) {
    missing.push('完成品（コードブロック・URL・デスクトップ上のファイルパス）を同じ応答に同梱する');
  }
  const audits = [...prose.matchAll(/^[ \t]*手間監査[:：][ \t]*([^\r\n]*)/gm)].map(([, line]) => line);
  if (!audits.some(line => evidence.test(line) && operationCount.test(line))) {
    missing.push('手間監査: で始まる1行に、Claude 側で吸収できない理由（試した経路・拒否／classifier／OAuth／物理／支払い／同意／権限などの根拠）と user の操作回数（例: 1クリック・年1回）を書く');
  }
  if (hasLauncher && !audits.some(line => {
    const parts = line.split(/[;；。]|(?=②)/);
    return parts.some((part, index) => directAttempt.test(part) && tried.test(part)
      && parts.some((other, otherIndex) => otherIndex !== index && alternateAttempt.test(other) && tried.test(other)))
      && evidence.test(line) && operationCount.test(line);
  })) missing.push('手間監査: の同じ行に①Claude 自身の実行と②別経路の自動化を試した経路名・結果（拒否／classifier 等）を両方書く');
  return missing.length
    ? { decision: 'block', triggered: true, missing, code: 'USER-BURDEN', reason: `[USER-BURDEN] ${missing.join('\n')}\n本当に必要な例外は [BURDEN-OK] <理由> を書く。` }
    : { decision: 'pass', triggered: true, missing: [] };
}
