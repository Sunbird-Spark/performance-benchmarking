import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const JMETER_VERSION = '5.6.3';

// jmeter/ holds only the downloaded JMeter install; everything custom lives at the root.
export const PATHS = {
  root: ROOT,
  apis: path.join(ROOT, 'apis'),
  jmeterProperties: path.join(ROOT, 'config/jmeter.properties'),
  defaults: path.join(ROOT, 'config/defaults.json'),
  localDefaults: path.join(ROOT, 'config/defaults.local.json'), // optional, per machine, gitignored
  tools: path.join(ROOT, 'jmeter'),
  runtime: path.join(ROOT, '.runtime'),
  token: process.env.BENCH_TOKEN_FILE || path.join(ROOT, '.token.json'), // tests point this elsewhere
  tokenConfig: path.join(ROOT, 'config/token.json'),
  localJmeter: path.join(ROOT, 'jmeter', `apache-jmeter-${JMETER_VERSION}`, 'bin', 'jmeter'),
  output: path.join(ROOT, 'output'),
};
