// Kill the isolated dev-host instance without touching the user's own VS Code:
// only Code.exe processes whose command line references this tools directory.
//
// The harness's own local AI mock endpoint (`launch --ai-mock`) is stopped here
// too. It is part of "the isolated instance this harness started", and leaving it
// behind would keep a port, a state file and a log for no reason — with one stop
// command, a walkthrough cannot half-clean-up. `ai-mock stop` is the same
// operation for an endpoint that was started on its own, and it removes the log
// only once the endpoint is proven gone (see stopAiMockServer): a log something
// may still be writing is left alone and named.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { stopAiMockServer } from './aiMockRun';

const HARNESS_DIR = path.resolve(import.meta.dirname, '..');
const MARKER = HARNESS_DIR.replaceAll('\\', '\\\\');
const ps = `Get-CimInstance Win32_Process -Filter "Name='Code.exe'" | Where-Object { $_.CommandLine -match '${MARKER}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; $_.ProcessId }`;
const out = execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' });
console.log(out.trim() ? `killed: ${out.trim()}` : 'no matching dev-host processes');

const mock = await stopAiMockServer(HARNESS_DIR);
if (mock.outcome !== 'none') {
  console.log(`AI mock endpoint: ${mock.message}`);
}
