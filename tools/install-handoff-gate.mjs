import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntry } from './is-entry.mjs';

const scriptFile=fileURLToPath(import.meta.url),repo=path.dirname(path.dirname(scriptFile));
const stamp=()=>new Date().toISOString().replace(/[-:]/g,'').replace('T','-').slice(0,15);
const hookCount=s=>Object.values(s.hooks||{}).reduce((n,groups)=>n+(Array.isArray(groups)?groups.reduce((m,g)=>m+(Array.isArray(g.hooks)?g.hooks.length:0),0):0),0);
const commands=(s,event)=>((s.hooks||{})[event]||[]).flatMap(g=>g.hooks||[]).map(h=>h.command||'');
function addHook(settings,event,command){settings.hooks??={};settings.hooks[event]??=[];let group=settings.hooks[event].find(g=>g.matcher==='*')||settings.hooks[event][0];if(!group){group={matcher:'*',hooks:[]};settings.hooks[event].push(group);}group.hooks??=[];if(commands(settings,event).includes(command))return 0;group.hooks.push({type:'command',command});return 1;}
export function install({home=os.homedir(),apply=false,failReadBack=false,log=console.log}={}){
  const claude=path.join(home,'.claude'),settingsFile=path.join(claude,'settings.json');
  let raw;try{raw=fs.readFileSync(settingsFile,'utf8');}catch(e){throw new Error(`settings.json を読めません: ${e.message}`);}let settings;try{settings=JSON.parse(raw);}catch(e){throw new Error(`settings.json が不正JSONです: ${e.message}`);}
  const beforeCount=hookCount(settings),next=structuredClone(settings);
  let removed=0;for(const group of next.hooks?.Stop||[]){const hooks=group.hooks||[];group.hooks=hooks.filter(h=>{const old=String(h.command||'').includes('manual-handoff-detector.ps1');if(old)removed++;return !old;});}
  const gate=`node "${path.join(repo,'tools','gate-hook-runner.mjs')}" "${path.join(repo,'tools','handoff-quality-gate.mjs')}"`,report=`node "${path.join(repo,'tools','rule-compliance-report.mjs')}"`;
  const added=addHook(next,'Stop',gate)+addHook(next,'SessionStart',report),expected=beforeCount-removed+added;
  const oldHook=path.join(claude,'hooks','manual-handoff-detector.ps1'),renamed=`${oldHook}.bak-20260828-superseded`,renamePlanned=fs.existsSync(oldHook)&&!fs.existsSync(renamed);
  const settingsChanged=removed>0||added>0;
  log(`[${apply?'apply':'dry-run'}] Stop旧hook削除: ${removed}件 / 新hook追加: ${added}件 / hook総数: ${beforeCount} → ${expected}`);log(`[${apply?'apply':'dry-run'}] 旧hookリネーム: ${renamePlanned?path.basename(renamed):'変更なし'}`);
  if(!apply){log('[dry-run] 変更は書き込んでいません');return{changed:settingsChanged||renamePlanned};}
  if(!settingsChanged&&!renamePlanned){log('変更なし');return{changed:false};}
  let backup;
  try{
    if(settingsChanged){backup=`${settingsFile}.bak-${stamp()}`;fs.copyFileSync(settingsFile,backup);fs.writeFileSync(settingsFile,JSON.stringify(next,null,2)+'\n');const check=JSON.parse(fs.readFileSync(settingsFile,'utf8'));if(failReadBack||commands(check,'Stop').some(x=>x.includes('manual-handoff-detector.ps1'))||!commands(check,'Stop').includes(gate)||!commands(check,'SessionStart').includes(report)||hookCount(check)!==expected)throw new Error('read-back検査に失敗');}
    if(renamePlanned)fs.renameSync(oldHook,renamed);else if(fs.existsSync(oldHook)&&fs.existsSync(renamed))log('旧hookのリネーム先が存在するため上書きせずスキップ');
  }catch(e){if(backup)fs.copyFileSync(backup,settingsFile);throw new Error(`${e.message}; settings.json をバックアップから復元しました`);}
  log('適用とread-back検査が完了しました');return{changed:true,backup};
}
function option(name){const i=process.argv.indexOf(name);return i>=0?process.argv[i+1]:undefined;}
if(isEntry(import.meta.url)){try{install({home:option('--home')||process.env.ORGIAST_HOME||os.homedir(),apply:process.argv.includes('--apply')});}catch(e){console.error(e.message);process.exitCode=1;}}
/**
 * Install handoff gate hooks to ~/.claude/settings.json
 * 
 * This script registers new hooks and renames old ones.
 * Run without --apply for dry-run mode (shows what would be done).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';

// Get the script's directory (2 levels up from this file)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

// Parse command line arguments
const args = process.argv.slice(2);
const apply = args.includes('--apply');
const homeIndex = args.indexOf('--home');
const homeDir = homeIndex !== -1 ? args[homeIndex + 1] : (process.env.ORGIAST_HOME || os.homedir());

// Paths
const settingsPath = path.join(homeDir, '.claude', 'settings.json');
const backupSuffix = `-bak-${new Date().toISOString().replace(/[:.]/g, '').replace('T', '-')}`;
const oldHookPath = path.join(homeDir, '.claude', 'hooks', 'manual-handoff-detector.ps1');
const renamedOldHookPath = `${oldHookPath}.bak-20260828-superseded`;

console.log(`Running in ${apply ? 'apply' : 'dry-run'} mode`);
console.log(`Target home directory: ${homeDir}`);

// New hook commands (resolved absolute paths)
const newStopHook = `node "${path.join(repoRoot, 'tools', 'handoff-quality-gate.mjs')}"`;
const newSessionStartHook = `node "${path.join(repoRoot, 'tools', 'rule-compliance-report.mjs')}"`;

async function main() {
  try {
    // Check if settings.json exists
    if (!fs.existsSync(settingsPath)) {
      console.error(`settings.json not found at ${settingsPath}`);
      process.exit(1);
    }

    // Read current settings
    const settingsContent = fs.readFileSync(settingsPath, 'utf8');
    let settings;
    
    try {
      settings = JSON.parse(settingsContent);
    } catch (err) {
      console.error(`Invalid JSON in settings.json: ${err.message}`);
      process.exit(1);
    }

    // Create backup if applying changes
    if (apply) {
      const backupPath = `${settingsPath}${backupSuffix}`;
      console.log(`Creating backup: ${backupPath}`);
      fs.writeFileSync(backupPath, settingsContent);
    }

    // Process Stop hooks
    const originalStopHooksCount = countStopHooks(settings);
    removeManualHandoffDetector(settings);
    addNewHooks(settings);
    const newStopHooksCount = countStopHooks(settings);

    console.log(`Stop hooks: ${originalStopHooksCount} -> ${newStopHooksCount}`);

    // Show what would be changed
    console.log('\nChanges to be made:');
    console.log(`  Remove: manual-handoff-detector.ps1 from Stop hooks`);
    console.log(`  Add: ${newStopHook} to Stop hooks (if not present)`);
    console.log(`  Add: ${newSessionStartHook} to SessionStart hooks (if not present)`);
    
    // Rename old hook file if it exists
    if (fs.existsSync(oldHookPath)) {
      if (fs.existsSync(renamedOldHookPath)) {
        console.log(`  Skip: ${renamedOldHookPath} already exists`);
      } else {
        console.log(`  Rename: ${oldHookPath} -> ${renamedOldHookPath}`);
      }
    } else {
      console.log(`  Skip: ${oldHookPath} does not exist`);
    }

    // Apply changes if requested
    if (apply) {
      // Write updated settings
      const updatedSettingsContent = JSON.stringify(settings, null, 2);
      console.log(`\nWriting updated settings to ${settingsPath}`);
      fs.writeFileSync(settingsPath, updatedSettingsContent);

      // Validate the changes
      try {
        validateSettings(settingsPath, originalStopHooksCount);
      } catch (err) {
        console.error(`Validation failed: ${err.message}`);
        // Restore from backup
        const backupPath = `${settingsPath}${backupSuffix}`;
        if (fs.existsSync(backupPath)) {
          console.log(`Restoring from backup: ${backupPath}`);
          fs.copyFileSync(backupPath, settingsPath);
        }
        process.exit(1);
      }

      // Rename old hook file
      if (fs.existsSync(oldHookPath)) {
        if (fs.existsSync(renamedOldHookPath)) {
          console.log(`Skipped renaming ${oldHookPath}: ${renamedOldHookPath} already exists`);
        } else {
          console.log(`Renaming ${oldHookPath} to ${renamedOldHookPath}`);
          fs.renameSync(oldHookPath, renamedOldHookPath);
        }
      }

      console.log('\nChanges applied successfully!');
    } else {
      console.log('\nDry-run completed. No changes were made.');
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

function countStopHooks(settings) {
  let count = 0;
  if (settings.hooks && Array.isArray(settings.hooks)) {
    for (const hookGroup of settings.hooks) {
      if (hookGroup.Stop && Array.isArray(hookGroup.Stop)) {
        count += hookGroup.Stop.length;
      }
    }
  }
  return count;
}

function removeManualHandoffDetector(settings) {
  if (settings.hooks && Array.isArray(settings.hooks)) {
    for (const hookGroup of settings.hooks) {
      if (hookGroup.Stop && Array.isArray(hookGroup.Stop)) {
        // Filter out entries containing manual-handoff-detector.ps1
        hookGroup.Stop = hookGroup.Stop.filter(entry => 
          !entry.command || !entry.command.includes('manual-handoff-detector.ps1')
        );
      }
    }
  }
}

function addNewHooks(settings) {
  // Find or create a hook group with matcher "*"
  let targetGroup = null;
  
  if (settings.hooks && Array.isArray(settings.hooks)) {
    targetGroup = settings.hooks.find(group => group.matcher === '*');
  } else {
    settings.hooks = [];
  }
  
  // If no group with matcher "*" exists, use the first group or create a new one
  if (!targetGroup) {
    if (settings.hooks.length > 0) {
      targetGroup = settings.hooks[0];
    } else {
      targetGroup = { matcher: '*', Stop: [], SessionStart: [] };
      settings.hooks.push(targetGroup);
    }
  }
  
  // Initialize arrays if they don't exist
  if (!targetGroup.Stop) targetGroup.Stop = [];
  if (!targetGroup.SessionStart) targetGroup.SessionStart = [];
  
  // Add Stop hook if not already present
  const stopHookExists = targetGroup.Stop.some(entry => 
    entry.command === newStopHook
  );
  
  if (!stopHookExists) {
    targetGroup.Stop.push({
      command: newStopHook,
      description: 'Handoff quality gate'
    });
  }
  
  // Add SessionStart hook if not already present
  const sessionStartHookExists = targetGroup.SessionStart.some(entry => 
    entry.command === newSessionStartHook
  );
  
  if (!sessionStartHookExists) {
    targetGroup.SessionStart.push({
      command: newSessionStartHook,
      description: 'Rule compliance report'
    });
  }
}

function validateSettings(settingsPath, originalStopHooksCount) {
  // Read the updated settings
  const updatedContent = fs.readFileSync(settingsPath, 'utf8');
  const updatedSettings = JSON.parse(updatedContent);
  
  // Basic JSON validation
  if (!updatedSettings) {
    throw new Error('Failed to parse updated settings');
  }
  
  // Check that manual-handoff-detector.ps1 is removed
  let hasManualHandoffDetector = false;
  if (updatedSettings.hooks && Array.isArray(updatedSettings.hooks)) {
    for (const hookGroup of updatedSettings.hooks) {
      if (hookGroup.Stop && Array.isArray(hookGroup.Stop)) {
        for (const entry of hookGroup.Stop) {
          if (entry.command && entry.command.includes('manual-handoff-detector.ps1')) {
            hasManualHandoffDetector = true;
            break;
          }
        }
      }
      if (hasManualHandoffDetector) break;
    }
  }
  
  if (hasManualHandoffDetector) {
    throw new Error('manual-handoff-detector.ps1 was not removed from Stop hooks');
  }
  
  // Check that new hooks are present
  let hasNewStopHook = false;
  let hasNewSessionStartHook = false;
  
  if (updatedSettings.hooks && Array.isArray(updatedSettings.hooks)) {
    for (const hookGroup of updatedSettings.hooks) {
      if (hookGroup.Stop && Array.isArray(hookGroup.Stop)) {
        for (const entry of hookGroup.Stop) {
          if (entry.command === `node "${path.join(repoRoot, 'tools', 'handoff-quality-gate.mjs')}"`) {
            
