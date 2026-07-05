import {
  augmentRoomPackageWithComponents,
  buildRoomComponentsFromPackage,
  formatRoomComponentLibrary,
} from './ai_room_components.js';
import {
  buildDefaultRoomPackageComposition,
  formatDefaultRoomPackageComposition,
  formatDefaultRoomPackageDetail,
  formatDefaultRoomPackageList,
  getDefaultRoomPackage,
  listDefaultRoomPackages,
  recommendDefaultRoomPackages,
  roomTemplateFromDefaultPackage,
} from './default_room_library.js';

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

function slugify(value = '', fallback = 'room') {
  const clean = cleanText(value || fallback, { maxLen: 160, lower: true })
    .replace(/[^a-z0-9가-힣._:-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return clean || fallback;
}

function uniqueStrings(values = [], { max = 32, lower = false } = {}) {
  const out = [];
  const seen = new Set();
  for (const raw of asArray(values)) {
    const text = cleanText(raw, { maxLen: 180, lower });
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= max) break;
  }
  return out;
}


const PRIVATE_PACKAGE_KEY_RE = /(credential|secret|token|password|api[_-]?key|provider[_-]?state|runtime[_-]?log|chat[_-]?history|transcript|raw[_-]?message|conversation[_-]?turn|private[_-]?memory|memory[_-]?content|artifact[_-]?content|upload[_-]?content|health[_-]?record|portfolio[_-]?holding|personal[_-]?note)/i;

function stripPrivatePackageFields(value, depth = 0) {
  if (depth > 12) return null;
  if (Array.isArray(value)) {
    return value.map((item) => stripPrivatePackageFields(item, depth + 1)).filter((item) => item !== null && typeof item !== 'undefined');
  }
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, raw] of Object.entries(value)) {
    if (PRIVATE_PACKAGE_KEY_RE.test(String(key))) continue;
    const cleaned = stripPrivatePackageFields(raw, depth + 1);
    if (cleaned !== null && typeof cleaned !== 'undefined') out[key] = cleaned;
  }
  return out;
}

