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

export function chunk(s, size = 3800) {
  const out = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
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
