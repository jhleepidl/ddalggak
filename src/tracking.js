import fs from "node:fs";
import path from "node:path";

import {
  LEGACY_SEMANTIC_DOC_NAMES,
  normalizeKnowledgeBaseProfile,
  renderKnowledgeBaseProfileMarkdown,
  resolveKnowledgeDocName,
  getKnowledgeDocEntry,
} from "./knowledge_base/profile.js";
import {
  KNOWLEDGE_BASE_CONTRACT_FILE,
  KNOWLEDGE_BASE_PROFILE_FILE,
  renderKnowledgeBaseContractMarkdown,
  resolveRoleWriteDecision,
} from "./knowledge_base/runtime.js";

const SAFE_DOC_RE = /^[a-zA-Z0-9._-]+\.md$/;
const PROFILE_FILE = "knowledge_base_profile.json";
const READ_ONLY_SYSTEM_DOCS = new Set([PROFILE_FILE, KNOWLEDGE_BASE_CONTRACT_FILE]);
const MEMORY_WRITE_EVENTS_FILE = "memory_write_events.jsonl";
const TEAM_SELECTION_EVENTS_FILE = "team_selection_events.jsonl";

function cleanText(value = "") {
  return String(value || "").trim();
}

function cleanLower(value = "") {
  return cleanText(value).toLowerCase();
}

function normalizePurpose(value = "") {
  const key = cleanLower(value);
  if (!key) return "";
  if (["research", "implementation", "review", "final", "artifact", "worklog"].includes(key)) return key;
  if (["decision", "decisions", "publish", "signoff"].includes(key)) return "final";
  if (["artifacts", "artifact_index", "artifact_register"].includes(key)) return "artifact";
  if (["progress", "repair", "plan", "execution", "implementation_log"].includes(key)) return "implementation";
  return key;
}

function inferSemanticKindFromDocName(name = "") {
  const key = cleanLower(name).replace(/\.md$/i, "");
  if (!key) return "";
  if (["plan", "mission_brief", "implementation_blueprint", "research_brief", "experiment_plan"].includes(key)) return "plan";
  if (["research", "evidence_ledger", "positions_and_evidence", "defect_log", "critic_log", "review_findings", "observations_and_data"].includes(key)) return "research";
  if (["implementation_notes", "repair_log", "progress", "working_memory", "change_log", "repair_journal", "analysis_journal", "run_log"].includes(key)) return "progress";
  if (["final_answer", "decisions", "recommendation_memo", "verdict_and_rationale", "conclusions_and_next_steps", "signoff_summary"].includes(key)) return "decisions";
  if (["artifact_index", "artifacts", "artifact_manifest", "artifact_register", "submission_packet", "repair_artifacts", "supporting_materials"].includes(key)) return "artifacts";
  return "";
}

function inferPurposeFromSemanticKind(kind = "") {
  const key = cleanLower(kind);
  if (!key) return "";
  if (key === "research") return "research";
  if (key === "decisions") return "final";
  if (key === "artifacts") return "artifact";
  if (key === "review") return "review";
  if (["plan", "progress"].includes(key)) return "implementation";
  return "";
}

function inferPurposeFromDocName(name = "") {
  return inferPurposeFromSemanticKind(inferSemanticKindFromDocName(name)) || "worklog";
}

function safeJsonlAppend(filePath = "", payload = {}) {
  try {
    if (!filePath) return;
    fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, "utf8");
  } catch {}
}

