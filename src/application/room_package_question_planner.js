function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function cleanText(value = '', { maxLen = 500, lower = false } = {}) {
  const text = String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLen);
  return lower ? text.toLowerCase() : text;
}

function slug(value = '', fallback = 'unknown') {
  return cleanText(value || fallback, { maxLen: 120, lower: true })
    .replace(/[^a-z0-9가-힣._:-]+/g, '_')
    .replace(/^_+|_+$/g, '') || fallback;
}

function uniqueStrings(values = [], { max = 16, lower = false } = {}) {
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

function hasAny(text, patterns = []) {
  return patterns.some((pattern) => pattern.test(text));
}

function countMatches(text, patterns = []) {
  return patterns.reduce((count, pattern) => count + (pattern.test(text) ? 1 : 0), 0);
}

const QUESTION_TEMPLATES = {
  schema_direction_confirmation: {
    prompt: '앞으로 이 room의 중심 구조를 “{candidate}” 기준으로 잡아둘까요?',
    field: 'schema_direction',
  },
  scope_confirmation: {
    prompt: '이 규칙은 현재 room에만 적용할까요, 아니면 관련 AI Rooms 전체 작업방식으로 볼까요?',
    field: 'scope',
  },
  permanence_confirmation: {
    prompt: '이 내용은 이번 작업에만 필요한 임시 판단인가요, 아니면 앞으로도 유지할 room 규칙으로 기록할까요?',
    field: 'permanence',
  },
  exportability_confirmation: {
    prompt: '이 내용은 다음 handoff/export package에 포함해도 될까요, 아니면 room 내부 판단 근거로만 남길까요?',
    field: 'exportability',
  },
  package_view_confirmation: {
    prompt: '다음 package는 현재 작업을 이어받는 operational view로 만들까요, 아니면 이전 결정까지 포함한 audit view로 만들까요?',
    field: 'package_view',
  },
};

function interpolatePrompt(template = '', values = {}) {
  return String(template || '').replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key) => cleanText(values[key] || '', { maxLen: 120 }));
}

const AMBIGUITY_PATTERNS = [
  /애매/i,
  /확인/i,
  /물어/i,
  /clarif/i,
  /uncertain/i,
  /ambiguous/i,
  /whether/i,
  /should\s+i/i,
  /should\s+we/i,
  /\?/,
  /할까요/i,
  /될까요/i,
  /될까/i,
  /어떻게 할/i,
];

