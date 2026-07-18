import { redactLlmTraceText } from '../application/llm_trace_recorder.js';

function cleanTerminalText(value = '') {
  return String(value ?? '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

function clip(value = '', max = 600) {
  const text = String(value || '').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(1, max - 1))}…`;
}

function classifyOperationalLine(line = '', stream = 'stdout') {
  const text = String(line || '').trim();
  const lower = text.toLowerCase();
  if (!text) return null;
  if (/room_stage_result|<\/?analysis>|<\/?thinking>|chain[- ]of[- ]thought/.test(lower)) return null;
  if (/^(analysis|thinking|reasoning)\s*[:：]/i.test(text)) return null;
  if (/^[\[{].*[\]}],?$/.test(text) && text.length > 80) return null;

  if (/(^|\b)(error|failed|failure|exception|fatal|panic|traceback)(\b|:)/i.test(text)) {
    return { kind: 'error', message: clip(text) };
  }
  if (/(^|\b)(warning|warn)(\b|:)/i.test(text)) {
    return { kind: 'warning', message: clip(text) };
  }
  if (/(^|\b)(pass(?:ed)?|fail(?:ed)?|tests?|test suite|lint|typecheck|type-check|build|compile|pytest|vitest|jest|npm test|pnpm test|cargo test|go test)(\b|:)/i.test(text)) {
    return { kind: 'validation', message: clip(text) };
  }
  const commandPrefix = /^(?:\$|>\s*(?:\$|npm\b|pnpm\b|yarn\b|node\b|python3?\b|pytest\b|git\b|cargo\b|go\b)|command\s*[:：]|shell\s*[:：]|tool\s*[:：]|npm\b|pnpm\b|yarn\b|node\b|python3?\b|pytest\b|git\b|cargo\b|go\b)/i;
  const runningCommand = /^(?:running|ran|executing)\s+(?:\$\s*)?(?:npm\b|pnpm\b|yarn\b|node\b|python3?\b|pytest\b|git\b|cargo\b|go\b|make\b|cmake\b|bash\b|sh\b|[\w./-]+\.(?:sh|py|js|ts)\b)/i;
  if (commandPrefix.test(text) || runningCommand.test(text)) {
    return { kind: 'command', message: clip(text) };
  }
  if (/(^|\b)(read(?:ing)?|inspect(?:ing|ed)?|open(?:ing|ed)?|edit(?:ing|ed)?|update(?:ing|d)?|creat(?:ing|ed)?|writ(?:ing|ten)|delet(?:ing|ed)?|patch(?:ing|ed)?|appl(?:ying|ied)|modif(?:ying|ied))\b/i.test(text)
      && /(?:\/[\w.\-]+|[\w.\-]+\.(?:js|ts|tsx|jsx|py|md|json|yaml|yml|toml|rs|go|java|kt|sh|css|html)|file|workspace|directory|repo)/i.test(text)) {
    return { kind: 'file', message: clip(text) };
  }
  if (/(^|\b)(started|completed|finished|done|retrying|resuming|paused|cancelled)(\b|:)/i.test(text)) {
    return { kind: 'progress', message: clip(text) };
  }
  if (stream === 'stderr' && text.length <= 300) {
    return { kind: 'diagnostic', message: clip(text) };
  }
  return null;
}

export function projectRoomProviderOutputLine({ line = '', stream = 'stdout' } = {}) {
  const redacted = redactLlmTraceText(cleanTerminalText(line));
  return classifyOperationalLine(redacted, stream);
}

export function createRoomProviderProgressTracker({
  maxProjectedEvents = 80,
  maxLineChars = 4000,
  onProjection = null,
} = {}) {
  const residual = { stdout: '', stderr: '' };
  const projections = [];
  const stats = {
    chunk_count: 0,
    stdout_chars: 0,
    stderr_chars: 0,
    projected_event_count: 0,
    dropped_projection_count: 0,
    last_projected_message: '',
    last_projected_kind: '',
  };

  async function processLine(line, event = {}) {
    const projected = projectRoomProviderOutputLine({ line, stream: event.stream });
    if (!projected) return;
    if (stats.projected_event_count >= Math.max(1, Number(maxProjectedEvents) || 80)) {
      stats.dropped_projection_count += 1;
      return;
    }
    stats.projected_event_count += 1;
    stats.last_projected_message = projected.message;
    stats.last_projected_kind = projected.kind;
    const projection = {
      ...projected,
      stream: event.stream || 'stdout',
      sequence: Number(event.sequence || stats.chunk_count),
      elapsed_ms: Number(event.elapsedMs || event.elapsed_ms || 0),
      provider_attempt: event.provider_attempt || event.attempt || null,
    };
    projections.push(projection);
    if (typeof onProjection === 'function') {
      await onProjection({
        ...projection,
      });
    }
  }

  async function observe(event = {}) {
    const stream = event.stream === 'stderr' ? 'stderr' : 'stdout';
    const chunk = cleanTerminalText(event.chunk || '');
    if (!chunk) return;
    stats.chunk_count += 1;
    stats[`${stream}_chars`] += chunk.length;
    const combined = `${residual[stream]}${chunk}`;
    const lines = combined.split('\n');
    residual[stream] = lines.pop() || '';
    for (const rawLine of lines) {
      await processLine(rawLine.slice(0, maxLineChars), { ...event, stream });
    }
  }

  async function flush() {
    for (const stream of ['stdout', 'stderr']) {
      const line = residual[stream];
      residual[stream] = '';
      if (line) await processLine(line.slice(0, maxLineChars), { stream, sequence: stats.chunk_count });
    }
  }

  function summary() {
    return { ...stats };
  }

  function events() {
    return projections.map((row) => ({ ...row }));
  }

  return { observe, flush, summary, events };
}
