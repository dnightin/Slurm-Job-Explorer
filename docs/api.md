# API

## `GET /api/jobs`

Returns Slurm jobs as JSON, one entry per job allocation. Peak memory comes from a second `sacct` query over the returned jobs' steps; if it fails, `warning` says so and `maxRssBytes` is `null`.

### Query Parameters

| Parameter | Default | Description |
| --- | --- | --- |
| `days` | `14` | Time window ending now. Clamped from 1 to 365 |
| `limit` | `500` | Maximum rows returned **after** the `user` filter is applied. Clamped from 10 to 5000. When the window holds more jobs, an evenly spaced sample across the window is returned |
| `start` | derived from `days` | Optional explicit start date/time. Must be before `end`, and the window can be at most 365 days |
| `end` | now | Optional explicit end date/time |
| `refresh` | none | `1` skips the server's cache of recent `sacct` pulls and runs a fresh one |
| `user` | none | Optional Slurm username, or a comma-separated list. Passed to `sacct --user` before the window filter and `limit` are applied. Returns `400` if it contains characters outside `A-Za-z0-9_.,-` |

When more jobs match than `limit`, the newest jobs (by start time) are returned.

### Response

```json
{
  "source": "sacct",
  "warning": null,
  "total": 1,
  "truncated": false,
  "fetchedAt": 1779530400000,
  "fromCache": false,
  "windowStartMs": 1778320800000,
  "windowEndMs": 1779530400000,
  "jobs": [
    {
      "jobId": "12345",
      "jobName": "my-job",
      "user": "dnightin",
      "account": "research",
      "partition": "batch",
      "state": "COMPLETED",
      "submit": "2026-05-23T10:00:00",
      "start": "2026-05-23T10:01:00",
      "end": "2026-05-23T10:44:00",
      "elapsed": "00:43:00",
      "runtimeSeconds": 2580,
      "allocCpus": 16,
      "totalCpu": "11:20:00",
      "maxRss": "3200M",
      "maxRssBytes": 3355443200,
      "cpuEfficiency": 0.99,
      "waitSeconds": 60,
      "startMs": 1779530460000
    }
  ]
}
```

Jobs are sorted newest first. `total` is the number of jobs in the window, and `truncated` is `true` when there were more than `limit`. In that case the response holds an evenly spaced sample of `limit` jobs across the whole window, not only the newest ones. `fetchedAt` is when the underlying `sacct` pull ran, in epoch milliseconds, and `fromCache` is `true` when the response was filtered from an earlier pull rather than a new one (see `SACCT_CACHE_SECONDS` in the README). `windowStartMs` and `windowEndMs` are the window that was queried, in epoch milliseconds; the chart's time axis spans them. `maxRssBytes` is the largest `MaxRSS` across the job's steps, in bytes. `cpuEfficiency` is `TotalCPU / (Elapsed × AllocCPUS)` as a fraction, or `null` for jobs that are pending, running, or have no CPU time. `waitSeconds` is Start minus Submit, or `null` if the job hasn't started. `startMs` is the time the server dated the job by (Start, else Submit, else End) in epoch milliseconds; the chart plots this value.

In demo mode (`npm run demo` or `DEMO_MODE=1`) the response has `"source": "sample"` and a `warning` saying the data is generated.

### Errors

Errors return JSON with an `error` message:

```json
{ "error": "sacct was not found on the server's PATH." }
```

| Status | When |
| --- | --- |
| `400` | Invalid `user`, `start`, or `end`, `start` after `end`, or a window longer than 365 days |
| `502` | `sacct` is missing, failed, timed out, or produced more output than `SACCT_MAX_BUFFER_MB`. Details are written to the server log |

## Server-Side Window Enforcement

The API filters returned rows by job start time after parsing `sacct` output. This prevents extra rows from appearing outside the selected window if the `sacct` command returns a broader result set.

