#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';

// Get the script's directory
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
const oldHookPath = path.join(homeDir, '.claude', 'hooks', 'manual-handoff-detector.ps1');
const renamedOldHookPath = `${oldHookPath}.bak-20260828-superseded`;

console.log(`Running in ${apply ? 'apply' : 'dry-run'} mode`);
console.log(`Target home directory: ${homeDir}`);

// New hook commands (resolved absolute paths)
const newStopHook = `node "${path.join(repoRoot, 'tools', 'handoff-quality-gate.mjs')}"`;
const newSessionStartHook = `node "${path.join(repoRoot, 'tools', 'rule-compliance-report.mjs')}"`;

function main() {
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
      const timestamp = new Date().toISOString().replace(/[:.]/g, '').replace('T', '-');
      const backupPath = `${settingsPath}.bak-${timestamp}`;
      console.log(`Creating backup: ${backupPath}`);
      fs.writeFileSync(backupPath, settingsContent);
    }

    // Count original hooks
    const originalHookCount = countHooks(settings);

    // Process hooks - remove old, add new
    removeManualHandoffDetector(settings);
    addNewHooks(settings);

    // Count new hooks
    const newHookCount = countHooks(settings);

    console.log(`Hooks: ${originalHookCount} -> ${newHookCount}`);

    // Show what would be changed
    console.log('\nChanges to be made:');
    console.log(`  Remove: manual-handoff-detector.ps1 from Stop hooks`);
    console.log(`  Add: ${newStopHook} to Stop hooks (if not present)`);
    console.log(`  Add: ${newSessionStartHook} to SessionStart hooks (if not present)`);
    
    // Handle old hook file
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

      // Validate the changes by reading back
      try {
        const validationContent = fs.readFileSync(settingsPath, 'utf8');
        const validationSettings = JSON.parse(validationContent);
        
        // Check that manual-handoff-detector.ps1 is removed
        let hasManualHandoffDetector = false;
        if (validationSettings.hooks && Array.isArray(validationSettings.hooks)) {
          for (const hookGroup of validationSettings.hooks) {
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
        
        console.log('Validation passed');
      } catch (err) {
        console.error(`Validation failed: ${err.message}`);
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

function countHooks(settings) {
  let count = 0;
  if (settings.hooks && Array.isArray(settings.hooks)) {
    for (const hookGroup of settings.hooks) {
      if (hookGroup.Stop && Array.isArray(hookGroup.Stop)) {
        count += hookGroup.Stop.length;
      }
      if (hookGroup.SessionStart && Array.isArray(hookGroup.SessionStart)) {
        count += hookGroup.SessionStart.length;
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

main();
