// Runs every discovered JMX through the real JMeter engine against a local mock (no live traffic).
// Requires JMeter: `npx bench setup` (or set JMETER_BIN).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { discoverApis, findApi } from '../cli/lib/apis.js';
import { escapeProperty, missingProperties, runBenchmark, targetRpm } from '../cli/lib/jmeter.js';
import { PATHS } from '../cli/lib/paths.js';
import { generateToken, tokenVariables } from '../cli/lib/token.js';
import { startMock } from './mock-server.js';

const SECRETS = ['mock-password', 'mock-api-credential', 'mock-client-secret', 'mock-gateway-', 'mock-refresh-'];
let mock, tmp, env, envFile, token;

before(async () => {
  mock = await startMock();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-test-'));
  env = {
    host: `http://127.0.0.1:${mock.port}`, apikey: 'mock-api-credential', admin_client_id: 'mock-client',
    admin_client_secret: 'mock-client-secret', username: 'mock-user', password: 'mock-password', channel_id: 'mock-channel',
    user_id: 'mock-user-id', course_id: 'do_mock_course', batch_id: 'mock-batch', content_id: 'do_mock_content',
    content_ids: 'do_mock_content, do_mock_content_2', collection_id: 'do_mock_collection',
  };
  envFile = path.join(tmp, 'env.json');
  // Never touch the real .token.json: CLI processes spawned by the tests save tokens here instead.
  process.env.BENCH_TOKEN_FILE = path.join(tmp, 'token.json');
  fs.writeFileSync(envFile, JSON.stringify(env));
  token = await generateToken(env);
});
after(() => { mock.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const RUN = {
  hosts: [], threads: 2, ramp_up: 0, duration: 0, loops: 2, tps: 0,
  connect_timeout_ms: 5000, response_timeout_ms: 5000, heap: '-Xmx512m', jmeter_bin: process.env.JMETER_BIN, env_file: 'test',
};
const run = (api, name, vars = {}, overrides = {}) =>
  runBenchmark(api, { ...RUN, ...overrides, name, output_dir: path.join(tmp, name) }, { ...env, ...token, ...vars }, { log: () => {} });

// Async: the mock server lives in this process and must keep answering while the CLI runs.
function cli(args, { interruptAfterMs } = {}) {
  return new Promise((resolve) => {
    // detached: own process group, so a test Ctrl+C reaches the CLI and JMeter like a terminal would.
    const child = spawn(process.execPath, ['cli/bench.js', ...args], { cwd: PATHS.root, detached: Boolean(interruptAfterMs) });
    if (interruptAfterMs) setTimeout(() => process.kill(-child.pid, 'SIGINT'), interruptAfterMs);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

function assertNoSecrets(dir) {
  for (const file of fs.readdirSync(dir, { recursive: true })) {
    const full = path.join(dir, file);
    if (fs.statSync(full).isFile()) for (const s of SECRETS) assert.ok(!fs.readFileSync(full, 'utf8').includes(s), `${s} leaked into ${file}`);
  }
}

test('discovery, properties, token config', () => {
  const apis = discoverApis();
  assert.ok(apis.length >= 9);
  for (const api of apis) {
    assert.ok(api.method && api.url.startsWith('${__P(host,)}'), `${api.id}: method/url read from JMX`);
    assert.deepEqual(missingProperties(api, { ...env, ...token }), [], `${api.id}: all properties provided`);
  }
  assert.deepEqual(missingProperties(findApi('user_read', apis), {}).sort(), ['apikey', 'channel_id', 'host', 'user_access_token', 'user_id']);
  assert.deepEqual(tokenVariables().sort(), ['user_access_token', 'user_refresh_token']);
  assert.match(token.user_access_token, /^mock-gateway-/);
  assert.equal(escapeProperty('a=b: c\né'), 'a\\=b\\:\\ c\\n\\u00e9');
  assert.equal(targetRpm(100, 2), 3000);
});

for (const api of discoverApis()) {
  test(`${api.id}: 2 threads x 2 loops pass`, async () => {
    const from = mock.state.requests.length;
    const r = await run(api, api.id);
    assert.equal(r.exitCode, 0);
    assert.equal(r.total.sampleCount, 4);
    assert.equal(r.total.errorCount, 0, fs.readFileSync(path.join(r.dir, 'samples.jtl'), 'utf8'));
    for (const f of ['console.log', 'jmeter.log', 'manifest.json', 'samples.jtl', 'dashboard/index.html', 'dashboard/statistics.json']) assert.ok(fs.existsSync(path.join(r.dir, f)), f);
    if (api.id === 'telemetry') {
      const bodies = mock.state.requests.slice(from).map((q) => q.body);
      assert.equal(new Set(bodies.map((b) => b.params.msgid)).size, 4, 'msgid unique per request');
      assert.ok(bodies.every((b) => Math.abs(b.ets - Date.now()) < 30000), 'ets is current');
    }
    assertNoSecrets(r.dir);
  });
}

test('wrong token shows up as errors', async () => {
  const r = await run(findApi('user_read'), 'bad-token', { user_access_token: 'not-a-token' });
  assert.equal(r.total.errorCount, 4);
});

test('application error under HTTP 200 is detected', async () => {
  mock.state.error = true;
  try {
    const r = await run(findApi('content_read'), 'app-error');
    assert.equal(r.total.errorCount, 4);
  } finally { mock.state.error = false; }
});

test('missing environment variable is refused before JMeter starts', async () => {
  await assert.rejects(run(findApi('content_read'), 'missing-var', { channel_id: '' }), /channel_id/);
});

test('CLI end to end: headless run with flags and --yes', async () => {
  const name = `cli-e2e-${process.pid}`;
  try {
    const out = await cli(['--api', 'user_read', '--env_file', envFile, '--name', name, '--hosts', '',
      '--threads', '1', '--ramp_up', '0', '--duration', '0', '--loops', '3', '--tps', '0', '--token', 'new', '--yes', 'true', ...(process.env.JMETER_BIN ? ['--jmeter_bin', process.env.JMETER_BIN] : [])]);
    assert.equal(out.status, 0, out.stdout + out.stderr);
    assert.match(out.stdout, /JMeter totals: requests=3 {2}errors=0/);
    assertNoSecrets(path.join(PATHS.output, name));
  } finally {
    fs.rmSync(path.join(PATHS.output, name), { recursive: true, force: true });
  }
});

test('CLI rejects invalid settings', async () => {
  const out = await cli(['--api', 'content_read', '--env_file', envFile, '--name', 'x', '--hosts', '',
    '--threads', '0', '--ramp_up', '0', '--duration', '0', '--loops', '1', '--tps', '0', '--yes', 'true']);
  assert.equal(out.status, 2);
  assert.match(out.stderr, /threads: whole number/);
});

test('CLI rejects unknown options and options without a value', async () => {
  const typo = await cli(['--api', 'content_read', '--tsp', '100']);
  assert.equal(typo.status, 2);
  assert.match(typo.stderr, /Unknown option\(s\): --tsp/);
  const empty = await cli(['--api', 'content_read', '--hosts', '--threads', '5']);
  assert.equal(empty.status, 2);
  assert.match(empty.stderr, /need a value: --hosts/);
});

test('Ctrl+C stops the load at once and the report is still generated', async () => {
  const name = `cli-interrupt-${process.pid}`;
  const dir = path.join(PATHS.output, name);
  try {
    const started = Date.now();
    const out = await cli(['--api', 'content_read', '--env_file', envFile, '--name', name, '--hosts', '', '--threads', '2',
      '--ramp_up', '0', '--duration', '60', '--tps', '20', '--yes', ...(process.env.JMETER_BIN ? ['--jmeter_bin', process.env.JMETER_BIN] : [])],
    { interruptAfterMs: 8000 });
    assert.ok(Date.now() - started < 40000, 'run stopped well before its 60s duration');
    assert.ok(fs.existsSync(path.join(dir, 'dashboard/statistics.json')), out.stdout + out.stderr);
    assert.ok(!fs.existsSync(PATHS.runtime) || fs.readdirSync(PATHS.runtime).length === 0, 'secrets file removed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Two real jmeter-server workers on loopback ports. Skipped on a machine configured as a real
// controller (java.rmi.server.hostname pinned to its public IP), where loopback callbacks can't work.
async function startWorkers(t, ports) {
  const bin = path.dirname(process.env.JMETER_BIN || PATHS.localJmeter);
  const sysProps = path.join(fs.realpathSync(bin), 'system.properties');
  if (fs.existsSync(sysProps) && /^java\.rmi\.server\.hostname=/m.test(fs.readFileSync(sysProps, 'utf8'))) {
    t.skip('this JMeter install is configured as a distributed controller (java.rmi.server.hostname set)');
    return null;
  }
  const workDir = fs.mkdtempSync(path.join(tmp, 'workers-'));
  const workers = ports.map((port) => {
    const cwd = path.join(workDir, String(port));
    fs.mkdirSync(cwd);
    return spawn(path.join(bin, 'jmeter-server'), [`-Dserver_port=${port}`, '-Jserver.rmi.ssl.disable=true', '-Djava.rmi.server.hostname=127.0.0.1',
      `-Jserver.rmi.localport=${port + 1000}`, '-Lorg.apache.jmeter.engine=WARN'], { cwd, detached: true, stdio: 'ignore' });
  });
  const ready = () => ports.every((p) => {
    const log = path.join(workDir, String(p), 'jmeter-server.log');
    return fs.existsSync(log) && fs.readFileSync(log, 'utf8').includes('Bound to registry');
  });
  for (let i = 0; i < 60 && !ready(); i++) await new Promise((r) => setTimeout(r, 500));
  return { hosts: ports.map((p) => `127.0.0.1:${p}`), workDir, stop: () => workers.forEach((w) => { try { process.kill(-w.pid, 'SIGTERM'); } catch {} }) };
}

test('distributed: two jmeter-server workers, TPS split, no secrets in controller or worker logs', async (t) => {
  const w = await startWorkers(t, [41199, 41200]);
  if (!w) return;
  try {
    // Two runs: workers log the previous run's properties when a new run starts (RemoteJMeterEngineImpl).
    await run(findApi('content_read'), 'distributed-warmup', {}, { hosts: w.hosts, threads: 1, loops: 1 });
    const r = await run(findApi('user_read'), 'distributed', {}, { hosts: w.hosts, threads: 1, duration: 8, loops: -1, tps: 2, ramp_up: 1 });
    assert.ok(r.total, 'report generated');
    assert.equal(r.total.errorCount, 0);
    // 2 TPS total (1 per worker) for ~8s -> about 16 requests; without the split it would be ~32.
    assert.ok(r.total.sampleCount >= 10 && r.total.sampleCount <= 22, `requests ${r.total.sampleCount}`);
    const threads = new Set(fs.readFileSync(path.join(r.dir, 'samples.jtl'), 'utf8').split('\n').slice(1).filter(Boolean).map((l) => l.split(',')[5].split('-')[0]));
    assert.deepEqual([...threads].sort(), w.hosts, 'both workers sent load');
    assertNoSecrets(r.dir);
    assertNoSecrets(w.workDir);
  } finally { w.stop(); }
});

test('distributed: stopping the CLI stops the load on the workers too', async (t) => {
  const w = await startWorkers(t, [41299, 41300]);
  if (!w) return;
  const name = `cli-dist-stop-${process.pid}`;
  try {
    const started = Date.now();
    const out = await new Promise((resolve) => {
      const child = spawn(process.execPath, ['cli/bench.js', '--api', 'content_read', '--env_file', envFile, '--name', name, '--hosts', w.hosts.join(','),
        '--threads', '2', '--ramp_up', '0', '--duration', '90', '--tps', '10', '--yes', ...(process.env.JMETER_BIN ? ['--jmeter_bin', process.env.JMETER_BIN] : [])], { cwd: PATHS.root });
      let text = '';
      child.stdout.on('data', (c) => { text += c; });
      setTimeout(() => child.kill('SIGINT'), 15000); // the CLI only, like Ctrl+C in tmux
      child.on('close', () => resolve(text));
    });
    const afterStop = mock.state.requests.length;
    await new Promise((r) => setTimeout(r, 6000));
    assert.equal(mock.state.requests.length, afterStop, 'workers kept sending requests after the CLI stopped');
    assert.ok(Date.now() - started < 60000, 'stopped well before the 90s duration');
    assert.match(out, /asking JMeter to stop all workers/);
    const errors = fs.readFileSync(path.join(PATHS.output, name, 'samples.jtl'), 'utf8').split('\n').filter((l) => l.includes(',false,'));
    assert.deepEqual(errors, [], 'graceful stop: no in-flight request recorded as an error');
    assert.ok(fs.existsSync(path.join(PATHS.output, name, 'dashboard/statistics.json')), 'report generated\n' + out);
  } finally {
    w.stop();
    fs.rmSync(path.join(PATHS.output, name), { recursive: true, force: true });
  }
});

test('SIGTERM / SIGHUP to the CLI (kill, timeout, dropped SSH) stop JMeter and remove the secrets file', async () => {
  for (const signal of ['SIGTERM', 'SIGHUP']) {
    const name = `cli-${signal}-${process.pid}`;
    try {
      const started = Date.now();
      const out = await new Promise((resolve) => {
        const child = spawn(process.execPath, ['cli/bench.js', '--api', 'content_read', '--env_file', envFile, '--name', name, '--hosts', '',
          '--threads', '1', '--ramp_up', '0', '--duration', '60', '--tps', '5', '--yes', ...(process.env.JMETER_BIN ? ['--jmeter_bin', process.env.JMETER_BIN] : [])], { cwd: PATHS.root });
        let text = '';
        child.stdout.on('data', (c) => { text += c; });
        setTimeout(() => child.kill(signal), 8000); // only the CLI process, not JMeter
        child.on('close', () => resolve(text));
      });
      assert.ok(Date.now() - started < 40000, `${signal}: stopped well before the 60s duration`);
      assert.ok(!fs.existsSync(PATHS.runtime) || fs.readdirSync(PATHS.runtime).length === 0, `${signal}: secrets file removed`);
      assert.ok(fs.existsSync(path.join(PATHS.output, name, 'dashboard/statistics.json')), `${signal}: report generated\n${out}`);
    } finally {
      fs.rmSync(path.join(PATHS.output, name), { recursive: true, force: true });
    }
  }
});

test('distributed: an unreachable worker is reported before anything starts', async () => {
  const name = `cli-worker-down-${process.pid}`;
  const started = Date.now();
  const out = await cli(['--api', 'content_read', '--env_file', envFile, '--name', name, '--hosts', '127.0.0.1:41999',
    '--threads', '1', '--ramp_up', '0', '--duration', '0', '--loops', '1', '--tps', '0', '--yes']);
  assert.equal(out.status, 2);
  assert.match(out.stderr, /Worker\(s\) not reachable: 127\.0\.0\.1:41999/);
  assert.ok(Date.now() - started < 15000);
  assert.ok(!fs.existsSync(path.join(PATHS.output, name)), 'no output folder for a run that never started');
});
