#!/usr/bin/env node
import { spawnSync } from 'node:child_process'; import path from 'node:path';
const tools=path.dirname(new URL(import.meta.url).pathname.replace(/^\/(.:)/,'$1'));
for(const script of ['discord-appointment-capture.mjs','unsent-ledger.mjs']){const r=spawnSync(process.execPath,[path.join(tools,script)],{stdio:'inherit',timeout:10*60*1000});if(r.status!==0)process.exit(r.status??1);}
