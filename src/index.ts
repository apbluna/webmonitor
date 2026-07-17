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

const TEMPLATE_FILE = join(__dirname, '..', 'views', 'index.html');
let pageTemplate = '';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function loadTemplate(): string {
  try {
    return readFileSync(TEMPLATE_FILE, 'utf-8');
  } catch {
    console.error('Template not found at ' + TEMPLATE_FILE);
    process.exit(1);
  }
}

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
  pageTemplate = loadTemplate();
  const app = express();
  app.use(express.json());
  app.use(express.static(join(__dirname, '..', 'public')));

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
    const recentLogs: Record<string, LogEntry[]> = {};
    try {
      const logs = readLogs();
      for (const url of allUrls) {
        recentLogs[url] = logs.filter(l => l.url === url).slice(-10);
      }
    } catch {} // ignore if logs unavailable
    const urlRows = allUrls.length > 0
      ? allUrls.map(url => {
          const s = stats.perUrl[url];
          const codes = perUrlCodes[url];
          const enc = encodeURIComponent(url);
          if (!s) {
            const logs = (recentLogs[url] || []).map(l => {
              const cls = l.status === 'UP' ? 'up' : l.status === 'UNCLEAR' ? 'warning' : 'down';
              return `<div class="log-row"><span class="log-ts">${l.ts}</span><span class="log-status label-${cls}">${l.status}</span><span class="log-code">${l.code}</span><span class="log-ms">${l.ms}ms</span></div>`;
            }).join('');
            const logSection = logs ? `<div class="log-label">Last 10 checks</div><div class="log-grid"><div class="log-row log-header"><span class="log-ts">Timestamp</span><span class="log-status">Status</span><span class="log-code">Code</span><span class="log-ms">Resp.</span></div>${logs}</div>` : '';
            return `<div class="url-card">
              <div class="url-header" onclick="this.parentElement.classList.toggle('open')">
                <span class="url-title">${url}</span>
                <span class="url-summary">No data yet</span>
                <span class="url-chevron">&#9654;</span>
              </div>
              <div class="url-body">
                ${logSection}
                <div class="url-actions"><button class="btn-edit" data-url="${enc}">Edit</button> <button class="btn-del" data-url="${enc}">Del</button></div>
              </div>
            </div>`;
          }
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
          const logs = (recentLogs[url] || []).map(l => {
            const cls = l.status === 'UP' ? 'up' : l.status === 'UNCLEAR' ? 'warning' : 'down';
            return `<div class="log-row"><span class="log-ts">${l.ts}</span><span class="log-status label-${cls}">${l.status}</span><span class="log-code">${l.code}</span><span class="log-ms">${l.ms}ms</span></div>`;
          }).join('');
          const logHeader = `<div class="log-row log-header"><span class="log-ts">Timestamp</span><span class="log-status">Status</span><span class="log-code">Code</span><span class="log-ms">Resp.</span></div>`;
          const logSection = logs ? `<div class="log-label">Last 10 checks</div><div class="log-grid">${logHeader}${logs}</div>` : '';
          return `<div class="url-card">
            <div class="url-header" onclick="this.parentElement.classList.toggle('open')">
              <span class="url-title">${url}</span>
              <span class="url-summary"><span class="up">${s.up}</span> / <span class="down">${s.down}</span> / <span class="warning">${s.unclear}</span> &middot; <span class="badge badge-${cls}">${s.uptimePct}</span></span>
              <span class="url-chevron">&#9654;</span>
            </div>
            <div class="url-body">
              ${details}
              ${logSection}
              <div class="url-actions"><button class="btn-edit" data-url="${enc}">Edit</button> <button class="btn-del" data-url="${enc}">Del</button></div>
            </div>
          </div>`;
        }).join('')
      : '<p style="color:#64748b;text-align:center">No URLs configured</p>';

    const statusClass = stats.overallStatus === 'ALL UP' ? 'up' : stats.overallStatus === 'ALL DOWN' ? 'down' : 'warning';
    res.send(
      pageTemplate
        .replace('{{LAST_CHECKED}}', stats.lastChecked)
        .replace('{{STATUS_CLASS}}', statusClass)
        .replace('{{OVERALL_STATUS}}', stats.overallStatus)
        .replace('{{TOTAL_MINS}}', String(stats.global.totalMins))
        .replace('{{UP_MINS}}', String(stats.global.upMins))
        .replace('{{DOWN_MINS}}', String(stats.global.downMins))
        .replace('{{UNCLEAR_MINS}}', String(stats.global.unclearMins))
        .replace('{{UPTIME_PCT}}', stats.global.uptimePct)
        .replace('{{URL_ROWS}}', urlRows)
    );
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
