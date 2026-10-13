// Runs one JMX with JMeter in non-GUI mode. JMeter itself produces all results
// (samples.jtl + HTML dashboard); this module only prepares inputs and starts it.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import dgram from 'node:dgram';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { PATHS } from './paths.js';

/**
 * Load-control properties every JMX reads (the CLI <-> JMX contract).
 * All other ${__P(name)} values come from the environment file or the token.
 */
export const RUN_PROPERTIES = ['threads', 'ramp_up', 'loops', 'scheduler', 'duration', 'target_rpm', 'connect_timeout_ms', 'response_timeout_ms'];

// Java .properties files are ISO-8859-1: escape separators and non-ASCII.
export function escapeProperty(value) {
  let out = '';
  for (const ch of String(value)) {
    if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if ('=: #!'.includes(ch)) out += '\\' + ch;
    else if (ch.codePointAt(0) < 128) out += ch;
    else for (const unit of Buffer.from(ch, 'utf16le').swap16().toString('hex').match(/.{4}/g)) out += '\\u' + unit;
  }
  return out;
}

export const jmeterBinary = (bin) => bin || (fs.existsSync(PATHS.localJmeter) ? PATHS.localJmeter : 'jmeter');

/**
 * Requests per minute for each generator's Constant Throughput Timer.
 * tps 0 (unpaced) uses a target so high the timer never waits.
 */
export const targetRpm = (tps, generators) => (tps > 0 ? (tps * 60) / generators : 600000000);

/**
 * In distributed runs several JMeter engine classes log every property (API key, tokens) at INFO:
 * ClientJMeterEngine (controller), StandardJMeterEngine and RemoteJMeterEngineImpl (workers, on each run).
 * -L lowers the whole engine package to WARN so secrets never reach a log. Workers need the same flag (infra/3-worker.sh).
 */
export const QUIET_ENGINE_LOGS = ['-Lorg.apache.jmeter.engine=WARN'];

/**
 * Pre-flight for distributed runs: each worker's jmeter-server port must accept a TCP connection.
 * Without this, a firewalled worker makes JMeter hang for minutes on "Configuring remote engine".
 */
export async function checkWorkers(hosts, timeoutMs = 5000) {
  const results = await Promise.all(hosts.map((h) => new Promise((resolve) => {
    const [host, port = '1099'] = h.split(':');
    const socket = net.connect({ host, port: Number(port), timeout: timeoutMs });
    const done = (ok) => { socket.destroy(); resolve(ok ? null : `${host}:${port}`); };
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  })));
  const down = results.filter(Boolean);
  if (down.length) throw new Error(`Worker(s) not reachable: ${down.join(', ')}. Check that jmeter-server is running there ("sudo systemctl status jmeter-server") and that the firewall allows this machine.`);
}

/** Names the JMX needs that `vars` does not provide (empty values count as missing). */
export const missingProperties = (api, vars) => api.properties.filter((p) => !RUN_PROPERTIES.includes(p) && !vars[p]);

/**
 * @param api  from discoverApis()
 * @param run  { name, hosts[], threads, ramp_up, duration, loops, tps, connect_timeout_ms,
 *               response_timeout_ms, heap, jmeter_bin?, output_dir?, env_file }
 * @param vars environment + token variables (secrets; never logged or saved)
 */
