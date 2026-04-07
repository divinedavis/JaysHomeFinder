# HomeFinder — CLAUDE.md

> **Living document.** Update this file whenever architecture, endpoints, infrastructure, or workflows change.

## Golden Rule

**Push every change to GitHub immediately after making it.**
```bash
cd /var/www/homefinder && git add -A && git commit -m 'describe change' && git push origin main
```

## Overview

HomeFinder is a real-estate property scanner that automatically finds affordable multi-family investment properties across the NYC/NJ/PA metro area. It runs a daily scan via the Realtor.com API, scores each property against a buyer checklist, and presents qualified deals through a web dashboard.

- **Domain:** jayshomefinder.com
- **GitHub:** git@github.com:divinedavis/JaysHomeFinder.git
- **Server:** DigitalOcean droplet 104.236.120.144
- **Owner goal:** Build a real estate portfolio toward a $3M Brooklyn mixed-use building with a coffee shop

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 20 (v20.20.2) |
| Framework | Express 5 |
| Database | SQLite via better-sqlite3 (WAL mode) |
| Process manager | PM2 (process name: `homefinder`) |
| Reverse proxy | Nginx → 127.0.0.1:3000 |
| SSL | Let's Encrypt (Certbot auto-renew) |
| Data source | Realtor.com via RapidAPI (`realty-in-us.p.rapidapi.com`) |
| Scheduler | node-cron (daily 7 AM EST) |
| OS | Ubuntu 24.04 LTS |

## Project Structure

```
/var/www/homefinder/
├── server.js          # All backend logic (Express app, API, cron, checklist)
├── public/
│   └── index.html     # Single-page frontend (vanilla HTML/JS/CSS)
│   └── og-image.png   # Open Graph social preview image
├── homefinder.db      # SQLite database (gitignored)
├── .env               # Environment variables (gitignored)
├── package.json
├── CLAUDE.md          # This file
└── .gitignore
```

## Database Schema

### properties
Core table storing every scanned listing. Key columns:
- `address` (UNIQUE), `city`, `state`, `zipCode`, lat/lon
- `price`, `propertyType`, `bedrooms`, `bathrooms`, `squareFootage`
- `checklistScore`, `checklistDetails` (JSON), `passedAll` (0/1)
- `photoUrl`, `listingUrl`, `propertyId`, `priceReduced`
- `source` (default: 'daily-scan'), timestamps

### portfolio
User's tracked/watched properties with financials (purchasePrice, monthlyRent, equity, etc.)

### user_profile
Single-row table (id=1) with buyer financial profile: income $150k, goal $3M Brooklyn building.

### scan_logs
Audit trail of every scan run (city, counts, timestamps).

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/properties | List properties (query: city, sort, showAll) |
| GET | /api/dashboard | Full dashboard data (stats, qualified, portfolio) |
| GET | /api/portfolio | List portfolio items |
| POST | /api/portfolio | Add to portfolio |
| DELETE | /api/portfolio/:id | Remove from portfolio |
| GET | /api/profile | Get user financial profile |
| PUT | /api/profile | Update user financial profile |
| POST | /api/calculate | Investment calculator |
| POST | /api/scan/run | Trigger manual scan |
| GET | /api/scan/logs | Recent scan history |

## Daily Scan

Runs automatically at **7 AM EST** and on server startup (3s delay). Scans these cities:
- Bronx NY
- Philadelphia PA, York PA, Lancaster PA
- Newark NJ, Camden NJ, Trenton NJ, Irvington NJ, East Orange NJ, Paterson NJ, Passaic NJ

**Filters:** Multi-family, $50k–$500k, non-distressed, listed within 2 years.

## Checklist (Scoring)

Each property is scored on these checks:
1. FHA 3.5% eligible (multi-family, under FHA limit)
2. Separated utilities estimate (4+ beds + multi-family)
3. Legal multi-family zoning
4. Owner-occupancy ready
5. Price per unit < $350k

Properties passing all checks get `passedAll = 1` and appear on the main dashboard.

## Environment Variables (.env)

| Key | Purpose |
|-----|---------|
| RAPIDAPI_KEY | Realtor.com API access |
| RENTCAST_API_KEY | Rent estimate API (available but not currently used in main scan) |
| PORT | Server port (default 3000) |
| SESSION_SECRET | Session signing |
| APP_PASSWORD | App authentication |

## Common Operations

```bash
# Restart the app after code changes
pm2 restart homefinder

# View logs
pm2 logs homefinder

# Check status
pm2 status

# Nginx config
/etc/nginx/sites-available/homefinder

# Reload Nginx
sudo systemctl reload nginx

# Run a manual scan
curl -X POST http://localhost:3000/api/scan/run
```

## Deployment Workflow

1. SSH into 104.236.120.144
2. Edit files in /var/www/homefinder/
3. `pm2 restart homefinder`
4. Test endpoints
5. `git add -A && git commit -m 'message' && git push origin main`

---
*Last updated: 2026-04-07*
