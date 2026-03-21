import fs from 'node:fs';
import path from 'node:path';

function safeString(value = '') {
  return String(value || '');
}

export function estimateTextTokens(text = '') {
  const src = safeString(text);
  if (!src) return 0;
  return Math.max(1, Math.ceil(src.length / 4));
}

function readJsonlLines(filePath = '') {
  try {
    if (!filePath || !fs.existsSync(filePath)) return [];
    return String(fs.readFileSync(filePath, 'utf8') || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function readText(filePath = '') {
  try {
    if (!filePath || !fs.existsSync(filePath)) return '';
    return String(fs.readFileSync(filePath, 'utf8') || '');
  } catch {
    return '';
  }
}

function buildConversationTranscript(jobDir = '') {
  const rows = readJsonlLines(path.join(jobDir, 'conversation.jsonl'));
  return rows
    .map((row) => {
      const role = safeString(row?.role || 'unknown').trim().toLowerCase() || 'unknown';
      const text = safeString(row?.text || '').trim();
      return text ? `${role}: ${text}` : '';
    })
    .filter(Boolean)
    .join('\n\n');
}

function buildSharedDocsSnapshot(sharedDir = '') {
  if (!sharedDir || !fs.existsSync(sharedDir)) return '';
  const preferred = [
    'mission_brief.md',
    'working_memory.md',
    'implementation_notes.md',
    'review_findings.md',
    'final_answer.md',
    'artifact_index.md',
  ];
  const out = [];
  for (const name of preferred) {
    const filePath = path.join(sharedDir, name);
    const text = readText(filePath).trim();
    if (!text) continue;
    out.push(`### ${name}\n\n${text}`);
  }
  return out.join('\n\n---\n\n');
}

const baselineCache = new Map();

export function buildPromptBaselines({ jobDir = '', sharedDir = '' } = {}) {
  const cacheKey = `${safeString(jobDir)}::${safeString(sharedDir)}`;
  if (baselineCache.has(cacheKey)) return baselineCache.get(cacheKey);
  const conversationTranscript = buildConversationTranscript(jobDir);
  const sharedDocsSnapshot = buildSharedDocsSnapshot(sharedDir);
  const baselines = {
    conversation_only_chars: conversationTranscript.length,
    conversation_only_tokens: estimateTextTokens(conversationTranscript),
    conversation_plus_shared_chars: conversationTranscript.length + sharedDocsSnapshot.length,
    conversation_plus_shared_tokens: estimateTextTokens([conversationTranscript, sharedDocsSnapshot].filter(Boolean).join('\n\n')),
    shared_docs_chars: sharedDocsSnapshot.length,
    shared_docs_tokens: estimateTextTokens(sharedDocsSnapshot),
  };
  baselineCache.set(cacheKey, baselines);
  return baselines;
}

export function appendPromptTelemetry({
  jobDir = '',
  sharedDir = '',
  row = {},
} = {}) {
  const cleanJobDir = safeString(jobDir).trim();
  if (!cleanJobDir) return null;
  try {
    const filePath = path.join(cleanJobDir, 'prompt_metrics.jsonl');
    const promptText = safeString(row?.prompt_text || '');
    const componentsInput = row?.components && typeof row.components === 'object' ? row.components : {};
    const components = Object.entries(componentsInput)
      .map(([key, value]) => {
        const text = safeString(value || '');
        return {
          key,
          chars: text.length,
          tokens: estimateTextTokens(text),
        };
      })
      .filter((entry) => entry.chars > 0 || entry.tokens > 0);
    const baselines = buildPromptBaselines({ jobDir: cleanJobDir, sharedDir });
    const actualPromptTokens = estimateTextTokens(promptText);
    const actualPromptChars = promptText.length;
    const rec = {
      ts: new Date().toISOString(),
      kind: safeString(row?.kind || 'provider_prompt').trim() || 'provider_prompt',
      provider: safeString(row?.provider || '').trim().toLowerCase() || undefined,
      model: safeString(row?.model || '').trim() || undefined,
      agent_id: safeString(row?.agent_id || '').trim().toLowerCase() || undefined,
      role_id: safeString(row?.role_id || '').trim().toLowerCase() || undefined,
      actual_prompt_chars: actualPromptChars,
      actual_prompt_tokens: actualPromptTokens,
      components,
      prepared_context_tokens: Number.isFinite(Number(row?.prepared_context_tokens)) ? Math.floor(Number(row.prepared_context_tokens)) : undefined,
      prepared_context_chars: Number.isFinite(Number(row?.prepared_context_chars)) ? Math.floor(Number(row.prepared_context_chars)) : undefined,
      baseline: baselines,
      savings_vs_conversation_tokens: baselines.conversation_only_tokens - actualPromptTokens,
      savings_vs_conversation_plus_shared_tokens: baselines.conversation_plus_shared_tokens - actualPromptTokens,
      metadata: row?.metadata && typeof row.metadata === 'object' ? row.metadata : undefined,
    };
    fs.appendFileSync(filePath, `${JSON.stringify(rec)}\n`, 'utf8');
    return rec;
  } catch {
    return null;
  }
}