function isBoilerplateDoc(text = '') {
  const src = String(text || '').trim();
  if (!src) return true;
  const stripped = src
    .replace(/^#\s+.*$/m, '')
    .replace(/^>\s*createdAt:.*$/m, '')
    .replace(/^>\s*migratedFrom:.*$/gm, '')
    .replace(/^>\s*migratedAt:.*$/gm, '')
    .replace(/\s+/g, '');
  return stripped.length === 0;
}

export class Tracking {
  constructor(jobs, opts = {}) {
    this.jobs = jobs;
    this.appendHook = typeof opts.appendHook === "function" ? opts.appendHook : null;
    this.profileCache = new Map();
  }

  setAppendHook(hook) {
    this.appendHook = typeof hook === "function" ? hook : null;
    return this.appendHook;
  }

  _logInternalWarning(jobId, message) {
    try {
      if (!jobId || !this.jobs || typeof this.jobs.log !== 'function') return;
      this.jobs.log(jobId, `[tracking] ${String(message || '').trim()}`);
    } catch {}
  }

  _invokeAppendHook(jobId, payload = {}) {
    if (typeof this.appendHook !== 'function') return;
    try {
      const maybePromise = this.appendHook(payload);
      if (maybePromise && typeof maybePromise.then === 'function') {
        maybePromise.catch((error) => {
          this._logInternalWarning(jobId, `append hook async failure: ${String(error?.message || error || 'unknown')}`);
        });
      }
    } catch (error) {
      this._logInternalWarning(jobId, `append hook failure: ${String(error?.message || error || 'unknown')}`);
    }
  }

  _sharedDir(jobId) {
    const dir = path.join(this.jobs.jobDir(jobId), "shared");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  _profilePath(jobId) {
    return path.join(this._sharedDir(jobId), PROFILE_FILE);
  }

  _invalidateProfileCache(jobId) {
    this.profileCache.delete(String(jobId || ''));
  }

  _readProfileFromDisk(filePath) {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      return normalizeKnowledgeBaseProfile(parsed || {});
    } catch {
      return null;
    }
  }

  _statProfileMtime(filePath) {
    try {
      return fs.statSync(filePath).mtimeMs || 0;
    } catch {
      return 0;
    }
  }

  _resolveAppendMetadata(jobId, docName, {
    purpose = '',
    source = 'system',
    eventType = '',
    actorKind = '',
    pipelineStage = '',
    semanticKind = '',
  } = {}) {
    const profile = this.loadProfile(jobId);
    const entry = profile ? getKnowledgeDocEntry(profile, docName) : null;
    const entrySemanticKind = Array.isArray(entry?.semantic_slots)
      ? cleanLower(entry.semantic_slots.find((row) => cleanText(row)))
      : '';
    const normalizedSemanticKind = cleanLower(semanticKind)
      || entrySemanticKind
      || cleanLower(entry?.doc_id)
      || inferSemanticKindFromDocName(docName);
    const normalizedPurpose = normalizePurpose(purpose)
      || inferPurposeFromSemanticKind(normalizedSemanticKind)
      || inferPurposeFromDocName(docName)
      || 'worklog';
    const normalizedActorKind = cleanLower(actorKind) || undefined;
    const normalizedPipelineStage = cleanLower(pipelineStage) || undefined;
    const normalizedEventType = cleanLower(eventType) || undefined;
    const normalizedSource = cleanLower(source) || normalizedActorKind || 'system';
    return {
      purpose: normalizedPurpose,
      source: normalizedSource,
      eventType: normalizedEventType,
      actorKind: normalizedActorKind,
      pipelineStage: normalizedPipelineStage,
      semanticKind: normalizedSemanticKind || undefined,
    };
  }

  _validateName(name) {
    if (!SAFE_DOC_RE.test(name)) throw new Error(`Invalid doc name: ${name}`);
    return name;
  }

  _docTemplate(jobId, name) {
    const profile = this.loadProfile(jobId);
    const entry = profile?.docs?.find((row) => String(row?.file_name || '').trim().toLowerCase() === String(name || '').trim().toLowerCase()) || null;
    const title = String(entry?.title || entry?.doc_id || name || 'Memory').trim();
    return `# ${title}\n\n> createdAt: ${new Date().toISOString()}\n\n`;
  }

  _ensureDocFile(jobId, name) {
    const safeName = this._validateName(name);
    const filePath = path.join(this._sharedDir(jobId), safeName);
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, this._docTemplate(jobId, safeName), 'utf8');
    }
    return filePath;
  }

  loadProfile(jobId) {
    const cleanJobId = String(jobId || '');
    const filePath = this._profilePath(cleanJobId);
    if (!fs.existsSync(filePath)) {
      this._invalidateProfileCache(cleanJobId);
      return null;
    }
    const mtimeMs = this._statProfileMtime(filePath);
    const cached = this.profileCache.get(cleanJobId);
    if (cached && cached.mtimeMs === mtimeMs) {
      return cached.profile;
    }
    const profile = this._readProfileFromDisk(filePath);
    if (!profile) {
      this._invalidateProfileCache(cleanJobId);
      return null;
    }
    this.profileCache.set(cleanJobId, { mtimeMs, profile });
    return profile;
  }

  saveProfile(jobId, profile = {}) {
    const cleanJobId = String(jobId || '');
    const normalized = normalizeKnowledgeBaseProfile(profile || {});
    const sharedDir = this._sharedDir(cleanJobId);
    const profilePath = this._profilePath(cleanJobId);
    fs.writeFileSync(profilePath, JSON.stringify(normalized, null, 2), "utf8");
    fs.writeFileSync(
      path.join(sharedDir, KNOWLEDGE_BASE_CONTRACT_FILE),
      renderKnowledgeBaseContractMarkdown(normalized),
      "utf8",
    );
    this.profileCache.set(cleanJobId, { mtimeMs: this._statProfileMtime(profilePath), profile: normalized });
    return normalized;
  }

  reconcileProfile(jobId, profile = {}, { migrate = true } = {}) {
    const nextProfile = normalizeKnowledgeBaseProfile(profile || {});
    const currentProfile = this.loadProfile(jobId);
    const sharedDir = this._sharedDir(jobId);
    const oldDocsById = new Map((currentProfile?.docs || []).map((doc) => [String(doc.doc_id || '').trim().toLowerCase(), doc]));
    const migration = { changed: false, moved_slots: [], created_files: [], retained_files: [] };
    this.saveProfile(jobId, nextProfile);
    for (const entry of nextProfile.docs) {
      const filePath = path.join(sharedDir, this._validateName(entry.file_name));
      if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, `# ${entry.title || entry.doc_id}\n\n> createdAt: ${new Date().toISOString()}\n\n`, 'utf8');
        migration.created_files.push(entry.file_name);
        migration.changed = true;
      }
    }
    if (currentProfile && migrate) {
      for (const entry of nextProfile.docs) {
        const previous = oldDocsById.get(String(entry.doc_id || '').trim().toLowerCase());
        if (!previous) continue;
        const prevName = this._validateName(previous.file_name);
        const nextName = this._validateName(entry.file_name);
        const prevPath = path.join(sharedDir, prevName);
        const nextPath = path.join(sharedDir, nextName);
        if (!fs.existsSync(prevPath) || prevName === nextName) {
          if (prevName === nextName) migration.retained_files.push(nextName);
          continue;
        }
        const prevText = fs.readFileSync(prevPath, 'utf8');
        let nextText = '';
        try { nextText = fs.readFileSync(nextPath, 'utf8'); } catch {}
        if (!prevText.trim()) continue;
        if (!fs.existsSync(nextPath) || isBoilerplateDoc(nextText)) {
          const migrated = `${prevText.trim()}\n\n> migratedFrom: ${prevName}\n> migratedAt: ${new Date().toISOString()}\n`;
          fs.writeFileSync(nextPath, `${migrated}\n`, 'utf8');
          migration.moved_slots.push({ doc_id: entry.doc_id, from: prevName, to: nextName });
          migration.changed = true;
        }
      }
    }
    return { profile: nextProfile, currentProfile, migration };
  }

  resolveDocName(jobId, name, { allowUnknown = false, includeSystem = false } = {}) {
    const profile = this.loadProfile(jobId);
    const rawName = String(name || "").trim();
    const rawKey = rawName.toLowerCase();
    if (!rawName) throw new Error('Tracking doc name is required');
    if (includeSystem && READ_ONLY_SYSTEM_DOCS.has(rawKey)) {
      return this._validateName(rawKey);
    }
    if (profile) {
      const entry = getKnowledgeDocEntry(profile, rawName);
      if (entry?.file_name) return this._validateName(entry.file_name);
      if (allowUnknown) return this._validateName(resolveKnowledgeDocName(profile, rawName));
      throw new Error(`Unknown tracking doc: ${rawName}`);
    }
    const legacy = LEGACY_SEMANTIC_DOC_NAMES[rawKey] || LEGACY_SEMANTIC_DOC_NAMES[rawName] || null;
    if (legacy) return this._validateName(legacy);
    const legacyFileName = Object.values(LEGACY_SEMANTIC_DOC_NAMES).find((entry) => String(entry || '').trim().toLowerCase() === rawKey);
    if (legacyFileName) return this._validateName(legacyFileName);
    if (allowUnknown) return this._validateName(resolveKnowledgeDocName({}, rawName));
    throw new Error(`Unknown tracking doc: ${rawName}`);
  }

  listDocs(jobId) {
    const profile = this.loadProfile(jobId);
    const rows = profile?.docs?.length
      ? profile.docs.map((entry) => ({ ...entry }))
      : Object.entries(LEGACY_SEMANTIC_DOC_NAMES).map(([slotId, name]) => ({
        doc_id: slotId,
        file_name: name,
        title: name.replace(/\.md$/i, ""),
        purpose: "",
        legacy_names: [name],
        read_priority: 0,
      }));
    const seen = new Set();
    return rows.filter((entry) => {
      const key = String(entry?.file_name || '').trim().toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  renderProfileMarkdown(jobId) {
    const profile = this.loadProfile(jobId);
    if (!profile) {
      return [
        "# Knowledge Base",
        "",
        "- profile: legacy/static",
        `- docs: ${Object.values(LEGACY_SEMANTIC_DOC_NAMES).join(', ')}`,
      ].join("\n");
    }
    return renderKnowledgeBaseProfileMarkdown(profile);
  }

  init(jobId, names = Object.values(LEGACY_SEMANTIC_DOC_NAMES)) {
    this._sharedDir(jobId);
    let targetNames = [];
    if (Array.isArray(names)) {
      targetNames = names.map((entry) => this.resolveDocName(jobId, entry, { allowUnknown: true })).filter(Boolean);
      const first = targetNames[0];
      if (first) this._ensureDocFile(jobId, first);
    } else if (names && typeof names === "object") {
      const profile = this.saveProfile(jobId, names);
      targetNames = [...new Set(profile.docs.map((entry) => this._validateName(entry.file_name)).filter(Boolean))];
      const primaryPlan = profile.docs.find((entry) => String(entry?.doc_id || '').trim().toLowerCase() === 'plan')?.file_name;
      if (primaryPlan) this._ensureDocFile(jobId, primaryPlan);
    }
    return targetNames;
  }

  read(jobId, name) {
    name = this.resolveDocName(jobId, name, { includeSystem: true });
    const p = path.join(this._sharedDir(jobId), name);
    if (!fs.existsSync(p)) throw new Error(`Doc not found: ${name}`);
    return fs.readFileSync(p, "utf8");
  }

  append(jobId, name, markdown, {
    timestamp = true,
    provider = '',
    roleId = '',
    purpose = '',
    source = 'system',
    eventType = '',
    actorKind = '',
    pipelineStage = '',
    semanticKind = '',
    memoryContractEnforced = false,
  } = {}) {
    name = this.resolveDocName(jobId, name);
    if (READ_ONLY_SYSTEM_DOCS.has(String(name || '').trim().toLowerCase())) {
      throw new Error(`Tracking doc is read-only: ${name}`);
    }
    const p = this._ensureDocFile(jobId, name);
    const prefix = timestamp ? `\n\n---\n\n**${new Date().toISOString()}**\n\n` : "\n\n";
    const chunk = prefix + markdown;
    fs.appendFileSync(p, chunk, "utf8");
    const meta = this._resolveAppendMetadata(jobId, name, {
      purpose,
      source,
      eventType,
      actorKind,
      pipelineStage,
      semanticKind,
    });

    this._invokeAppendHook(jobId, {
      jobId: String(jobId),
      docName: name,
      markdown: String(markdown),
      chunk,
      timestamp,
      provider: cleanLower(provider) || undefined,
      roleId: cleanLower(roleId) || undefined,
      purpose: meta.purpose,
      source: meta.source,
      eventType: meta.eventType,
      actorKind: meta.actorKind,
      pipelineStage: meta.pipelineStage,
      semanticKind: meta.semanticKind,
      memoryContractEnforced: memoryContractEnforced === true,
    });
  }

  _memoryWriteEventsPath(jobId) {
    try {
      return path.join(this.jobs.jobDir(jobId), MEMORY_WRITE_EVENTS_FILE);
    } catch {
      return "";
    }
  }

  _recordMemoryWriteEvent(jobId, payload = {}) {
    safeJsonlAppend(this._memoryWriteEventsPath(jobId), { ts: new Date().toISOString(), ...payload });
  }

  _teamSelectionEventsPath(jobId) {
    try {
      return path.join(this.jobs.jobDir(jobId), TEAM_SELECTION_EVENTS_FILE);
    } catch {
      return "";
    }
  }

  recordTeamSelectionEvent(jobId, payload = {}) {
    const row = payload && typeof payload === 'object' && !Array.isArray(payload) ? { ...payload } : {};
    const recommendation = row.recommendation && typeof row.recommendation === 'object' && !Array.isArray(row.recommendation)
      ? { ...row.recommendation }
      : {};
    const candidates = Array.isArray(recommendation.candidates) ? recommendation.candidates : [];
    const selectedBlueprintId = String(row.selected_blueprint_id || row.selectedBlueprintId || '').trim();
    const selectedCandidate = selectedBlueprintId
      ? candidates.find((candidate) => String(candidate?.template_id || candidate?.blueprint_id || '').trim() === selectedBlueprintId) || null
      : null;
    if (selectedCandidate && !recommendation.selected_candidate_snapshot) {
      recommendation.selected_candidate_snapshot = selectedCandidate;
    }
    if (Object.keys(recommendation).length) {
      row.recommendation = recommendation;
    }
    safeJsonlAppend(this._teamSelectionEventsPath(jobId), { ts: new Date().toISOString(), ...row });
  }

  readTeamSelectionEvents(jobId, limit = null) {
    try {
      const filePath = this._teamSelectionEventsPath(jobId);
      if (!filePath || !fs.existsSync(filePath)) return [];
      const rows = String(fs.readFileSync(filePath, 'utf8') || '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          try { return JSON.parse(line); } catch { return null; }
        })
        .filter(Boolean);
      const cleanLimit = Number(limit);
      if (Number.isFinite(cleanLimit) && cleanLimit > 0) {
        return rows.slice(-Math.max(1, Math.floor(cleanLimit)));
      }
      return rows;
    } catch {
      return [];
    }
  }

  readRecentTeamSelectionEvents(jobId, limit = 10) {
    return this.readTeamSelectionEvents(jobId, limit);
  }

  readRecentWriteEvents(jobId, limit = 10) {
    try {
      const filePath = this._memoryWriteEventsPath(jobId);
      if (!filePath || !fs.existsSync(filePath)) return [];
      return String(fs.readFileSync(filePath, 'utf8') || '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(-Math.max(1, Math.floor(Number(limit) || 10)))
        .map((line) => {
          try { return JSON.parse(line); } catch { return null; }
        })
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  appendWithContract(jobId, requestedName, markdown, {
    timestamp = true,
    provider = '',
    roleId = '',
    purpose = '',
    fallbackDoc = 'progress',
    strict = false,
    source = 'system',
    eventType = '',
    actorKind = '',
    pipelineStage = '',
    semanticKind = '',
  } = {}) {
    const cleanRequested = cleanText(requestedName || fallbackDoc || 'progress');
    const cleanProvider = cleanLower(provider);
    const cleanRoleId = cleanLower(roleId);
    const meta = this._resolveAppendMetadata(jobId, cleanRequested, {
      purpose,
      source,
      eventType,
      actorKind,
      pipelineStage,
      semanticKind,
    });
    const profile = this.loadProfile(jobId);

    if (!profile || (!cleanRoleId && !cleanProvider)) {
      this.append(jobId, cleanRequested || fallbackDoc || 'progress', markdown, {
        timestamp,
        provider: cleanProvider,
        roleId: cleanRoleId,
        purpose: meta.purpose,
        source: meta.source,
        eventType: meta.eventType,
        actorKind: meta.actorKind,
        pipelineStage: meta.pipelineStage,
        semanticKind: meta.semanticKind,
      });
      const resolvedName = this.resolveDocName(jobId, cleanRequested || fallbackDoc || 'progress');
      const event = {
        source: meta.source,
        provider: cleanProvider || undefined,
        role_id: cleanRoleId || undefined,
        purpose: meta.purpose,
        semantic_kind: meta.semanticKind,
        event_type: meta.eventType,
        actor_kind: meta.actorKind,
        pipeline_stage: meta.pipelineStage,
        requested_doc: cleanRequested || undefined,
        requested_surface_id: cleanRequested.replace(/\.md$/i, '') || undefined,
        resolved_doc: resolvedName,
        target_surface_id: resolvedName.replace(/\.md$/i, '') || undefined,
        status: 'allowed',
        reason: 'no_contract_context',
      };
      this._recordMemoryWriteEvent(jobId, event);
      return event;
    }

    const decision = resolveRoleWriteDecision({
      profile,
      provider: cleanProvider,
      roleId: cleanRoleId,
      requestedDoc: cleanRequested,
      purpose: meta.purpose,
      fallbackDoc,
    });

    if (decision.status === 'rejected' || !decision.target_doc?.file_name) {
      const requestedSurfaceId = cleanLower(decision.requested_doc?.surface_id || decision.requested_doc?.surfaceId || decision.requested_doc?.doc_id) || cleanRequested.replace(/\.md$/i, '') || undefined;
      if (strict) {
        const event = {
          source: meta.source,
          provider: cleanProvider || undefined,
          role_id: cleanRoleId || undefined,
          purpose: meta.purpose,
          semantic_kind: meta.semanticKind,
          event_type: meta.eventType,
          actor_kind: meta.actorKind,
          pipeline_stage: meta.pipelineStage,
          requested_doc: cleanRequested || undefined,
          requested_surface_id: requestedSurfaceId,
          resolved_doc: '',
          target_surface_id: '',
          status: 'rejected',
          reason: decision.reason || 'no_writable_surface',
          policy_blocked: true,
        };
        this._recordMemoryWriteEvent(jobId, event);
        const error = new Error(`memory write rejected for ${cleanRoleId || cleanProvider || 'writer'}: ${decision.reason || 'no writable surface'}`);
        error.memory_write_event = event;
        throw error;
      }
      this.append(jobId, fallbackDoc, markdown, {
        timestamp,
        provider: cleanProvider,
        roleId: cleanRoleId,
        purpose: meta.purpose,
        source: meta.source,
        eventType: meta.eventType,
        actorKind: meta.actorKind,
        pipelineStage: meta.pipelineStage,
        semanticKind: meta.semanticKind,
        memoryContractEnforced: true,
      });
      const fallbackResolvedDoc = this.resolveDocName(jobId, fallbackDoc);
      const event = {
        source: meta.source,
        provider: cleanProvider || undefined,
        role_id: cleanRoleId || undefined,
        purpose: meta.purpose,
        semantic_kind: meta.semanticKind,
        event_type: meta.eventType,
        actor_kind: meta.actorKind,
        pipeline_stage: meta.pipelineStage,
        requested_doc: cleanRequested || undefined,
        requested_surface_id: requestedSurfaceId,
        resolved_doc: fallbackResolvedDoc,
        target_surface_id: fallbackResolvedDoc.replace(/\.md$/i, ''),
        status: 'rerouted',
        reason: decision.reason || 'rejected_with_fallback',
        fallback_used: true,
        policy_blocked: true,
      };
      this._recordMemoryWriteEvent(jobId, event);
      return event;
    }

    this.append(jobId, decision.target_doc.file_name, markdown, {
      timestamp,
      provider: cleanProvider,
      roleId: cleanRoleId,
      purpose: meta.purpose,
      source: meta.source,
      eventType: meta.eventType,
      actorKind: meta.actorKind,
      pipelineStage: meta.pipelineStage,
      semanticKind: meta.semanticKind,
      memoryContractEnforced: true,
    });
    const resolvedDocName = this.resolveDocName(jobId, decision.target_doc.file_name);
    const event = {
      source: meta.source,
      provider: cleanProvider || undefined,
      role_id: cleanRoleId || undefined,
      purpose: meta.purpose,
      semantic_kind: meta.semanticKind,
      event_type: meta.eventType,
      actor_kind: meta.actorKind,
      pipeline_stage: meta.pipelineStage,
      requested_doc: cleanRequested || undefined,
      requested_surface_id: cleanLower(decision.requested_doc?.surface_id || decision.requested_doc?.surfaceId || decision.requested_doc?.doc_id) || cleanRequested.replace(/\.md$/i, '') || undefined,
      resolved_doc: resolvedDocName,
      target_surface_id: cleanLower(decision.target_doc?.surface_id || decision.target_doc?.surfaceId || decision.target_doc?.doc_id) || resolvedDocName.replace(/\.md$/i, ''),
      status: decision.status || 'allowed',
      reason: decision.reason || 'requested_surface_allowed',
      fallback_used: decision.fallback_used === true,
      policy_blocked: decision.status === 'rerouted',
    };
    this._recordMemoryWriteEvent(jobId, event);
    return event;
  }

}
