# Deployment

## Head Node Deployment

Clone or pull the repo on the Slurm head node:

```bash
git clone https://github.com/dnightin/Slurm-Job-Explorer.git
cd Slurm-Job-Explorer
npm start
```

The app binds to `0.0.0.0:3017` by default so other machines can connect if the network allows the port.

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

Create `/etc/systemd/system/slurm-job-explorer.service`:

```ini
[Unit]
Description=Slurm Job History Explorer
After=network.target

[Service]
Type=simple
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

