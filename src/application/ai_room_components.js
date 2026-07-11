function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function cleanText(value = '', { maxLen = 800, lower = false } = {}) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  const clipped = text.length > maxLen ? text.slice(0, maxLen) : text;
  return lower ? clipped.toLowerCase() : clipped;
}

function slugify(value = '', fallback = 'component') {
  const clean = cleanText(value || fallback, { maxLen: 180, lower: true })
    .replace(/[^a-z0-9가-힣._:-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return clean || fallback;
}

function uniqueStrings(values = [], { max = 64, lower = false } = {}) {
  const out = [];
  const seen = new Set();
  for (const raw of asArray(values)) {
    const text = cleanText(raw, { maxLen: 220, lower });
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

const PRIVATE_FIELD_RE = /(credential|secret|token|password|api[_-]?key|provider[_-]?state|runtime[_-]?log|chat[_-]?history|transcript|raw[_-]?message|conversation[_-]?turn|private[_-]?memory[_-]?content|memory[_-]?content|artifact[_-]?content|upload[_-]?content|health[_-]?record|portfolio[_-]?holding|personal[_-]?note|source[_-]?file|raw[_-]?file)/i;

export function stripPrivateRoomComponentFields(value, depth = 0) {
  if (depth > 12) return null;
  if (Array.isArray(value)) {
    return value.map((item) => stripPrivateRoomComponentFields(item, depth + 1)).filter((item) => item !== null && typeof item !== 'undefined');
  }
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, raw] of Object.entries(value)) {
    if (PRIVATE_FIELD_RE.test(String(key))) continue;
    const cleaned = stripPrivateRoomComponentFields(raw, depth + 1);
    if (cleaned !== null && typeof cleaned !== 'undefined') out[key] = cleaned;
  }
  return out;
}



const DOMAIN_AGENT_ALIAS_SPECS = Object.freeze({
  creative_writing: [
    {
      canonical: 'canon_reviewer',
      aliases: ['continuity_reviewer', 'continuity_checker', 'canon_checker'],
      title: 'Canon Reviewer',
      description: 'Review canon facts, character voice, motivation, and setting consistency.',
    },
    {
      canonical: 'continuity_checker',
      aliases: ['continuity_reviewer', 'canon_reviewer', 'timeline_reviewer'],
      title: 'Continuity Checker',
      description: 'Check timeline, plot continuity, unresolved contradictions, and foreshadowing.',
    },
    {
      canonical: 'story_planner',
      aliases: ['plot_planner', 'outline_planner'],
      title: 'Story Planner',
      description: 'Plan story structure, scenes, character arcs, and plot progression.',
    },
    {
      canonical: 'revision_synthesizer',
      aliases: ['style_editor', 'revision_editor', 'reader_advocate'],
      title: 'Revision Synthesizer',
      description: 'Combine draft and review findings into a coherent revision plan or revised draft.',
    },
  ],
});

function agentIdentity(raw = {}) {
  if (typeof raw === 'string') return slugify(raw, 'agent');
  const row = asObject(raw);
  return slugify(row.local_id || row.role || row.role_id || row.id || row.agent_id || row.title || row.name || 'agent', 'agent');
}

function ensureDomainAgentAliases(agentRows = [], domainLabel = '') {
  const rows = [...asArray(agentRows)];
  const specs = asArray(DOMAIN_AGENT_ALIAS_SPECS[slugify(domainLabel, 'general_workbench')]);
  if (!specs.length) return rows;
  const existing = new Set(rows.map(agentIdentity));
  for (const spec of specs) {
    const canonical = slugify(spec.canonical, 'agent');
    if (existing.has(canonical)) continue;
    const aliasSet = new Set(asArray(spec.aliases).map((value) => slugify(value, 'agent')));
    const source = rows.find((row) => aliasSet.has(agentIdentity(row)));
    const base = typeof source === 'string' ? {} : asObject(source);
    rows.push({
      ...base,
      id: canonical,
      agent_id: canonical,
      role: canonical,
      title: cleanText(spec.title || canonical, { maxLen: 120 }),
      description: cleanText(base.description || base.summary || spec.description || '', { maxLen: 1200 }),
      alias_of: source ? agentIdentity(source) : undefined,
      tags: uniqueStrings([...(asArray(base.tags)), domainLabel, canonical, ...(asArray(spec.aliases))], { max: 32, lower: true }),
    });
    existing.add(canonical);
  }
  return rows;
}

export const ROOM_COMPONENT_TYPES = Object.freeze({
  AGENT: 'agent_card',
  MEMORY_SCHEMA: 'memory_schema_card',
  PROMPT_POLICY: 'prompt_policy_card',
  CONTEXT_POLICY: 'context_policy_card',
  APPROVAL_POLICY: 'approval_policy_card',
  EVALUATION: 'evaluation_criteria_card',
  INTERACTION_GUIDE: 'interaction_guide_card',
});

function componentId(type, id, fallback) {
  return `${type}:${slugify(id || fallback || type, fallback || type)}`;
}

export function normalizeAgentCard(raw = {}, { sourcePackageId = '', domainLabel = '' } = {}) {
  const row = typeof raw === 'string' ? { id: raw, role: raw, title: raw } : asObject(raw);
  const role = slugify(row.role || row.role_id || row.id || row.agent_id || row.title || row.name || 'agent', 'agent');
  const id = componentId(ROOM_COMPONENT_TYPES.AGENT, row.id || row.agent_id || role, role);
  const allowedTools = uniqueStrings(row.allowed_tools || row.allowedTools || row.tools || [], { max: 32, lower: true });
  const reads = uniqueStrings(row.reads || row.memory_reads || row.memoryReads || row.input_memory || [], { max: 48, lower: true });
  const proposes = uniqueStrings(row.proposes_updates || row.proposesUpdates || row.memory_writes || row.memoryWrites || [], { max: 48, lower: true });
  return stripPrivateRoomComponentFields({
    kind: 'room_component_v1',
    component_type: ROOM_COMPONENT_TYPES.AGENT,
    component_id: id,
    local_id: role,
    source_package_id: sourcePackageId,
    domain_label: domainLabel,
    title: cleanText(row.title || row.name || role, { maxLen: 120 }),
    role,
    description: cleanText(row.description || row.summary || '', { maxLen: 1200 }),
    instructions: cleanText(row.instructions || row.prompt || row.base_prompt || '', { maxLen: 2000 }),
    input_contract: asObject(row.input_contract || row.inputContract),
    output_contract: asObject(row.output_contract || row.outputContract),
    memory_access: {
      read_private_source_room_memory: false,
      read_target_room_projection: true,
      write_memory_directly: false,
      allow_propose_update: true,
      reads,
      proposes_updates: proposes,
      ...(asObject(row.memory_access || row.memoryAccess)),
    },
    tool_policy: {
      allowed_tools: allowedTools,
      external_side_effects: row.external_side_effects || row.externalSideEffects || 'approval_required',
      ...(asObject(row.tool_policy || row.toolPolicy)),
    },
    install_policy: {
      default_scope: row.default_scope || row.defaultScope || 'borrow_single_attempt',
      can_borrow: row.can_borrow !== false,
      can_install_resident: row.can_install_resident !== false,
      can_fork: row.can_fork !== false,
      ...(asObject(row.install_policy || row.installPolicy)),
    },
    tags: uniqueStrings(row.tags || [domainLabel, role].filter(Boolean), { max: 32, lower: true }),
  });
}

export function normalizeMemorySchemaCard(raw = {}, { sourcePackageId = '', domainLabel = '' } = {}) {
  const row = asObject(raw);
  const objectTypes = uniqueStrings(row.object_types || row.objectTypes || row.objects || [], { max: 96, lower: true });
  const title = cleanText(row.title || `${domainLabel || 'room'} memory schema`, { maxLen: 120 });
  return stripPrivateRoomComponentFields({
    kind: 'room_component_v1',
    component_type: ROOM_COMPONENT_TYPES.MEMORY_SCHEMA,
    component_id: componentId(ROOM_COMPONENT_TYPES.MEMORY_SCHEMA, row.id || title, 'memory_schema'),
    local_id: slugify(row.id || 'memory_schema', 'memory_schema'),
    source_package_id: sourcePackageId,
    domain_label: domainLabel,
    title,
    description: cleanText(row.description || '', { maxLen: 1000 }),
    object_types: objectTypes,
    schemas: asObject(row.schemas || row.object_schemas || row.objectSchemas),
    retention_policy: cleanText(row.retention_policy || row.retentionPolicy || 'room_local_by_default', { maxLen: 200 }),
    export_policy: {
      copies_private_memory: false,
      private_memory_export: 'never_by_default',
    },
    agent_read_policy: asObject(row.agent_read_policy || row.agentReadPolicy),
    agent_write_policy: {
      direct_write: false,
      proposal_only: true,
      ...(asObject(row.agent_write_policy || row.agentWritePolicy)),
    },
    tags: uniqueStrings(row.tags || [domainLabel, 'memory'].filter(Boolean), { max: 32, lower: true }),
  });
}

export function normalizePolicyCard(type, raw = {}, { sourcePackageId = '', domainLabel = '', title = '' } = {}) {
  const row = asObject(raw);
  const local = slugify(row.id || title || type, type);
  return stripPrivateRoomComponentFields({
    kind: 'room_component_v1',
    component_type: type,
    component_id: componentId(type, row.id || title || local, local),
    local_id: local,
    source_package_id: sourcePackageId,
    domain_label: domainLabel,
    title: cleanText(row.title || title || local, { maxLen: 120 }),
    description: cleanText(row.description || '', { maxLen: 1000 }),
    policy: row.policy && typeof row.policy === 'object' ? row.policy : row,
    reusable: row.reusable !== false,
    tags: uniqueStrings(row.tags || [domainLabel, type].filter(Boolean), { max: 32, lower: true }),
  });
}

export function buildRoomComponentsFromPackage(roomPackage = {}) {
  const pkg = asObject(roomPackage);
  const packageId = slugify(pkg.package_id || pkg.packageId || pkg.id || pkg.title || 'room_package', 'room_package');
  const domainLabel = slugify(pkg.domain_label || pkg.domainLabel || pkg.domain || 'general_workbench', 'general_workbench');
  const rawComponents = asObject(pkg.components || pkg.component_library || pkg.componentLibrary);
  const agentRows = asArray(rawComponents.agents || rawComponents.agent_cards || rawComponents.agentCards).length
    ? asArray(rawComponents.agents || rawComponents.agent_cards || rawComponents.agentCards)
    : asArray(pkg.agent_cards || pkg.agentCards).length
      ? asArray(pkg.agent_cards || pkg.agentCards)
      : uniqueStrings(pkg.agents || pkg.agent_roles || pkg.agentRoles || [], { max: 32, lower: true });
  const agents = ensureDomainAgentAliases(agentRows, domainLabel)
    .map((agent) => normalizeAgentCard(agent, { sourcePackageId: packageId, domainLabel }));
  const memorySchema = normalizeMemorySchemaCard(
    asObject(rawComponents.memory_schema || rawComponents.memorySchema || pkg.memory_schema || pkg.memorySchema),
    { sourcePackageId: packageId, domainLabel },
  );
  const promptPolicy = normalizePolicyCard(
    ROOM_COMPONENT_TYPES.PROMPT_POLICY,
    asObject(rawComponents.prompt_policy || rawComponents.promptPolicy || pkg.prompt_policy || pkg.promptPolicy),
    { sourcePackageId: packageId, domainLabel, title: 'Prompt policy' },
  );
  const contextPolicy = normalizePolicyCard(
    ROOM_COMPONENT_TYPES.CONTEXT_POLICY,
    asObject(rawComponents.context_policy || rawComponents.contextPolicy || pkg.context_policy || pkg.contextPolicy),
    { sourcePackageId: packageId, domainLabel, title: 'Context firewall policy' },
  );
  const approvalPolicy = normalizePolicyCard(
    ROOM_COMPONENT_TYPES.APPROVAL_POLICY,
    asObject(rawComponents.approval_policy || rawComponents.approvalPolicy || pkg.approval_policy || pkg.approvalPolicy || pkg.autonomy_policy || pkg.autonomyPolicy),
    { sourcePackageId: packageId, domainLabel, title: 'Approval policy' },
  );
  const evaluationRows = asArray(rawComponents.evaluation_criteria || rawComponents.evaluationCriteria || pkg.evaluation_criteria || pkg.evaluationCriteria);
  const evaluation = evaluationRows.length
    ? evaluationRows.map((row, idx) => normalizePolicyCard(ROOM_COMPONENT_TYPES.EVALUATION, asObject(row), { sourcePackageId: packageId, domainLabel, title: `Evaluation ${idx + 1}` }))
    : [normalizePolicyCard(ROOM_COMPONENT_TYPES.EVALUATION, { criteria: uniqueStrings(pkg.evaluation_criteria || [], { max: 32 }) }, { sourcePackageId: packageId, domainLabel, title: 'Evaluation criteria' })];
  const guide = normalizePolicyCard(
    ROOM_COMPONENT_TYPES.INTERACTION_GUIDE,
    { examples: asArray(pkg.examples || pkg.interaction_examples || pkg.interactionExamples), default_depth: pkg.default_depth || pkg.defaultDepth },
    { sourcePackageId: packageId, domainLabel, title: 'Interaction guide' },
  );
  const flat = [
    ...agents,
    memorySchema,
    promptPolicy,
    contextPolicy,
    approvalPolicy,
    ...evaluation,
    guide,
  ].filter(Boolean);
  return {
    kind: 'room_component_library_v1',
    package_id: packageId,
    domain_label: domainLabel,
    agents,
    memory_schema: memorySchema,
    prompt_policy: promptPolicy,
    context_policy: contextPolicy,
    approval_policy: approvalPolicy,
    evaluation_criteria: evaluation,
    interaction_guide: guide,
    components: flat,
    summary: summarizeRoomComponents(flat),
  };
}

export function summarizeRoomComponents(components = []) {
  const counts = {};
  for (const component of asArray(components)) {
    const type = asObject(component).component_type || 'unknown';
    counts[type] = (counts[type] || 0) + 1;
  }
  return {
    total_components: asArray(components).length,
    component_counts: counts,
    reusable_agent_count: asArray(components).filter((c) => asObject(c).component_type === ROOM_COMPONENT_TYPES.AGENT && asObject(asObject(c).install_policy).can_borrow !== false).length,
    private_memory_copied: false,
  };
}

export function augmentRoomPackageWithComponents(roomPackage = {}) {
  const pkg = asObject(stripPrivateRoomComponentFields(roomPackage));
  const library = buildRoomComponentsFromPackage(pkg);
  return {
    ...pkg,
    agents: uniqueStrings([
      ...asArray(pkg.agents || pkg.agent_roles || pkg.agentRoles),
      ...library.agents.map((agent) => agent.local_id || agent.role),
    ], { max: 32, lower: true }),
    component_model: 'composable_room_components_v1',
    components: library,
    composition_policy: {
      shareable_units: ['agent_card', 'memory_schema_card', 'prompt_policy_card', 'context_policy_card', 'approval_policy_card', 'evaluation_criteria_card'],
      private_memory_copied: false,
      borrowed_agents_receive_projected_context_only: true,
      borrowed_agents_write_policy: 'proposal_only',
      source_room_private_memory: 'never_read_by_default',
      lineage_required: true,
      ...(asObject(pkg.composition_policy || pkg.compositionPolicy)),
    },
  };
}

export function findRoomAgentCard(roomPackage = {}, agentId = '') {
  const library = buildRoomComponentsFromPackage(roomPackage);
  const key = slugify(agentId, 'agent');
  return library.agents.find((agent) => {
    const row = asObject(agent);
    return slugify(row.local_id || row.role || row.title, 'agent') === key
      || slugify(String(row.component_id || '').split(':').pop(), 'agent') === key;
  }) || null;
}

export function createBorrowedAgentInvocation({
  sourceRoomPackage = null,
  sourceRoomPackageId = '',
  agentId = '',
  targetRoomId = '',
  targetRoomPackageId = '',
  scope = 'single_attempt',
  contextProjection = 'target_room_task_projection',
  reason = '',
} = {}) {
  const sourcePkg = asObject(sourceRoomPackage);
  const sourceId = slugify(sourceRoomPackageId || sourcePkg.package_id || sourcePkg.packageId || sourcePkg.title || 'source_room', 'source_room');
  const agent = sourcePkg && Object.keys(sourcePkg).length ? findRoomAgentCard(sourcePkg, agentId) : normalizeAgentCard(agentId || 'borrowed_agent', { sourcePackageId: sourceId });
  if (!agent) return null;
  return stripPrivateRoomComponentFields({
    kind: 'borrowed_agent_invocation_v1',
    source_room_package_id: sourceId,
    source_component_id: agent.component_id,
    agent_id: agent.local_id || agent.role || slugify(agentId, 'agent'),
    agent_title: agent.title || agentId,
    target_room_id: String(targetRoomId || 'current_room'),
    target_room_package_id: slugify(targetRoomPackageId || 'current_room_package', 'current_room_package'),
    scope,
    context_projection: contextProjection,
    reason: cleanText(reason, { maxLen: 800 }),
    memory_access: {
      read_source_private_memory: false,
      read_target_project_memory: true,
      write_memory: false,
      allow_propose_update: true,
      reads: asArray(asObject(agent.memory_access).reads),
      proposes_updates: asArray(asObject(agent.memory_access).proposes_updates),
    },
    approval_policy: 'target_room_owner_approves_merge_or_install',
    lineage: {
      borrowed_from_package: sourceId,
      borrowed_component_id: agent.component_id,
      copied_private_memory: false,
    },
  });
}

const BORROW_ROLE_PATTERNS = [
  { role: 'canon_reviewer', patterns: [/canon|continuity|character|캐릭터|설정|모순|말투|팬픽|소설|줄거리/i] },
  { role: 'continuity_checker', patterns: [/continuity|timeline|plot hole|모순|타임라인|복선|설정/i] },
  { role: 'security_reviewer', patterns: [/security|auth|credential|권한|보안|인증/i] },
  { role: 'verifier', patterns: [/test|verify|검증|테스트|재현/i] },
  { role: 'novelty_critic', patterns: [/novelty|related work|논문|새로움|기여|관련 연구/i] },
  { role: 'risk_reviewer', patterns: [/risk|finance|stock|리스크|주식|투자/i] },
];

export function recommendBorrowedAgents({ taskText = '', availableRoomPackages = [], targetRoomId = '', targetRoomPackageId = '' } = {}) {
  const text = cleanText(taskText, { lower: true, maxLen: 4000 });
  const recommendations = [];
  for (const pkg of asArray(availableRoomPackages)) {
    const source = asObject(pkg.package || pkg.room_package || pkg.roomPackage || pkg);
    if (!Object.keys(source).length) continue;
    const library = buildRoomComponentsFromPackage(source);
    for (const agent of library.agents) {
      const role = agent.local_id || agent.role || '';
      let matched = false;
      for (const row of BORROW_ROLE_PATTERNS) {
        if (row.role !== role && !String(role).includes(row.role)) continue;
        matched = row.patterns.some((pattern) => pattern.test(text));
        if (matched) break;
      }
      if (!matched) {
        const haystack = [role, agent.title, agent.description, asArray(agent.tags).join(' ')].join(' ').toLowerCase();
        matched = text && haystack && haystack.split(/[^a-z0-9가-힣]+/).filter(Boolean).some((token) => token.length > 3 && text.includes(token));
      }
      if (!matched) continue;
      const invocation = createBorrowedAgentInvocation({
        sourceRoomPackage: source,
        agentId: role,
        targetRoomId,
        targetRoomPackageId,
        reason: `task matches reusable agent role ${role}`,
      });
      if (invocation) recommendations.push({ score: 0.75, agent, invocation, package_id: library.package_id, title: source.title || source.name || library.package_id });
    }
  }
  return recommendations.slice(0, 8);
}

export function formatRoomComponentLibrary(library = {}, { maxAgents = 12 } = {}) {
  const row = asObject(library.components ? library : buildRoomComponentsFromPackage(library));
  const lines = [
    `Composable Room Components: ${row.package_id || '-'}`,
    `- domain: ${row.domain_label || 'general_workbench'}`,
    `- total components: ${asObject(row.summary).total_components || asArray(row.components).length}`,
    `- reusable agents: ${asObject(row.summary).reusable_agent_count || 0}`,
    '- private memory copied: no',
  ];
  if (asArray(row.agents).length) {
    lines.push('- agent cards:');
    for (const agent of asArray(row.agents).slice(0, maxAgents)) {
      lines.push(`  - ${agent.local_id || agent.role}: ${agent.title || ''}`.trim());
    }
  }
  if (asArray(asObject(row.memory_schema).object_types).length) {
    lines.push(`- memory schema: ${asArray(asObject(row.memory_schema).object_types).join(', ')}`);
  }
  lines.push('- composition policy: borrow/install/fork components; borrowed agents receive only target-room context projections and can only propose memory updates.');
  return lines.join('\n');
}
