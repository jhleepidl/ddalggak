#!/usr/bin/env node
import fs from 'node:fs';

import {
  listPendingModelBenchmarks,
  modelCatalogRefreshStatePath,
  modelCapabilitySnapshotPath,
  modelDiscoveryRegistryPath,
  modelNodesDiscoveredConfigPath,
  readJson,
} from '../src/application/model_catalog_refresh.js';
import { sanitizeProviderCliVersion } from '../src/evaluation/provider_capability_registry.js';

function exists(file) { try { return fs.existsSync(file); } catch { return false; } }
function line(label, value) { console.log(`${label}: ${value ?? '-'}`); }

const statePath = modelCatalogRefreshStatePath();
const registryPath = modelDiscoveryRegistryPath();
const capabilityPath = modelCapabilitySnapshotPath();
const catalogPath = modelNodesDiscoveredConfigPath();
const state = readJson(statePath) || {};
const registry = readJson(registryPath) || {};
const capabilities = readJson(capabilityPath) || {};
const catalog = readJson(catalogPath) || {};
const pending = listPendingModelBenchmarks({ registryPath });
const lifecycleEntries = Object.values(registry.entries && typeof registry.entries === 'object' ? registry.entries : {});
const ineligible = lifecycleEntries.filter((row) => row?.availability === 'available' && row?.execution_eligibility === 'ineligible');

console.log('Model discovery status');
line('catalog', exists(catalogPath) ? catalogPath : `${catalogPath} (missing)`);
line('last_completed_at', state.last_completed_at);
line('last_reason', state.reason);
line('nodes', Array.isArray(catalog.nodes) ? catalog.nodes.length : 0);
line('new_models_last_refresh', state.new_models ?? 0);
line('benchmark_candidates', pending.length);
console.log('');
console.log('Provider CLI versions:');
for (const row of Array.isArray(capabilities.items) ? capabilities.items : []) {
  console.log(`- ${row.provider}: ${row.cli_available ? 'available' : 'unavailable'} · ${sanitizeProviderCliVersion(row.cli_version) || '-'}`);
}
console.log('');
console.log('Discovered benchmark models:');
const nodes = Array.isArray(catalog.nodes) ? catalog.nodes : [];
if (!nodes.length) console.log('- none');
for (const node of nodes) {
  const source = node?.model_catalog?.discovered_from || '-';
  const label = node?.model === '@default' ? 'provider default' : node?.model;
  const lifecycle = registry.entries?.[`${String(node?.provider || '').toLowerCase()}:${String(node?.model || '').toLowerCase()}`] || {};
  console.log(`- ${node?.provider}/${label} · source=${source} · cli=${sanitizeProviderCliVersion(node?.discovery_runtime?.cli_version) || '-'} · execution=${lifecycle.execution_eligibility || 'unknown'}`);
}

const discoveryRows = Array.isArray(catalog.discovery_results) ? catalog.discovery_results : [];
const notices = discoveryRows.filter((row) => row?.ok !== true || row?.warning);
if (notices.length) {
  console.log('');
  console.log('Discovery notices:');
  for (const row of notices) {
    console.log(`- ${row.label}: ${row.ok === true ? 'fallback' : 'failed'} · ${row.warning || row.error || '-'}`);
  }
}

console.log('');
console.log('Pending model benchmarks:');
if (!pending.length) console.log('- none');
for (const row of pending) {
  console.log(`- ${row.provider}/${row.model} · status=${row.benchmark_status} · cli=${sanitizeProviderCliVersion(row.discovered_cli_version) || '-'} · first_seen=${row.first_seen_at || '-'}`);
}
console.log('');
console.log('Execution-ineligible models for current runtime credentials:');
if (!ineligible.length) console.log('- none');
for (const row of ineligible) {
  console.log(`- ${row.provider}/${row.model} · category=${row.execution_ineligibility?.category || '-'} · observed=${row.execution_ineligibility?.observed_at || '-'}`);
}
