#!/usr/bin/env bash
# All VMs. Installs Java 17 (headless) and Apache JMeter into /opt/apache-jmeter-$V (symlink /opt/jmeter).
# Usage: ssh azureuser@<vm> "bash -s" < infra/1-install-jmeter.sh
set -euo pipefail
V=5.6.3
export DEBIAN_FRONTEND=noninteractive
sudo apt-get update -qq
sudo apt-get install -y -qq openjdk-17-jre-headless curl ca-certificates >/dev/null
if [ ! -x /opt/apache-jmeter-$V/bin/jmeter ]; then
  cd /tmp
  for base in https://dlcdn.apache.org https://archive.apache.org/dist; do
    url=$base/jmeter/binaries/apache-jmeter-$V.tgz
    if curl -fsSL --retry 2 -o jmeter.tgz "$url" && curl -fsSL -o jmeter.tgz.sha512 "$url.sha512"; then break; fi
  done
  echo "$(awk '{print $1}' jmeter.tgz.sha512)  jmeter.tgz" | sha512sum -c --status
  sudo tar -xzf jmeter.tgz -C /opt
  rm -f jmeter.tgz jmeter.tgz.sha512
fi
sudo ln -sfn /opt/apache-jmeter-$V /opt/jmeter
sudo chown -R azureuser:azureuser /opt/apache-jmeter-$V
echo "$(hostname): $(java -version 2>&1 | head -1) | $(/opt/jmeter/bin/jmeter --version 2>/dev/null | grep -o '5\.[0-9.]*' | head -1)"
