# API

## `GET /api/jobs`

Returns Slurm job allocation rows as JSON.

### Query Parameters

| Parameter | Default | Description |
| --- | --- | --- |
| `days` | `14` | Time window ending now. Clamped from 1 to 365 |
| `limit` | `500` | Maximum rows returned **after** the `user` filter is applied. Clamped from 10 to 5000 |
| `start` | derived from `days` | Optional explicit start date/time |
| `end` | now | Optional explicit end date/time |
| `user` | none | Optional Slurm username. Passed to `sacct --user` before the window filter and `limit` are applied. Ignored if it contains characters outside `A-Za-z0-9_.,-` |

### Response

```json
{
  "source": "sacct",
  "warning": null,
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
      "maxRss": "3200M"
    }
  ]
}
```

If `sacct` is unavailable, the server returns sample data with:

```json
{
  "source": "sample",
  "warning": "sacct unavailable or failed: ...",
  "jobs": []
}
```

## Server-Side Window Enforcement

The API filters returned rows by job start time after parsing `sacct` output. This prevents extra rows from appearing outside the selected window if the `sacct` command returns a broader result set.