const DOMAIN_TEMPLATES = {
  quick_search: {
    room_name: 'Quick Search Room',
    purpose: 'Answer lightweight information requests quickly with concise, source-aware responses.',
    default_depth: 'ask',
    agent_roles: ['research_scout', 'answer_synthesizer'],
    memory_schema: ['query_preferences', 'trusted_sources', 'recurring_entities'],
    prompt_policy: {
      token_budget: 'small',
      compression: 'aggressive',
      default_style: 'concise',
    },
    context_policy: {
      default_scope: 'room_local_first',
      cross_room_memory: 'ask_before_use',
      private_memory: 'minimal',
    },
    approval_policy: {
      default: 'auto_for_low_risk_answers',
      requires_approval: ['memory_promotion', 'external_account_action'],
    },
    examples: [
      { user: 'Find the latest high-level summary of this topic.', room: 'Give a compact answer with key sources and uncertainty.' },
      { user: 'What does this term mean?', room: 'Explain briefly, then offer one useful follow-up.' },
    ],
    tags: ['search', 'quick_answer', 'concise'],
  },
  portfolio_research: {
    room_name: 'Portfolio Research Room',
    purpose: 'Support recurring market, stock, portfolio, and risk research without executing trades.',
    default_depth: 'team',
    agent_roles: ['market_researcher', 'portfolio_context_curator', 'risk_reviewer', 'thesis_synthesizer'],
    memory_schema: ['holdings', 'watchlist', 'risk_tolerance', 'investment_theses', 'rejected_assumptions', 'earnings_notes', 'macro_concerns'],
    prompt_policy: {
      token_budget: 'medium',
      compression: 'evidence_first',
      default_style: 'research_memo',
    },
    context_policy: {
      default_scope: 'room_local_first',
      cross_room_memory: 'explicit_user_approval',
      private_memory: 'portfolio_data_role_filtered',
    },
    approval_policy: {
      default: 'research_only',
      requires_approval: ['portfolio_memory_update', 'high_risk_claim', 'external_order_or_trade'],
      forbidden_without_explicit_instruction: ['trade_execution'],
    },
    examples: [
      { user: 'Update my thesis on this stock after earnings.', room: 'Use holdings/watchlist context, separate facts from thesis, and ask before changing portfolio memory.' },
      { user: 'Compare these two stocks.', room: 'Produce market thesis, risk review, and portfolio-fit summary.' },
    ],
    tags: ['finance', 'research', 'risk'],
  },
  nutrition_tracker: {
    room_name: 'Nutrition Tracker Room',
    purpose: 'Estimate meals from photos or text, maintain meal history, and suggest future meals.',
    default_depth: 'ask',
    agent_roles: ['food_image_interpreter', 'nutrition_estimator', 'meal_history_tracker', 'next_meal_planner'],
    memory_schema: ['meal_log', 'estimated_calories', 'macros', 'diet_preferences', 'allergies', 'restrictions', 'weekly_patterns'],
    prompt_policy: {
      token_budget: 'small',
      compression: 'daily_summary_plus_recent_meals',
      default_style: 'practical_estimate',
    },
    context_policy: {
      default_scope: 'room_local_first',
      cross_room_memory: 'off_by_default',
      private_memory: 'health_related_local_only',
    },
    approval_policy: {
      default: 'ask_before_persistent_health_memory',
      requires_approval: ['allergy_or_medical_memory_update', 'weekly_plan_change'],
    },
    examples: [
      { user: 'uploads a meal photo', room: 'Estimate visible food, calories/macros with uncertainty, then ask whether to log it.' },
      { user: 'What should I eat next?', room: 'Use today’s logged meals and preferences, avoid medical claims.' },
    ],
    tags: ['nutrition', 'photos', 'tracking'],
  },
  research_paper: {
    room_name: 'Research Paper Room',
    purpose: 'Turn rough research ideas into claims, related work maps, experiments, figures, and drafts.',
    default_depth: 'team',
    agent_roles: ['idea_expander', 'related_work_scout', 'novelty_critic', 'evaluation_designer', 'paper_synthesizer'],
    memory_schema: ['research_claims', 'related_work', 'novelty_gaps', 'rejected_framings', 'figure_plans', 'evaluation_metrics', 'paper_outline'],
    prompt_policy: {
      token_budget: 'large_for_loop',
      compression: 'claims_and_decisions_first',
      default_style: 'research_slide_or_paper_ready',
    },
    context_policy: {
      default_scope: 'room_local_first',
      cross_room_memory: 'ask_before_import',
      private_memory: 'role_specific_packets',
    },
    approval_policy: {
      default: 'user_approves_claim_promotion',
      requires_approval: ['main_claim_change', 'memory_promotion', 'paper_title_or_scope_change'],
    },
    examples: [
      { user: 'This idea feels weak. Find a stronger angle.', room: 'Compare framings, identify novelty gaps, and propose experiments.' },
      { user: 'Make a figure for this paper.', room: 'Produce a figure concept, labels, and image-generation prompt.' },
    ],
    tags: ['research', 'paper', 'novelty', 'evaluation'],
  },
  creative_writing: {
    room_name: 'Creative Writing Room',
    purpose: 'Develop stories with consistent canon, character memory, drafts, reviews, and revisions.',
    default_depth: 'team',
    agent_roles: ['story_planner', 'draft_writer', 'canon_reviewer', 'continuity_checker', 'revision_synthesizer'],
    memory_schema: ['characters', 'canon_facts', 'plot_arcs', 'style_preferences', 'draft_history', 'continuity_issues', 'rejected_versions'],
    prompt_policy: {
      token_budget: 'medium',
      compression: 'canon_and_current_arc_first',
      default_style: 'draft_then_review',
    },
    context_policy: {
      default_scope: 'room_local_first',
      cross_room_memory: 'ask_before_import',
      private_memory: 'story_project_local',
    },
    approval_policy: {
      default: 'ask_before_canon_memory_update',
      requires_approval: ['canon_change', 'character_arc_change', 'long_term_style_memory'],
    },
    examples: [
      { user: 'I have a rough plot. Turn it into a scene.', room: 'Draft a scene, then run canon and continuity review.' },
      { user: 'Find contradictions in this chapter.', room: 'Check character motivation, timeline, canon facts, and unresolved foreshadowing.' },
    ],
    tags: ['writing', 'fiction', 'canon', 'drafting'],
  },
  code_review: {
    room_name: 'Code Review Room',
    purpose: 'Review, patch, test, and explain code changes with explicit runtime and approval boundaries.',
    default_depth: 'team',
    agent_roles: ['implementation_planner', 'builder', 'reviewer', 'verifier', 'delivery_synthesizer'],
    memory_schema: ['repo_conventions', 'test_commands', 'known_failures', 'patch_history', 'deployment_constraints'],
    prompt_policy: {
      token_budget: 'medium',
      compression: 'repo_contract_plus_recent_failures',
      default_style: 'patch_notes_and_tests',
    },
    context_policy: {
      default_scope: 'workspace_and_room_memory',
      cross_room_memory: 'ask_before_import',
      private_memory: 'never_share_credentials',
    },
    approval_policy: {
      default: 'approval_required_for_destructive_or_deploy_actions',
      requires_approval: ['deployment', 'credential_binding', 'destructive_change'],
    },
    examples: [
      { user: 'Patch this bug and test it.', room: 'Plan patch, modify code, run tests, then summarize diff and risks.' },
      { user: 'Review this implementation.', room: 'Check contract, tests, regressions, and deployment risk.' },
    ],
    tags: ['code', 'review', 'testing'],
  },
  general_workbench: {
    room_name: 'General AI Work Room',
    purpose: 'Manage repeated AI work with room-local memory, reusable workflows, and user approval.',
    default_depth: 'ask',
    agent_roles: ['planner', 'researcher', 'reviewer', 'synthesizer'],
    memory_schema: ['room_preferences', 'recurring_entities', 'decisions', 'saved_workflows'],
    prompt_policy: {
      token_budget: 'adaptive',
      compression: 'room_summary_first',
      default_style: 'helpful_and_structured',
    },
    context_policy: {
      default_scope: 'room_local_first',
      cross_room_memory: 'ask_before_use',
      private_memory: 'least_privilege',
    },
    approval_policy: {
      default: 'ask_before_long_term_memory_update',
      requires_approval: ['memory_promotion', 'external_action'],
    },
    examples: [
      { user: 'Help me with this recurring task.', room: 'Infer task type, propose a work mode, and ask before specializing.' },
    ],
    tags: ['general', 'room', 'workflow'],
  },
};

