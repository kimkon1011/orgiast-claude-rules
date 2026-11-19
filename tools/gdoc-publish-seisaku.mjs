#!/usr/bin/env node
/**
 * gdoc-publish.mjs のラッパー。認証を seisaku-team@orgiast.jp (GWS_USER) で行う。
 * この PC には SA 鍵ファイルが無く、kim@orgiast.jp は GWS proxy で calendar 限定のため。
 */
import { main } from './gdoc-publish.mjs';
import { getDriveToken } from './lib/drive-auth.mjs';

// impersonate を seisaku-team@orgiast.jp に固定（kim@orgiast.jp の Drive 権限が proxy で制限されているため）
const customGetToken = (opts) => getDriveToken({ ...opts, impersonate: 'seisaku-team@orgiast.jp' });

process.exitCode = await main(process.argv.slice(2), { getToken: customGetToken });