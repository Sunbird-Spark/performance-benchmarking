import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { JMETER_VERSION, PATHS } from './paths.js';

// dlcdn serves current releases only; archive.apache.org keeps every version.
const MIRRORS = ['https://dlcdn.apache.org', 'https://archive.apache.org/dist'].map((m) => `${m}/jmeter/binaries/apache-jmeter-${JMETER_VERSION}.tgz`);

/** Download Apache JMeter into jmeter/ and verify its SHA-512. */
export async function setupJmeter({ log = console.log } = {}) {
  const java = spawnSync('java', ['-version'], { encoding: 'utf8' });
  if (java.status !== 0) throw new Error('Java 8+ (17 recommended) is required on PATH');
  log((java.stderr || java.stdout).split('\n')[0]);
  if (fs.existsSync(PATHS.localJmeter)) {
    log(`JMeter ${JMETER_VERSION} already installed: ${PATHS.localJmeter}`);
    return PATHS.localJmeter;
  }
  fs.mkdirSync(PATHS.tools, { recursive: true });
  let archive, checksum;
  for (const url of MIRRORS) {
    log(`Downloading ${url}`);
    [archive, checksum] = await Promise.all([fetch(url), fetch(url + '.sha512')]);
    if (archive.ok && checksum.ok) break;
  }
  if (!archive.ok || !checksum.ok) throw new Error(`Download failed (${archive.status}/${checksum.status})`);
  const data = Buffer.from(await archive.arrayBuffer());
  const expected = (await checksum.text()).trim().split(/\s+/)[0].toLowerCase();
  const actual = crypto.createHash('sha512').update(data).digest('hex');
  if (actual !== expected) throw new Error('SHA-512 mismatch for downloaded JMeter archive');
  const tgz = path.join(PATHS.tools, `apache-jmeter-${JMETER_VERSION}.tgz`);
  fs.writeFileSync(tgz, data);
  const tar = spawnSync('tar', ['-xzf', tgz, '-C', PATHS.tools], { stdio: 'inherit' });
  fs.rmSync(tgz);
  if (tar.status !== 0) throw new Error('Extracting JMeter failed');
  log(`Installed ${PATHS.localJmeter}`);
  return PATHS.localJmeter;
}
