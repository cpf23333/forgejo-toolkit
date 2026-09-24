#!/usr/bin/env node
/**
 * Headless check of the extension's MCP server (out/mcp-server.js).
 *
 * The MCP server is a stdio child of VS Code, but nothing about it needs the
 * editor: it reads its instance from the launch environment. This script spawns
 * it directly, speaks JSON-RPC over its stdio and exercises the read-only tool
 * surface against a real instance, which is what the walkthrough checklist asks
 * for (validation of hostile input, and the truncation marker on large results).
 *
 *   node tools/ui-review/src/mcpCheck.mjs [--instances <path>] [--url <substring>]
 *
 * The token is read from the instances file and passed through the child's
 * environment; it is never printed.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const serverPath = resolve(repoRoot, 'packages', 'forgejo-toolkit', 'out', 'mcp-server.js');

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const instancesPath = argValue('--instances', 'D:\\forgejo-toolkit-instances.json');
const urlFilter = argValue('--url', '');

const raw = JSON.parse(readFileSync(instancesPath, 'utf8'));
const instances = Array.isArray(raw.instances) ? raw.instances : [];
const instance = instances.find((entry) => !urlFilter || String(entry.url).includes(urlFilter)) ?? instances[0];
if (!instance) {
  console.error(`no instance found in ${instancesPath}`);
  process.exit(1);
}
console.log(`instance: ${instance.url} (user ${instance.username ?? '?'})`);

const child = spawn(process.execPath, [serverPath], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: {
    ...process.env,
    FORGEJO_MCP_INSTANCE_URL: String(instance.url),
    FORGEJO_MCP_TOKEN: String(instance.token),
    FORGEJO_MCP_SYNC_API_URLS: 'true',
    // The version probe is only visible in the debug log.
    FORGEJO_MCP_DEBUG: 'true',
  },
});

let buffered = '';
const pending = new Map();
const serverStderr = [];

child.stderr.on('data', (chunk) => {
  serverStderr.push(String(chunk));
});

child.stdout.on('data', (chunk) => {
  buffered += String(chunk);
  let newline = buffered.indexOf('\n');
  while (newline >= 0) {
    const line = buffered.slice(0, newline).trim();
    buffered = buffered.slice(newline + 1);
    newline = buffered.indexOf('\n');
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      console.log(`[server] ${line}`);
      continue;
    }
    if (message.id !== undefined && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  }
});

let nextId = 1;
function request(method, params) {
  const id = nextId++;
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      rejectPromise(new Error(`${method} timed out`));
    }, 30000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      if (message.error) rejectPromise(new Error(`${method}: ${JSON.stringify(message.error)}`));
      else resolvePromise(message.result);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

function notify(method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
}

function textOf(result) {
  return (result?.content ?? []).map((part) => part.text ?? '').join('\n');
}

/**
 * Parses a tool payload. Results that hit the item cap or the whole-result
 * budget end with a trailing prose note instead of staying pure JSON (the note
 * is what makes a truncated answer recognizable to a reader), so the note is
 * stripped before parsing. A result cut by the size budget is not valid JSON at
 * all, so this returns undefined rather than throwing.
 */
function parsePayload(text) {
  const stripped = text.replace(/\n?\(list truncated[\s\S]*$/i, '').replace(/\n?\.\.\. \(truncated[\s\S]*$/i, '');
  try {
    return JSON.parse(stripped);
  } catch {
    return undefined;
  }
}

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

try {
  const init = await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'ui-review-mcp-check', version: '0.0.0' },
  });
  notify('notifications/initialized', {});
  check('initialize', Boolean(init?.serverInfo), `server=${init?.serverInfo?.name ?? '?'}`);

  const tools = await request('tools/list', {});
  const names = (tools?.tools ?? []).map((tool) => tool.name);
  check('tools/list', names.length > 0, `${names.length} tools`);
  console.log(`      ${names.join(', ')}`);

  const writeTools = names.filter((name) =>
    /^(create|update|delete|merge|submit|mark|close|reopen|add|remove)_/.test(name),
  );
  check('read-only surface (no write tools registered)', writeTools.length === 0, writeTools.join(', '));

  // The Actions tools are gated on the probed server version. That probe used to
  // run only in the extension host, so in this process the gate always saw
  // "unknown" and passed — assert the child probes for itself.
  const probeDeadline = Date.now() + 10000;
  while (Date.now() < probeDeadline && !/Server version for/.test(serverStderr.join(''))) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const probeLog = serverStderr.join('');
  check(
    'probes the server version (the Actions gate is not dead code here)',
    /Server version for/.test(probeLog),
    (probeLog.match(/Server version for [^\n]*/) ?? ['no probe seen'])[0].slice(0, 90),
  );

  // 1. Hostile path: must be rejected by the schema, not turned into a request.
  const hostile = await request('tools/call', {
    name: 'get_file_content',
    arguments: { owner: 'x', repo: 'y', path: '../../../../notifications' },
  });
  const hostileText = textOf(hostile);
  check(
    'get_file_content rejects a traversal path',
    hostile?.isError === true && /repository-relative path/.test(hostileText),
    hostileText.split('\n')[0].slice(0, 120),
  );

  // 2. Sanity: the same tool works for a legitimate path.
  const reposResult = await request('tools/call', { name: 'list_my_repos', arguments: {} });
  const reposText = textOf(reposResult);
  if (reposResult?.isError) {
    check('list_my_repos', false, reposText.split('\n')[0].slice(0, 120));
  } else {
    const repos = parsePayload(reposText);
    const repo = Array.isArray(repos) ? repos[0] : (repos?.repositories ?? [])[0];
    check('list_my_repos', Boolean(repo?.owner && repo?.name), `${repo?.full_name ?? '?'}`);
    await checkRepo(repo);
  }
} catch (error) {
  check('run', false, String(error.message ?? error));
} finally {
  child.kill();
}

