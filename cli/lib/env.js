// Environment file -> flat { name: value }. Accepts a Postman environment export
// ({ "values": [{ key, value, enabled }] }) or a plain JSON object.
// Variables keep their names: {{apikey}} in Postman is ${__P(apikey,)} in the JMX.
import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from './paths.js';

/** A relative path is looked up in the current folder first, then in the repo, so the CLI works from any folder. */
export const resolveEnvFile = (file) => (fs.existsSync(file) || path.isAbsolute(file) ? file : path.join(PATHS.root, file));

export function loadEnv(file) {
  file = resolveEnvFile(file);
  if (!fs.existsSync(file)) throw new Error(`Environment file not found: ${file}`);
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (Array.isArray(data.values)) {
    return Object.fromEntries(data.values.filter((v) => v.enabled !== false).map((v) => [v.key, String(v.value ?? '')]));
  }
  return Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)]));
}
