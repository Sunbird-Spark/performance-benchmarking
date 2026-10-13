#!/usr/bin/env node
// bench: run one API benchmark with Apache JMeter. See HELP below or `npx bench help`.
// The CLI only orchestrates: it discovers APIs in apis/, collects run settings,
// passes them to JMeter as properties and starts it. JMeter writes all results.
import fs from 'node:fs';
import path from 'node:path';
import prompts from 'prompts';
import { discoverApis, findApi } from './lib/apis.js';
import { loadEnv, resolveEnvFile } from './lib/env.js';
import { checkWorkers, missingProperties, runBenchmark } from './lib/jmeter.js';
import { PATHS } from './lib/paths.js';
import { setupJmeter } from './lib/setup.js';
import { generateToken, loadSavedToken, saveToken, tokenAgeMinutes, tokenVariables } from './lib/token.js';

const HELP = `
bench — benchmark one API at a time with Apache JMeter

COMMANDS
  npx bench                 Start an interactive run (same as "npx bench run")
  npx bench list            List the APIs found in apis/ with descriptions
  npx bench token           Log in (steps in config/token.json) and save the user token to .token.json
  npx bench setup           Download Apache JMeter into jmeter/ (needs Java 17)
  npx bench help            Show this help

RUN SETTINGS (prompted; pass any as --name value to skip its prompt)
  --api        API folder name in apis/ (see "npx bench list")
  --env_file   Environment file with host, API key and the other variables the JMX needs.
               A Postman environment export or a flat JSON object. Use the prod file for prod runs.
  --name       Run name. Results go to output/<name>/ (must not exist yet)
  --hosts      Remote jmeter-server hosts, comma separated, for distributed runs. "" = this machine
  --threads    Concurrent virtual users on EACH generator machine; each sends requests back to back
  --ramp_up    Seconds to start all threads (spreads the initial load)
  --duration   Seconds the test runs; threads loop until time is up. 0 = fixed loop count instead
  --loops      Requests per thread, only when duration is 0
  --tps        Target requests/second for the WHOLE run (split across generators). JMeter waits
               between requests to stay at or below it. 0 = unpaced: as fast as threads and server allow
  --token      For APIs that need a user token: new (log in now) | saved (.token.json) | paste
  --yes        true = skip the final "Start the run?" confirmation

  Defaults come from config/defaults.json, overridden on a machine by config/defaults.local.json
  (e.g. on the master: {"hosts": "<worker1>,<worker2>"}). Also settable there or as flags: connect_timeout_ms, response_timeout_ms,
  heap (JMeter JVM heap, e.g. "-Xms2g -Xmx4g"), jmeter_bin (path to a JMeter install).
  An API can override defaults in the "defaults" object of its metadata.json.

CAPACITY RULE OF THUMB
  achievable TPS ≈ total threads × 1000 / average response ms
  e.g. 1000 TPS at ~200 ms needs ≥ 200 threads; use ~1.5× for headroom.

OUTPUT  output/<name>/ — written by JMeter:
          dashboard/index.html       HTML report (TPS, errors, percentiles, graphs over time)
          dashboard/statistics.json  the same numbers as JSON (pct1/2/3 = p90/p95/p99)
          samples.jtl                every request (CSV)
          jmeter.log                 JMeter log
        plus console.log (JMeter console) and manifest.json (run settings; no secrets)
EXIT    JMeter's exit code; 2 = setup/usage error; 130 = cancelled

EXAMPLE
  npx bench --api content_read --env_file postman-collection/benchmark-env.json --name content-read-500tps \\
            --hosts "" --threads 150 --ramp_up 30 --duration 600 --tps 500
`;

// config/defaults.json, overridden per machine by config/defaults.local.json (e.g. the master's worker hosts).
const readJson = (file) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {});
const defaults = { ...readJson(PATHS.defaults), ...readJson(PATHS.localDefaults) };
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const cancel = { onCancel: () => process.exit(130) };
const isInt = (v, min) => Number.isInteger(v) && v >= min;

const RUN_FLAGS = ['api', 'env_file', 'name', 'hosts', 'threads', 'ramp_up', 'duration', 'loops', 'tps', 'token', 'yes', 'jmeter_bin'];
const TEXT_FLAGS = ['api', 'env_file', 'name', 'hosts', 'token', 'jmeter_bin', 'heap'];

/** `--key value` pairs. A flag without a value is `true`; numbers and true/false are converted, except for text options. */
function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) throw new Error(`Unexpected argument "${argv[i]}". Use --name value pairs (see "npx bench help").`);
    const key = argv[i].slice(2).replace(/-/g, '_');
    const hasValue = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--');
    const raw = hasValue ? argv[++i] : true;
    if (raw === true || TEXT_FLAGS.includes(key)) flags[key] = raw;
    else flags[key] = raw === 'true' ? true : raw === 'false' ? false : raw !== '' && Number.isFinite(Number(raw)) ? Number(raw) : raw;
  }
  return flags;
}