const RESOLVED_NEGATIVE_POLICY_PATTERNS = [
  /넣지 말/i,
  /포함하지 말/i,
  /공유하지 말/i,
  /내보내지 말/i,
  /exclude/i,
  /do not include/i,
  /don['’]?t include/i,
  /internal[-_\s]?only/i,
  /내부.*남/i,
];

function classifySignals({ recentTurns = [], candidateMemoryWrites = [], roomPackage = {}, taskText = '' } = {}) {
  const pkg = asObject(roomPackage);
  const memory = asObject(pkg.memory_schema || pkg.memorySchema);
  const context = asObject(pkg.context_policy || pkg.contextPolicy);
  const text = cleanText([
    taskText,
    ...asArray(recentTurns).slice(-8).map((turn) => {
      const row = asObject(turn);
      return `${row.role || ''} ${row.text || row.content || row.message || ''}`;
    }),
    ...asArray(candidateMemoryWrites).slice(-8).map((mem) => {
      const row = asObject(mem);
      return `${row.object_type || row.objectType || ''} ${row.text || row.summary || ''} ${row.privacy_scope || row.privacyScope || ''} ${row.package_view || row.packageView || ''}`;
    }),
  ].join(' '), { maxLen: 6000, lower: true });

  const candidateRows = asArray(candidateMemoryWrites).map(asObject);
  const uncertainMemoryCount = candidateRows.filter((row) => row.requires_confirmation || row.needs_confirmation || row.uncertain || row.status === 'needs_confirmation').length;
  const riskyMemoryCount = candidateRows.filter((row) => {
    const privacy = slug(row.privacy_scope || row.privacyScope || '');
    return ['no_export', 'private', 'room_private', 'sensitive'].includes(privacy);
  }).length;

  const domain = slug(pkg.domain_label || pkg.domainLabel || pkg.domain || 'general_workbench');
  const objectTypes = uniqueStrings(memory.object_types || memory.objectTypes || [], { lower: true, max: 32 });
  const hasRoomPackage = hasAny(text, [/room package/i, /handoff/i, /export/i, /bundle/i, /zip/i, /패키지/i, /번들/i, /공유/i, /내보/i]);
  const hasPaperDirection = hasAny(text, [/paper\s*[345]/i, /논문/i, /topic/i, /토픽/i, /novelty/i, /아이디어/i, /실험/i]);
  const hasMemoryStructure = hasAny(text, [/memory schema/i, /memory structure/i, /projection/i, /room[-\s]?special/i, /기억 구조/i, /메모리 구조/i, /schema/i, /스키마/i]);
  const hasGlobalScopeRisk = hasAny(text, [/앞으로/i, /항상/i, /다음부터/i, /전체/i, /every time/i, /from now on/i, /default/i]);
  const hasPrivacyRisk = hasAny(text, [/private/i, /no[-_\s]?export/i, /secret/i, /pricing/i, /credential/i, /비공개/i, /민감/i, /공유하면 안/i]) || riskyMemoryCount > 0;
  const hasTemporaryRisk = hasAny(text, [/이번/i, /임시/i, /temporary/i, /for this run/i, /이번 실험/i, /smoke/i]);
  const hasExplicitAmbiguity = hasAny(text, AMBIGUITY_PATTERNS) || uncertainMemoryCount > 0;
  const hasResolvedNegativePolicy = hasAny(text, RESOLVED_NEGATIVE_POLICY_PATTERNS);
  const hasSchemaRecordingRequest = hasPaperDirection && hasMemoryStructure && hasAny(text, [/기록/i, /확정/i, /잡아둘/i, /중심.*기준/i, /main direction/i, /record/i, /make.*canonical/i]);
  const hasScopeAmbiguity = hasGlobalScopeRisk && (hasExplicitAmbiguity || countMatches(text, [/현재 room/i, /room에만/i, /전체/i, /global/i, /관련 ai rooms/i]) >= 2);
  const hasExportDecisionRequest = hasRoomPackage && hasPrivacyRisk && hasExplicitAmbiguity && !hasResolvedNegativePolicy;
  const hasPackageViewAmbiguity = hasRoomPackage && hasExplicitAmbiguity && countMatches(text, [/operational/i, /audit/i, /public/i, /handoff/i, /export/i, /package view/i]) >= 2;
  const hasPermanenceAmbiguity = hasExplicitAmbiguity && (hasTemporaryRisk && hasGlobalScopeRisk || hasAny(text, [/이번.*앞으로/i, /임시.*규칙/i, /temporary.*persistent/i, /persistent.*temporary/i]));

  return {
    domain,
    object_types: objectTypes,
    has_room_package: hasRoomPackage,
    has_paper_direction: hasPaperDirection,
    has_memory_structure: hasMemoryStructure,
    has_global_scope_risk: hasGlobalScopeRisk,
    has_privacy_risk: hasPrivacyRisk,
    has_temporary_risk: hasTemporaryRisk,
    has_explicit_ambiguity: hasExplicitAmbiguity,
    has_resolved_negative_policy: hasResolvedNegativePolicy,
    has_schema_recording_request: hasSchemaRecordingRequest,
    has_scope_ambiguity: hasScopeAmbiguity,
    has_export_decision_request: hasExportDecisionRequest,
    has_package_view_ambiguity: hasPackageViewAmbiguity,
    has_permanence_ambiguity: hasPermanenceAmbiguity,
    uncertain_memory_count: uncertainMemoryCount,
    risky_memory_count: riskyMemoryCount,
    context_policy: context,
  };
}

function scoreQuestionCandidates(signals = {}) {
  const candidates = [];
  const add = (type, score, reasonCodes = [], values = {}, impact = 'medium') => {
    const template = QUESTION_TEMPLATES[type];
    if (!template) return;
    candidates.push({
      question_type: type,
      score,
      reason_codes: uniqueStrings(reasonCodes, { lower: true, max: 12 }),
      question: interpolatePrompt(template.prompt, values),
      target_field: template.field,
      options: defaultOptionsForType(type),
      can_defer: true,
      interaction_style: 'inline_only_when_confirmation_needed',
      requires_user_confirmation: true,
      ambiguity_level: 'explicit',
      impact_level: impact,
    });
  };

  if (signals.has_export_decision_request) {
    add('exportability_confirmation', 0.94, ['explicit_export_ambiguity', 'sensitive_or_private_signal'], {}, 'high');
  }
  if (signals.has_schema_recording_request) {
    add('schema_direction_confirmation', 0.9, ['explicit_schema_recording_request', 'paper_direction_shift'], {
      candidate: 'room별 specialized memory structure를 footprint로 학습/추천하는 방향',
    }, 'high');
  }
  if (signals.has_scope_ambiguity) {
    add('scope_confirmation', 0.88, ['explicit_scope_ambiguity', 'future_default_language'], {}, 'high');
  }
  if (signals.has_package_view_ambiguity && !signals.has_export_decision_request) {
    add('package_view_confirmation', 0.87, ['explicit_package_view_ambiguity', 'handoff_or_export_signal'], {}, 'high');
  }
  if (signals.has_permanence_ambiguity) {
    add('permanence_confirmation', 0.86, ['explicit_permanence_ambiguity'], {}, 'medium');
  }
  return candidates.sort((a, b) => b.score - a.score);
}

function defaultOptionsForType(type = '') {
  if (type === 'scope_confirmation') return ['current_room', 'related_ai_rooms', 'global_workflow'];
  if (type === 'permanence_confirmation') return ['temporary_this_task', 'shadow_memory_candidate', 'persistent_room_rule'];
  if (type === 'exportability_confirmation') return ['include_in_handoff', 'internal_only', 'ask_each_time'];
  if (type === 'package_view_confirmation') return ['operational_view', 'audit_view', 'public_view'];
  if (type === 'schema_direction_confirmation') return ['record_as_main_direction', 'keep_as_candidate_only', 'discard'];
  return [];
}

export function planRoomPackageQuestions({
  recentTurns = [],
  candidateMemoryWrites = [],
  roomPackage = {},
  taskText = '',
  previousQuestions = [],
  maxQuestions = 1,
  minScore = 0.85,
} = {}) {
  const signals = classifySignals({ recentTurns, candidateMemoryWrites, roomPackage, taskText });
  const askedTypes = new Set(asArray(previousQuestions).map((q) => slug(asObject(q).question_type || q)).filter(Boolean));
  const candidates = scoreQuestionCandidates(signals)
    .filter((q) => q.score >= minScore)
    .filter((q) => q.requires_user_confirmation)
    .filter((q) => !askedTypes.has(slug(q.question_type)))
    .slice(0, Math.max(0, Number(maxQuestions) || 1));
  return {
    kind: 'room_package_question_plan_v1',
    should_ask: candidates.length > 0,
    policy: {
      max_questions_per_turn: Math.max(0, Number(maxQuestions) || 1),
      ask_only_when_confirmation_is_required: true,
      suppress_passive_learning_questions: true,
      user_can_ignore: true,
      no_blocking_required: true,
      default_min_score: minScore,
    },
    signals,
    suppressed_reason: candidates.length > 0 ? '' : 'no_explicit_high_impact_ambiguity',
    questions: candidates.map((question, index) => ({
      question_id: `rpq:${question.question_type}:${index + 1}`,
      ...question,
      candidate_updates: [{
        object_type: 'room_package_policy',
        field: question.target_field,
        options: question.options,
        status: 'shadow_until_user_confirms',
      }],
    })),
  };
}

export function applyRoomPackageQuestionAnswer(plan = {}, answer = {}) {
  const row = asObject(answer);
  const questions = asArray(asObject(plan).questions);
  const questionId = cleanText(row.question_id || row.questionId || '', { maxLen: 160 });
  const question = questions.find((q) => q.question_id === questionId) || questions[0] || {};
  const selected = slug(row.selected || row.selection || row.answer || '', 'unspecified');
  return {
    kind: 'room_package_elicitation_event_v1',
    question_id: question.question_id || questionId,
    question_type: question.question_type || 'unknown',
    target_field: question.target_field || '',
    selected,
    freeform_note: cleanText(row.note || row.freeform_note || '', { maxLen: 500 }),
    memory_update: {
      object_type: 'room_package_policy',
      field: question.target_field || '',
      value: selected,
      status: selected === 'unspecified' ? 'needs_review' : 'confirmed_by_user',
      source: 'conversational_room_package_elicitation',
    },
  };
}

export { classifySignals as classifyRoomPackageQuestionSignals, scoreQuestionCandidates as scoreRoomPackageQuestionCandidates };
