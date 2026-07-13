import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(MODULE_DIR, '..');
export const TEST_DIR = path.join(PROJECT_ROOT, 'test');
export const TEST_TIER_CONFIG = path.join(PROJECT_ROOT, 'config', 'test_tiers.json');

function cleanList(value) {
  return [...new Set((Array.isArray(value) ? value : []).map((item) => String(item || '').trim()).filter(Boolean))].sort();
}

export function readTestTierConfig(configPath = TEST_TIER_CONFIG) {
  const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  return {
    version: Number(parsed?.version || 1),
    policy: String(parsed?.policy || '').trim(),
    integration: cleanList(parsed?.integration),
    system: cleanList(parsed?.system),
  };
}

export function listAllTestFiles(testDir = TEST_DIR) {
  return fs.readdirSync(testDir)
    .filter((name) => name.endsWith('.test.js'))
    .sort();
}

export function buildTestTierRegistry({ configPath = TEST_TIER_CONFIG, testDir = TEST_DIR } = {}) {
  const config = readTestTierConfig(configPath);
  const all = listAllTestFiles(testDir);
  const allSet = new Set(all);
  const integrationSet = new Set(config.integration);
  const systemSet = new Set(config.system);
  const overlap = config.integration.filter((name) => systemSet.has(name));
  const missing = [...config.integration, ...config.system].filter((name) => !allSet.has(name));
  if (overlap.length) throw new Error(`Test tier overlap: ${overlap.join(', ')}`);
  if (missing.length) throw new Error(`Test tier entries not found: ${[...new Set(missing)].join(', ')}`);
  const fast = all.filter((name) => !integrationSet.has(name) && !systemSet.has(name));
  return {
    config,
    all,
    fast,
    integration: config.integration,
    system: config.system,
  };
}

export function resolveTestTierFiles(tier = 'fast', options = {}) {
  const registry = buildTestTierRegistry(options);
  const name = String(tier || 'fast').trim().toLowerCase();
  if (!['fast', 'integration', 'system', 'all'].includes(name)) {
    throw new Error(`Unknown test tier: ${tier}. Expected fast, integration, system, or all.`);
  }
  return { registry, tier: name, files: registry[name] };
}

export function absoluteTestFiles(files = [], testDir = TEST_DIR) {
  return files.map((name) => path.join(testDir, name));
}
