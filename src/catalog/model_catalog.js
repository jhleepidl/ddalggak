import fs from 'node:fs';
import path from 'node:path';

const MODEL_ALIASES = new Map([
  ['gemini 2.5', 'gemini-2.5-pro'],
  ['gemini 2.5 pro', 'gemini-2.5-pro'],
  ['gemini-2.5', 'gemini-2.5-pro'],
  ['gemini 2.5 flash', 'gemini-2.5-flash'],
  ['gemini flash', 'gemini-2.5-flash'],
  ['gemini 3', 'gemini-3-flash-preview'],
  ['gemini3', 'gemini-3-flash-preview'],
  ['gemini 3.0', 'gemini-3-flash-preview'],
  ['gemini-3.0', 'gemini-3-flash-preview'],
  ['gemini 3 flash preview', 'gemini-3-flash-preview'],
  ['gemini 3 flash', 'gemini-3-flash-preview'],
  ['gpt 5', 'gpt-5'],
  ['gpt-5', 'gpt-5'],
  ['gpt 5.4', 'gpt-5.4'],
  ['gpt-5.4', 'gpt-5.4'],
  ['gpt 5.5', 'gpt-5.5'],
  ['gpt-5.5', 'gpt-5.5'],
  ['gpt5.5', 'gpt-5.5'],
  ['codex 5.3', 'gpt-5-codex'],
  ['gpt-5-codex', 'gpt-5-codex'],
  ['codex', 'gpt-5-codex'],
  ['local', 'local-model'],
  ['local model', 'local-model'],
  ['ollama', 'local-model'],
]);

export const SUPPORTED_MODELS = [
  { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
  { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
  { id: 'gemini-3-flash-preview', label: 'Gemini 3 Flash Preview' },
  { id: 'gpt-5', label: 'GPT-5' },
  { id: 'gpt-5.4', label: 'GPT-5.4' },
  { id: 'gpt-5.5', label: 'GPT-5.5' },
  { id: 'gpt-5-codex', label: 'GPT-5 Codex' },
  { id: 'local-model', label: 'Local/OpenAI-Compatible Model' },
];

function clean(value = '') {
  return String(value || '').trim();
}

function discoveredConfigPath() {
  const explicit = clean(process.env.MODEL_NODES_DISCOVERED_CONFIG || process.env.MODEL_NODES_DISCOVERED_PATH);
  if (explicit) return path.resolve(explicit);
  return path.resolve(process.cwd(), 'config', 'model_nodes.discovered.json');
}

function readDiscoveredModels() {
  try {
    const file = discoveredConfigPath();
    if (!fs.existsSync(file)) return [];
    const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
    const rows = Array.isArray(payload?.nodes) ? payload.nodes : [];
    const seen = new Set();
    return rows
      .map((row) => ({
        id: clean(row?.model),
        label: clean(row?.label || row?.model),
        provider: clean(row?.provider).toLowerCase(),
        runtime: clean(row?.runtime).toLowerCase(),
        discovered: true,
      }))
      .filter((row) => {
        const key = row.id.toLowerCase();
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  } catch {
    return [];
  }
}

export function listSupportedModels() {
  const rows = SUPPORTED_MODELS.map((row) => ({ ...row }));
  const seen = new Set(rows.map((row) => row.id.toLowerCase()));
  for (const row of readDiscoveredModels()) {
    if (seen.has(row.id.toLowerCase())) continue;
    seen.add(row.id.toLowerCase());
    rows.push({ ...row });
  }
  return rows;
}

export function resolveSupportedModel(raw = '') {
  const text = String(raw || '').trim();
  if (!text) return '';
  const key = text.toLowerCase();
  const all = listSupportedModels();
  const exact = all.find((row) => row.id.toLowerCase() === key);
  if (exact) return exact.id;
  return MODEL_ALIASES.get(key) || '';
}

export function requireSupportedModel(raw = '') {
  const resolved = resolveSupportedModel(raw);
  if (resolved) return resolved;
  throw new Error(`unsupported model: ${String(raw || '').trim()}`);
}

export function inferProviderForModel(raw = '') {
  const input = String(raw || '').trim();
  const model = resolveSupportedModel(input) || input.toLowerCase();
  if (!model) return '';
  const discovered = readDiscoveredModels().find((row) => row.id.toLowerCase() === model.toLowerCase());
  if (discovered?.provider) return discovered.provider;
  if (model.startsWith('gemini')) return 'gemini';
  if (model.includes('codex')) return 'codex';
  if (model === 'local-model' || model.startsWith('gemma') || model.startsWith('llama') || model.startsWith('qwen') || model.startsWith('mistral') || model.startsWith('deepseek')) return 'openai_compatible';
  if (model.startsWith('gpt-')) return 'chatgpt';
  if (model.startsWith('claude-')) return 'claude';
  return '';
}
