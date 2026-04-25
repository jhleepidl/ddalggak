function asObject(raw) {
  return raw && typeof raw === 'object' ? raw : {};
}

function asArray(raw) {
  return Array.isArray(raw) ? raw : [];
}

function cleanText(raw = '', { lower = false } = {}) {
  const value = String(raw || '').trim();
  return lower ? value.toLowerCase() : value;
}

function stripMemoryPlanSuffix(raw = '') {
  let text = cleanText(raw);
  if (!text) return text;
  // Repeated normalization of a memory_plan as a profile used to append
  // "memory plan" on every pass. Collapse those suffixes so prompts do not
  // grow like "Compact execution KB memory plan memory plan ...".
  while (/\s+memory\s+plan$/i.test(text)) {
    text = text.replace(/\s+memory\s+plan$/i, '').trim();
  }
  return text || cleanText(raw);
}


function slugify(raw = '') {
  return cleanText(raw, { lower: true })
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
}

function safeFileName(raw = '', fallback = 'note.md') {
  const text = cleanText(raw, { lower: true }) || fallback;
  const stem = text
    .replace(/\.md$/i, '')
    .replace(/[^a-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 72) || fallback.replace(/\.md$/i, '');
  return `${stem}.md`;
}

function uniqueStrings(values = [], { limit = 24, lower = false } = {}) {
  const out = [];
  const seen = new Set();
  for (const value of asArray(values)) {
    const clean = cleanText(value);
    if (!clean) continue;
    const normalized = lower ? clean.toLowerCase() : clean;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
    if (out.length >= limit) break;
  }
  return out;
}

export const STABLE_KB_FILE_NAMES = [
  'knowledge_base_profile.json',
  'knowledge_base_contract.md',
];

export const KB_SEMANTIC_SLOTS = ['plan', 'research', 'progress', 'decisions', 'artifacts'];

export const LEGACY_SEMANTIC_DOC_NAMES = {
  plan: 'plan.md',
  research: 'research.md',
  progress: 'progress.md',
  decisions: 'decisions.md',
  artifacts: 'artifacts.md',
};

const DEFAULT_CANONICAL_DOCS = [
  { doc_id: 'plan', file_name: 'plan.md', title: 'Plan', purpose: 'Implementation plan, goals, scope, and checkpoints.', legacy_names: ['plan.md'] },
  { doc_id: 'research', file_name: 'research.md', title: 'Research', purpose: 'Evidence, findings, references, and context recovery.', legacy_names: ['research.md'] },
  { doc_id: 'progress', file_name: 'progress.md', title: 'Progress', purpose: 'Execution logs, intermediate outputs, and run journal.', legacy_names: ['progress.md'] },
  { doc_id: 'decisions', file_name: 'decisions.md', title: 'Decisions', purpose: 'Trade-offs, final conclusions, and decision history.', legacy_names: ['decisions.md'] },
  { doc_id: 'artifacts', file_name: 'artifacts.md', title: 'Artifacts', purpose: 'Produced files, uploads, output links, and artifact index.', legacy_names: ['artifacts.md'] },
];

const DEFAULT_MEMORY_POLICY = {
  stable_semantic_slots: ['decisions', 'artifacts'],
  mutable_semantic_slots: ['plan', 'research', 'progress'],
  immutable_file_names: STABLE_KB_FILE_NAMES,
  preserve_history: true,
  migration_strategy: 'semantic_slot_preserving',
  enforce_concrete_file_names_in_prompts: true,
};

const PROFILE_TEMPLATES = {
  general: {
    profile_id: 'general_execution',
    display_name: 'Compact execution KB',
    strategy: 'goal_adaptive',
    docs: [
      { doc_id: 'plan', file_name: 'mission_brief.md', title: 'Mission Brief', purpose: 'Goal framing, scope, checklist, and handoff plan.', legacy_names: ['plan.md'], section_hints: ['goal', 'scope', 'checklist'] },
      { doc_id: 'research', file_name: 'working_memory.md', title: 'Working Memory', purpose: 'Facts, findings, open questions, and intermediate progress.', legacy_names: ['research.md'], section_hints: ['facts', 'constraints', 'open questions'] },
      { doc_id: 'progress', file_name: 'working_memory.md', title: 'Working Memory', purpose: 'Run journal, intermediate outputs, and next actions.', legacy_names: ['progress.md'], section_hints: ['run log', 'outputs', 'next actions'] },
      { doc_id: 'decisions', file_name: 'final_answer.md', title: 'Final Answer', purpose: 'Decisions, rationale, and user-facing final deliverable.', legacy_names: ['decisions.md'], section_hints: ['decision', 'rationale', 'deliverable'] },
      { doc_id: 'artifacts', file_name: 'artifact_index.md', title: 'Artifact Index', purpose: 'Uploads, generated files, output links, and delivery pointers.', legacy_names: ['artifacts.md'], section_hints: ['uploads', 'exports', 'refs'] },
    ],
  },
  implementation: {
    profile_id: 'implementation_workbench',
    display_name: 'Implementation workbench KB',
    strategy: 'goal_adaptive',
    docs: [
      { doc_id: 'plan', file_name: 'implementation_blueprint.md', title: 'Implementation Blueprint', purpose: 'Task decomposition, patch plan, test plan, and open risks.', legacy_names: ['plan.md'], target_roles: ['builder', 'operator'], section_hints: ['task breakdown', 'test plan'] },
      { doc_id: 'research', file_name: 'codebase_findings.md', title: 'Codebase Findings', purpose: 'Repository inspection notes, dependency findings, and evidence.', legacy_names: ['research.md'], target_roles: ['researcher', 'builder', 'reviewer'], section_hints: ['repository map', 'dependencies', 'evidence'] },
      { doc_id: 'progress', file_name: 'change_log.md', title: 'Change Log', purpose: 'Executed edits, command outputs, and step-by-step implementation journal.', legacy_names: ['progress.md'], target_roles: ['builder'], section_hints: ['edits', 'outputs', 'tests'] },
      { doc_id: 'decisions', file_name: 'design_decisions.md', title: 'Design Decisions', purpose: 'Architecture choices, trade-offs, and final implementation rationale.', legacy_names: ['decisions.md'], target_roles: ['reviewer', 'synthesizer', 'operator'], section_hints: ['trade-offs', 'decision', 'rationale'] },
      { doc_id: 'artifacts', file_name: 'artifact_manifest.md', title: 'Artifact Manifest', purpose: 'Patched files, uploads, outputs, and workspace artifact index.', legacy_names: ['artifacts.md'], target_roles: ['builder', 'operator'], section_hints: ['patched files', 'deliverables'] },
    ],
  },
  analysis: {
    profile_id: 'analysis_briefing_room',
    display_name: 'Analysis briefing KB',
    strategy: 'goal_adaptive',
    docs: [
      { doc_id: 'plan', file_name: 'question_map.md', title: 'Question Map', purpose: 'Research goals, framing, hypotheses, and success criteria.', legacy_names: ['plan.md'], section_hints: ['questions', 'hypotheses'] },
      { doc_id: 'research', file_name: 'evidence_ledger.md', title: 'Evidence Ledger', purpose: 'Collected evidence, observations, and source-grounded findings.', legacy_names: ['research.md'], target_roles: ['researcher', 'reviewer'], section_hints: ['evidence', 'observations', 'sources'] },
      { doc_id: 'progress', file_name: 'analysis_journal.md', title: 'Analysis Journal', purpose: 'Reasoning steps, intermediate synthesis, and unresolved issues.', legacy_names: ['progress.md'], target_roles: ['researcher', 'synthesizer'], section_hints: ['working notes', 'unresolved issues'] },
      { doc_id: 'decisions', file_name: 'recommendation_memo.md', title: 'Recommendation Memo', purpose: 'Conclusions, recommendations, and decision rationale.', legacy_names: ['decisions.md'], target_roles: ['synthesizer', 'reviewer', 'operator'], section_hints: ['recommendation', 'rationale'] },
      { doc_id: 'artifacts', file_name: 'supporting_materials.md', title: 'Supporting Materials', purpose: 'Linked artifacts, tables, exports, and supporting deliverables.', legacy_names: ['artifacts.md'], section_hints: ['tables', 'exports', 'attachments'] },
    ],
  },
  deliberation: {
    profile_id: 'deliberation_room',
    display_name: 'Deliberation room KB',
    strategy: 'pattern_adaptive',
    docs: [
      { doc_id: 'plan', file_name: 'agenda_and_questions.md', title: 'Agenda and Questions', purpose: 'Issues to resolve, evaluation criteria, and debate agenda.', legacy_names: ['plan.md'], section_hints: ['agenda', 'criteria'] },
      { doc_id: 'research', file_name: 'positions_and_evidence.md', title: 'Positions and Evidence', purpose: 'Competing viewpoints, supporting evidence, and dissent notes.', legacy_names: ['research.md'], target_roles: ['researcher', 'reviewer', 'judge'], section_hints: ['position A', 'position B', 'evidence'] },
      { doc_id: 'progress', file_name: 'deliberation_log.md', title: 'Deliberation Log', purpose: 'Rounds, objections, quorum progress, and committee/debate journal.', legacy_names: ['progress.md'], target_roles: ['judge', 'operator', 'synthesizer'], section_hints: ['round 1', 'objections', 'quorum'] },
      { doc_id: 'decisions', file_name: 'verdict_and_rationale.md', title: 'Verdict and Rationale', purpose: 'Consensus outcome, chair/judge rationale, and final ruling.', legacy_names: ['decisions.md'], target_roles: ['judge', 'chair', 'synthesizer', 'operator'], section_hints: ['verdict', 'rationale'] },
      { doc_id: 'artifacts', file_name: 'submission_packet.md', title: 'Submission Packet', purpose: 'Submitted artifacts, supporting packets, and final handoff bundle.', legacy_names: ['artifacts.md'], section_hints: ['submission', 'packet', 'bundle'] },
    ],
  },
  review_repair: {
    profile_id: 'review_repair_room',
    display_name: 'Review & repair KB',
    strategy: 'goal_adaptive',
    docs: [
      { doc_id: 'plan', file_name: 'repair_brief.md', title: 'Repair Brief', purpose: 'Failure context, repair scope, and signoff conditions.', legacy_names: ['plan.md'], section_hints: ['scope', 'signoff'] },
      { doc_id: 'research', file_name: 'defect_log.md', title: 'Defect Log', purpose: 'Concrete defects, evidence, and severity notes.', legacy_names: ['research.md'], target_roles: ['reviewer', 'researcher'], section_hints: ['defects', 'evidence'] },
      { doc_id: 'progress', file_name: 'repair_journal.md', title: 'Repair Journal', purpose: 'Repair progress, commands, and bounded patch notes.', legacy_names: ['progress.md'], target_roles: ['builder'], section_hints: ['commands', 'patches'] },
      { doc_id: 'decisions', file_name: 'signoff_summary.md', title: 'Signoff Summary', purpose: 'Residual risk, verification result, and user-facing repair summary.', legacy_names: ['decisions.md'], target_roles: ['reviewer', 'synthesizer'], section_hints: ['risks', 'verification'] },
      { doc_id: 'artifacts', file_name: 'repair_artifacts.md', title: 'Repair Artifacts', purpose: 'Patched files, exports, and supporting evidence.', legacy_names: ['artifacts.md'], section_hints: ['patched files', 'evidence'] },
    ],
  },
  experiment: {
    profile_id: 'experiment_lab',
    display_name: 'Experiment lab KB',
    strategy: 'goal_adaptive',
    docs: [
      { doc_id: 'plan', file_name: 'experiment_plan.md', title: 'Experiment Plan', purpose: 'Setup plan, hypotheses, evaluation criteria, and run checklist.', legacy_names: ['plan.md'], section_hints: ['setup', 'hypotheses', 'metrics'] },
      { doc_id: 'research', file_name: 'observations_and_data.md', title: 'Observations and Data', purpose: 'Observed metrics, datasets, evidence, and result notes.', legacy_names: ['research.md'], section_hints: ['metrics', 'datasets', 'evidence'] },
      { doc_id: 'progress', file_name: 'run_log.md', title: 'Run Log', purpose: 'Execution traces, experiment iterations, and notebook workflow journal.', legacy_names: ['progress.md'], section_hints: ['iteration', 'run log'] },
      { doc_id: 'decisions', file_name: 'conclusions_and_next_steps.md', title: 'Conclusions and Next Steps', purpose: 'Findings, decisions, recommendations, and next iteration plan.', legacy_names: ['decisions.md'], section_hints: ['findings', 'next steps'] },
      { doc_id: 'artifacts', file_name: 'artifact_register.md', title: 'Artifact Register', purpose: 'Datasets, notebooks, outputs, and artifact references.', legacy_names: ['artifacts.md'], section_hints: ['datasets', 'notebooks', 'outputs'] },
    ],
  },
};

function normalizeDocEntry(raw = {}, fallbackIndex = 0) {
  const row = asObject(raw);
  const docId = cleanText(row.doc_id || row.docId || row.semantic_slot || row.semanticSlot || row.slot_id || row.slotId || `doc_${fallbackIndex + 1}`, { lower: true }) || `doc_${fallbackIndex + 1}`;
  const fileName = safeFileName(row.file_name || row.fileName || `${docId}.md`);
  return {
    doc_id: docId,
    surface_id: cleanText(row.surface_id || row.surfaceId || docId, { lower: true }) || docId,
    file_name: fileName,
    title: cleanText(row.title || docId) || docId,
    purpose: cleanText(row.purpose || row.description || '') || 'Knowledge base document.',
    legacy_names: uniqueStrings([...(asArray(row.legacy_names || row.legacyNames)), `${docId}.md`].filter(Boolean)),
    read_priority: Number.isFinite(Number(row.read_priority || row.readPriority)) ? Math.max(1, Math.floor(Number(row.read_priority || row.readPriority))) : (fallbackIndex + 1),
    write_hint: cleanText(row.write_hint || row.writeHint || ''),
    section_hints: uniqueStrings(row.section_hints || row.sectionHints || []),
    target_roles: uniqueStrings(row.target_roles || row.targetRoles || [], { lower: true }),
    load_policy: cleanText(row.load_policy || row.loadPolicy || '', { lower: true }) || undefined,
    write_policy: cleanText(row.write_policy || row.writePolicy || '', { lower: true }) || undefined,
    create_mode: cleanText(row.create_mode || row.createMode || '', { lower: true }) || undefined,
  };
}

export function normalizeMemoryPolicy(raw = {}, { docs = DEFAULT_CANONICAL_DOCS } = {}) {
  const row = asObject(raw);
  const availableDocIds = uniqueStrings(asArray(docs).map((doc) => doc?.doc_id).filter(Boolean), { lower: true, limit: 32 });
  const stableSlots = uniqueStrings(
    row.stable_semantic_slots || row.stableSemanticSlots || DEFAULT_MEMORY_POLICY.stable_semantic_slots,
    { lower: true, limit: 16 },
  ).filter((slot) => availableDocIds.includes(slot));
  const mutableDefaults = availableDocIds.filter((slot) => !stableSlots.includes(slot));
  const mutableSlots = uniqueStrings(
    row.mutable_semantic_slots || row.mutableSemanticSlots || mutableDefaults,
    { lower: true, limit: 16 },
  ).filter((slot) => availableDocIds.includes(slot) && !stableSlots.includes(slot));
  return {
    stable_semantic_slots: stableSlots.length > 0 ? stableSlots : availableDocIds.filter((slot) => ['decisions', 'artifacts'].includes(slot)),
    mutable_semantic_slots: mutableSlots.length > 0 ? mutableSlots : mutableDefaults,
    immutable_file_names: uniqueStrings(row.immutable_file_names || row.immutableFileNames || DEFAULT_MEMORY_POLICY.immutable_file_names, { lower: false, limit: 16 }),
    preserve_history: row.preserve_history !== false && row.preserveHistory !== false,
    migration_strategy: cleanText(row.migration_strategy || row.migrationStrategy || DEFAULT_MEMORY_POLICY.migration_strategy, { lower: true }) || DEFAULT_MEMORY_POLICY.migration_strategy,
    enforce_concrete_file_names_in_prompts: row.enforce_concrete_file_names_in_prompts !== false && row.enforceConcreteFileNamesInPrompts !== false,
  };
}



function coerceProfileSeedFromMemoryPlan(plan = {}) {
  const row = asObject(plan);
  const surfaces = asArray(row.surfaces || row.memory_surfaces || row.memorySurfaces);
  const docs = [];
  for (const surface of surfaces) {
    const entry = asObject(surface);
    const fileName = safeFileName(entry.file_name || entry.fileName || `${cleanText(entry.surface_id || entry.surfaceId || 'memory_surface', { lower: true }) || 'memory_surface'}.md`);
    const semanticSlots = uniqueStrings(entry.semantic_slots || entry.semanticSlots || [entry.surface_id || entry.surfaceId], { lower: true, limit: 8 });
    const targetRoles = uniqueStrings(entry.target_roles || entry.targetRoles || [], { lower: true, limit: 8 });
    const sectionHints = uniqueStrings(entry.section_hints || entry.sectionHints || [], { limit: 8 });
    for (const slotId of (semanticSlots.length > 0 ? semanticSlots : [cleanText(entry.surface_id || entry.surfaceId || fileName.replace(/\.md$/i, ''), { lower: true }) || fileName.replace(/\.md$/i, '')])) {
      docs.push({
        doc_id: slotId,
        surface_id: cleanText(entry.surface_id || entry.surfaceId || slotId, { lower: true }) || slotId,
        file_name: fileName,
        title: cleanText(entry.title || entry.display_name || entry.displayName || slotId) || slotId,
        purpose: cleanText(entry.purpose || entry.description || 'Knowledge base surface.'),
        target_roles: targetRoles,
        section_hints: sectionHints,
        load_policy: cleanText(entry.load_policy || entry.loadPolicy || '', { lower: true }) || undefined,
        write_policy: cleanText(entry.write_policy || entry.writePolicy || '', { lower: true }) || undefined,
        create_mode: cleanText(entry.create_mode || entry.createMode || '', { lower: true }) || undefined,
      });
    }
  }
  return {
    profile_id: row.profile_id || row.profileId || row.plan_id || row.planId,
    display_name: stripMemoryPlanSuffix(row.display_name || row.displayName || row.title),
    strategy: row.strategy || 'team_blueprint',
    selection_reason: row.selection_reason || row.selectionReason,
    team_name: row.team_name || row.teamName,
    topology_pattern: row.topology_pattern || row.topologyPattern,
    task_brief: row.task_brief || row.taskBrief,
    docs,
    memory_policy: {
      stable_semantic_slots: row.stable_surface_ids || row.stableSurfaceIds || row.stable_semantic_slots || row.stableSemanticSlots || [],
      mutable_semantic_slots: row.mutable_surface_ids || row.mutableSurfaceIds || row.mutable_semantic_slots || row.mutableSemanticSlots || [],
      immutable_file_names: row.system_files || row.systemFiles || row.immutable_file_names || row.immutableFileNames || [],
      preserve_history: row.preserve_history,
      migration_strategy: row.migration_strategy || row.migrationStrategy,
      enforce_concrete_file_names_in_prompts: row.enforce_concrete_file_names_in_prompts,
    },
  };
}

export function buildMemoryPlanFromProfile(profile = null) {
  const normalized = normalizeKnowledgeBaseProfile(profile || {});
  const surfaceMap = new Map();
  for (const doc of normalized.docs) {
    const fileName = cleanText(doc.file_name);
    if (!fileName) continue;
    const existing = surfaceMap.get(fileName) || {
      surface_id: cleanText(doc.surface_id || doc.surfaceId || doc.doc_id, { lower: true }) || fileName.replace(/\.md$/i, ''),
      file_name: fileName,
      title: cleanText(doc.title || doc.doc_id || fileName) || fileName,
      purpose: cleanText(doc.purpose || 'Knowledge base surface.'),
      semantic_slots: [],
      target_roles: [],
      section_hints: [],
      load_policy: cleanText(doc.load_policy || doc.loadPolicy || 'on_demand', { lower: true }) || 'on_demand',
      write_policy: cleanText(doc.write_policy || doc.writePolicy || 'shared', { lower: true }) || 'shared',
      create_mode: cleanText(doc.create_mode || doc.createMode || 'lazy', { lower: true }) || 'lazy',
    };
    existing.surface_id = cleanText(existing.surface_id || doc.surface_id || doc.surfaceId || doc.doc_id, { lower: true }) || existing.surface_id;
    existing.semantic_slots = uniqueStrings([...(existing.semantic_slots || []), doc.doc_id], { lower: true, limit: 8 });
    existing.target_roles = uniqueStrings([...(existing.target_roles || []), ...asArray(doc.target_roles)], { lower: true, limit: 8 });
    existing.section_hints = uniqueStrings([...(existing.section_hints || []), ...asArray(doc.section_hints)], { limit: 8 });
    const slotSet = new Set(existing.semantic_slots);
    if (!doc.load_policy && (slotSet.has('plan') || slotSet.has('research') || slotSet.has('progress'))) existing.load_policy = 'always';
    if (!doc.create_mode && slotSet.has('plan')) existing.create_mode = 'eager';
    if (!doc.write_policy && slotSet.has('decisions')) existing.write_policy = 'final';
    else if (!doc.write_policy && slotSet.has('artifacts')) existing.write_policy = 'index';
    surfaceMap.set(fileName, existing);
  }
  const surfaces = Array.from(surfaceMap.values());
  return {
    version: 1,
    plan_id: normalized.profile_id,
    display_name: `${stripMemoryPlanSuffix(normalized.display_name)} memory plan`,
    selection_reason: normalized.selection_reason,
    team_name: normalized.team_name || undefined,
    topology_pattern: normalized.topology_pattern || undefined,
    task_brief: normalized.task_brief || undefined,
    strategy: normalized.strategy,
    surfaces,
    default_load_surface_ids: surfaces.filter((surface) => surface.load_policy === 'always').map((surface) => surface.surface_id),
    writable_surface_ids: surfaces.filter((surface) => surface.write_policy !== 'readonly').map((surface) => surface.surface_id),
    stable_surface_ids: surfaces.filter((surface) => (surface.semantic_slots || []).some((slot) => normalized.memory_policy.stable_semantic_slots.includes(slot))).map((surface) => surface.surface_id),
    mutable_surface_ids: uniqueStrings(normalized.memory_policy.mutable_semantic_slots, { lower: true, limit: 16 }),
    system_files: [...normalized.memory_policy.immutable_file_names],
    migration_strategy: normalized.memory_policy.migration_strategy,
    preserve_history: normalized.memory_policy.preserve_history !== false,
    enforce_concrete_file_names_in_prompts: normalized.memory_policy.enforce_concrete_file_names_in_prompts !== false,
  };
}

export function normalizeMemoryPlan(raw = {}) {
  const seed = buildMemoryPlanFromProfile(coerceProfileSeedFromMemoryPlan(raw));
  const row = asObject(raw);
  const merged = { ...seed, ...row };
  const surfaces = asArray(merged.surfaces || merged.memory_surfaces || merged.memorySurfaces).map((surface, index) => {
    const entry = asObject(surface);
    const surfaceId = cleanText(entry.surface_id || entry.surfaceId || `surface_${index + 1}`, { lower: true }) || `surface_${index + 1}`;
    return {
      surface_id: surfaceId,
      file_name: safeFileName(entry.file_name || entry.fileName || `${surfaceId}.md`),
      title: cleanText(entry.title || entry.display_name || entry.displayName || surfaceId) || surfaceId,
      purpose: cleanText(entry.purpose || entry.description || 'Knowledge base surface.') || 'Knowledge base surface.',
      semantic_slots: uniqueStrings(entry.semantic_slots || entry.semanticSlots || [surfaceId], { lower: true, limit: 8 }),
      target_roles: uniqueStrings(entry.target_roles || entry.targetRoles || [], { lower: true, limit: 8 }),
      section_hints: uniqueStrings(entry.section_hints || entry.sectionHints || [], { limit: 8 }),
      load_policy: cleanText(entry.load_policy || entry.loadPolicy || 'on_demand', { lower: true }) || 'on_demand',
      write_policy: cleanText(entry.write_policy || entry.writePolicy || 'shared', { lower: true }) || 'shared',
      create_mode: cleanText(entry.create_mode || entry.createMode || 'lazy', { lower: true }) || 'lazy',
    };
  });
  return {
    version: 1,
    plan_id: cleanText(merged.plan_id || merged.planId || merged.profile_id || merged.profileId || 'general_execution', { lower: true }) || 'general_execution',
    display_name: cleanText(merged.display_name || merged.displayName || merged.title || 'Memory plan') || 'Memory plan',
    selection_reason: cleanText(merged.selection_reason || merged.selectionReason || ''),
    team_name: cleanText(merged.team_name || merged.teamName || ''),
    topology_pattern: cleanText(merged.topology_pattern || merged.topologyPattern || '', { lower: true }),
    task_brief: cleanText(merged.task_brief || merged.taskBrief || ''),
    strategy: cleanText(merged.strategy || 'manual', { lower: true }) || 'manual',
    surfaces,
    default_load_surface_ids: uniqueStrings(merged.default_load_surface_ids || merged.defaultLoadSurfaceIds || surfaces.filter((entry) => entry.load_policy === 'always').map((entry) => entry.surface_id), { lower: true, limit: 16 }),
    writable_surface_ids: uniqueStrings(merged.writable_surface_ids || merged.writableSurfaceIds || surfaces.filter((entry) => entry.write_policy !== 'readonly').map((entry) => entry.surface_id), { lower: true, limit: 16 }),
    stable_surface_ids: uniqueStrings(merged.stable_surface_ids || merged.stableSurfaceIds || [], { lower: true, limit: 16 }),
    mutable_surface_ids: uniqueStrings(merged.mutable_surface_ids || merged.mutableSurfaceIds || [], { lower: true, limit: 16 }),
    system_files: uniqueStrings(merged.system_files || merged.systemFiles || STABLE_KB_FILE_NAMES, { limit: 16 }),
    migration_strategy: cleanText(merged.migration_strategy || merged.migrationStrategy || DEFAULT_MEMORY_POLICY.migration_strategy, { lower: true }) || DEFAULT_MEMORY_POLICY.migration_strategy,
    preserve_history: merged.preserve_history !== false && merged.preserveHistory !== false,
    enforce_concrete_file_names_in_prompts: merged.enforce_concrete_file_names_in_prompts !== false && merged.enforceConcreteFileNamesInPrompts !== false,
  };
}

export function deriveKnowledgeBaseProfileFromMemoryPlan(plan = {}) {
  return normalizeKnowledgeBaseProfile(coerceProfileSeedFromMemoryPlan(plan));
}

function coerceProfileSeedFromKnowledgeSurface(surface = {}) {
  const row = asObject(surface);
  const docs = asArray(row.docs || row.semantic_slots || row.semanticSlots).map((entry) => {
    const item = asObject(entry);
    return {
      ...item,
      doc_id: item.doc_id || item.docId || item.semantic_slot || item.semanticSlot || item.slot_id || item.slotId,
    };
  });
  return {
    profile_id: row.profile_id || row.profileId,
    display_name: row.display_name || row.displayName,
    strategy: row.strategy,
    selection_reason: row.selection_reason || row.selectionReason,
    team_name: row.team_name || row.teamName,
    topology_pattern: row.topology_pattern || row.topologyPattern,
    task_brief: row.task_brief || row.taskBrief,
    docs,
  };
}

export function normalizeKnowledgeBaseProfile(raw = {}) {
  const row = asObject(raw);
  const docs = asArray(row.docs).map((entry, index) => normalizeDocEntry(entry, index));
  const finalDocs = docs.length > 0 ? docs : DEFAULT_CANONICAL_DOCS.map((entry, index) => normalizeDocEntry(entry, index));
  const legacyMap = {};
  for (const doc of finalDocs) {
    legacyMap[doc.doc_id] = doc.file_name;
    legacyMap[doc.file_name] = doc.file_name;
    if (cleanText(doc.surface_id || doc.surfaceId, { lower: true })) legacyMap[cleanText(doc.surface_id || doc.surfaceId, { lower: true })] = doc.file_name;
    for (const alias of asArray(doc.legacy_names)) legacyMap[alias] = doc.file_name;
  }
  const memoryPolicy = normalizeMemoryPolicy(row.memory_policy || row.memoryPolicy || {}, { docs: finalDocs });
  return {
    version: 1,
    profile_id: cleanText(row.profile_id || row.profileId || 'general_execution', { lower: true }) || 'general_execution',
    display_name: stripMemoryPlanSuffix(row.display_name || row.displayName || 'Knowledge Base') || 'Knowledge Base',
    strategy: cleanText(row.strategy || 'manual', { lower: true }) || 'manual',
    selection_reason: cleanText(row.selection_reason || row.selectionReason || ''),
    team_name: cleanText(row.team_name || row.teamName || ''),
    topology_pattern: cleanText(row.topology_pattern || row.topologyPattern || '', { lower: true }),
    task_brief: cleanText(row.task_brief || row.taskBrief || ''),
    docs: finalDocs,
    memory_policy: memoryPolicy,
    legacy_map: legacyMap,
  };
}

function inferTopologyPattern(teamConfig = null) {
  const team = asObject(teamConfig);
  return cleanText(team?.structure_v2?.topology?.pattern || team?.structureV2?.topology?.pattern || team?.topology?.pattern || '', { lower: true });
}

function inferGoalMode(goal = '') {
  const text = cleanText(goal, { lower: true });
  if (!text) return 'general';
  if (/(debate|committee|consensus|judge|chair|토론|위원회|합의|판정)/.test(text)) return 'deliberation';
  if (/(experiment|evaluation|eval|benchmark|notebook|dataset|ab test|workflow|pipeline|실험|평가|벤치마크|노트북|데이터셋)/.test(text)) return 'experiment';
  if (/(review|audit|repair|regression|qa|triage|quality|회귀|감사|복구|수습|검토)/.test(text)) return 'review_repair';
  if (/(implement|implementation|fix|bug|patch|refactor|repo|repository|workspace|code|script|pull request|구현|수정|버그|패치|리팩터|레포|코드|스크립트)/.test(text)) return 'implementation';
  if (/(research|analy|brief|memo|report|market|strategy|investigate|조사|분석|리포트|전략|브리프)/.test(text)) return 'analysis';
  return 'general';
}

function chooseTemplateKey({ goal = '', teamConfig = null } = {}) {
  const pattern = inferTopologyPattern(teamConfig);
  if (pattern === 'debate' || pattern === 'committee') return 'deliberation';
  if (pattern === 'workflow') return 'experiment';
  return inferGoalMode(goal);
}

function maybePrefixFileName(fileName, { teamName = '', profileId = '' } = {}) {
  const teamSlug = slugify(teamName);
  if (!teamSlug || ['team', 'default_team', 'new_team'].includes(teamSlug)) return fileName;
  const stem = fileName.replace(/\.md$/i, '');
  const prefix = cleanText(profileId, { lower: true }) === 'general_execution' ? teamSlug : `${teamSlug}_${stem}`;
  if (cleanText(profileId, { lower: true }) === 'general_execution') return fileName;
  return safeFileName(`${prefix}`);
}

export function buildKnowledgeSurfaceFromProfile(profile = null) {
  const normalized = normalizeKnowledgeBaseProfile(profile || {});
  return {
    version: 1,
    profile_id: normalized.profile_id,
    display_name: normalized.display_name,
    strategy: normalized.strategy,
    selection_reason: normalized.selection_reason,
    dynamic_file_naming: true,
    team_name: normalized.team_name || undefined,
    topology_pattern: normalized.topology_pattern || undefined,
    task_brief: normalized.task_brief || undefined,
    docs: normalized.docs.map((doc) => ({
      doc_id: doc.doc_id,
      file_name: doc.file_name,
      title: doc.title,
      purpose: doc.purpose,
      legacy_names: [...doc.legacy_names],
      read_priority: doc.read_priority,
      write_hint: doc.write_hint || undefined,
      section_hints: [...doc.section_hints],
      target_roles: [...doc.target_roles],
    })),
    semantic_slot_map: Object.fromEntries(normalized.docs.map((doc) => [doc.doc_id, doc.file_name])),
    stable_memory_files: [...normalized.memory_policy.immutable_file_names],
  };
}

function resolveKnowledgeProfileSeed({ goal = '', teamConfig = null } = {}) {
  const team = asObject(teamConfig);
  const structure = asObject(team.structure_v2 || team.structureV2);
  if (Object.keys(team.memory_plan || team.memoryPlan || {}).length > 0) return coerceProfileSeedFromMemoryPlan(team.memory_plan || team.memoryPlan);
  if (Object.keys(structure.memory_plan || structure.memoryPlan || {}).length > 0) return coerceProfileSeedFromMemoryPlan(structure.memory_plan || structure.memoryPlan);
  if (Object.keys(team.team_blueprint || team.teamBlueprint || {}).length > 0) {
    const blueprint = asObject(team.team_blueprint || team.teamBlueprint);
    if (Object.keys(blueprint.memory_plan || blueprint.memoryPlan || {}).length > 0) return coerceProfileSeedFromMemoryPlan(blueprint.memory_plan || blueprint.memoryPlan);
  }
  if (Object.keys(team.knowledge_base_profile || {}).length > 0) return asObject(team.knowledge_base_profile);
  if (Object.keys(team.knowledgeBaseProfile || {}).length > 0) return asObject(team.knowledgeBaseProfile);
  if (Object.keys(structure.knowledge_surface || structure.knowledgeSurface || {}).length > 0) {
    return coerceProfileSeedFromKnowledgeSurface(structure.knowledge_surface || structure.knowledgeSurface);
  }
  if (Object.keys(team.knowledge_surface || team.knowledgeSurface || {}).length > 0) {
    return coerceProfileSeedFromKnowledgeSurface(team.knowledge_surface || team.knowledgeSurface);
  }
  return null;
}

export function deriveKnowledgeBaseDesign({ goal = '', teamConfig = null } = {}) {
  const explicitProfileSeed = resolveKnowledgeProfileSeed({ goal, teamConfig });
  const team = asObject(teamConfig);
  const structure = asObject(team.structure_v2 || team.structureV2);
  const explicitMemoryPolicy = asObject(
    structure.memory_policy
    || structure.memoryPolicy
    || team.memory_policy
    || team.memoryPolicy
    || explicitProfileSeed?.memory_policy
    || explicitProfileSeed?.memoryPolicy
    || {},
  );
  let profile;
  if (explicitProfileSeed) {
    profile = normalizeKnowledgeBaseProfile({
      ...explicitProfileSeed,
      memory_policy: explicitMemoryPolicy,
      team_name: explicitProfileSeed.team_name || team.team_name || structure?.metadata?.team_name,
      topology_pattern: explicitProfileSeed.topology_pattern || inferTopologyPattern(teamConfig),
      task_brief: explicitProfileSeed.task_brief || team.task_brief || structure?.intent?.task_brief || goal,
    });
  } else {
    const templateKey = chooseTemplateKey({ goal, teamConfig });
    const template = PROFILE_TEMPLATES[templateKey] || PROFILE_TEMPLATES.general;
    const teamName = cleanText(team.team_name || structure?.metadata?.team_name || '');
    const topologyPattern = inferTopologyPattern(teamConfig);
    const docs = template.docs.map((entry, index) => ({
      ...entry,
      file_name: maybePrefixFileName(entry.file_name, { teamName, profileId: template.profile_id }) || entry.file_name,
      read_priority: index + 1,
    }));
    const selectionReason = topologyPattern
      ? `Derived from topology=${topologyPattern} and goal classification=${templateKey}.`
      : `Derived from goal classification=${templateKey}.`;
    profile = normalizeKnowledgeBaseProfile({
      ...template,
      docs,
      selection_reason: selectionReason,
      team_name: teamName || undefined,
      topology_pattern: topologyPattern || undefined,
      task_brief: cleanText(team.task_brief || structure?.intent?.task_brief || goal),
      memory_policy: explicitMemoryPolicy,
    });
  }
  const memoryPolicy = normalizeMemoryPolicy(explicitMemoryPolicy || profile.memory_policy, { docs: profile.docs });
  const normalizedProfile = normalizeKnowledgeBaseProfile({ ...profile, memory_policy: memoryPolicy });
  const memoryPlan = normalizeMemoryPlan(buildMemoryPlanFromProfile(normalizedProfile));
  return {
    profile: normalizedProfile,
    knowledge_surface: buildKnowledgeSurfaceFromProfile(normalizedProfile),
    memory_policy: memoryPolicy,
    memory_plan: memoryPlan,
  };
}

export function deriveKnowledgeBaseProfile({ goal = '', teamConfig = null } = {}) {
  return deriveKnowledgeBaseDesign({ goal, teamConfig }).profile;
}

export function getKnowledgeDocEntry(profile = null, name = '') {
  const normalized = normalizeKnowledgeBaseProfile(profile || {});
  const cleanName = cleanText(name, { lower: true });
  if (!cleanName) return null;
  const actual = normalized.legacy_map[cleanName] || normalized.legacy_map[safeFileName(cleanName)];
  if (!actual) return null;
  return normalized.docs.find((entry) => cleanText(entry.file_name, { lower: true }) === actual) || null;
}

export function resolveKnowledgeDocName(profile = null, name = '') {
  const entry = getKnowledgeDocEntry(profile, name);
  return entry?.file_name || safeFileName(name);
}

export function listKnowledgeDocNames(profile = null) {
  return normalizeKnowledgeBaseProfile(profile || {}).docs.map((entry) => entry.file_name);
}

export function renderKnowledgeBaseProfileMarkdown(profile = null) {
  const normalized = normalizeKnowledgeBaseProfile(profile || {});
  const lines = [
    `# ${normalized.display_name}`,
    '',
    `- profile_id: ${normalized.profile_id}`,
    `- strategy: ${normalized.strategy}`,
    normalized.team_name ? `- team_name: ${normalized.team_name}` : '',
    normalized.topology_pattern ? `- topology_pattern: ${normalized.topology_pattern}` : '',
    normalized.task_brief ? `- task_brief: ${normalized.task_brief}` : '',
    normalized.selection_reason ? `- selection_reason: ${normalized.selection_reason}` : '',
    '',
    '## Memory policy',
    `- stable_semantic_slots: ${normalized.memory_policy.stable_semantic_slots.join(', ') || '(none)'}`,
    `- mutable_semantic_slots: ${normalized.memory_policy.mutable_semantic_slots.join(', ') || '(none)'}`,
    `- migration_strategy: ${normalized.memory_policy.migration_strategy}`,
    `- preserve_history: ${normalized.memory_policy.preserve_history ? 'true' : 'false'}`,
    `- immutable_files: ${normalized.memory_policy.immutable_file_names.join(', ')}`,
    '',
    '## Documents',
    ...normalized.docs.map((doc) => [
      `### ${doc.title}`,
      `- doc_id: ${doc.doc_id}`,
      `- file: ${doc.file_name}`,
      `- purpose: ${doc.purpose}`,
      doc.legacy_names.length > 0 ? `- aliases: ${doc.legacy_names.join(', ')}` : '',
      doc.target_roles.length > 0 ? `- target_roles: ${doc.target_roles.join(', ')}` : '',
      doc.write_hint ? `- write_hint: ${doc.write_hint}` : '',
      doc.section_hints.length > 0 ? `- sections: ${doc.section_hints.join(', ')}` : '',
      '',
    ].filter(Boolean).join('\n')),
  ].filter(Boolean);
  return lines.join('\n');
}


export function formatMemoryPlanMap(plan = null, { maxSurfaces = 8, includePolicy = true } = {}) {
  const normalized = normalizeMemoryPlan(plan || {});
  const surfaceLines = normalized.surfaces.slice(0, maxSurfaces).map((surface) => {
    const slots = asArray(surface.semantic_slots).map((entry) => cleanText(entry, { lower: true })).filter(Boolean);
    return `- ${surface.file_name}: ${slots.join(', ')} · ${cleanText(surface.purpose) || 'tracking memory'}`;
  });
  return [
    `Memory layout · ${normalized.display_name}`,
    `- plan_id: ${normalized.plan_id}`,
    ...(normalized.selection_reason ? [`- reason: ${normalized.selection_reason}`] : []),
    ...(includePolicy ? [
      `- default load: ${normalized.default_load_surface_ids.join(', ') || '(none)'}`,
      `- stable surfaces: ${normalized.stable_surface_ids.join(', ') || '(none)'}`,
    ] : []),
    ...surfaceLines,
    `- system files: ${normalized.system_files.join(', ')}`,
  ].join('\n');
}

export function formatKnowledgeBaseMemoryMap(profile = null, { maxDocs = 8, includePolicy = true } = {}) {
  return formatMemoryPlanMap(buildMemoryPlanFromProfile(profile || {}), { maxSurfaces: maxDocs, includePolicy });
}

export function summarizeKnowledgeBaseProfile(profile = null) {
  const normalized = normalizeKnowledgeBaseProfile(profile || {});
  return [
    `KB profile: ${normalized.display_name} (${normalized.profile_id})`,
    ...(normalized.selection_reason ? [`reason: ${normalized.selection_reason}`] : []),
    `stable slots: ${normalized.memory_policy.stable_semantic_slots.join(', ') || '(none)'}`,
    `mutable slots: ${normalized.memory_policy.mutable_semantic_slots.join(', ') || '(none)'}`,
    ...normalized.docs.map((doc) => `- ${doc.doc_id} -> ${doc.file_name} (${doc.purpose})`),
  ].join('\n');
}