export function inferRoomDomain(goal = '', { attachmentKinds = [] } = {}) {
  const text = cleanText(goal, { lower: true, maxLen: 3000 });
  const attachmentText = asArray(attachmentKinds).join(' ').toLowerCase();
  const scores = {
    quick_search: 0,
    portfolio_research: 0,
    nutrition_tracker: 0,
    research_paper: 0,
    creative_writing: 0,
    code_review: 0,
    general_workbench: 1,
  };
  const add = (domain, amount, pattern) => {
    if (!pattern) return;
    if (pattern instanceof RegExp) {
      if (pattern.test(text) || pattern.test(attachmentText)) scores[domain] += amount;
      return;
    }
    scores[domain] += amount;
  };

  add('creative_writing', 5, /(fanfic|fiction|novel|story|scene|chapter|plot|character|canon|continuity|draft|rewrite|소설|팬픽|글쓰기|줄거리|캐릭터|설정|모순|초안|장면|대사|문체|복선)/i);
  add('research_paper', 5, /(paper|research|related work|novelty|experiment|evaluation|figure|method|abstract|논문|연구|아이디어|관련\s*연구|실험|평가|새로움|노벨티|방법론|초록)/i);
  add('portfolio_research', 5, /(stock|portfolio|holding|watchlist|earnings|market|equity|ticker|macro|risk|주식|포트폴리오|보유|관심종목|실적|시장|투자|리스크|매크로)/i);
  add('nutrition_tracker', 5, /(meal|food|nutrition|calorie|macro|protein|carb|fat|diet|allergy|음식|식사|영양|칼로리|탄수|단백질|지방|식단|알러지|알레르기)/i);
  add('nutrition_tracker', 3, /(image|photo|사진|이미지)/i);
  add('code_review', 6, /(code|repo|repository|patch|bug|test|build|deploy|implementation|api|frontend|backend|코드|레포|패치|버그|테스트|빌드|배포|구현|프론트|백엔드)/i);
  add('quick_search', 2, /(what is|who is|when|where|summarize|find|lookup|latest|briefly|무엇|누구|언제|어디|요약|검색|찾아|최신|간단히)/i);

  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [domain_label, score] = ranked[0];
  const margin = score - (ranked[1]?.[1] || 0);
  const setupOnly = /(setup|configure|prepare|ready|template|team|workflow|agent|나중에|준비|구성|설정|팀|에이전트|방식|워크플로|설명서)/i.test(text)
    && /(will provide|later|when I|대략적인|내가.*말|나중에|줄거리.*얘기|입력.*하면|사진.*올리면)/i.test(text);
  return {
    domain_label,
    confidence: Math.max(0.25, Math.min(0.95, 0.45 + (score / 10) + (margin / 20))),
    setup_only: setupOnly,
    matched_score: score,
    template: DOMAIN_TEMPLATES[domain_label] || DOMAIN_TEMPLATES.general_workbench,
  };
}

