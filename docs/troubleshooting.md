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
