import { clip } from "../textutil.js";

function asObject(v) {
  return v && typeof v === "object" ? v : {};
}

function normalizeNodeIds(raw) {
  if (Array.isArray(raw)) {
    return raw.map((row) => String(row || "").trim()).filter(Boolean);
  }
  if (typeof raw === "string") {
    return raw.split(",").map((row) => row.trim()).filter(Boolean);
  }
  return [];
}

function asText(value) {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function extractNodeParts(node) {
  const row = asObject(node);
  const partsRaw = row.parts ?? row.node_parts ?? row.segments;
  const parts = Array.isArray(partsRaw) ? partsRaw : [];
  const out = [];

  const direct = [
    row.summary,
    row.text,
    row.content,
    row.body,
    row.markdown,
  ].map(asText).filter(Boolean);
  if (direct.length > 0) out.push(direct.join("\n"));

  for (const part of parts) {
    const p = asObject(part);
    const value = [
      p.text,
      p.content,
      p.body,
      p.markdown,
      p.raw_text,
      p.rawText,
    ].map(asText).find(Boolean);
    if (value) out.push(value);
  }
  return out.join("\n").trim();
}

export async function expandDetailContext({
  client,
  contextSetId,
  nodeIds = [],
  depth = 1,
  maxChars = 7000,
}) {
  const ctxId = String(contextSetId || "").trim();
  if (!client) throw new Error("expandDetailContext requires client");
  if (!ctxId) throw new Error("expandDetailContext requires contextSetId");

  const requestedNodeIds = normalizeNodeIds(nodeIds);
  const compiledExplain = await client.getCompiledContextExplain(ctxId);
  const activeNodeIds = normalizeNodeIds(compiledExplain?.active_node_ids);

  const unique = new Set();
  for (const id of requestedNodeIds) unique.add(id);
  if (unique.size === 0) {
    const expandCount = Math.max(1, Math.min(6, Number(depth) > 0 ? Number(depth) * 2 : 2));
    for (const id of activeNodeIds.slice(0, expandCount)) unique.add(id);
  }

  const selectedNodeIds = Array.from(unique).filter(Boolean);
  const sections = [];
  const maxNodes = Math.max(1, Math.min(8, Number(depth) > 0 ? Number(depth) * 3 : 3));

  for (const nodeId of selectedNodeIds.slice(0, maxNodes)) {
    try {
      const node = await client.getNode(nodeId);
      const text = extractNodeParts(node);
      if (!text) continue;
      sections.push(`### node:${nodeId}\n${clip(text, 2400)}`);
    } catch {}
  }

  const explainSnippet = (() => {
    const explain = compiledExplain?.explain;
    if (!explain) return "";
    if (typeof explain === "string") return clip(explain, 1200);
    try {
      return clip(JSON.stringify(explain, null, 2), 1200);
    } catch {
      return "";
    }
  })();

  const detailContext = clip([
    "## DETAIL CONTEXT",
    explainSnippet ? `### explain\n${explainSnippet}` : "",
    ...sections,
  ].filter(Boolean).join("\n\n"), maxChars);

  return {
    context_set_id: ctxId,
    detail_context: detailContext,
    used_node_ids: sections.length > 0
      ? selectedNodeIds.slice(0, maxNodes)
      : [],
    active_node_ids: activeNodeIds,
    compiled_text: String(compiledExplain?.compiled_text || ""),
  };
}

