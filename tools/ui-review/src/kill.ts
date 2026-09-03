// Kill the isolated dev-host instance without touching the user's own VS Code:
// only Code.exe processes whose command line references this tools directory.
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const MARKER = path.resolve(import.meta.dirname, '..').replaceAll('\\', '\\\\');
const ps = `Get-CimInstance Win32_Process -Filter "Name='Code.exe'" | Where-Object { $_.CommandLine -match '${MARKER}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; $_.ProcessId }`;
const out = execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' });
console.log(out.trim() ? `killed: ${out.trim()}` : 'no matching dev-host processes');
