import path from 'node:path';

export function detectCodex({ runSync }) {
    const wslListResult = runSync('wsl', ['-l', '-q']);
    if (wslListResult.status !== 0) {
        return { usable: false, via: 'none', distro: '', reason: 'WSL が無い' };
    }
    
    const stdoutClean = wslListResult.stdout.replace(/\0/g, '');
    const lines = stdoutClean.split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0)
        .filter(line => !line.includes('Copyright') && !line.includes('wsl.exe'));
    
    if (lines.length === 0) {
        return { usable: false, via: 'none', distro: '', reason: 'WSL が無い' };
    }
    
    const distros = lines;
    const ubuntuDistro = distros.find(d => d.toLowerCase() === 'ubuntu');
    const targetDistro = ubuntuDistro || distros[0];
    
    const codexResult = runSync('wsl', ['-d', targetDistro, '--', 'codex', '--version']);
    if (codexResult.status === 0) {
        return { usable: true, via: 'wsl', distro: targetDistro, reason: '' };
    }
    
    return { usable: false, via: 'none', distro: '', reason: 'WSL に codex が無い' };
}

export function detectProviders({ homeDir, exists, readFile }) {
    const providerConfigs = [
        ['openrouter', 'openrouter.env', 'OPENROUTER_API_KEY'],
        ['deepseek', 'deepseek.env', 'DEEPSEEK_API_KEY'],
        ['groq', 'groq.env', 'GROQ_API_KEY'],
        ['kimi', 'kimi-api.env', 'MOONSHOT_API_KEY'],
        ['gemini', 'gemini.env', 'GEMINI_API_KEY'],
        ['mistral', 'mistral.env', 'MISTRAL_API_KEY'],
        ['grok', 'xai.env', 'XAI_API_KEY']
    ];
    
    const available = [];
    
    for (const [provider, envFile, keyName] of providerConfigs) {
        const filePath = path.join(homeDir, '.claude', envFile);
        if (!exists(filePath)) {
            continue;
        }
        
        try {
            let content = readFile(filePath, 'utf8');
            if (content.charCodeAt(0) === 0xFEFF) {
                content = content.slice(1);
            }
            
            const lines = content.split('\n');
            for (const line of lines) {
                const regex = new RegExp(`^\\s*(?:export\\s+)?${keyName}\\s*=\\s*(.+)$`);
                const match = line.match(regex);
                if (match) {
                    const value = match[1].trim().replace(/^['"](.*)['"]$/, '$1');
                    if (value) {
                        available.push(provider);
                        break;
                    }
                }
            }
        } catch {
            // 読み取り失敗は無視
        }
    }
    
    return available;
}

export function chooseExecutors(codex, providers) {
    const plan = [];
    
    // role: 実装
    if (codex.usable) {
        plan.push({
            role: '実装',
            provider: 'codex',
            command: 'node tools/codex-do.mjs --prompt-file <指示ファイル> --cwd <リポ>',
            note: ''
        });
    } else {
        // 優先順は providers の並びではなく、この順で固定する（openrouter → deepseek → kimi）。
        const fallback = ['openrouter', 'deepseek', 'kimi'].find(p => providers.includes(p));
        if (fallback) {
            plan.push({
                role: '実装',
                provider: fallback,
                command: `node tools/llm-ask.mjs --provider ${fallback} --max 14000 --prompt-file <指示ファイル> --out <出力ファイル> --system "出力はファイル全文のみ。説明・コードフェンス禁止"`,
                note: `Codex は使えない（${codex.reason}）ので代替ルート。指示は必ず --prompt-file で渡す（argv だとシェルがバッククォートを実行して仕様が消える）`
            });
        } else {
            plan.push({
                role: '実装',
                provider: '',
                command: '',
                note: '委譲先が無い（監督が実装する）'
            });
        }
    }
    
    // role: 分類・量産
    const classifyProvider = providers.includes('groq') ? 'groq' : 
                           providers.includes('openrouter') ? 'openrouter' : '';
    if (classifyProvider === 'groq') {
        plan.push({
            role: '分類・量産',
            provider: 'groq',
            command: 'node tools/llm-ask.mjs --provider groq --max 6000 "<指示>"',
            note: '無料枠 TPM 8,000 のため短文専用'
        });
    } else if (classifyProvider === 'openrouter') {
        plan.push({
            role: '分類・量産',
            provider: 'openrouter',
            command: 'node tools/llm-ask.mjs --provider openrouter --max 6000 "<指示>"',
            note: ''
        });
    } else {
        plan.push({
            role: '分類・量産',
            provider: '',
            command: '',
            note: 'なし'
        });
    }
    
    // role: 長文脈
    const longContextProvider = providers.includes('gemini') ? 'gemini' : 
                              providers.includes('openrouter') ? 'openrouter' : '';
    if (longContextProvider === 'gemini') {
        plan.push({
            role: '長文脈',
            provider: 'gemini',
            command: 'node tools/llm-ask.mjs --provider gemini --max 8000 "<指示>"',
            note: ''
        });
    } else if (longContextProvider === 'openrouter') {
        plan.push({
            role: '長文脈',
            provider: 'openrouter',
            command: 'node tools/llm-ask.mjs --provider openrouter --max 8000 "<指示>"',
            note: ''
        });
    } else {
        plan.push({
            role: '長文脈',
            provider: '',
            command: '',
            note: 'なし'
        });
    }
    
    return plan;
}

export function buildDelegationBlock(plan) {
    const lines = ['## 委譲ルート（このマシンで実測済み・§1.18）'];
    
    for (const item of plan) {
        if (item.provider) {
            let line = `- ${item.role}: ${item.command}`;
            if (item.note) {
                line += ` ※${item.note}`;
            }
            lines.push(line);
        } else {
            lines.push(`- ${item.role}: 利用不可（${item.note}）`);
        }
    }
    
    lines.push('- 監督(あなた)が自分で書いてよいのは「10行未満の修正」「設定値の変更」「テストの実行」だけ。それ以外は必ず上のコマンドで委譲する。');
    lines.push('- 委譲したら、実行したコマンドと結果(成功/失敗)をサマリに1行ずつ残す。');
    lines.push('- 上の実装ルートが失敗したら、失敗の事実をサマリに書いてから次のルートへ落とす。黙って自分で書き直さない。');
    
    return lines.join('\n');
}
