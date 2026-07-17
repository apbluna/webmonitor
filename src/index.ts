import express from 'express';
import { readFileSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

puppeteer.use(StealthPlugin());

const DATA_DIR = '/app/data';
const URLS_FILE = join(DATA_DIR, 'urls.txt');
const LOGS_FILE = join(DATA_DIR, 'uptime_logs.json');
const STATS_FILE = join(DATA_DIR, 'uptime_stats.json');
const INTERVAL = 60_000;
const TIMEOUT = 30_000;
const PORT = 3000;

const SKIP_CODES = new Set([
  'NO INTERNET',
  'net::ERR_INTERNET_DISCONNECTED',
  'net::ERR_NAME_NOT_RESOLVED',
  'net::ERR_ADDRESS_UNREACHABLE',
  'net::ERR_NETWORK_CHANGED',
  'net::ERR_NETWORK_ACCESS_DENIED',
]);

const SKIP_HTTP = new Set([403, 405, 429, 503]);

const UNCLEAR_CODES = new Set([
  'Timeout', 'ReadTimeout', 'ERR', 'ConnectionError',
  'net::ERR_CONNECTION_TIMED_OUT', 'net::ERR_CONNECTION_RESET',
]);

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function readUrls(): string[] {
  if (!existsSync(URLS_FILE)) return [];
  return readFileSync(URLS_FILE, 'utf-8')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'));
}

function writeUrls(urls: string[]) {
  writeFileSync(URLS_FILE, urls.join('\n') + '\n');
}

interface LogEntry {
  ts: string;
  url: string;
  status: string;
  code: string;
  ms: string;
}

function ensureLogsFile() {
  if (!existsSync(LOGS_FILE)) {
    writeFileSync(LOGS_FILE, '[]');
  }
}

function appendLog(entry: LogEntry) {
  const logs: LogEntry[] = JSON.parse(readFileSync(LOGS_FILE, 'utf-8'));
  logs.push(entry);
  writeFileSync(LOGS_FILE, JSON.stringify(logs));
}

function readLogs(): LogEntry[] {
  if (!existsSync(LOGS_FILE)) return [];
  return JSON.parse(readFileSync(LOGS_FILE, 'utf-8'));
}

interface UrlStats {
  total: number;
  up: number;
  down: number;
  unclear: number;
  uptimePct: string;
}

interface Stats {
  perUrl: Record<string, UrlStats>;
  perUrlCodes: Record<string, Record<string, { status: string; count: number }[]>>;
  global: { totalMins: number; upMins: number; downMins: number; unclearMins: number; uptimePct: string };
  lastChecked: string;
  overallStatus: string;
}

function computeStats(logs: LogEntry[]): Stats {
  const urlMap: Record<string, { total: number; up: number; down: number; unclear: number }> = {};
  let globalUp = 0;
  let globalDown = 0;
  let globalUnclear = 0;

  for (const log of logs) {
    if (log.status === 'SKIP' || SKIP_CODES.has(log.status) || SKIP_CODES.has(log.code)) continue;
    if (!urlMap[log.url]) urlMap[log.url] = { total: 0, up: 0, down: 0, unclear: 0 };
    urlMap[log.url].total++;
    if (log.status === 'UP') {
      urlMap[log.url].up++;
      globalUp++;
    } else if (log.status === 'UNCLEAR' || UNCLEAR_CODES.has(log.code)) {
      urlMap[log.url].unclear++;
      globalUnclear++;
    } else {
      urlMap[log.url].down++;
      globalDown++;
    }
  }

  const perUrl: Stats['perUrl'] = {};
  const perUrlCodes: Stats['perUrlCodes'] = {};
  for (const log of logs) {
    if (log.status === 'SKIP' || SKIP_CODES.has(log.status) || SKIP_CODES.has(log.code)) continue;
    if (!perUrlCodes[log.url]) perUrlCodes[log.url] = {};
    const isUp = log.status === 'UP';
    const key = isUp ? '200' : log.code;
    const effectiveStatus = isUp ? 'UP' : (log.status === 'UNCLEAR' || UNCLEAR_CODES.has(log.code)) ? 'UNCLEAR' : 'DOWN';
    if (!perUrlCodes[log.url][key]) perUrlCodes[log.url][key] = [];
    perUrlCodes[log.url][key].push({ status: effectiveStatus, count: 0 });
  }
  for (const [url, codes] of Object.entries(perUrlCodes)) {
    const collapsed: Record<string, { status: string; count: number }> = {};
    for (const [code, entries] of Object.entries(codes)) {
      if (!collapsed[code]) collapsed[code] = { status: entries[0].status, count: 0 };
      collapsed[code].count += entries.length;
    }
    perUrlCodes[url] = {};
    for (const [code, v] of Object.entries(collapsed)) {
      perUrlCodes[url][code] = [v];
    }
  }

  for (const [url, d] of Object.entries(urlMap)) {
    const relevant = d.up + d.down;
    perUrl[url] = {
      total: d.total, up: d.up, down: d.down, unclear: d.unclear,
      uptimePct: relevant > 0 ? ((d.up / relevant) * 100).toFixed(2) + '%' : 'N/A',
    };
  }

  const totalMins = globalUp + globalDown;
  return {
    perUrl,
    perUrlCodes,
    global: {
      totalMins, upMins: globalUp, downMins: globalDown, unclearMins: globalUnclear,
      uptimePct: totalMins > 0 ? ((globalUp / totalMins) * 100).toFixed(2) + '%' : 'N/A',
    },
    lastChecked: new Date().toLocaleString('en-US', { hour12: false }),
    overallStatus: totalMins === 0 ? 'N/A' : globalDown === 0 ? 'ALL UP' : globalUp === 0 ? 'ALL DOWN' : 'SOME DOWN',
  };
}

async function checkUrl(browser: any, url: string): Promise<{ status: string; code: string; ms: number }> {
  const page = await browser.newPage();
  await page.setUserAgent(USER_AGENT);
  await page.setViewport({ width: 1920, height: 1080 });
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  });
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  });
  const start = Date.now();
  try {
    const resp = await page.goto(url, { waitUntil: 'networkidle0', timeout: TIMEOUT });
    const elapsed = Date.now() - start;
    const httpCode = resp ? resp.status().toString() : 'N/A';
    if (resp && resp.status() >= 200 && resp.status() < 400) {
      return { status: 'UP', code: httpCode, ms: elapsed };
    }
    if (resp && SKIP_HTTP.has(resp.status())) {
      return { status: 'SKIP', code: httpCode, ms: elapsed };
    }
    return { status: 'DOWN', code: httpCode, ms: elapsed };
  } catch (err: any) {
    const elapsed = Date.now() - start;
    const msg = err.message || '';
    let code = 'ERR';
    if (/timeout/i.test(msg)) code = 'Timeout';
    else if (/net::ERR_/.test(msg)) code = msg.match(/net::ERR_\w+/)?.[0] || 'NetworkError';
    if (SKIP_CODES.has(code)) return { status: 'SKIP', code, ms: elapsed };
    if (UNCLEAR_CODES.has(code)) return { status: 'UNCLEAR', code, ms: elapsed };
    return { status: 'DOWN', code, ms: elapsed };
  } finally {
    await page.close();
  }
}

