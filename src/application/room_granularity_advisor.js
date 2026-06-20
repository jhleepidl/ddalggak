function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function cleanText(value = '', { maxLen = 1000, lower = false } = {}) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  const clipped = text.length > maxLen ? text.slice(0, maxLen) : text;
  return lower ? clipped.toLowerCase() : clipped;
}

function clamp(value, min = 0, max = 1) {
  const n = Number.isFinite(Number(value)) ? Number(value) : 0;
  return Math.max(min, Math.min(max, n));
}

function scoreKeyword(text, patterns = []) {
  let score = 0;
  for (const [weight, re] of patterns) {
    if (re.test(text)) score += weight;
  }
  return score;
}

export function inferRoomGranularitySignals({ goal = '', profile = {}, usage = {} } = {}) {
  const text = cleanText(goal || profile.current_goal || profile.room_purpose || '', { lower: true, maxLen: 4000 });
  const memoryObjects = asArray(asObject(profile.memory_schema).object_types);
  const agents = asArray(profile.default_agents);
  const reasons = asArray(profile.reasons);
  const taskCount = Number(usage.task_count || usage.taskCount || usage.repeated_tasks || usage.repeatedTasks || 0);
  const correctionCount = Number(usage.correction_count || usage.correctionCount || 0);
  const approvalCount = Number(usage.approval_count || usage.approvalCount || 0);
  const distinctDomains = Number(usage.distinct_domains || usage.distinctDomains || 0);
  const domainsMentioned = new Set();
  const domainPatterns = [
    ['research', /(research|paper|novelty|experiment|논문|연구|실험|평가)/i],
    ['finance', /(stock|portfolio|market|holding|투자|주식|포트폴리오|시장)/i],
    ['nutrition', /(meal|food|nutrition|calorie|식사|음식|영양|칼로리)/i],
    ['writing', /(fiction|story|fanfic|character|소설|팬픽|캐릭터|줄거리)/i],
    ['code', /(code|repo|patch|build|test|deploy|코드|레포|패치|빌드|테스트|배포)/i],
  ];
  for (const [name, re] of domainPatterns) if (re.test(text) || profile.domain_label === name || reasons.some((r) => String(r).includes(name))) domainsMentioned.add(name);
  if (profile.domain_label && profile.domain_label !== 'general_workbench') domainsMentioned.add(String(profile.domain_label));

  const recurrence = clamp((taskCount / 8) + scoreKeyword(text, [
    [0.25, /(again|repeat|every|daily|weekly|whenever|always|반복|매번|매일|매주|계속|자주|항상)/i],
    [0.2, /(room|workspace|workflow|template|package|방|워크플로|템플릿|패키지)/i],
  ]));
  const domainStability = clamp((domainsMentioned.size === 1 ? 0.65 : 0.25) + (profile.domain_label && profile.domain_label !== 'general_workbench' ? 0.25 : 0) - Math.max(0, domainsMentioned.size - 1) * 0.12);
  const memorySpecificity = clamp((memoryObjects.length / 8) + scoreKeyword(text, [
    [0.2, /(memory|remember|portfolio|meal log|canon|claims|private|기억|메모리|포트폴리오|식단|캐논|설정|비공개)/i],
  ]));
  const privacySensitivity = clamp(scoreKeyword(text, [
    [0.35, /(private|sensitive|credential|health|portfolio|personal|privacy|비공개|민감|자격증명|건강|포트폴리오|개인|프라이버시)/i],
    [0.25, /(finance|medical|nutrition|stock|투자|의료|식단|주식)/i],
  ]) + (profile.context_policy?.private_memory ? 0.15 : 0));
  const crossDomainNeed = clamp((domainsMentioned.size > 1 ? 0.55 : 0) + (distinctDomains > 1 ? 0.4 : 0) + scoreKeyword(text, [
    [0.35, /(across|combine|between rooms|global|cross-room|전체|여러 방|공통|통합|연결)/i],
  ]));
  const fragmentationRisk = clamp((distinctDomains / 6) + scoreKeyword(text, [
    [0.25, /(too many rooms|fragment|duplicate|overlap|confusing|너무 많은 방|분산|중복|겹침|헷갈)/i],
  ]) + (agents.length > 8 ? 0.15 : 0));
  const coldStartRisk = clamp((taskCount <= 1 ? 0.35 : 0.05) + (!profile.kind ? 0.25 : 0) + scoreKeyword(text, [
    [0.15, /(new|first|start|처음|새로|시작)/i],
  ]));
  const userCorrectionPressure = clamp(correctionCount / 5 + approvalCount / 12);

  return {
    recurrence,
    domain_stability: domainStability,
    memory_specificity: memorySpecificity,
    privacy_sensitivity: privacySensitivity,
    cross_domain_need: crossDomainNeed,
    fragmentation_risk: fragmentationRisk,
    cold_start_risk: coldStartRisk,
    user_correction_pressure: userCorrectionPressure,
    domains: Array.from(domainsMentioned),
    task_count: taskCount,
    memory_object_count: memoryObjects.length,
    agent_count: agents.length,
  };
}

