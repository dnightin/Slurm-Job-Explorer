# Slurm Job History Explorer

A small Node.js web app for exploring Slurm `sacct` history in a browser. The first view is a runtime scatter plot that helps spot long-running jobs, failures, timeouts, and user-specific patterns.

## Features

- Pulls job allocation data from `sacct`
- Graphs job runtime by start time
- Color-codes points by Slurm state
- Sizes points by fixed runtime buckets
- Filters by time window, row limit, and user
- Mousewheel zooms the chart time range
- Hover tooltips show job details
- Falls back to sample data if `sacct` is unavailable

## Requirements

- Node.js 18 or newer
- Slurm accounting configured on the host
- `sacct` available in the service user's `PATH`

No npm package install is required for the current app. It uses only Node built-ins and browser-native canvas.

## Quick Start

```bash
git clone https://github.com/dnightin/Slurm-Job-Explorer.git
cd Slurm-Job-Explorer
npm start
```

By default the app listens on all interfaces:

```text
http://0.0.0.0:3017
```

Browse to the server by hostname or IP:

```text
http://head-node-name:3017
http://10.21.0.110:3017
```

## Configuration

Environment variables:

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3017` | TCP port for the web server |
| `HOST` | `0.0.0.0` | Bind address. Use `127.0.0.1` for local-only access |

Example:

```bash
PORT=8080 HOST=0.0.0.0 npm start
```

## How It Works

The server exposes `/api/jobs`, runs `sacct`, parses pipe-delimited output, filters jobs to the requested time window, and returns JSON to the browser. The frontend renders the scatter plot with canvas.

The `sacct` query requests allocation rows using:

```text
JobIDRaw, JobName, User, Account, Partition, State, Submit, Start, End, Elapsed, AllocCPUS, TotalCPU, MaxRSS
```

## Runtime Buckets

Point size is based on elapsed runtime:

| Bucket | Runtime |
| --- | --- |
| 1 | `0-12 hours` |
| 2 | `13-72 hours` |
| 3 | `73 hours-1 week` |
| 4 | `2 weeks` |
| 5 | `28+ days` |

## Documentation

- [Deployment](docs/deployment.md)
- [Usage](docs/usage.md)
- [API](docs/api.md)
- [Troubleshooting](docs/troubleshooting.md)

## Development

Start the app:

```bash
npm start
```

Syntax-check the JavaScript:

```bash
node --check server.js
node --check public/app.js
```

