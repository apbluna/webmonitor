# Uptime Monitor

A lightweight uptime monitoring service that uses Puppeteer with stealth plugins to check website availability. Built with Express and TypeScript.

## Features

- Monitors multiple URLs at configurable intervals (default: 60s)
- Uses Puppeteer Stealth to bypass bot detection
- Web UI dashboard with real-time stats
- JSON API endpoints for stats and logs
- Logs stored in JSON format
- Docker Compose deployment

## Setup

```
docker compose up -d --build
```

The web UI is available on port 3000.

## Configuration

- **URLs**: Edit `urls.txt` in the data directory (one URL per line, `#` for comments)
- **Interval**: Change `INTERVAL` in `src/index.ts` (default: 60,000ms)
- **Timeout**: Change `TIMEOUT` in `src/index.ts` (default: 30,000ms)

## Endpoints

| Route | Description |
|---|---|
| `/` | Web UI dashboard |
| `/api/stats` | JSON stats |
| `/api/logs` | Recent log entries (`?limit=50`) |

## Data

Logs and stats persist in the mounted volume:
- `uptime_logs.json` — Raw check log entries
- `uptime_stats.json` — Computed uptime statistics