export function getRoomDomainTemplate(domainLabel = '') {
  return DOMAIN_TEMPLATES[domainLabel] || DOMAIN_TEMPLATES.general_workbench;
}

export function selectDefaultRoomPackageForGoal(goal = '', { minScore = 4 } = {}) {
  const recommendations = recommendDefaultRoomPackages(goal, { limit: 5, minScore: 1 });
  const top = recommendations[0] || null;
  if (!top || Number(top.score || 0) < minScore) return { preset: null, recommendations };
  return { preset: top, recommendations };
}

export function buildRoomProfileFromGoal({ chatId = '', goal = '', roomName = '', source = 'room_specialization', attachmentKinds = [], presetId = '' } = {}) {
  const explicitPreset = presetId ? getDefaultRoomPackage(presetId) : null;
  const selected = explicitPreset ? { preset: explicitPreset, recommendations: [explicitPreset] } : selectDefaultRoomPackageForGoal(goal);
  const composition = explicitPreset
    ? buildDefaultRoomPackageComposition(explicitPreset.description || explicitPreset.title || goal, { limit: 6 })
    : buildDefaultRoomPackageComposition(goal, { limit: 6 });
  const compositionBaseId = composition?.base_package?.package_id || '';
  const compositionBase = compositionBaseId ? getDefaultRoomPackage(compositionBaseId) : null;
  const inferred = inferRoomDomain(goal, { attachmentKinds });
  const basePreset = explicitPreset || compositionBase || selected.preset;
  const presetTemplate = basePreset ? roomTemplateFromDefaultPackage(basePreset) : null;
  const template = presetTemplate || inferred.template;
  const now = new Date().toISOString();
  const domainLabel = basePreset?.domain_label || inferred.domain_label;
  const defaultDepth = template.default_depth || 'team';
  const borrowed = asArray(composition?.borrowed_packages);
  const borrowedSkills = borrowed.flatMap((item) => asArray(asObject(item.borrowed_components).skills));
  const borrowedMemory = borrowed.flatMap((item) => asArray(asObject(item.borrowed_components).memory_schema));
  const borrowedHierarchy = borrowed.flatMap((item) => asArray(asObject(item.borrowed_components).memory_hierarchy));
  const borrowedAgents = borrowed.flatMap((item) => asArray(asObject(item.borrowed_components).agents));
  const skills = uniqueStrings([...(template.skills || basePreset?.skills || []), ...borrowedSkills], { max: 48, lower: true });
  const memoryHierarchy = uniqueStrings([...(template.memory_hierarchy || basePreset?.memory_hierarchy || []), ...borrowedHierarchy], { max: 48, lower: true });
  const memoryObjects = uniqueStrings([...(template.memory_schema || []), ...borrowedMemory], { max: 48, lower: true });
  const agentRoles = uniqueStrings([...(template.agent_roles || []), ...borrowedAgents], { max: 12, lower: true });
  return {
    kind: 'agent_room_profile_v1',
    room_id: String(chatId || 'telegram_room'),
    name: cleanText(roomName || template.room_name || 'AI Work Room', { maxLen: 120 }),
    status: 'active',
    source,
    package_id: basePreset?.package_id || '',
    preset_id: basePreset?.package_id || '',
    preset_title: basePreset?.title || '',
    domain_label: domainLabel,
    domain_confidence: basePreset ? Math.max(0.75, inferred.confidence || 0.75) : inferred.confidence,
    setup_only: inferred.setup_only,
    room_purpose: template.purpose,
    default_agents: agentRoles,
    default_workflow: defaultDepth === 'loop' ? 'bounded_review_improve_loop' : (defaultDepth === 'team' ? 'review_gated_pipeline' : 'quick_answer'),
    default_depth: defaultDepth,
    installed_skills: skills,
    memory_scope: 'room',
    memory_hierarchy: memoryHierarchy,
    loop_policy: asObject(template.loop_policy || basePreset?.loop_policy),
    memory_schema: {
      object_types: memoryObjects,
      hierarchy: memoryHierarchy,
      retention_policy: 'room_local_by_default',
      private_memory_export: 'never_by_default',
    },
    prompt_policy: {
      ...asObject(template.prompt_policy),
      selected_default_room_preset: basePreset?.package_id || '',
      room_package_composition_mode: composition?.mode || '',
    },
    context_policy: asObject(template.context_policy),
    autonomy_policy: asObject(template.approval_policy),
    interaction_examples: asArray(template.examples),
    current_goal: cleanText(goal, { maxLen: 800 }),
    room_package_recommendations: (composition?.candidates || selected.recommendations || []).slice(0, 8).map((row) => ({ package_id: row.package_id, title: row.title, score: row.composition_score ?? row.score })),
    room_package_composition: composition,
    reasons: [
      `domain:${domainLabel}`,
      basePreset ? `default_room_preset:${basePreset.package_id}` : '',
      borrowed.length ? `borrowed_room_components:${borrowed.map((row) => row.package_id).join(',')}` : '',
      inferred.setup_only ? 'setup_only_room_preparation' : 'recurring_room_specialization',
    ].filter(Boolean),
    tags: uniqueStrings(template.tags, { max: 16, lower: true }),
    created_at: now,
    updated_at: now,
  };
}

