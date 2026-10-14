import os from 'node:os';
import path from 'node:path';

export const platformName = () => process.env.ORGIAST_PLATFORM || process.platform;
export const isWindows = () => platformName() === 'win32';
export const isLinux = () => platformName() === 'linux';
export const isMac = () => platformName() === 'darwin';
export const homeDir = () => os.homedir();
export const claudeDir = () => path.join(homeDir(), '.claude');
export const tempDir = () => os.tmpdir();
export const pathJoin = (...parts) => path.join(...parts);
