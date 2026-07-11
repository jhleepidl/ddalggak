#!/usr/bin/env node
import { probeProviderCapabilities } from '../src/evaluation/provider_capability_registry.js';
const providers = process.argv.slice(2).filter((arg) => !arg.startsWith('-'));
const result = await probeProviderCapabilities({ providers: providers.length ? providers : ['codex', 'claude', 'antigravity'] });
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.items.some((row) => row.cli_available === false) ? 2 : 0;
