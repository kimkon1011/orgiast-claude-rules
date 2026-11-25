#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendToast } from '../../tools/autopilot-local-notice.mjs';
const home = path.join(path.dirname(fileURLToPath(import.meta.url)), 'verification/toast-home');
const result = await sendToast('定時進捗報告の通知テスト\nuser 作業待ちは latest-digest.md で確認できます。\nラハイナ Instagram トークン登録', { home });
console.log(JSON.stringify(result));
