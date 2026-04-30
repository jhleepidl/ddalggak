import fs from 'node:fs';
import path from 'node:path';

import { WORKSPACE_ARTIFACT_PUBLISH_MANIFEST } from './cli_workspace_contract.js';

function clean(value = '') {
  return String(value || '').trim();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeRelPath(raw = '') {
  const value = clean(raw)
    .replace(/^['"`]+|['"`,.;]+$/g, '')
    .replace(/\\/g, '/')
    .replace(/^workspace\//i, '')
    .replace(/^\.\//, '');
  if (!value || value.startsWith('/') || value.includes('\0')) return '';
  const normalized = path.posix.normalize(value);
  if (!normalized || normalized === '.' || normalized.startsWith('../') || normalized === '..') return '';
  const first = normalized.split('/')[0]?.toLowerCase() || '';
  if (['.orchestrator', '.codex', '.gemini', '.git', 'node_modules'].includes(first)) return '';
  return normalized;
}

function inferKind(relPath = '', lang = '') {
  const ext = path.extname(relPath).toLowerCase();
  const language = clean(lang).toLowerCase();
  if (ext === '.ipynb' || language === 'ipynb' || language === 'notebook') return 'notebook';
  if (['.json', '.js', '.ts', '.tsx', '.jsx', '.py', '.sh', '.sql', '.yaml', '.yml', '.html', '.css', '.xml', '.java', '.go', '.rs', '.rb', '.php'].includes(ext)) return 'code';
  if (['.md', '.txt', '.pdf', '.docx', '.doc', '.tex'].includes(ext) || language === 'markdown') return 'document';
  if (['.csv', '.tsv', '.xlsx'].includes(ext)) return 'data';
  if (['.zip', '.tar', '.tgz', '.gz'].includes(ext)) return 'archive';
  return 'file';
}

function extractFencedBlocks(text = '') {
  const out = [];
  const re = /```([a-zA-Z0-9_.-]*)\s*\n([\s\S]*?)```/g;
  let match;
  while ((match = re.exec(String(text || '')))) {
    out.push({
      lang: clean(match[1]).toLowerCase(),
      body: String(match[2] || '').replace(/^\n+|\n+$/g, ''),
      index: match.index,
      end: re.lastIndex,
    });
  }
  return out;
}

function parsePathHeader(text = '') {
  const src = String(text || '');
  const patterns = [
    /(?:^|\n)\s*(?:path|filename|file|relative_path|artifact_path|파일명|파일\s*이름|경로)\s*[:=]\s*([^\n]+)/i,
    /(?:^|\n)\s*(?:save\s+as|write\s+to|저장\s*경로|저장\s*파일)\s*[:=]?\s*([^\n]+)/i,
  ];
  for (const re of patterns) {
    const match = src.match(re);
    if (!match) continue;
    const raw = clean(match[1]).replace(/^[-*]\s*/, '').replace(/^['"`]+|['"`]+$/g, '');
    const rel = safeRelPath(raw);
    if (rel) return rel;
  }
  return '';
}

function extractMentionedFilename(text = '', { preferredExt = '' } = {}) {
  const source = String(text || '');
  const ext = preferredExt ? preferredExt.replace(/^\./, '') : '[A-Za-z0-9]+';
  const re = new RegExp('\\b([A-Za-z0-9가-힣_.-]{2,100}\\.' + ext + ')\\b', 'i');
  const match = source.match(re);
  if (!match) return '';
  return safeRelPath(path.basename(clean(match[1]).replace(/[`()[\]{}]/g, '')));
}

function defaultPathForBlock({ lang = '', userRequest = '', defaultName = '', ordinal = 1 } = {}) {
  const explicit = safeRelPath(defaultName);
  if (explicit) return explicit;
  const mentioned = extractMentionedFilename(userRequest);
  if (mentioned) return mentioned;
  const language = clean(lang).toLowerCase();
  const extByLang = {
    markdown: 'md', md: 'md', python: 'py', py: 'py', javascript: 'js', js: 'js', typescript: 'ts', ts: 'ts',
    json: 'json', html: 'html', css: 'css', csv: 'csv', yaml: 'yaml', yml: 'yml', bash: 'sh', shell: 'sh', sh: 'sh',
  };
  const ext = extByLang[language] || 'txt';
  return `artifact_${ordinal}.${ext}`;
}

function looksLikeNotebook(value) {
  return value && typeof value === 'object' && Array.isArray(value.cells) && Number(value.nbformat || 0) >= 4;
}

function normalizeNotebookContent(body = '') {
  try {
    const parsed = JSON.parse(clean(body));
    return looksLikeNotebook(parsed) ? `${JSON.stringify(parsed, null, 2)}\n` : null;
  } catch {
    return null;
  }
}

function extractArtifactCandidates(text = '', { userRequest = '', defaultName = '' } = {}) {
  const src = String(text || '');
  const candidates = [];

  const envelopeRe = /\[ARTIFACT\]([\s\S]*?)\[\/ARTIFACT\]/gi;
  let envelope;
  while ((envelope = envelopeRe.exec(src))) {
    const body = String(envelope[1] || '');
    const rel = parsePathHeader(body);
    const blocks = extractFencedBlocks(body);
    if (!rel || blocks.length === 0) continue;
    const block = blocks[0];
    candidates.push({ path: rel, lang: block.lang, body: block.body, source: 'artifact_contract_block' });
  }

  const adjacentRe = /(?:^|\n)([^\n]{0,40}(?:path|filename|file|relative_path|artifact_path|파일명|파일\s*이름|경로)\s*[:=]\s*[^\n]+)\n```([a-zA-Z0-9_.-]*)\s*\n([\s\S]*?)```/gi;
  let adjacent;
  while ((adjacent = adjacentRe.exec(src))) {
    const rel = parsePathHeader(`\n${adjacent[1]}`);
    if (!rel) continue;
    candidates.push({ path: rel, lang: clean(adjacent[2]).toLowerCase(), body: String(adjacent[3] || '').replace(/^\n+|\n+$/g, ''), source: 'path_header_fenced_block' });
  }

  // Backward-compatible safety net: if a model emits exactly one fenced notebook JSON block
  // and the user/request names an .ipynb file, materialize it rather than failing because
  // provider-side file-write tools were unavailable. This is a fallback, not the primary contract.
  const mentionedNotebook = extractMentionedFilename(`${userRequest}\n${src}`, { preferredExt: 'ipynb' });
  if (mentionedNotebook) {
    for (const block of extractFencedBlocks(src)) {
      if (!['json', 'ipynb', 'notebook'].includes(block.lang)) continue;
      const notebook = normalizeNotebookContent(block.body);
      if (!notebook) continue;
      candidates.push({ path: safeRelPath(defaultName) || mentionedNotebook, lang: 'json', body: notebook, source: 'notebook_json_fallback' });
      break;
    }
  }

  return candidates;
}

function loadPublishManifest(workspaceRoot = '') {
  try {
    const file = path.join(workspaceRoot, WORKSPACE_ARTIFACT_PUBLISH_MANIFEST);
    if (!fs.existsSync(file)) return { artifacts: [], notes: [] };
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      artifacts: asArray(parsed?.artifacts).map((row) => row && typeof row === 'object' ? row : null).filter(Boolean),
      notes: asArray(parsed?.notes).map((entry) => clean(entry)).filter(Boolean),
    };
  } catch {
    return { artifacts: [], notes: [] };
  }
}

function writePublishManifest(workspaceRoot = '', entries = [], notes = []) {
  const dir = path.join(workspaceRoot, path.dirname(WORKSPACE_ARTIFACT_PUBLISH_MANIFEST));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(workspaceRoot, WORKSPACE_ARTIFACT_PUBLISH_MANIFEST);
  const current = loadPublishManifest(workspaceRoot);
  const byPath = new Map();
  for (const row of current.artifacts) {
    const rel = safeRelPath(row.path || row.relative_path || row.relativePath || '');
    if (rel) byPath.set(rel.toLowerCase(), { ...row, path: rel });
  }
  for (const row of entries) {
    const rel = safeRelPath(row.path || '');
    if (rel) byPath.set(rel.toLowerCase(), { ...row, path: rel });
  }
  const seenNotes = new Set();
  const mergedNotes = [];
  for (const note of [...current.notes, ...notes].map((entry) => clean(entry)).filter(Boolean)) {
    const key = note.toLowerCase();
    if (seenNotes.has(key)) continue;
    seenNotes.add(key);
    mergedNotes.push(note);
  }
  fs.writeFileSync(file, `${JSON.stringify({ artifacts: [...byPath.values()], notes: mergedNotes }, null, 2)}\n`, 'utf8');
}

function writeCandidate({ root, candidate }) {
  const rel = safeRelPath(candidate.path || '');
  if (!rel) return null;
  const resolved = path.resolve(path.join(root, rel));
  if (!resolved.startsWith(`${root}${path.sep}`) && resolved !== root) return null;
  let content = String(candidate.body || '');
  if (path.extname(rel).toLowerCase() === '.ipynb') {
    const normalized = normalizeNotebookContent(content);
    if (normalized) content = normalized;
  }
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, content.endsWith('\n') ? content : `${content}\n`, 'utf8');
  const stat = fs.statSync(resolved);
  return {
    path: rel,
    kind: inferKind(rel, candidate.lang),
    size: Number(stat.size || 0),
    source: candidate.source || 'llm_output_artifact_contract',
  };
}

export function materializeArtifactsFromLlmOutput({ output = '', workspaceRoot = '', userRequest = '', defaultName = '' } = {}) {
  const root = path.resolve(clean(workspaceRoot) || process.cwd());
  const materialized = [];
  const manifestEntries = [];
  const seen = new Set();
  const candidates = extractArtifactCandidates(output, { userRequest, defaultName });

  for (const candidate of candidates) {
    const rel = safeRelPath(candidate.path || defaultPathForBlock({ lang: candidate.lang, userRequest, defaultName, ordinal: materialized.length + 1 }));
    if (!rel || seen.has(rel.toLowerCase())) continue;
    seen.add(rel.toLowerCase());
    const written = writeCandidate({ root, candidate: { ...candidate, path: rel } });
    if (!written) continue;
    materialized.push(written);
    manifestEntries.push({
      path: written.path,
      label: path.basename(written.path),
      kind: written.kind,
      final: true,
      note: 'Materialized from LLM artifact output contract',
    });
  }

  if (manifestEntries.length > 0) {
    writePublishManifest(root, manifestEntries, ['LLM output artifacts were materialized by the runtime from an explicit artifact contract.']);
  }
  return { materialized };
}

export function hasProviderFileToolLimitation(text = '') {
  const src = String(text || '').toLowerCase();
  return /tool ["']?write_file["']? not found/.test(src)
    || /error executing tool write_file/.test(src)
    || /error executing tool write_todos: tool execution denied by policy/.test(src)
    || /tool execution denied by policy/.test(src);
}
