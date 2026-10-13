# API benchmarks with Apache JMeter

Each API has its own JMeter plan in `apis/<api>/`. The `bench` CLI asks for the run settings, passes them to JMeter and starts it. JMeter produces all the results.

## Layout

```
apis/<api>/<api>.jmx        JMeter plan for one API (open/edit it in the JMeter GUI)
apis/<api>/metadata.json    title, description, writes flag, warning, optional per-API defaults
config/defaults.json        default answers for the CLI prompts
config/token.json           how to log in and get a user token (HTTP steps, no code)
config/jmeter.properties    JMeter result-file and distributed-mode settings for every run
postman-collection/         the source collection and one environment file per cluster:
                              postman-env.json (test.sunbirded.org), benchmark-env.json (benchmark/dev cluster);
                              gitignored, created from the committed *.example.json copies
cli/                        the bench CLI (orchestration only)
infra/                      scripts that set up the master/worker VMs
test/                       runs every plan through real JMeter against a local mock
jmeter/                     JMeter install only (npx bench setup) — gitignored
output/<run-name>/          one folder per run — gitignored
```

## Setup (once)

```bash
npm install
npx bench setup      # downloads and verifies JMeter 5.6.3 into jmeter/ (needs Java 17)
```

## Run

```bash
npx bench            # interactive; every prompt explains itself
npx bench help       # every setting explained
npx bench list       # available APIs with descriptions and warnings
```

The CLI asks for:
1. the API;
2. the environment file (choose the prod file for prod);
3. a run name;
4. remote hosts (blank = this machine);
5. threads, ramp-up, and either a duration or a loop count;
6. a target TPS;
7. a user token, if the API needs one.

It then shows a plan (target host, request, load, expected volume, warnings) and asks for confirmation. Write APIs default to "No".

Any prompt can be answered with a flag, which makes runs repeatable:

```bash
npx bench --api content_read --env_file postman-collection/benchmark-env.json --name content-read-500tps \
          --hosts "" --threads 150 --ramp_up 30 --duration 600 --tps 500 --yes true
```

| Setting | Meaning |
|---|---|
| `threads` | Concurrent virtual users **on each generator**; each sends requests back to back |
| `ramp_up` | Seconds to start all threads |
| `duration` | Seconds to run (threads loop until time is up). `0` = use `loops` |
| `loops` | Requests per thread when duration is 0 |
| `tps` | Target requests/second for the **whole** run, split across generators. `0` = unpaced (as fast as threads allow). TPS is a ceiling: reaching it needs `threads ≈ tps × avg response seconds × 1.5` |

A machine can override any default in `config/defaults.local.json` (gitignored). The master uses it to pre-fill the worker hosts: `{"hosts": "<worker1-ip>,<worker2-ip>"}`. `config/defaults.json` also holds `connect_timeout_ms`, `response_timeout_ms` and `heap` (the JMeter JVM heap, e.g. `-Xms2g -Xmx4g` for high load). An API can override defaults in the `defaults` object of its `metadata.json`.

## Results

Everything in `output/<run-name>/` is written by JMeter, except `manifest.json`:

- `dashboard/index.html`: JMeter HTML report with TPS, errors, p90/p95/p99 and graphs over time. Use the over-time graphs to ignore the warm-up period.
- `dashboard/statistics.json`: the same totals as JSON (`pct1/2/3ResTime` = p90/p95/p99). The CLI prints its `Total` line at the end.
- `samples.jtl`: every request (CSV, no bodies or headers)
- `jmeter.log`, `console.log`: JMeter's log and console output
- `manifest.json`: run settings, target host, JMX hash, token time. No secrets.

## Variables, environment and tokens

The JMX files read values with `${__P(name,)}`, using the same names as the Postman variables (`{{apikey}}` → `${__P(apikey,)}`).

- **Environment file:** holds every variable the JMX files use (host, API key, user …); only the ones the chosen JMX uses are passed to JMeter. It can be a Postman environment export or a flat JSON object. Before starting, the CLI checks that every `${__P(...)}` the chosen JMX uses has a value. A missing variable stops the run with its name.
- **Token:** `config/token.json` lists the login steps (Keycloak login, then gateway refresh) and which response fields to keep (`user_access_token`, `user_refresh_token`). If a JMX uses one of those, the CLI asks how to get it:
  - **new** (default): log in now;
  - **saved**: reuse `.token.json`, offered only if it was created for the same host;
  - **paste**: enter a token by hand.

  `npx bench token` just generates one. Expiry isn't handled: generate a fresh token before each run, and keep runs shorter than the token's lifetime.
- **Secrets** reach JMeter only through a temporary owner-only file in `.runtime/`, which is deleted after the run. Only the variables the chosen JMX uses are passed, never the whole environment file. They never appear on the command line or in `output/`; `npm test` checks this, including for distributed runs. Keep production environment files outside the repo, or gitignored.

## Adding or changing an API

1. Create `apis/<new_api>/` with one `.jmx` file and a `metadata.json`:
   ```json
   { "title": "…", "description": "METHOD /path. What it does.", "writes": false, "warning": "", "defaults": {} }
   ```
2. Build the JMX like the existing ones:
   - one Thread Group using `${__P(threads,1)}`, `${__P(ramp_up,1)}`, `${__P(loops,1)}`, `${__P(scheduler,false)}`, `${__P(duration,0)}`;
   - an HTTP Request with `${__P(host,)}` in the path and `${__P(connect_timeout_ms,10000)}` / `${__P(response_timeout_ms,30000)}`;
   - a Constant Throughput Timer with `${__P(target_rpm,600000000)}` (calcMode "all active threads (shared)");
   - assertions for HTTP 200 and the application response code.

   The easiest way is to copy an existing folder and edit it in the GUI: `jmeter/apache-jmeter-5.6.3/bin/jmeter`.