let running = false;

async function runCheck(urls: string[]) {
  if (running) return;
  running = true;
  console.log(`[${new Date().toLocaleString('en-US', { hour12: false, timeZone: 'Asia/Manila' })}] Checking ${urls.length} URLs...`);
  let browser: any;
  try {
    browser = await puppeteer.launch({
      executablePath: '/usr/bin/chromium-browser',
      headless: 'new',
      args: [
        '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
        '--disable-gpu', '--window-size=1920,1080',
        '--disable-blink-features=AutomationControlled',
        '--no-first-run', '--no-service-autorun', '--password-store=basic',
        `--user-agent=${USER_AGENT}`,
      ],
    });
    for (const url of urls) {
      const timestamp = new Date().toLocaleString('en-US', { hour12: false, timeZone: 'Asia/Manila' });
      const result = await checkUrl(browser, url);
      appendLog({ ts: timestamp, url, status: result.status, code: result.code, ms: result.ms.toString() });
      console.log(`  ${result.status} ${result.code} ${result.ms}ms - ${url}`);
    }
  } catch (err) {
    console.error('Browser launch error:', err);
  } finally {
    if (browser) await browser.close();
  }
  const logs = readLogs();
  const stats = computeStats(logs);
  writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
  console.log(`Stats: ${stats.global.upMins}/${stats.global.totalMins} UP (${stats.global.uptimePct})`);
  running = false;
}

