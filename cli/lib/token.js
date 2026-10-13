// Runs the steps in config/token.json (login, then refresh) and keeps the extracted
// variables (e.g. user_access_token) in .token.json for later runs.
import fs from 'node:fs';
import { PATHS } from './paths.js';

const fill = (text, vars) => text.replace(/\{\{(\w+)\}\}/g, (_, k) => {
  if (!(k in vars) || vars[k] === '') throw new Error(`Token config needs "${k}" in the environment file`);
  return vars[k];
});
const pick = (obj, dotPath) => dotPath.split('.').reduce((o, k) => o?.[k], obj);

export function tokenConfig(file = PATHS.tokenConfig) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Variable names token generation produces (e.g. user_access_token, user_refresh_token). */
export const tokenVariables = (config = tokenConfig()) => config.steps.flatMap((s) => Object.keys(s.extract ?? {}));

export async function generateToken(env, config = tokenConfig()) {
  const vars = { ...env };
  const produced = {};
  for (const step of config.steps) {
    const res = await fetch(fill(step.url, vars), {
      method: step.method ?? 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...Object.fromEntries(Object.entries(step.headers ?? {}).map(([k, v]) => [k, fill(v, vars)])) },
      body: new URLSearchParams(Object.fromEntries(Object.entries(step.form ?? {}).map(([k, v]) => [k, fill(v, vars)]))),
      signal: AbortSignal.timeout(30000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const reason = body.error_description ?? body.error ?? body.params?.errmsg ?? body.params?.err ?? '';
      throw new Error(`Token step "${step.name}" failed: HTTP ${res.status} ${reason}`.trim());
    }
    for (const [name, dotPath] of Object.entries(step.extract ?? {})) {
      const value = pick(body, dotPath);
      if (!value) throw new Error(`Token step "${step.name}": response has no "${dotPath}"`);
      vars[name] = produced[name] = String(value);
    }
  }
  return { ...produced, username: env.username ?? '', host: env.host ?? '', created_at: new Date().toISOString() };
}

export function saveToken(token, file = PATHS.token) {
  fs.rmSync(file, { force: true });
  fs.writeFileSync(file, JSON.stringify(token, null, 2) + '\n', { mode: 0o600 });
}

export const loadSavedToken = (file = PATHS.token) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null);

export const tokenAgeMinutes = (token) => Math.round((Date.now() - Date.parse(token.created_at)) / 60000);
