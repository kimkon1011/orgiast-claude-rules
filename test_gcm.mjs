import { execSync } from 'child_process';
const gcm = 'C:\\Program Files\\Git\\mingw64\\bin\\git-credential-manager.exe';
try {
  const out = execSync(`"${gcm}" get`, { input: 'protocol=https\nhost=github.com\n\n' }).toString();
  const lines = out.split('\n');
  const user = lines.find(l => l.startsWith('username=')) || '';
  const hasPw = lines.some(l => l.startsWith('password='));
  console.log('GCM user:', user, 'has password:', hasPw);
} catch (e) {
  console.error('GCM error:', e.message);
}
