#!/usr/bin/env bash
# Worker VMs. jmeter-server as a systemd service on fixed RMI ports.
# Usage: ssh azureuser@<worker> "bash -s <worker-public-ip>" < infra/3-worker.sh
#   1099  RMI registry (controller connects here)
#   50000 worker RMI object port (controller connects here)
# java.rmi.server.hostname must be the PUBLIC IP: the VMs only reach each other over public IPs.
set -euo pipefail
PUBLIC_IP=$1
sudo mkdir -p /var/lib/jmeter && sudo chown azureuser:azureuser /var/lib/jmeter
sudo tee /etc/systemd/system/jmeter-server.service >/dev/null <<UNIT
[Unit]
Description=Apache JMeter worker (jmeter-server)
After=network-online.target
Wants=network-online.target

[Service]
User=azureuser
WorkingDirectory=/var/lib/jmeter
Environment="HEAP=-Xms4g -Xmx4g -XX:MaxMetaspaceSize=256m"
# -L ...=WARN: otherwise every property sent by the controller (API key, tokens) is logged.
# The wrapper script logs to ./jmeter-server.log, i.e. /var/lib/jmeter/jmeter-server.log.
ExecStart=/opt/jmeter/bin/jmeter-server -Djava.rmi.server.hostname=${PUBLIC_IP} -Dserver_port=1099 \
  -Jserver.rmi.localport=50000 -Jserver.rmi.ssl.disable=true \
  -Lorg.apache.jmeter.engine=WARN
Restart=always
RestartSec=5
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable --now jmeter-server >/dev/null 2>&1
sudo systemctl restart jmeter-server
sleep 10
systemctl is-active jmeter-server
grep -o "Created remote object.*endpoint:\[[^]]*\]" /var/lib/jmeter/jmeter-server.log | tail -1
ss -ltn | grep -E ':(1099|50000) ' | awk '{print "listening " $4}'
