import fs from 'fs';
import { pathToFileURL } from 'url';
const req = JSON.parse(fs.readFileSync('C:/Users/uers/.claude/nightly-repo/.landing/growi-req.json','utf8'));
const m = await import(pathToFileURL('C:/Users/uers/.claude/nightly-repo/tools/growi-manual.mjs').href);
for (const it of req.growiAppend) {
  try {
    const dry = await m.appendAfterFromEnv({pagePath: it.path, anchor: it.anchor, lines: it.lines, dryRun: true});
    console.log('DRY ' + JSON.stringify(dry));
    if (!dry.unchanged) {
      const real = await m.appendAfterFromEnv({pagePath: it.path, anchor: it.anchor, lines: it.lines});
      console.log('REAL ' + JSON.stringify(real));
      const back = await m.appendAfterFromEnv({pagePath: it.path, anchor: it.anchor, lines: it.lines, dryRun: true});
      console.log('READBACK ' + JSON.stringify(back));
    }
  } catch (e) {
    console.log('ERROR ' + JSON.stringify({path: it.path, error: e.message, details: e.details ?? null}));
  }
}