function startServer() {
  const app = express();
  app.use(express.json());

  app.get('/', (_req, res) => {
    let stats: Stats;
    if (existsSync(STATS_FILE)) {
      stats = JSON.parse(readFileSync(STATS_FILE, 'utf-8'));
    } else {
      stats = {
        perUrl: {},
        perUrlCodes: {},
        global: { totalMins: 0, upMins: 0, downMins: 0, unclearMins: 0, uptimePct: 'N/A' },
        lastChecked: 'Never',
        overallStatus: 'N/A',
      };
    }
    const allUrls = readUrls();
    const perUrlCodes = stats.perUrlCodes || {};
    const urlRows = allUrls.length > 0
      ? allUrls.map(url => {
          const s = stats.perUrl[url];
          const codes = perUrlCodes[url];
          const enc = encodeURIComponent(url);
          if (!s) return `<div class="url-card">
            <div class="url-header" onclick="this.parentElement.classList.toggle('open')">
              <span class="url-title">${url}</span>
              <span class="url-summary">No data yet</span>
              <span class="url-chevron">&#9654;</span>
            </div>
            <div class="url-body">
              <div class="url-actions"><button class="btn-edit" data-url="${enc}">Edit</button> <button class="btn-del" data-url="${enc}">Del</button></div>
            </div>
          </div>`;
          const pct = parseFloat(s.uptimePct);
          const cls = isNaN(pct) ? 'warning' : pct >= 99 ? 'up' : 'down';
          let details = '';
          if (codes) {
            const sorted = Object.entries(codes).sort((a, b) => b[1][0].count - a[1][0].count);
            const unclearCodes = ['Timeout','ReadTimeout','ERR','ConnectionError','net::ERR_CONNECTION_TIMED_OUT','net::ERR_CONNECTION_RESET'];
            const hints: Record<string, string> = {
              '200':'OK','502':'Bad Gateway (upstream server error)','403':'Forbidden (blocked by WAF)',
              '405':'Method Not Allowed (blocked)','429':'Too Many Requests (rate limited)',
              '503':'Service Unavailable','Timeout':'Request timed out','ReadTimeout':'Page load timed out',
              'ERR':'Generic error','ConnectionError':'Failed to establish connection',
              'net::ERR_CONNECTION_TIMED_OUT':'Connection attempt timed out',
              'net::ERR_CONNECTION_RESET':'Connection was reset',
              'net::ERR_CONNECTION_REFUSED':'Server refused connection',
              'net::ERR_INTERNET_DISCONNECTED':'Local network disconnected',
              'net::ERR_NAME_NOT_RESOLVED':'DNS lookup failed',
              'net::ERR_ADDRESS_UNREACHABLE':'Server address unreachable',
              'net::ERR_NETWORK_CHANGED':'Network configuration changed',
              'net::ERR_NETWORK_ACCESS_DENIED':'Network access denied',
            };
            const rows = sorted.map(([code, entries]) => {
              const st = entries[0].status;
              const label = st === 'UP' ? 'up' : (st === 'UNCLEAR' || unclearCodes.includes(code)) ? 'warning' : 'down';
              const hint = hints[code] || '';
              const titleAttr = hint ? ` title="${hint}"` : '';
              return `<div class="code-row"${titleAttr}><span class="code-label label-${label}">${code}</span><span class="code-count">${entries[0].count}x</span></div>`;
            }).join('');
            details = `<div class="codes-grid">${rows}</div>`;
          }
          return `<div class="url-card">
            <div class="url-header" onclick="this.parentElement.classList.toggle('open')">
              <span class="url-title">${url}</span>
              <span class="url-summary"><span class="up">${s.up}</span> / <span class="down">${s.down}</span> / <span class="warning">${s.unclear}</span> &middot; <span class="badge badge-${cls}">${s.uptimePct}</span></span>
              <span class="url-chevron">&#9654;</span>
            </div>
            <div class="url-body">
              ${details}
              <div class="url-actions"><button class="btn-edit" data-url="${enc}">Edit</button> <button class="btn-del" data-url="${enc}">Del</button></div>
            </div>
          </div>`;
        }).join('')
      : '<p style="color:#64748b;text-align:center">No URLs configured</p>';

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Uptime Monitor</title>
<style>
  * { box-sizing:border-box; }
  body { font-family: system-ui,-apple-system,sans-serif; max-width:1000px; margin:0 auto; padding:20px; background:#0f172a; color:#e2e8f0; }
  h1 { color:#38bdf8; border-bottom:1px solid #334155; padding-bottom:10px; }
  .stats { display:flex; flex-wrap:wrap; gap:12px; margin:20px 0; }
  .card { background:#1e293b; padding:16px 24px; border-radius:8px; min-width:130px; flex:1; }
  .card .val { font-size:1.8em; font-weight:700; color:#38bdf8; }
  .card .lbl { font-size:0.85em; color:#64748b; margin-top:4px; }
  .status-badge { display:inline-block; padding:4px 14px; border-radius:20px; font-weight:600; font-size:0.9em; }
  .status-up { background:#166534; color:#4ade80; }
  .status-down { background:#7f1d1d; color:#f87171; }
  .status-warning { background:#713f12; color:#fbbf24; }
  .add-row { display:flex; gap:8px; margin:16px 0; }
  .add-row input { flex:1; padding:10px 14px; border:1px solid #334155; border-radius:6px; background:#1e293b; color:#e2e8f0; font-size:0.95em; }
  .add-row input:focus { outline:none; border-color:#38bdf8; }
  .add-row button, .btn-edit, .btn-del { padding:8px 16px; border:none; border-radius:6px; cursor:pointer; font-size:0.85em; font-weight:600; }
  .add-row button { background:#166534; color:#4ade80; }
  .add-row button:hover { background:#1a7a3e; }
  .btn-edit { background:#1e3a5f; color:#38bdf8; }
  .btn-edit:hover { background:#254e7a; }
  .btn-del { background:#7f1d1d; color:#f87171; }
  .btn-del:hover { background:#a32a2a; }
  .up { color:#4ade80; }
  .down { color:#f87171; }
  .warning { color:#fbbf24; }
  .badge { display:inline-block; padding:2px 10px; border-radius:12px; font-size:0.85em; font-weight:600; }
  .badge-up { background:#166534; color:#4ade80; }
  .badge-down { background:#7f1d1d; color:#f87171; }
  .badge-warning { background:#713f12; color:#fbbf24; }
  .links { margin-top:16px; font-size:0.85em; }
  .links a { color:#38bdf8; text-decoration:none; }
  .links a:hover { text-decoration:underline; }
  .toast { position:fixed; bottom:20px; right:20px; padding:12px 20px; border-radius:8px; font-size:0.9em; display:none; }
  .toast.error { display:block; background:#7f1d1d; color:#f87171; }
  .toast.ok { display:block; background:#166534; color:#4ade80; }

  .url-card { background:#1e293b; border-radius:8px; margin:8px 0; overflow:hidden; }
  .url-header { display:flex; align-items:center; gap:12px; padding:14px 16px; cursor:pointer; user-select:none; }
  .url-header:hover { background:#253349; }
  .url-title { flex:1; word-break:break-all; font-size:0.9em; }
  .url-summary { white-space:nowrap; font-size:0.85em; color:#94a3b8; }
  .url-chevron { color:#64748b; font-size:0.8em; transition:transform .2s; }
  .url-card.open .url-chevron { transform:rotate(90deg); }
  .url-body { display:none; padding:0 16px 16px; }
  .url-card.open .url-body { display:block; }
  .codes-grid { display:flex; flex-wrap:wrap; gap:8px; margin-bottom:12px; }
  .code-row { display:flex; align-items:center; gap:8px; background:#0f172a; padding:6px 12px; border-radius:6px; font-size:0.85em; cursor:help; }
  .code-label { font-weight:600; }
  .label-up { color:#4ade80; }
  .label-down { color:#f87171; }
  .label-warning { color:#fbbf24; }
  .code-count { color:#64748b; }
  .url-actions { display:flex; gap:8px; }
</style>
</head>
<body>
<h1>Uptime Monitor</h1>
<p style="color:#64748b">Last checked: ${stats.lastChecked} &middot; <span class="status-badge status-${stats.overallStatus === 'ALL UP' ? 'up' : stats.overallStatus === 'ALL DOWN' ? 'down' : 'warning'}">${stats.overallStatus}</span></p>
<div class="stats">
  <div class="card"><div class="val">${stats.global.totalMins}</div><div class="lbl">Total Checks</div></div>
  <div class="card"><div class="val" style="color:#4ade80">${stats.global.upMins}</div><div class="lbl">UP</div></div>
  <div class="card"><div class="val" style="color:#f87171">${stats.global.downMins}</div><div class="lbl">DOWN</div></div>
  <div class="card"><div class="val" style="color:#fbbf24">${stats.global.unclearMins}</div><div class="lbl">UNCLEAR</div></div>
  <div class="card"><div class="val">${stats.global.uptimePct}</div><div class="lbl">Uptime</div></div>
</div>
<div class="add-row">
  <input id="newUrl" placeholder="https://example.com" onkeydown="if(event.key==='Enter') addUrl()">
  <button onclick="addUrl()">Add URL</button>
</div>
<div class="url-list">
${urlRows}
</div>
<div class="links">
  <a href="/api/stats">JSON Stats</a> &middot;
  <a href="/api/logs">Recent Logs</a>
</div>
<div id="toast" class="toast"></div>
<script>
function toast(msg, type) { const t=document.getElementById('toast'); t.textContent=msg; t.className='toast '+type; setTimeout(()=>t.className='toast',3000); }
async function addUrl() {
  const inp=document.getElementById('newUrl'); const url=inp.value.trim();
  if(!url) return;
  const r=await fetch('/api/urls',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url})});
  if(!r.ok) { const e=await r.json(); toast(e.error||'Failed','error'); return; }
  inp.value=''; location.reload();
}
async function delUrl(enc) {
  if(!confirm('Delete this URL?')) return;
  const r=await fetch('/api/urls/'+enc,{method:'DELETE'});
  if(!r.ok) { const e=await r.json(); toast(e.error||'Failed','error'); return; }
  location.reload();
}
async function editUrl(enc) {
  const current=decodeURIComponent(enc);
  const url=prompt('Edit URL:',current);
  if(!url||url===current) return;
  const r=await fetch('/api/urls/'+enc,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({url})});
  if(!r.ok) { const e=await r.json(); toast(e.error||'Failed','error'); return; }
  location.reload();
}
document.querySelectorAll('.btn-del').forEach(b=>b.addEventListener('click',()=>delUrl(b.dataset.url)));
document.querySelectorAll('.btn-edit').forEach(b=>b.addEventListener('click',()=>editUrl(b.dataset.url)));
</script>
</body>
</html>`);
  });

  app.get('/api/stats', (_req, res) => {
    if (!existsSync(STATS_FILE)) return res.json({ error: 'No stats yet' });
    res.json(JSON.parse(readFileSync(STATS_FILE, 'utf-8')));
  });

  app.get('/api/logs', (req, res) => {
    const logs = readLogs();
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 500);
    res.json(logs.slice(-limit));
  });

  app.post('/api/urls', (req, res) => {
    const { url } = req.body;
    if (!url || typeof url !== 'string') return res.status(400).json({ error: 'url required' });
    const trimmed = url.trim();
    if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://'))
      return res.status(400).json({ error: 'URL must start with http:// or https://' });
    const urls = readUrls();
    if (urls.includes(trimmed)) return res.status(409).json({ error: 'URL already exists' });
    urls.push(trimmed);
    writeUrls(urls);
    res.json({ urls });
  });

  app.delete('/api/urls/:encoded', (req, res) => {
    const target = decodeURIComponent(req.params.encoded);
    const urls = readUrls();
    const idx = urls.indexOf(target);
    if (idx === -1) return res.status(404).json({ error: 'URL not found' });
    urls.splice(idx, 1);
    writeUrls(urls);
    res.json({ urls });
  });

  app.put('/api/urls/:encoded', (req, res) => {
    const target = decodeURIComponent(req.params.encoded);
    const { url } = req.body;
    if (!url || typeof url !== 'string') return res.status(400).json({ error: 'url required' });
    const trimmed = url.trim();
    if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://'))
      return res.status(400).json({ error: 'URL must start with http:// or https://' });
    const urls = readUrls();
    const idx = urls.indexOf(target);
    if (idx === -1) return res.status(404).json({ error: 'URL not found' });
    if (target !== trimmed && urls.includes(trimmed))
      return res.status(409).json({ error: 'New URL already exists' });
    urls[idx] = trimmed;
    writeUrls(urls);
    res.json({ urls });
  });

  app.get('/api/urls', (_req, res) => {
    res.json({ urls: readUrls() });
  });

  app.listen(PORT, '0.0.0.0', () => console.log(`Web UI listening on port ${PORT}`));
}

ensureLogsFile();
const urls = readUrls();
if (urls.length === 0) {
  console.error('No URLs found in ' + URLS_FILE);
  process.exit(1);
}
console.log(`Monitoring ${urls.length} URLs every ${INTERVAL / 1000}s`);

runCheck(urls).then(() => setInterval(() => runCheck(urls), INTERVAL));
startServer();
