//!/usr/bin/env node

// Simple test to verify mobile-push functionality
import fs from 'fs';
import path from 'path';

// Test 1: Check if notify-owner.mjs has mobile-push imports
const notifyOwnerPath = path.join(__dirname, 'notify-owner.mjs');
let notifyOwnerContent;
try {
  notifyOwnerContent = fs.readFileSync(notifyOwnerPath, 'utf8');
  console.log('✅ notify-owner.mjs is readable');
  
  // Check for mobile-push related code
  if (notifyOwnerContent.includes('const mobilePushEnabled')) {
    console.log('✅ notify-owner.mjs has mobilePushEnabled check');
  } else {
    console.log('❌ notify-owner.mjs missing mobilePushEnabled check');
  }
  
  if (notifyOwnerContent.includes('const push = async')) {
    console.log('✅ notify-owner.mjs has push function');
  } else {
    console.log('❌ notify-owner.mjs missing push function');
  }
  
  if (notifyOwnerContent.includes('enqueue({ owner, title, body, home }')) {
    console.log('✅ notify-owner.mjs calls enqueue function');
  } else {
    console.log('❌ notify-owner.mjs missing enqueue call');
  }
  
} catch (error) {
  console.log('❌ Cannot read notify-owner.mjs:', error.message);
}

// Test 2: Check if mobile-push-queue.mjs exists and has required functions
const mobilePushQueuePath = path.join(__dirname, 'mobile-push-queue.mjs');
try {
  const mobilePushQueueContent = fs.readFileSync(mobilePushQueuePath, 'utf8');
  console.log('✅ mobile-push-queue.mjs is readable');
  
  if (mobilePushQueueContent.includes('export function enqueue')) {
    console.log('✅ mobile-push-queue.mjs has enqueue function');
  } else {
    console.log('❌ mobile-push-queue.mjs missing enqueue function');
  }
  
  if (mobilePushQueueContent.includes('export function listPending')) {
    console.log('✅ mobile-push-queue.mjs has listPending function');
  } else {
    console.log('❌ mobile-push-queue.mjs missing listPending function');
  }
  
} catch (error) {
  console.log('❌ Cannot read mobile-push-queue.mjs:', error.message);
}

// Test 3: Check if auto-progress-inbox-hook.mjs has mobile-push context
const autoProgressInboxHookPath = path.join(__dirname, 'auto-progress-inbox-hook.mjs');
try {
  const autoProgressInboxHookContent = fs.readFileSync(autoProgressInboxHookPath, 'utf8');
  console.log('✅ auto-progress-inbox-hook.mjs is readable');
  
  if (autoProgressInboxHookContent.includes('let mobilePushContext')) {
    console.log('✅ auto-progress-inbox-hook.mjs has mobilePushContext variable');
  } else {
    console.log('❌ auto-progress-inbox-hook.mjs missing mobilePushContext variable');
  }
  
  if (autoProgressInboxHookContent.includes('listPending(home)')) {
    console.log('✅ auto-progress-inbox-hook.mjs calls listPending function');
  } else {
    console.log('❌ auto-progress-inbox-hook.mjs missing listPending call');
  }
  
} catch (error) {
  console.log('❌ Cannot read auto-progress-inbox-hook.mjs:', error.message);
}

console.log('\nSummary: Mobile push implementation verification complete');