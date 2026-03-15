import fs from "node:fs";
import path from "node:path";

function normalizeText(raw = "") {
  return String(raw || "").trim();
}

function readText(filePath = "") {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function normalizeScalar(raw = "") {
  const value = normalizeText(raw);
  if (!value) return "";
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  if (value === "true") return true;
  if (value === "false") return false;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && String(numeric) === value) return numeric;
  return value;
}

function parseInlineArray(raw = "") {
  const src = normalizeText(raw);
  if (!src.startsWith("[") || !src.endsWith("]")) return null;
  const body = src.slice(1, -1).trim();
  if (!body) return [];
  return body.split(",").map((entry) => normalizeScalar(entry)).filter((entry) => entry !== "");
}

function nextMeaningfulLine(lines = [], start = 0) {
  for (let index = start; index < lines.length; index += 1) {
    const trimmed = normalizeText(lines[index]);
    if (!trimmed || trimmed.startsWith("#")) continue;
    return index;
  }
  return -1;
}

function lineIndent(line = "") {
  const match = String(line || "").match(/^ */);
  return match ? match[0].length : 0;
}

function parseValue(raw = "") {
  const inline = parseInlineArray(raw);
  if (inline) return inline;
  return normalizeScalar(raw);
}

function parseBlock(lines = [], startIndex = 0, indent = 0) {
  const firstIndex = nextMeaningfulLine(lines, startIndex);
  if (firstIndex < 0) return [{}, lines.length];
  const firstLine = lines[firstIndex];
  if (lineIndent(firstLine) < indent) return [{}, firstIndex];
  const asArray = normalizeText(firstLine).startsWith("- ");
  if (asArray) {
    const out = [];
    let index = firstIndex;
    while (index < lines.length) {
      const line = lines[index];
      const trimmed = normalizeText(line);
      if (!trimmed || trimmed.startsWith("#")) {
        index += 1;
        continue;
      }
      const currentIndent = lineIndent(line);
      if (currentIndent < indent) break;
      if (currentIndent > indent || !trimmed.startsWith("- ")) break;
      const valueSrc = trimmed.slice(2).trim();
      if (!valueSrc) {
        const [nestedValue, nextIndex] = parseBlock(lines, index + 1, indent + 2);
        out.push(nestedValue);
        index = nextIndex;
        continue;
      }
      out.push(parseValue(valueSrc));
      index += 1;
    }
    return [out, index];
  }

  const out = {};
  let index = firstIndex;
  while (index < lines.length) {
    const line = lines[index];
    const trimmed = normalizeText(line);
    if (!trimmed || trimmed.startsWith("#")) {
      index += 1;
      continue;
    }
    const currentIndent = lineIndent(line);
    if (currentIndent < indent) break;
    if (currentIndent > indent) {
      index += 1;
      continue;
    }
    const separator = trimmed.indexOf(":");
    if (separator <= 0) {
      index += 1;
      continue;
    }
    const key = trimmed.slice(0, separator).trim();
    const rest = trimmed.slice(separator + 1).trim();
    if (rest) {
      out[key] = parseValue(rest);
      index += 1;
      continue;
    }
    const nextIndex = nextMeaningfulLine(lines, index + 1);
    if (nextIndex < 0 || lineIndent(lines[nextIndex]) <= currentIndent) {
      out[key] = "";
      index += 1;
      continue;
    }
    const [nestedValue, blockEnd] = parseBlock(lines, index + 1, currentIndent + 2);
    out[key] = nestedValue;
    index = blockEnd;
  }
  return [out, index];
}

export function parsePresetSpecText(raw = "") {
  const text = String(raw || "");
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {}
  const [parsed] = parseBlock(text.split(/\r?\n/g), 0, 0);
  return parsed && typeof parsed === "object" ? parsed : {};
}

export function loadPresetSpec(presetDir = "") {
  const root = normalizeText(presetDir);
  if (!root) return null;
  const yamlPath = path.join(root, "preset.yaml");
  const promptPath = path.join(root, "prompt.md");
  if (!fs.existsSync(yamlPath)) return null;
  const spec = parsePresetSpecText(readText(yamlPath));
  return {
    ...spec,
    preset_id: normalizeText(spec.preset_id || path.basename(root)).toLowerCase() || path.basename(root).toLowerCase(),
    source_dir: root,
    prompt_text: readText(promptPath),
    instructions_ref: normalizeText(spec.instructions_ref || "prompt.md") || "prompt.md",
    prompt_path: fs.existsSync(promptPath) ? promptPath : undefined,
  };
}

export function loadPresetSpecs(presetsDir = path.resolve(process.cwd(), "presets")) {
  if (!fs.existsSync(presetsDir)) return [];
  const entries = fs.readdirSync(presetsDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => loadPresetSpec(path.join(presetsDir, entry.name)))
    .filter(Boolean);
}