3. `npx bench list` shows it immediately. `npm test` runs it against the mock (extend `test/mock-server.js` for a new route).

IDs such as user, course, batch and content come from the environment file (`user_id`, `course_id`, `batch_id`, `content_id`, `content_ids` (comma-separated), `collection_id`), so the same plans run on any cluster. `user_id` must belong to `username`, and that user must be enrolled in `course_id`/`batch_id`.

## Clusters

| Cluster | Environment file |
|---|---|
| benchmark / dev (dev.sunbirded.org) | `postman-collection/benchmark-env.json` (default) |
| test (test.sunbirded.org) | `postman-collection/postman-env.json` (pass `--env_file`) |

`benchmark-env.json` is the default environment file (set in `config/defaults.json`). It uses the dev cluster's Public User 1 (`user1@yopmail.com`); course, batch and content IDs still need to be replaced once the benchmark cluster is seeded. To target the test cluster, pass `--env_file postman-collection/postman-env.json`.

Both environment files are gitignored because they hold secrets. Create them from the committed copies and fill in `apikey`, the client secrets and the passwords:

```bash
cp postman-collection/benchmark-env.example.json postman-collection/benchmark-env.json
cp postman-collection/postman-env.example.json postman-collection/postman-env.json
```

## Distributed runs (several load generators)

One **master** (controller) runs `npx bench`, starts the test on the **workers** and collects their results. The workers generate the load. Everything runs the same JMeter and Java versions.

### Current VMs (Azure, Ubuntu 24.04, 2 vCPU / 7 GB each)

| Role | VM | Public IP | Runs |
|---|---|---|---|
| master | <master-vm> | <master-ip> | `~/benchmarking` (this repo), `npx bench` |
| worker | <worker1-vm> | <worker1-ip> | `jmeter-server` systemd service |
| worker | <worker2-vm> | <worker2-ip> | `jmeter-server` systemd service |

The VMs have no shared private network, so JMeter traffic goes over their **public IPs** on fixed ports. The Azure NSGs must allow:

| On | Allow inbound TCP | From |
|---|---|---|
| each worker | 1099, 50000 | master <master-ip> |
| master | 60000-60010 | each worker IP |

Run a distributed test on the master inside `tmux`. If your SSH connection drops, the run keeps going; without `tmux` a dropped connection stops it:

```bash
ssh azureuser@<master-ip>
tmux new -s bench                 # reattach later with: tmux attach -t bench
cd ~/benchmarking
npx bench                         # hosts are pre-filled from config/defaults.local.json
```

**Stopping a run.** Ctrl+C, `kill`, or a dropped SSH session asks JMeter to stop the test on **all workers**: no new requests start, and requests already in flight finish. The report is still generated, and the temporary secrets file is removed. Press Ctrl+C again to force-stop. JMeter is also force-stopped automatically if it doesn't exit within the response timeout plus 15s.

**Emergency stop.** If the master itself dies (VM reboot, `kill -9`), the workers keep sending load until the run's duration ends. Stop them directly:

```bash
for w in <worker1-ip> <worker2-ip>; do ssh azureuser@$w sudo systemctl restart jmeter-server; done
```

Run one benchmark at a time per master: the results port (60000) is shared, so a second run fails to start.

Before a run starts, the CLI checks that each worker's port 1099 is reachable. It stops with a clear message instead of hanging on a stopped service or a firewall block.

- `threads` applies to each worker.
- `tps` is the total, and each worker gets `tps / workers`.
- JMeter sends all properties, including the token, to the workers (`-G`), so the workers need no project files.
- RMI runs without TLS (`server.rmi.ssl.disable=true`); allow the ports above only from the other VMs' IPs.

Worker service: `sudo systemctl status|restart jmeter-server`. Its log is `/var/lib/jmeter/jmeter-server.log`.

### Rebuilding or adding a VM

The scripts in `infra/` were used to set up these VMs. Run them from this repo:

```bash
ssh azureuser@<vm> "bash -s" < infra/1-install-jmeter.sh                    # all VMs: Java 17 + JMeter
ssh azureuser@<vm> "bash -s" < infra/2-tune-os.sh                           # all VMs: ports/file limits
ssh azureuser@<worker> "bash -s <worker-public-ip>" < infra/3-worker.sh     # workers: jmeter-server service
ssh azureuser@<master> "bash -s <master-public-ip>" < infra/3-master.sh     # master: RMI settings + Node.js
rsync -az --exclude output --exclude node_modules --exclude jmeter --exclude .token.json --exclude config/defaults.local.json ./ azureuser@<master>:benchmarking/
ssh azureuser@<master> 'cd benchmarking && npm ci && mkdir -p jmeter && ln -sfn /opt/apache-jmeter-5.6.3 jmeter/apache-jmeter-5.6.3'
```

The worker service starts `jmeter-server` with `-Lorg.apache.jmeter.engine=WARN`. Without it, the worker writes every received property, including the API key and token, into its log on every run. The CLI applies the same setting on the master.

## Running against production

- Use the production environment file, and read the plan's `Target` line before confirming.
- Step the load up (e.g. 100 → 250 → 500 → 1000 TPS), one run each. Watch server metrics and the load generators' CPU (keep it under about 80%).
- Use Linux VMs close to the servers as load generators. A laptop measures its own network.
- `content_state_update` and `telemetry` write real data, and `auth_token` creates Keycloak sessions. The CLI shows their warnings and defaults to "No".
- All token-based runs use the single user from the environment file.

## Tests

```bash
npm test     # every plan through real JMeter against test/mock-server.js; no live traffic
```