export function sanitizeRoomPackage(raw = {}) {
  const source = asObject(stripPrivatePackageFields(raw.package || raw.room_package || raw.roomPackage || raw));
  const domain = source.domain_label || source.domainLabel || source.domain || 'general_workbench';
  const template = getRoomDomainTemplate(domain);
  const title = cleanText(source.title || source.name || template.room_name || 'AI Work Room', { maxLen: 160 });
  const packageId = slugify(source.package_id || source.packageId || source.id || title || 'room_package', 'room_package');
  const memory = asObject(source.memory_schema || source.memorySchema || {});
  const context = asObject(source.context_policy || source.contextPolicy || {});
  const prompt = asObject(source.prompt_policy || source.promptPolicy || {});
  const approval = asObject(source.approval_policy || source.approvalPolicy || source.autonomy_policy || source.autonomyPolicy || {});
  const examples = asArray(source.examples || source.interaction_examples || source.interactionExamples).slice(0, 12).map((item) => {
    const row = asObject(item);
    return {
      user: cleanText(row.user || row.input || '', { maxLen: 500 }),
      room: cleanText(row.room || row.output || row.response || '', { maxLen: 700 }),
    };
  }).filter((row) => row.user || row.room);
  return augmentRoomPackageWithComponents({
    ...source,
    kind: 'shared_room_package_v1',
    schema_version: 1,
    package_id: packageId,
    title,
    description: cleanText(source.description || source.purpose || template.purpose || '', { maxLen: 2000 }),
    visibility: slugify(source.visibility || 'private_review', 'private_review'),
    status: slugify(source.status || source.publish_state || 'candidate', 'candidate'),
    version: cleanText(source.version || '0.1.0', { maxLen: 40 }),
    license: cleanText(source.license || 'unlicensed', { maxLen: 80 }),
    domain_label: slugify(domain, 'general_workbench'),
    room_manual: cleanText(source.room_manual || source.roomManual || '', { maxLen: 8000 }),
    agents: uniqueStrings(source.agents || source.agent_roles || source.agentRoles || template.agent_roles, { max: 24, lower: true }),
    default_depth: slugify(source.default_depth || source.defaultDepth || template.default_depth || 'ask', 'ask'),
    skills: uniqueStrings(source.skills || source.installed_skills || template.skills, { max: 64, lower: true }),
    memory_hierarchy: uniqueStrings(source.memory_hierarchy || source.memoryHierarchy || memory.hierarchy || template.memory_hierarchy, { max: 64, lower: true }),
    loop_policy: asObject(source.loop_policy || source.loopPolicy || template.loop_policy),
    memory_schema: {
      object_types: uniqueStrings(memory.object_types || memory.objectTypes || source.memory_object_types || template.memory_schema, { max: 64, lower: true }),
      hierarchy: uniqueStrings(memory.hierarchy || source.memory_hierarchy || source.memoryHierarchy || template.memory_hierarchy, { max: 64, lower: true }),
      retention_policy: cleanText(memory.retention_policy || memory.retentionPolicy || 'room_local_by_default', { maxLen: 200 }),
      private_memory_export: 'never_by_default',
      copies_private_memory: false,
    },
    prompt_policy: {
      ...prompt,
      token_budget: cleanText(prompt.token_budget || prompt.tokenBudget || template.prompt_policy?.token_budget || 'adaptive', { maxLen: 120 }),
    },
    context_policy: {
      ...context,
      shared_package_copies_private_memory: false,
      private_memory: cleanText(context.private_memory || context.privateMemory || template.context_policy?.private_memory || 'least_privilege', { maxLen: 160 }),
      cross_room_memory: cleanText(context.cross_room_memory || context.crossRoomMemory || template.context_policy?.cross_room_memory || 'ask_before_use', { maxLen: 160 }),
    },
    approval_policy: approval && Object.keys(approval).length ? approval : template.approval_policy,
    examples: examples.length ? examples : asArray(template.examples),
    tags: uniqueStrings(source.tags || template.tags, { max: 24, lower: true }),
    safety_report: {
      clone_safe: true,
      copies_private_memory: false,
      credentials_copied: false,
      provider_state_copied: false,
      private_files_copied: false,
    },
    install_policy: {
      private_memory: 'fresh_on_install',
      credentials: 'never_copy',
      user_must_approve_memory_import: true,
    },
  });
}

