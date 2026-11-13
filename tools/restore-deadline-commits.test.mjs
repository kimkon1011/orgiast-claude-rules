import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { restoreDeadlineCommits } from './restore-deadline-commits.mjs';
test('履歴復元は変更された作業ファイルで停止し、一致時だけ6コミットを復元', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'deadline-restore-')); t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const source=path.join(root,'source'),repo=path.join(root,'working'),packageDir=path.join(root,'package'); fs.mkdirSync(source); fs.mkdirSync(packageDir);
  const git=(cwd,...args)=>execFileSync('git',['-c','user.name=Test','-c','user.email=test@example.invalid','-c','commit.gpgsign=false','-c','core.hooksPath=/dev/null',...args],{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  git(source,'init','-b','feat/deadline-watch'); fs.writeFileSync(path.join(source,'example.txt'),'base\n'); git(source,'add','example.txt'); git(source,'commit','-m','base');
  const base=git(source,'rev-parse','HEAD');
  for(let n=1;n<=6;n++){fs.writeFileSync(path.join(source,'example.txt'),`step ${n}\n`);git(source,'add','example.txt');git(source,'commit','-m',`step ${n}`);}
  const target=git(source,'rev-parse','HEAD'); git(source,'bundle','create',path.join(packageDir,'deadline-watch.bundle'),`${base}..refs/heads/feat/deadline-watch`);
  fs.writeFileSync(path.join(packageDir,'commits.json'),JSON.stringify({base,target,branch:'feat/deadline-watch'}));
  git(root,'clone','--shared','--no-checkout',source,repo); git(repo,'update-ref','refs/heads/feat/deadline-watch',base); git(repo,'read-tree',base);
  fs.writeFileSync(path.join(repo,'example.txt'),'user edit\n'); assert.throws(()=>restoreDeadlineCommits({repo,packageDir}),/Working file changed/); assert.equal(git(repo,'rev-parse','HEAD'),base);
  fs.writeFileSync(path.join(repo,'example.txt'),'step 6\n'); assert.equal(restoreDeadlineCommits({repo,packageDir}).restored,true);
  assert.equal(git(repo,'rev-list','--count',`${base}..HEAD`),'6'); assert.equal(fs.readFileSync(path.join(repo,'example.txt'),'utf8'),'step 6\n');
  assert.equal(restoreDeadlineCommits({repo,packageDir}).reason,'already-restored');
});
