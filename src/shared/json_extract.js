function parseJsonMaybe(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function findFirstJsonObject(text) {
  const s = String(text || "");
  const start = s.indexOf("{");
  if (start < 0) return null;

  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < s.length; i += 1) {
    const ch = s[i];
    if (inStr) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inStr = false;
      }
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

export function parseJsonObjectFromText(raw) {
  const text = String(raw || "");
  const candidates = [];
  const fenced = text.match(/```json\s*([\s\S]*?)```/i) || text.match(/```\s*([\s\S]*?)```/i);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  candidates.push(text.trim());

  for (const c of candidates) {
    if (!c) continue;
    const direct = parseJsonMaybe(c);
    if (direct && typeof direct === "object") return direct;

    const objText = findFirstJsonObject(c);
    if (!objText) continue;
    const parsed = parseJsonMaybe(objText);
    if (parsed && typeof parsed === "object") return parsed;
  }
  return null;
}

export function parseAutoSuggestDecision(raw) {
  const parsed = parseJsonObjectFromText(raw);
  if (!parsed || typeof parsed !== "object") return null;
  return parsed;
}

export function parseJsonMaybeLoose(text) {
  const parsed = parseJsonMaybe(text);
  if (parsed && typeof parsed === "object") return parsed;
  return parseJsonObjectFromText(text);
}
