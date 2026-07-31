# Deployment

## Head Node Deployment

Clone or pull the repo on the Slurm head node:

```bash
git clone https://github.com/dnightin/Slurm-Job-Explorer.git
cd Slurm-Job-Explorer
npm start
```

The app binds to `0.0.0.0:3017` by default so other machines can connect if the network allows the port.

## Access Control

The app has no built-in authentication. Anyone who can reach `HOST:PORT` sees cluster-wide job data — usernames, job names, states, and resource usage for every user, not just their own. Treat this like any other unauthenticated internal tool: restrict who can reach the port rather than relying on the app itself.

Options, roughly in order of effort:

- **VPN/firewall-only access** (the pattern this repo assumes): keep `HOST=0.0.0.0` but rely on the head node's firewall and a campus VPN as the real access boundary — see [Firewall](#firewall). Anyone on the VPN can still see every user's job data; that's a deliberate trade-off for a shared HPC dashboard, worth confirming is the one you want rather than an oversight.
- **Bind to localhost and put a reverse proxy in front** with its own authentication (HTTP basic auth, SSO, etc.) if you need per-user access control instead of network-level gating — see [Local-Only Binding](#local-only-binding).

## Running On Another Port

```bash
PORT=8080 npm start
```

## Local-Only Binding

```bash
HOST=127.0.0.1 npm start
```

## Firewall

If the app works locally on the head node but not from another machine, check whether the port is blocked.

```bash
ss -ltnp | grep 3017
sudo iptables -L INPUT -n --line-numbers
```

Allow the port with iptables:

```bash
sudo iptables -I INPUT -p tcp --dport 3017 -j ACCEPT
```

Persist the rule using the method standard for the host:

```bash
sudo service iptables save
```

or:

```bash
sudo iptables-save | sudo tee /etc/sysconfig/iptables
```

## systemd Example

Create `/etc/systemd/system/slurm-job-explorer.service`. Run it as a dedicated, non-root service account rather than root — but that account needs Slurm accounting read access (an `sacctmgr` operator/coordinator role, or equivalent), or every query will silently return zero jobs even though `sacct` exits cleanly. See [Troubleshooting](troubleshooting.md#sacct-succeeds-but-returns-no-jobs).

```ini
[Unit]
Description=Slurm Job History Explorer
After=network.target

[Service]
Type=simple
User=slurm-explorer
WorkingDirectory=/opt/Slurm-Job-Explorer
Environment=PORT=3017
Environment=HOST=0.0.0.0
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now slurm-job-explorer
sudo systemctl status slurm-job-explorer
```

