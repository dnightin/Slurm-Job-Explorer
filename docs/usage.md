# Usage

## Sample Screenshots

The images below use sanitized sample data for documentation.

![Sanitized dashboard screenshot](assets/sample-dashboard.png)

![Sanitized tooltip screenshot](assets/sample-tooltip.png)

## Filters

- `Window`: reloads data for the selected number of days.
- `Limit`: caps the number of jobs plotted. When the window holds more, the chart shows an evenly spaced sample across the whole window, and the status line says so. The time axis always spans the full window.
- `User`: reloads data scoped to one Slurm user (`limit` applies to that user's jobs). The dropdown is populated from the most recent unfiltered load.
- `Refresh`: reloads data using the current window and limit, always running a fresh `sacct` query. Changing the window or user may instead reuse a pull from the last few minutes, which is much faster; the status line says how old that data is.

Changing the `Window` dropdown reloads data immediately.

## Chart

Each point is a Slurm job allocation.

- X-axis: job start time
- Y-axis: picked with the `Y-axis` menu (see below)
- Color: job state. Out-of-memory jobs have their own color; node failures are drawn as dark diamonds; states without their own style are grouped as Other

The `Y-axis` menu picks what each point's height shows:

| Option | Meaning |
| --- | --- |
| Runtime | Elapsed wall-clock time |
| Queue wait | Start minus Submit: how long the job waited for resources |
| CPU efficiency | `TotalCPU / (Elapsed × AllocCPUS)`. Low values mean cores were allocated but idle |
| Peak memory | The largest `MaxRSS` across the job's steps |

Jobs with no value for the chosen metric are left off the chart, and the status line says how many. CPU efficiency is blank for jobs that are pending or still running (Slurm only adds CPU time when a step finishes), and wait time is blank for jobs that haven't started.

Check `Log scale` to switch the axis to a logarithmic scale, with gridlines at round values (1s, 10s, 1m, 10m, 1h, 6h, 1d for times; 1 MB, 10 MB, 100 MB, 1 GB for memory). This spreads out small values when a few large ones would otherwise squash everything into the bottom of the chart. Zero values (such as a pending job's runtime) sit on the lowest line. CPU efficiency is always shown on a linear 0-100% scale.

The summary tiles above the chart include the median CPU efficiency and median queue wait for the loaded jobs.

Hover a point to see:

- Job ID
- Job name
- Runtime, CPU efficiency, peak memory, and queue wait
- State
- User
- Start time

## Zooming

Scale the visible time range with the mousewheel, or a two-finger pinch on a touchscreen:

- Wheel up / pinch out: zoom in around the cursor (or pinch midpoint)
- Wheel down / pinch in: zoom out
- `Reset zoom`: return to the full loaded time range

## Accessibility

The chart is a canvas element, so its data isn't directly readable by a keyboard or screen reader. A visually-hidden table with the same job data (ID, name, user, state, start, runtime) sits alongside it in the DOM at all times — it reflects the current filters but not the chart's zoom state, since zoom only changes what's visually plotted, not what data is loaded.