export async function runBenchmark(api, run, vars, { log = console.log } = {}) {
  const missing = missingProperties(api, vars);
  if (missing.length) throw new Error(`${api.id} needs ${missing.join(', ')} (add to the environment file or generate a token)`);
  const dir = path.resolve(run.output_dir || path.join(PATHS.output, run.name));
  if (fs.existsSync(dir)) throw new Error(`Output folder already exists: ${dir}`);
  fs.mkdirSync(dir, { recursive: true });

  const generators = Math.max(1, run.hosts.length);
  const manifest = {
    run_name: run.name,
    api: api.id,
    title: api.title,
    request: `${api.method} ${api.url}`,
    host: vars.host ?? '',
    env_file: run.env_file,
    jmx: path.relative(PATHS.root, api.jmx),
    jmx_sha256: crypto.createHash('sha256').update(fs.readFileSync(api.jmx)).digest('hex').slice(0, 12),
    started_at: new Date().toISOString(),
    generators: run.hosts.length ? run.hosts : ['local'],
    load: {
      threads_per_generator: run.threads, total_threads: run.threads * generators, ramp_up: run.ramp_up,
      duration: run.duration, loops: run.duration > 0 ? 'forever (until duration)' : run.loops,
      target_tps: run.tps,
    },
    token_created_at: vars.token_created_at ?? null,
  };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  // Secrets reach JMeter only through this 0600 file (never the command line); deleted after the run.
  // Least privilege: only the variables this JMX actually uses are passed on (not the whole environment file).
  const used = Object.fromEntries(api.properties.filter((p) => !RUN_PROPERTIES.includes(p)).map((p) => [p, vars[p]]));
  const props = {
    ...used,
    threads: run.threads, ramp_up: run.ramp_up, loops: run.duration > 0 ? -1 : run.loops,
    scheduler: String(run.duration > 0), duration: run.duration, target_rpm: targetRpm(run.tps, generators),
    connect_timeout_ms: run.connect_timeout_ms, response_timeout_ms: run.response_timeout_ms,
  };
  fs.mkdirSync(PATHS.runtime, { recursive: true, mode: 0o700 });
  const runtime = fs.mkdtempSync(path.join(PATHS.runtime, 'run-'));
  const propsFile = path.join(runtime, 'run.properties');
  fs.writeFileSync(propsFile, fs.readFileSync(PATHS.jmeterProperties, 'utf8') + '\n' +
    Object.entries(props).map(([k, v]) => `${escapeProperty(k)}=${escapeProperty(v)}`).join('\n') + '\n', { mode: 0o600 });

  const args = ['-n', '-t', api.jmx, '-q', propsFile, '-l', path.join(dir, 'samples.jtl'), '-j', path.join(dir, 'jmeter.log'), ...QUIET_ENGINE_LOGS];
  // Distributed: -G sends the same properties to every remote jmeter-server, -R lists them.
  if (run.hosts.length) args.push('-G', propsFile, '-R', run.hosts.join(','));
  args.push('-e', '-o', path.join(dir, 'dashboard')); // JMeter's HTML report + statistics.json
  const cmd = jmeterBinary(run.jmeter_bin);

  log(`\n▶ ${cmd} ${args.join(' ')}\n`);
  const consoleLog = fs.createWriteStream(path.join(dir, 'console.log'));
  // Ctrl+C, kill/timeout (SIGTERM) or a dropped SSH session (SIGHUP) stop the test.
  // Killing the JVM would NOT stop remote workers (they keep sending load until the duration ends),
  // so first ask JMeter to stop via its control port. "Shutdown" stops every remote engine too:
  // no new requests start, requests in flight finish (so they are not recorded as false errors),
  // then JMeter writes the report. Force-kill only if that takes too long or on a second Ctrl+C.
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  let child;
  let controlPort = null; // JMeter prints "Waiting for possible Shutdown/StopTestNow/... message on port 4445"
  let stopping = false;
  const forceKill = (signal) => { try { process.kill(-child.pid, signal); } catch { /* already exited */ } };
  const onSignal = (signal) => {
    if (stopping || !controlPort) { log(`\nForce-stopping JMeter (${signal}) …`); forceKill('SIGKILL'); return; }
    stopping = true;
    log(`\nStopping the test (${signal}): asking JMeter to stop${run.hosts.length ? ' all workers' : ''} … (press Ctrl+C again to force)`);
    const udp = dgram.createSocket('udp4');
    udp.send('Shutdown', controlPort, '127.0.0.1', () => udp.close());
    const grace = run.response_timeout_ms + 15000; // in-flight requests may take up to the response timeout
    setTimeout(() => { if (child.exitCode === null) { log(`JMeter did not stop within ${grace / 1000}s; force-stopping it.`); forceKill('SIGKILL'); } }, grace).unref();
  };
  for (const sig of signals) process.on(sig, onSignal);
  process.stdout.on('error', () => {}); // terminal gone (dropped SSH): keep stopping cleanly
  let exitCode;
  try {
    exitCode = await new Promise((resolve, reject) => {
      child = spawn(cmd, args, { env: { ...process.env, HEAP: run.heap }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
      for (const s of [child.stdout, child.stderr]) {
        s.on('data', (c) => {
          consoleLog.write(c);
          if (process.stdout.writable) process.stdout.write(c);
          controlPort ??= Number(String(c).match(/message on port (\d+)/)?.[1]) || null;
        });
      }
      child.on('error', (err) => reject(new Error(`Cannot start ${cmd}: ${err.message}. Run "npx bench setup" or pass --jmeter_bin.`)));
      child.on('close', (code) => resolve(code ?? 1));
    });
  } finally {
    for (const sig of signals) process.off(sig, onSignal);
    fs.rmSync(runtime, { recursive: true, force: true });
    await new Promise((r) => consoleLog.end(r));
  }

  // An interrupted JMeter (see signals above) writes no report.
  // JMeter can build the same report from samples.jtl afterwards.
  const jtl = path.join(dir, 'samples.jtl');
  const statsFile = path.join(dir, 'dashboard', 'statistics.json');
  if (!fs.existsSync(statsFile) && fs.existsSync(jtl) && fs.statSync(jtl).size > 0) {
    log('\nGenerating the report from samples.jtl …');
    fs.rmSync(path.join(dir, 'dashboard'), { recursive: true, force: true });
    await new Promise((resolve) => {
      const child = spawn(cmd, ['-g', jtl, '-o', path.join(dir, 'dashboard'), '-q', PATHS.jmeterProperties, '-j', path.join(dir, 'report.log')], { stdio: 'ignore' });
      child.on('error', resolve);
      child.on('close', resolve);
    });
  }

  // JMeter's own totals (dashboard/statistics.json), shown in the console for convenience.
  const total = fs.existsSync(statsFile) ? JSON.parse(fs.readFileSync(statsFile, 'utf8')).Total : null;
  return { exitCode, dir, total };
}
