import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Loads the Fable policy from the specified directory or the directory of this module.
 * If the file is missing or invalid, returns a safe default.
 * 
 * @param {object} [options]
 * @param {string} [options.dir] Optional directory to read from.
 * @returns {object} The parsed policy object.
 */
export function loadFablePolicy(options = {}) {
  try {
    const dir = options.dir || path.dirname(fileURLToPath(import.meta.url));
    const filePath = path.join(dir, 'fable-policy.json');
    const rawContent = fs.readFileSync(filePath, 'utf8');
    // Remove BOM if present (PowerShell or Windows encoding artifacts)
    const cleanContent = rawContent.replace(/^\uFEFF/, '');
    return JSON.parse(cleanContent);
  } catch {
    // Default to safe values if the file is missing or invalid
    return { planIncluded: false, scope: 'supervisor-only' };
  }
}

/**
 * Checks if Fable is allowed for supervisor use (main loop).
 * @param {object} policy 
 * @returns {boolean}
 */
export function fableAllowedForSupervisor(policy) {
  return policy?.planIncluded === true;
}

/**
 * Checks if Fable is allowed for subagent use.
 * @param {object} policy 
 * @returns {boolean}
 */
export function fableAllowedForSubagent(policy) {
  return policy?.planIncluded === true && policy?.scope === 'all';
}
