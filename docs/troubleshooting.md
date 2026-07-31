# Troubleshooting

## App Starts But Remote Browser Cannot Connect

Confirm the app is listening:

```bash
ss -ltnp | grep 3017
curl -v http://127.0.0.1:3017
curl -v http://$(hostname):3017
```

If local curl works but remote clients fail, check firewall rules:

```bash
sudo iptables -L INPUT -n --line-numbers
```

If there is a reject rule at the end, add an allow rule before it:

```bash
sudo iptables -I INPUT -p tcp --dport 3017 -j ACCEPT
```

From Windows, test TCP directly:

```powershell
Test-NetConnection your-head-node.example.edu -Port 3017
```

## Browser Shows Sample Data

Sample data means `sacct` could not be executed successfully by the Node process.

Check:

```bash
which sacct
sacct --version
sacct --parsable2 --noheader --allocations --starttime now-1days --endtime now --format JobIDRaw,JobName,User,State,Start,Elapsed
```

If `sacct` works in your shell but not in the service, make sure the service user has the same Slurm environment and `PATH`.

## sacct Succeeds But Returns No Jobs

The API can report `{"source":"sacct","warning":null,"jobs":[]}` even when jobs exist in the selected window. `sacct` exits `0` and produces no error text in this case, so the app has no way to distinguish it from "no jobs in this window" — it looks identical to an empty chart.

The most common cause is running the Node process as a service account that can query Slurm but does not have accounting permissions for other users' jobs, so `sacct` silently returns rows only for jobs owned by that account (often none).

Check:

```bash
whoami
sacct --parsable2 --noheader --allocations --starttime now-1days --endtime now --format JobIDRaw,User
```

If that comes back empty while running as the service user, but returns rows when run as your own account (or as a user known to have accounting read access), the service user needs Slurm accounting permissions — either run the service as a user with cluster-wide `sacct` visibility, or grant the service account an operator/coordinator role in `sacctmgr`.

## Window Shows Unexpected Data

The server filters jobs by parsed start time. If the chart still looks wrong, inspect the API response directly:

```bash
curl 'http://127.0.0.1:3017/api/jobs?days=7&limit=10'
```

Check the `start`, `submit`, and `end` fields returned by `sacct`.

## Empty Chart

Possible causes:

- No jobs in the selected window
- Selected user has no jobs in the selected window
- `sacct` returned rows without parseable start, submit, or end timestamps
- `limit` is too low for the jobs you expect to see
