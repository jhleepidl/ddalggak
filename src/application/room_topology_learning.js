function asArray(value) { return Array.isArray(value) ? value : []; }
function asObject(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function cleanText(value = '', { maxLen = 1000, lower = false } = {}) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  const clipped = text.length > maxLen ? text.slice(0, maxLen) : text;
  return lower ? clipped.toLowerCase() : clipped;
}
function uniqueStrings(values = [], { max = 32, lower = false } = {}) {
  const out = []; const seen = new Set();
  for (const raw of asArray(values)) {
    const text = cleanText(raw, { maxLen: 200, lower });
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key); out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

const TOPOLOGY_CATALOG = [
  {
    id: 'sequential_handoff',
    title: 'Sequential handoff',
    best_for: ['well-specified tasks', 'small artifacts', 'low coordination risk'],
    risk: 'slow if every stage waits unnecessarily',
    graph: ['planner -> executor -> synthesizer'],
  },
  {
    id: 'reviewer_gated_pipeline',
    title: 'Reviewer-gated pipeline',
    best_for: ['code changes', 'research claims', 'artifact delivery', 'safety-sensitive decisions'],
    risk: 'review bottleneck; over-review for low-risk tasks',
    graph: ['planner -> builder -> reviewer -> verifier -> delivery'],
  },
  {
    id: 'visible_companion_council',
    title: 'Visible companion council',
    best_for: ['ambiguous preferences', 'tradeoff-heavy planning', 'user-facing decisions'],
    risk: 'can become verbose unless summarized into a room decision',
    graph: ['role companions -> council transcript -> room decision'],
  },
  {
    id: 'bounded_parallel_wccu_group',
    title: 'Bounded parallel group with witness checks',
    best_for: ['parallel research/build subtasks', 'workspace contention', 'multi-agent memory updates'],
    risk: 'requires explicit read/write witnesses and review-required handling',
    graph: ['agent A snapshot', 'agent B snapshot', 'WCCU-style verifier', 'policy lanes'],
  },
  {
    id: 'orchestrator_star',
    title: 'Orchestrator star',
    best_for: ['heterogeneous skill routing', 'many small specialists', 'tool-heavy tasks'],
    risk: 'orchestrator can become single point of failure',
    graph: ['orchestrator <-> specialist agents', 'orchestrator -> delivery'],
  },
];

function scoreTopology(topology, signals = {}) {
  let score = 0;
  const text = cleanText([signals.goal, signals.room_purpose, ...(signals.skills || []), ...(signals.memory_schema || [])].join(' '), { lower: true, maxLen: 3000 });
  if (topology.id === 'reviewer_gated_pipeline' && /code|patch|test|paper|claim|논문|코드|패치|검증|테스트/.test(text)) score += 4;
  if (topology.id === 'visible_companion_council' && /ambiguous|tradeoff|preference|선호|고민|결정|비교/.test(text)) score += 3;
  if (topology.id === 'bounded_parallel_wccu_group' && /loop|parallel|multi|agent|workspace|memory|동시|여러|메모리/.test(text)) score += 4;
  if (topology.id === 'orchestrator_star' && /skill|tool|api|search|browser|crawler|자동화|탐색/.test(text)) score += 3;
  if (topology.id === 'sequential_handoff') score += 1;
  if (signals.default_depth === 'loop' && topology.id !== 'sequential_handoff') score += 1;
  return score;
}

export function buildRoomTopologyLearningCard({ roomPackage = null, profile = null, events = [] } = {}) {
  const pkg = asObject(roomPackage);
  const prof = asObject(profile);
  const signals = {
    goal: prof.current_goal || pkg.description || '',
    room_purpose: prof.room_purpose || pkg.description || '',
    skills: pkg.skills || prof.installed_skills || [],
    memory_schema: asObject(pkg.memory_schema).object_types || asObject(prof.memory_schema).object_types || [],
    default_depth: pkg.default_depth || prof.default_depth || '',
    events_count: asArray(events).length,
  };
  const candidates = TOPOLOGY_CATALOG.map((topology) => ({ ...topology, score: scoreTopology(topology, signals) }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const primary = candidates[0] || TOPOLOGY_CATALOG[0];
  return {
    kind: 'room_topology_learning_card_v1',
    primary_topology: primary.id,
    candidates,
    learning_policy: {
      immediate_finetune: 'not recommended until trace labels are reliable',
      first_step: 'collect topology traces and outcome labels',
      model_role: 'train or tune a small router/evaluator after deterministic metrics and user feedback exist',
      durable_change_policy: 'trial mode first; durable topology changes require user or GoC approval',
    },
    dataset_schema: {
      special_tokens: ['<ROOM_INTENT>', '<PACKAGE>', '<MEMORY_GRAPH>', '<SKILL_SET>', '<TOPOLOGY>', '<WITNESS>', '<OUTCOME>', '<HUMAN_FEEDBACK>'],
      labels: ['topology_choice', 'skill_bundle_choice', 'memory_projection_quality', 'safe_commit_policy', 'user_acceptance'],
      metrics: ['task_completion', 'artifact_success', 'test_passed', 'correction_rate', 'stop_rate', 'review_required_rate', 'unsafe_claim_rate', 'latency', 'token_cost'],
    },
    guardrails: [
      'Do not let a trained router directly mutate room state.',
      'Use WCCU-style witnesses for memory, skill, topology, and package updates.',
      'Keep raw transcripts out of training exports unless explicitly approved and redacted.',
      'Evaluate candidate topology by replaying fixed traces, not by self-judgment alone.',
    ],
  };
}

export function formatRoomTopologyLearningCardForTelegram(card = {}) {
  const row = asObject(card);
  const candidates = asArray(row.candidates);
  const policy = asObject(row.learning_policy);
  const schema = asObject(row.dataset_schema);
  return [
    '🧭 Room topology learning',
    '',
    `primary candidate: ${row.primary_topology || '(none)'}`,
    '',
    'Topology candidates:',
    ...candidates.slice(0, 5).map((item) => `- ${item.id} · score=${item.score} · ${item.title}`),
    '',
    'Fine-tuning stance:',
    `- immediate fine-tune: ${policy.immediate_finetune}`,
    `- first step: ${policy.first_step}`,
    `- model role: ${policy.model_role}`,
    `- durable changes: ${policy.durable_change_policy}`,
    '',
    'Training/export schema:',
    `- special tokens: ${asArray(schema.special_tokens).join(' ')}`,
    `- labels: ${asArray(schema.labels).join(', ')}`,
    `- metrics: ${asArray(schema.metrics).join(', ')}`,
    '',
    'Guardrails:',
    ...asArray(row.guardrails).map((item) => `- ${item}`),
  ].join('\n');
}