async function checkRepo(repo) {
  if (!repo) return;
  // The API returns the owner as an object; the tools take the login as a string.
  const owner = typeof repo.owner === 'string' ? repo.owner : repo.owner?.login;
  if (!owner || !repo.name) {
    check('repo owner/name', false, JSON.stringify(repo).slice(0, 120));
    return;
  }
  const contentsResult = await request('tools/call', {
    name: 'list_repo_contents',
    arguments: { owner, repo: repo.name },
  });
  const contentsText = textOf(contentsResult);
  if (contentsResult?.isError) {
    check('list_repo_contents', false, contentsText.split('\n')[0].slice(0, 120));
    return;
  }
  const contents = parsePayload(contentsText);
  const file = (Array.isArray(contents) ? contents : []).find(
    (entry) => entry.type === 'file' || entry.type === 'blob',
  );
  if (!file) {
    check('get_file_content returns file text', false, 'no file found to read');
  } else {
    const contentResult = await request('tools/call', {
      name: 'get_file_content',
      arguments: { owner, repo: repo.name, path: file.path ?? file.name },
    });
    const content = textOf(contentResult);
    check(
      'get_file_content returns file text',
      !contentResult?.isError && content.length > 0,
      `${content.length} chars`,
    );
  }

  // 3. Truncation marker. The whole-result cut needs > 64 KB of data, which a
  // small instance never has, so also look for a file big enough to trip the
  // 10 KB per-string budget: that marker is the one the checklist refers to for
  // large results.
  let best = { source: 'none', length: 0, marker: '' };
  const recordResult = (source, text) => {
    const marker = (text.match(/\(truncated:[^)]*\)/) ?? [''])[0];
    if (marker) {
      best = { source, length: text.length, marker };
      return true;
    }
    if (text.length > best.length) best = { source, length: text.length, marker: '' };
    return false;
  };

  const allReposResult = await request('tools/call', { name: 'list_my_repos', arguments: {} });
  const allRepos = (() => {
    const parsed = parsePayload(textOf(allReposResult));
    return Array.isArray(parsed) ? parsed : [];
  })();

  for (const candidate of allRepos.slice(0, 8)) {
    const candidateOwner = typeof candidate.owner === 'string' ? candidate.owner : candidate.owner?.login;
    if (!candidateOwner || !candidate.name) continue;
    const listing = await request('tools/call', {
      name: 'list_repo_contents',
      arguments: { owner: candidateOwner, repo: candidate.name },
    });
    if (listing?.isError) continue;
    const entries = (() => {
      const parsed = parsePayload(textOf(listing));
      return Array.isArray(parsed) ? parsed : [];
    })();
    const biggest = entries
      .filter((entry) => (entry.type === 'file' || entry.type === 'blob') && typeof entry.size === 'number')
      .sort((a, b) => b.size - a.size)[0];
    if (!biggest || biggest.size <= 11 * 1024) continue;
    const content = await request('tools/call', {
      name: 'get_file_content',
      arguments: { owner: candidateOwner, repo: candidate.name, path: biggest.path ?? biggest.name },
    });
    if (recordResult(`${candidate.full_name ?? candidate.name}/${biggest.name} (${biggest.size} B)`, textOf(content))) {
      break;
    }
  }

  if (!best.marker) {
    for (const candidate of [
      { tool: 'list_commits', args: { owner, repo: repo.name } },
      { tool: 'list_issues', args: {} },
      { tool: 'list_notifications', args: {} },
    ]) {
      const result = await request('tools/call', { name: candidate.tool, arguments: candidate.args });
      if (recordResult(candidate.tool, textOf(result))) break;
    }
  }

  check(
    'large results carry a truncation marker',
    Boolean(best.marker),
    best.marker
      ? `${best.source}: ${best.marker.slice(0, 80)}`
      : `no result exceeded a budget (largest: ${best.source} at ${best.length} chars)`,
  );
}

const failed = checks.filter((entry) => !entry.ok);
if (serverStderr.length) {
  console.log(`--- server stderr (${serverStderr.join('').split('\n').length - 1} lines) ---`);
  console.log(serverStderr.join('').split('\n').slice(0, 12).join('\n'));
}
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