export function buildRoomPackage({ profile = null, goal = '', title = '', chatId = '', visibility = 'private_review', source = 'ddalggak_room_export' } = {}) {
  const row = asObject(profile);
  const base = row.kind ? row : buildRoomProfileFromGoal({ chatId, goal, roomName: title, source });
  return sanitizeRoomPackage({
    package_id: row.package_id || title || base.name,
    title: title || base.name,
    description: base.room_purpose || base.current_goal || goal,
    visibility,
    status: 'candidate',
    domain_label: base.domain_label || inferRoomDomain(goal).domain_label,
    agents: base.default_agents,
    default_depth: base.default_depth || (base.default_workflow === 'quick_answer' ? 'ask' : 'team'),
    skills: base.installed_skills || base.skills || [],
    memory_hierarchy: base.memory_hierarchy || base.memory_schema?.hierarchy || [],
    loop_policy: base.loop_policy || {},
    memory_schema: base.memory_schema,
    prompt_policy: base.prompt_policy,
    context_policy: base.context_policy,
    approval_policy: base.autonomy_policy,
    examples: base.interaction_examples,
    tags: base.tags,
    source: { chat_id: String(chatId || base.room_id || ''), source },
  });
}

export function roomPackageToProfilePatch(roomPackage = {}, { chatId = '', source = 'room_package_install' } = {}) {
  const pkg = sanitizeRoomPackage(roomPackage);
  return {
    kind: 'agent_room_profile_v1',
    room_id: String(chatId || 'telegram_room'),
    name: pkg.title,
    status: 'active',
    source,
    package_id: pkg.package_id,
    domain_label: pkg.domain_label,
    domain_confidence: 0.9,
    room_purpose: pkg.description,
    default_agents: pkg.agents,
    default_depth: pkg.default_depth,
    default_workflow: pkg.default_depth === 'loop' ? 'bounded_review_improve_loop' : (pkg.default_depth === 'team' ? 'review_gated_pipeline' : 'quick_answer'),
    installed_skills: pkg.skills || [],
    memory_scope: 'room',
    memory_hierarchy: pkg.memory_hierarchy || pkg.memory_schema?.hierarchy || [],
    loop_policy: pkg.loop_policy || {},
    memory_schema: pkg.memory_schema,
    prompt_policy: pkg.prompt_policy,
    context_policy: pkg.context_policy,
    autonomy_policy: pkg.approval_policy,
    interaction_examples: pkg.examples,
    tags: pkg.tags,
    reasons: ['installed_shared_room_package', `domain:${pkg.domain_label}`],
  };
}