/** Reject typos (a misspelled flag would otherwise fall through to an interactive prompt). */
function checkFlags(flags, extra) {
  const known = new Set([...RUN_FLAGS, ...Object.keys(defaults), ...extra, 'help', 'h']);
  const unknown = Object.keys(flags).filter((k) => !known.has(k));
  if (unknown.length) throw new Error(`Unknown option(s): ${unknown.map((k) => '--' + k).join(', ')} (see "npx bench help")`);
  const empty = TEXT_FLAGS.filter((k) => flags[k] === true);
  if (empty.length) throw new Error(`Option(s) need a value: ${empty.map((k) => '--' + k).join(', ')}`);
}

function validate(s) {
  const errors = [];
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(s.name ?? '')) errors.push('name: letters, digits, ".", "_" and "-" only');
  else if (fs.existsSync(path.join(PATHS.output, s.name))) errors.push(`name: output/${s.name} already exists`);
  if (!isInt(s.threads, 1)) errors.push('threads: whole number ≥ 1');
  if (!isInt(s.ramp_up, 0)) errors.push('ramp_up: whole number ≥ 0');
  if (!isInt(s.duration, 0)) errors.push('duration: whole number ≥ 0');
  if (s.duration === 0 && !isInt(s.loops, 1)) errors.push('loops: whole number ≥ 1 when duration is 0');
  if (s.duration > 0 && s.ramp_up >= s.duration) errors.push('ramp_up must be shorter than duration');
  if (!(typeof s.tps === 'number' && s.tps >= 0)) errors.push('tps: number ≥ 0');
  if (errors.length) throw new Error('Invalid settings:\n  - ' + errors.join('\n  - '));
}

async function newToken(env) {
  const token = await generateToken(env);
  saveToken(token);
  console.log(`✔ Token generated for ${token.username || 'the configured user'} on ${token.host}; saved to .token.json`);
  return token;
}

