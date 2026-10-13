// Discovers benchmarkable APIs: every folder in apis/ with exactly one .jmx and a metadata.json.
// Nothing about individual APIs is hard-coded here; add a folder to add an API.
import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from './paths.js';

/** Names the JMX reads with ${__P(name,...)}. */
const propertiesUsed = (xml) => [...new Set([...xml.matchAll(/\$\{__P\(([\w.]+)/g)].map((m) => m[1]))];
const unescapeXml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const field = (xml, name) => unescapeXml(xml.match(new RegExp(`name="${name}">([^<]*)<`))?.[1] ?? '');

export function discoverApis(dir = PATHS.apis) {
  if (!fs.existsSync(dir)) throw new Error(`APIs folder not found: ${dir}`);
  return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).sort((a, b) => a.name.localeCompare(b.name)).map((d) => {
    const folder = path.join(dir, d.name);
    const jmxFiles = fs.readdirSync(folder).filter((f) => f.endsWith('.jmx'));
    if (jmxFiles.length !== 1) throw new Error(`apis/${d.name} must contain exactly one .jmx file (found ${jmxFiles.length})`);
    const metaFile = path.join(folder, 'metadata.json');
    if (!fs.existsSync(metaFile)) throw new Error(`apis/${d.name}/metadata.json is missing`);
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    for (const key of ['title', 'description']) if (typeof meta[key] !== 'string') throw new Error(`apis/${d.name}/metadata.json needs a "${key}" string`);
    const jmx = path.join(folder, jmxFiles[0]);
    const xml = fs.readFileSync(jmx, 'utf8');
    return {
      id: d.name,
      jmx,
      title: meta.title,
      description: meta.description,
      writes: meta.writes === true,
      warning: meta.warning ?? '',
      defaults: meta.defaults ?? {},
      method: field(xml, 'HTTPSampler.method'),
      url: field(xml, 'HTTPSampler.path'),
      properties: propertiesUsed(xml),
    };
  });
}

export function findApi(id, apis = discoverApis()) {
  const api = apis.find((a) => a.id === id);
  if (!api) throw new Error(`Unknown API "${id}". Available: ${apis.map((a) => a.id).join(', ')}`);
  return api;
}
