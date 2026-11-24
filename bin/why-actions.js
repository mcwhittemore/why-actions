#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { parseArgs } from 'node:util';
import { getToken, createClient } from '../lib/github.js';
import { collect, cacheDir } from '../lib/collect.js';
import { analyze } from '../lib/analyze.js';

const HELP = `Usage: why-actions <org> [options]

Explore why a GitHub org spends its Actions minutes.

Options:
  --days <n>     How far back to look (default 365)
  --offline      Use only cached data, make no API calls
  --port <n>     Port for the local web UI (default: random)
  --no-open      Don't open a browser
  --json <file>  Write the analyzed dataset to a file and exit
  -h, --help     Show this help

Data is cached in ${path.dirname(cacheDir('x'))}; re-runs only fetch what changed.
Auth comes from GITHUB_TOKEN / GH_TOKEN or \`gh auth token\`.`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    days: { type: 'string', default: '365' },
    offline: { type: 'boolean', default: false },
    port: { type: 'string', default: '0' },
    'no-open': { type: 'boolean', default: false },
    json: { type: 'string' },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help || positionals.length !== 1) {
  console.log(HELP);
  process.exit(values.help ? 0 : 1);
}

const org = positionals[0];
const log = (msg) => process.stderr.write(`[why-actions] ${msg}\n`);
const webDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');

const gh = createClient(values.offline ? '' : getToken(), { log });
const started = Date.now();
const raw = await collect(gh, org, { days: Number(values.days), offline: values.offline, log });
const data = analyze(raw);
log(
  `analyzed ${data.runs.length} runs, ${data.prs.length} PRs, ${data.bursts.length} multi-PR bursts ` +
    `in ${((Date.now() - started) / 1000).toFixed(1)}s (${gh.stats().calls} API calls)`,
);

if (values.json) {
  fs.writeFileSync(values.json, JSON.stringify(data));
  log(`wrote ${values.json}`);
  process.exit(0);
}

const payload = JSON.stringify(data);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/data.json') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(payload);
  }
  const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const file = path.join(webDir, path.normalize(rel));
  if (!file.startsWith(webDir) || !fs.existsSync(file)) {
    res.writeHead(404);
    return res.end('not found');
  }
  res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

server.listen(Number(values.port), '127.0.0.1', () => {
  const url = `http://127.0.0.1:${server.address().port}/`;
  log(`explore at ${url}  (Ctrl-C to stop)`);
  if (!values['no-open']) {
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    execFile(cmd, [url], () => {});
  }
});