async function run(flags) {
  const apis = discoverApis();
  const tokenVars = tokenVariables();
  checkFlags(flags, tokenVars);
  prompts.override(flags); // flags answer their prompts
  const { api: apiId } = await prompts({ name: 'api', type: 'select', message: 'API to benchmark', hint: '↑/↓ then Enter',
    choices: apis.map((x) => ({ title: `${x.id}${x.writes ? '  ⚠ WRITES DATA' : ''}`, description: x.description, value: x.id })) }, cancel);
  const api = findApi(apiId, apis);
  const d = { ...defaults, ...api.defaults }; // per-API defaults from metadata.json win
  const a = await prompts([
    { name: 'env_file', type: 'text', message: 'Environment file (host, API key, variables) — use the prod file for prod', initial: d.env_file,
      validate: (v) => (fs.existsSync(resolveEnvFile(v)) ? true : `File not found: ${resolveEnvFile(v)}`) },
    { name: 'name', type: 'text', message: 'Run name — results go to output/<name>/', initial: `${api.id}-${stamp()}` },
    { name: 'hosts', type: 'list', message: 'Remote jmeter-server hosts, comma separated — blank = run on this machine', initial: d.hosts ?? '' },
    { name: 'threads', type: 'number', message: 'Threads per generator — concurrent virtual users on each machine', initial: d.threads, min: 1 },
    { name: 'ramp_up', type: 'number', message: 'Ramp-up seconds — time to start all threads', initial: d.ramp_up, min: 0 },
    { name: 'duration', type: 'number', message: 'Duration seconds — how long to run; 0 = fixed loop count instead', initial: d.duration, min: 0 },
    { name: 'loops', type: (p) => (p === 0 ? 'number' : null), message: 'Loops — requests per thread', initial: d.loops, min: 1 },
    { name: 'tps', type: 'number', message: 'Target TPS for the whole run — 0 = unpaced (as fast as threads allow)', initial: d.tps, min: 0, float: true, round: 2 },
  ], cancel);

  const settings = { ...d, ...flags, ...a, api: api.id };
  settings.hosts = [].concat(a.hosts ?? []).join(',').split(',').map((h) => h.trim()).filter(Boolean);
  validate(settings);

  // Values for the JMX's ${__P(...)}: from the environment file, plus a user token if the JMX uses one.
  const env = loadEnv(settings.env_file);
  const neededTokenVars = api.properties.filter((p) => tokenVars.includes(p));
  const missing = missingProperties(api, { ...env, ...Object.fromEntries(neededTokenVars.map((v) => [v, 'from token'])) });
  if (missing.length) throw new Error(`${settings.env_file} is missing variable(s) used by ${path.relative(PATHS.root, api.jmx)}: ${missing.join(', ')}`);

  let tokenChoice = null;
  const saved = loadSavedToken();
  const savedUsable = saved && saved.host === env.host && neededTokenVars.every((v) => saved[v]);
  if (neededTokenVars.length) {
    ({ token: tokenChoice } = await prompts({ name: 'token', type: 'select', message: `User token needed (${neededTokenVars.join(', ')})`,
      choices: [
        { title: 'Generate a new token', description: 'Log in now with the user from the environment file (recommended before every run)', value: 'new' },
        ...(savedUsable ? [{ title: `Use saved token (${tokenAgeMinutes(saved)} min old)`, description: 'From .token.json; requests fail if it has expired', value: 'saved' }] : []),
        { title: 'Paste a token', value: 'paste' },
      ] }, cancel));
    if (!['new', 'saved', 'paste'].includes(tokenChoice)) throw new Error('token must be new, saved or paste');
    if (tokenChoice === 'saved' && !savedUsable) throw new Error(`No saved token for ${env.host}; use --token new`);
  }

  if (settings.hosts.length) await checkWorkers(settings.hosts);

  // Show exactly what will happen, then confirm.
  const generators = Math.max(1, settings.hosts.length);
  const volume = settings.duration > 0
    ? (settings.tps > 0 ? `up to ~${Math.round(settings.tps * settings.duration)} requests` : 'unpaced: as many as threads and server allow')
    : `${settings.threads * generators * settings.loops} requests`;
  console.log(`
  Target     ${env.host}   (${settings.env_file})
  API        ${api.id} — ${api.title}
  Request    ${api.method} ${api.url.replace(/\$\{__P\((\w+),?\)\}/g, '{$1}')}
  Load       ${settings.threads} threads × ${generators} generator(s) ${settings.hosts.length ? `[${settings.hosts.join(', ')}]` : '[this machine]'}, ramp-up ${settings.ramp_up}s
  Length     ${settings.duration > 0 ? `${settings.duration}s` : `${settings.loops} loops/thread`}, target ${settings.tps > 0 ? `${settings.tps} TPS` : 'unpaced'}
  Volume     ${volume}
  Results    output/${settings.name}/${api.warning ? `\n\n  ⚠ ${api.warning}` : ''}
`);
  const { yes } = await prompts({ name: 'yes', type: 'confirm', message: api.writes ? 'This API WRITES data. Start the run?' : 'Start the run?', initial: !api.writes }, cancel);
  if (yes !== true) { console.log('Not started.'); return 130; }

  const vars = { ...env };
  let token = {};
  if (tokenChoice === 'new') token = await newToken(env);
  else if (tokenChoice === 'saved') token = saved;
  else if (tokenChoice === 'paste') {
    for (const name of neededTokenVars) Object.assign(token, await prompts({ name, type: 'password', message: `Paste ${name}` }, cancel));
    token.created_at = 'pasted';
  }
  // Only token variables are added; host/username always come from the environment file.
  for (const v of neededTokenVars) vars[v] = token[v];
  if (tokenChoice) vars.token_created_at = token.created_at;

  const { exitCode, dir, total: t } = await runBenchmark(api, settings, vars);
  if (t) {
    const ms = (v) => `${Math.round(v)}ms`;
    console.log(`\nJMeter totals: requests=${t.sampleCount}  errors=${t.errorCount} (${t.errorPct.toFixed(2)}%)  throughput=${t.throughput.toFixed(2)}/s` +
      `  mean=${ms(t.meanResTime)}  p90=${ms(t.pct1ResTime)}  p95=${ms(t.pct2ResTime)}  p99=${ms(t.pct3ResTime)}`);
  }
  const rel = path.relative(process.cwd(), dir) || dir;
  if (!t) {
    console.error(`\nbench: JMeter produced no results (exit code ${exitCode}). See ${rel}/console.log and ${rel}/jmeter.log`);
    return exitCode || 1;
  }
  console.log(`Report: ${rel}/dashboard/index.html`);
  return exitCode;
}

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0] && !argv[0].startsWith('--') ? argv.shift() : 'run';
  const flags = parseFlags(argv);
  if (flags.help || flags.h) { console.log(HELP); return 0; }
  switch (command) {
    case 'run': return run(flags);
    case 'list':
      for (const api of discoverApis()) {
        console.log(`${api.id}${api.writes ? '  ⚠ WRITES DATA' : ''}\n  ${api.title}: ${api.description}${api.warning ? `\n  ⚠ ${api.warning}` : ''}\n`);
      }
      return 0;
    case 'token': checkFlags(flags, []); await newToken(loadEnv(flags.env_file ?? defaults.env_file)); return 0;
    case 'setup': await setupJmeter(); return 0;
    case 'help': console.log(HELP); return 0;
    default: console.log(HELP); return 2;
  }
}

main().then((code) => process.exit(code), (err) => { console.error(`\nbench: ${err.message}`); process.exit(2); });
