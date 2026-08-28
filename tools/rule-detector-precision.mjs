import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectSessions, fixtureSession } from './rule-detectors.mjs';
import { isEntry } from './is-entry.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
const fixtureFile=path.join(here,'fixtures','rule-samples.jsonl');
const registryFile=path.join(here,'rules-registry.json');
export function measure(){
  const samples=fs.readFileSync(fixtureFile,'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
  const registry=JSON.parse(fs.readFileSync(registryFile,'utf8'));
  const catalog=JSON.parse(fs.readFileSync(path.join(here,'automation-routes.json'),'utf8'));
  const metrics={};
  for(const rule of registry.rules){
    if(rule.detect?.mode==='delegated'){metrics[rule.id]={delegatedTo:rule.owner};continue;}
    const own=samples.filter(x=>x.ruleId===rule.id); let tp=0,fp=0,fn=0; const falsePositives=[];
    for(const [i,s] of own.entries()){
      const predicted=detectSessions([fixtureSession(s,i)],registry,catalog)[rule.id].violation>0;
      if(predicted&&s.label==='violation')tp++; else if(predicted){fp++;falsePositives.push(s);} else if(s.label==='violation')fn++;
    }
    const precision=tp+fp?tp/(tp+fp):null,recall=tp+fn?tp/(tp+fn):null;
    const violations=own.filter(x=>x.label==='violation').length,compliant=own.length-violations,minPrecision=rule.validation?.minPrecision??.9;
    metrics[rule.id]={fixtureCount:own.length,precision,recall,falsePositives,violations,compliant};
    rule.validation={...(rule.validation||{}),fixtureCount:own.length,precision,minPrecision,status:own.length>=15&&violations>=5&&compliant>=10&&precision!==null&&precision>=minPrecision&&recall>=.8?'validated':'unvalidated'};
  }
  fs.writeFileSync(registryFile,JSON.stringify(registry,null,2)+'\n'); return metrics;
}
export function format(metrics){const lines=['| ルール | fixture | precision | recall | 誤検知 |','|---|---:|---:|---:|---:|'];for(const [id,m] of Object.entries(metrics))lines.push(m.delegatedTo?`| ${id} | 担当: ${m.delegatedTo} | — | — | — |`:`| ${id} | ${m.fixtureCount} | ${m.precision===null?'—':(m.precision*100).toFixed(1)+'%'} | ${m.recall===null?'—':(m.recall*100).toFixed(1)+'%'} | ${m.falsePositives.length} |`);for(const [id,m] of Object.entries(metrics))for(const x of m.falsePositives||[])lines.push(`- ${id}: ${x.text.slice(0,160).replace(/\s+/g,' ')} (${x.note})`);return lines.join('\n')+'\n';}
if(isEntry(import.meta.url))process.stdout.write(format(measure()));