export function renderRoomMarkdown(roomPackage = {}) {
  const pkg = sanitizeRoomPackage(roomPackage);
  const lines = [];
  lines.push(`# ${pkg.title}`);
  lines.push('');
  lines.push('## Purpose');
  lines.push(pkg.description || 'A specialized AI room for recurring work.');
  lines.push('');
  lines.push('## How to use this room');
  lines.push(`- Default work depth: ${pkg.default_depth}`);
  lines.push(`- Domain: ${pkg.domain_label}`);
  lines.push('- Use this room for recurring tasks that match the purpose above.');
  lines.push('- The room may propose memory updates, but the user should approve important long-term changes.');
  lines.push('');
  lines.push('## Agent team');
  for (const agent of pkg.agents) lines.push(`- ${agent}`);
  lines.push('');
  lines.push('## Composable components');
  lines.push('- Room packages are module bundles, not monoliths.');
  lines.push('- Agent cards, memory schema cards, prompt/context/approval policies, and evaluation criteria can be borrowed, installed, or forked.');
  lines.push('- Borrowed agents receive only target-room context projections and cannot read source-room private memory.');
  lines.push('- Borrowed agents can propose memory updates, but direct writes require the target room approval policy.');
  const componentLibrary = buildRoomComponentsFromPackage(pkg);
  for (const agent of componentLibrary.agents) lines.push(`- agent_card: ${agent.local_id || agent.role} · borrow=${agent.install_policy?.can_borrow !== false}`);
  lines.push('');
  lines.push('## Skills');
  for (const skill of asArray(pkg.skills)) lines.push(`- ${skill}`);
  if (!asArray(pkg.skills).length) lines.push('- (none declared)');
  lines.push('');
  lines.push('## Memory hierarchy');
  for (const layer of asArray(pkg.memory_hierarchy || pkg.memory_schema.hierarchy)) lines.push(`- ${layer}`);
  if (!asArray(pkg.memory_hierarchy || pkg.memory_schema.hierarchy).length) lines.push('- room_profile');
  lines.push('');
  lines.push('## Memory schema');
  for (const objectType of asArray(pkg.memory_schema.object_types)) lines.push(`- ${objectType}`);
  lines.push('');
  lines.push('## Loop policy');
  for (const [key, value] of Object.entries(asObject(pkg.loop_policy))) {
    lines.push(`- ${key}: ${Array.isArray(value) ? value.join(', ') : String(value)}`);
  }
  if (!Object.keys(asObject(pkg.loop_policy)).length) lines.push('- default_iterations: adaptive');
  lines.push('');
  lines.push('## Prompt policy');
  for (const [key, value] of Object.entries(asObject(pkg.prompt_policy))) {
    lines.push(`- ${key}: ${Array.isArray(value) ? value.join(', ') : String(value)}`);
  }
  lines.push('');
  lines.push('## Context policy');
  lines.push('- Shared room packages never include private user memory, credentials, provider state, raw chat logs, or private files.');
  for (const [key, value] of Object.entries(asObject(pkg.context_policy))) {
    lines.push(`- ${key}: ${Array.isArray(value) ? value.join(', ') : String(value)}`);
  }
  lines.push('');
  lines.push('## Interaction examples');
  for (const example of asArray(pkg.examples)) {
    lines.push(`- User: ${example.user}`);
    lines.push(`  Room: ${example.room}`);
  }
  lines.push('');
  lines.push('## Governance');
  for (const [key, value] of Object.entries(asObject(pkg.approval_policy))) {
    lines.push(`- ${key}: ${Array.isArray(value) ? value.join(', ') : String(value)}`);
  }
  lines.push('');
  lines.push('## Export boundary');
  lines.push('- This ROOM.md describes a way of working.');
  lines.push('- It does not export private memory.');
  lines.push('- Installed rooms start with fresh local private memory unless the user explicitly imports memory.');
  return lines.join('\n');
}