export function recommendRoomGranularity({ goal = '', profile = {}, usage = {} } = {}) {
  const s = inferRoomGranularitySignals({ goal, profile, usage });
  const generalScore = clamp(0.45 + (1 - s.recurrence) * 0.25 + s.cross_domain_need * 0.25 - s.memory_specificity * 0.12 - s.privacy_sensitivity * 0.12 - s.user_correction_pressure * 0.08);
  const specializedScore = clamp(0.25 + s.recurrence * 0.28 + s.domain_stability * 0.2 + s.memory_specificity * 0.18 + s.privacy_sensitivity * 0.12 - s.cross_domain_need * 0.12 - s.fragmentation_risk * 0.1 - s.cold_start_risk * 0.05);
  const hybridScore = clamp(0.2 + s.recurrence * 0.16 + s.cross_domain_need * 0.22 + s.memory_specificity * 0.16 + s.privacy_sensitivity * 0.14 + s.fragmentation_risk * 0.08 - s.cold_start_risk * 0.04);
  const ranked = [
    ['general_workspace', generalScore],
    ['specialized_room', specializedScore],
    ['hierarchical_hybrid', hybridScore],
  ].sort((a, b) => b[1] - a[1]);
  const [recommended, score] = ranked[0];
  const second = ranked[1];
  let action = 'keep_broad';
  if (recommended === 'specialized_room') action = profile.kind && profile.domain_label !== 'general_workbench' ? 'keep_specialized' : 'specialize_room';
  if (recommended === 'hierarchical_hybrid') action = 'use_parent_child_hierarchy';
  if (s.fragmentation_risk > 0.65 && s.cross_domain_need < 0.45) action = 'merge_or_consolidate_rooms';
  if (s.recurrence > 0.65 && s.domain_stability > 0.65 && !profile.kind) action = 'specialize_room';

  const tradeoffs = [];
  if (s.recurrence > 0.55) tradeoffs.push('Repeated work can amortize room setup and prompt specialization costs.');
  if (s.memory_specificity > 0.55) tradeoffs.push('Domain-specific memory objects are likely useful, but should remain room-scoped.');
  if (s.privacy_sensitivity > 0.45) tradeoffs.push('Private memory isolation is important; avoid one broad shared memory pool.');
  if (s.cross_domain_need > 0.45) tradeoffs.push('Cross-domain reasoning is needed; a parent/global layer may help.');
  if (s.fragmentation_risk > 0.45) tradeoffs.push('Too many rooms may create navigation, duplication, and maintenance overhead.');
  if (s.cold_start_risk > 0.45) tradeoffs.push('Specialization may be premature because the room has little usage evidence.');
  if (!tradeoffs.length) tradeoffs.push('No strong pressure detected; keep the current room structure until more traces accumulate.');

  const scenario = {
    general_workspace: 'Best for one-off, shallow, or cross-domain tasks where setup overhead should stay low.',
    specialized_room: 'Best for repeated, domain-stable, memory-sensitive work with reusable agent/team patterns.',
    hierarchical_hybrid: 'Best when global preferences and cross-room routing are useful, but private/domain memory must stay scoped.',
  }[recommended];

  return {
    kind: 'room_granularity_recommendation_v1',
    recommended,
    action,
    confidence: Number(score.toFixed(3)),
    runner_up: { approach: second[0], score: Number(second[1].toFixed(3)) },
    scores: Object.fromEntries(ranked.map(([name, value]) => [name, Number(value.toFixed(3))])),
    signals: s,
    tradeoffs,
    scenario,
  };
}

export function formatRoomGranularityRecommendation(rec = {}) {
  const row = asObject(rec);
  const lines = [
    'Room granularity advisor',
    `- recommended approach: ${row.recommended || 'general_workspace'}`,
    `- suggested action: ${row.action || 'keep_broad'}`,
    `- confidence: ${row.confidence ?? '-'}`,
  ];
  if (row.runner_up?.approach) lines.push(`- runner-up: ${row.runner_up.approach} (${row.runner_up.score})`);
  if (row.scenario) lines.push(`- scenario: ${row.scenario}`);
  lines.push('', 'Scores:');
  for (const [key, value] of Object.entries(asObject(row.scores))) lines.push(`- ${key}: ${value}`);
  lines.push('', 'Tradeoffs:');
  for (const item of asArray(row.tradeoffs)) lines.push(`- ${item}`);
  const signals = asObject(row.signals);
  lines.push('', 'Key signals:');
  for (const key of ['recurrence', 'domain_stability', 'memory_specificity', 'privacy_sensitivity', 'cross_domain_need', 'fragmentation_risk', 'cold_start_risk']) {
    if (typeof signals[key] !== 'undefined') lines.push(`- ${key}: ${signals[key]}`);
  }
  if (asArray(signals.domains).length) lines.push(`- domains: ${signals.domains.join(', ')}`);
  return lines.join('\n');
}
