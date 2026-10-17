import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const text = readFileSync('/mnt/c/Users/uers/Downloads/CLAUDE.md配布/購買部管理アプリ/.env.local', 'utf8');
const match = text.match(/^DATABASE_URL\s*=\s*(.*)$/m);
if (!match) throw new Error('Database setting unavailable');
const env = {...process.env,
 PURCHASING_APP_DATABASE_URL: match[1].trim().replace(/^(['"])(.*)\1$/, '$2'),
 GOOGLE_SA_KEY: '/mnt/c/Users/uers/Downloads/CLAUDE.md配布/aujust-sales-automation/.gcp/sheets-sa.json',
 EXPENSE_LEAK_HOME: '/mnt/c/Users/uers/orgiast-main/.expense-leak-evidence/runtime',
 EXPENSE_LEAK_YAHOO_SCRIPT: '/mnt/c/Users/uers/Downloads/CLAUDE.md配布/yahoo-auction-sniper/yahoo-mail-search.mjs',
 ORGIAST_HOME: '/mnt/c/Users/uers',
};
const child = spawnSync(process.execPath, process.argv.slice(2), {env, stdio:'inherit'});
process.exitCode = child.status ?? 1;
