export function clip(s, max = 3500, { mode = "middle" } = {}) {
  if (!s) return "";
  const raw = String(s);
  const limit = Number(max || 0);
  if (!(limit > 0) || raw.length <= limit) return raw;
  const marker = "\n…(truncated; latest context preserved below)…\n";
  const available = Math.max(20, limit - marker.length);
  if (mode === "tail") return `${marker}${raw.slice(-available)}`;
  if (mode === "head") return `${raw.slice(0, available)}${marker}`;
  const head = Math.max(10, Math.floor(available * 0.35));
  const tail = Math.max(10, available - head);
  return `${raw.slice(0, head)}${marker}${raw.slice(-tail)}`;
}

export function clipTail(s, max = 3500) {
  return clip(s, max, { mode: "tail" });
}

export function chunk(s, size = 3800, { preserveLines = true } = {}) {
  const raw = String(s || "");
  const limit = Math.max(200, Math.floor(Number(size || 3800)));
  if (raw.length <= limit) return [raw];
  if (!preserveLines) {
    const out = [];
    for (let i = 0; i < raw.length; i += limit) out.push(raw.slice(i, i + limit));
    return out;
  }
  const out = [];
  let remaining = raw;
  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf("\n", limit);
    if (cut < Math.floor(limit * 0.45)) {
      cut = remaining.lastIndexOf(" ", limit);
    }
    if (cut < Math.floor(limit * 0.35)) cut = limit;
    out.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) out.push(remaining);
  return out;
}

export const splitLongText = chunk;

function normalizePinPatterns(patterns = []) {
  return (Array.isArray(patterns) ? patterns : [])
    .map((pattern) => {
      if (pattern instanceof RegExp) return pattern;
      const raw = String(pattern || '').trim();
      if (!raw) return null;
      const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      try { return new RegExp(escaped, 'i'); } catch { return null; }
    })
    .filter(Boolean);
}

function uniqueLines(lines = []) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(lines) ? lines : []) {
    const line = String(raw || '').trim();
    if (!line) continue;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  return out;
}

export function compactWithPinnedContext(value = '', max = 3500, options = {}) {
  const raw = String(value || '').trim();
  const limit = Number.isFinite(Number(max)) ? Math.max(400, Math.floor(Number(max))) : 3500;
  if (!raw || raw.length <= limit) return raw;

  const defaultPinPatterns = [
    /\buploads\//i,
    /\bworkspace_path\b/i,
    /\bsha256\b/i,
    /이미지|사진|파일|첨부|업로드|해당\s*음식|해당\s*이미지/i,
    /아니라|정정|잘못|틀렸|혼동|retract|correction|verified|rejected/i,
    /PINNED FACTS|ACTIVE ARTIFACT CONTEXT|artifact_observation/i,
  ];
  const pinPatterns = [...defaultPinPatterns, ...normalizePinPatterns(options.pinPatterns || [])];
  const maxPinLines = Math.max(2, Math.floor(Number(options.maxPinLines || 10)));
  const pinnedLines = uniqueLines(
    raw.split(/\r?\n/).filter((line) => pinPatterns.some((pattern) => pattern.test(line)))
  ).slice(-maxPinLines);

  const headBudget = Math.max(120, Math.floor(limit * 0.18));
  const tailBudget = Math.max(180, Math.floor(limit * 0.42));
  const pinBudget = Math.max(160, limit - headBudget - tailBudget - 220);
  const pinnedBlock = pinnedLines.length > 0
    ? `[PINNED EXCERPTS PRESERVED DURING COMPACTION]\n${clip(pinnedLines.map((line) => `- ${line}`).join('\n'), pinBudget, { mode: 'middle' })}`
    : '';
  const head = clip(raw.slice(0, Math.max(headBudget * 2, headBudget)).trim(), headBudget, { mode: 'head' });
  const tail = clip(raw.slice(Math.max(0, raw.length - Math.max(tailBudget * 2, tailBudget))).trim(), tailBudget, { mode: 'tail' });
  const note = [
    '[COMPACTION NOTE]',
    '- This context was compacted by budget, not deleted.',
    '- Pinned excerpts and recent tail are preserved; prefer ACTIVE ARTIFACT CONTEXT when available.',
  ].join('\n');
  const compacted = [head, pinnedBlock, note, tail].filter(Boolean).join('\n\n---\n\n');
  if (compacted.length <= limit) return compacted;
  return clip(compacted, limit, { mode: 'middle' });
}

// Prefer last "Codex instruction" section from plan.md
export function extractCodexInstruction(planText) {
  if (!planText) return null;

  const patterns = [
    /Codex에게\s*줄\s*작업\s*지시문[\s\S]*?(?:\n\n|$)/ig,
    /##\s*Codex\s*instructions[\s\S]*?(?:\n\n|$)/ig,
    /##\s*Codex\s*지시문[\s\S]*?(?:\n\n|$)/ig,
    /5\)\s*Codex에게\s*줄\s*작업\s*지시문[\s\S]*?(?:\n\n|$)/ig
  ];

  let last = null;
  for (const re of patterns) {
    let m;
    while ((m = re.exec(planText)) !== null) last = m[0];
  }

  if (!last) return null;

  // If it contains a fenced code block, prefer its contents
  const fence = last.match(/```(?:text|md|markdown|)\s*([\s\S]*?)```/i);
  if (fence && fence[1]) return fence[1].trim();

  // Otherwise strip heading line(s)
  return last.replace(/^#+\s.*$/m, "").trim();
}

export function extractJsonPlan(text) {
  if (!text) return null;
  const fence = text.match(/```json\s*([\s\S]*?)```/i);
  if (fence && fence[1]) {
    try { return JSON.parse(fence[1].trim()); } catch {}
  }
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) {
    try { return JSON.parse(text.slice(first, last + 1)); } catch {}
  }
  return null;
}
