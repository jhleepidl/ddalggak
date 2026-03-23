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
  ['codex 5.3', 'gpt-5-codex'],
  ['gpt-5-codex', 'gpt-5-codex'],
  ['codex', 'gpt-5-codex'],
]);

export const SUPPORTED_MODELS = [
  { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
  { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
  { id: 'gemini-3-flash-preview', label: 'Gemini 3 Flash Preview' },
  { id: 'gpt-5', label: 'GPT-5' },
  { id: 'gpt-5.4', label: 'GPT-5.4' },
  { id: 'gpt-5-codex', label: 'GPT-5 Codex' },
];

export function listSupportedModels() {
  return SUPPORTED_MODELS.map((row) => ({ ...row }));
}

export function resolveSupportedModel(raw = '') {
  const text = String(raw || '').trim();
  if (!text) return '';
  const clean = text.toLowerCase();
  if (SUPPORTED_MODELS.some((row) => row.id === clean)) return clean;
  return MODEL_ALIASES.get(clean) || '';
}

export function requireSupportedModel(raw = '') {
  const resolved = resolveSupportedModel(raw);
  if (resolved) return resolved;
  throw new Error(`unsupported model: ${String(raw || '').trim()}`);
}

export function inferProviderForModel(raw = '') {
  const model = resolveSupportedModel(raw) || String(raw || '').trim().toLowerCase();
  if (!model) return '';
  if (model.startsWith('gemini')) return 'gemini';
  if (model.includes('codex')) return 'codex';
  if (model.startsWith('gpt-')) return 'chatgpt';
  return '';
}