export function formatRoomPackageSummary(roomPackage = {}, { includeExamples = true } = {}) {
  const pkg = sanitizeRoomPackage(roomPackage);
  const lines = [
    `Room Package: ${pkg.title}`,
    `- package_id: ${pkg.package_id}`,
    `- domain: ${pkg.domain_label}`,
    `- default depth: ${pkg.default_depth}`,
    `- agents: ${pkg.agents.join(', ') || '-'}`,
    `- components: ${asObject(pkg.components?.summary).total_components || buildRoomComponentsFromPackage(pkg).summary.total_components}`,
    `- reusable agents: ${asObject(pkg.components?.summary).reusable_agent_count || buildRoomComponentsFromPackage(pkg).summary.reusable_agent_count}`,
    `- memory objects: ${asArray(pkg.memory_schema.object_types).join(', ') || '-'}`,
    `- skills: ${asArray(pkg.skills).slice(0, 8).join(', ') || '-'}`,
    `- memory hierarchy: ${asArray(pkg.memory_hierarchy || pkg.memory_schema.hierarchy).slice(0, 8).join(' → ') || '-'}`,
    `- loop default: ${asObject(pkg.loop_policy).default_iterations || 'adaptive'}`,
    `- private memory copied: no`,
  ];
  if (includeExamples && asArray(pkg.examples).length) {
    lines.push('- examples:');
    for (const ex of asArray(pkg.examples).slice(0, 3)) {
      lines.push(`  - User: ${ex.user}`);
      lines.push(`    Room: ${ex.room}`);
    }
  }
  return lines.join('\n');
}

export function parseRoomPackageInput(raw = '') {
  const text = String(raw || '').trim();
  if (!text) return null;
  try {
    return sanitizeRoomPackage(JSON.parse(text));
  } catch {
    return null;
  }
}

export {
  buildRoomComponentsFromPackage,
  formatRoomComponentLibrary,
  buildDefaultRoomPackageComposition,
  formatDefaultRoomPackageComposition,
  formatDefaultRoomPackageDetail,
  formatDefaultRoomPackageList,
  getDefaultRoomPackage,
  listDefaultRoomPackages,
  recommendDefaultRoomPackages,
};
