import { buildDefaultAgentActivationPolicy } from './room_agent_policy.js';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function cleanText(value = '', { maxLen = 800, lower = false } = {}) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  const clipped = text.length > maxLen ? text.slice(0, maxLen) : text;
  return lower ? clipped.toLowerCase() : clipped;
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

const COMMON_AUTONOMY = {
  small_safe_changes: 'auto_with_trace',
  risky_or_large_changes: 'approval_required',
  destructive_actions: 'forbidden_without_explicit_approval',
  credential_or_external_api_binding: 'approval_required',
  cross_room_memory: 'ask_before_import',
};



export const MULTI_MODEL_ROLE_LIBRARY = [
  {
    role: 'concierge_router',
    purpose: 'Classify work depth, surface language, and room route quickly without doing heavy generation.',
    preferred_tier: 'fast_low_latency',
    fallback_tier: 'general_reasoning',
  },
  {
    role: 'source_grounder',
    purpose: 'Handle fresh, local, finance, health, or research claims that need evidence and citation discipline.',
    preferred_tier: 'search_or_retrieval_capable',
    fallback_tier: 'strong_reasoning_with_grounding_guard',
  },
  {
    role: 'code_executor',
    purpose: 'Plan and perform workspace changes through controlled tool/runtime execution.',
    preferred_tier: 'tool_capable_coding_model',
    fallback_tier: 'strong_reasoning_with_no_write_mode',
  },
  {
    role: 'verifier_critic',
    purpose: 'Review artifacts, tests, claims, safety boundaries, and continuation correctness.',
    preferred_tier: 'strong_reasoning',
    fallback_tier: 'general_reasoning',
  },
  {
    role: 'idle_structurer',
    purpose: 'Run slower background memory, docs, skill, protocol, and room-evolution structuring work.',
    preferred_tier: 'cheap_batch_or_local',
    fallback_tier: 'fast_low_latency',
  },
  {
    role: 'delivery_synthesizer',
    purpose: 'Produce concise user-facing summaries in the room language after specialist work is done.',
    preferred_tier: 'general_reasoning',
    fallback_tier: 'fast_low_latency',
  },
];

function inferModelStrategy(goal = '', { evidence = 'normal', autonomy = 'ask_or_plan', artifacts = [] } = {}) {
  const text = cleanText(goal, { lower: true, maxLen: 6000 });
  const needsCode = asArray(artifacts).includes('code_or_patch') || /(code|repo|patch|test|build|코드|레포|패치|테스트|구현)/i.test(text);
  const needsLoop = autonomy === 'bounded_loop' || /(loop|반복|루프|autonomous|iterate)/i.test(text);
  const needsGrounding = evidence === 'high' || evidence === 'medium_high';
  const roles = ['concierge_router', 'delivery_synthesizer', 'idle_structurer'];
  if (needsGrounding) roles.push('source_grounder');
  if (needsCode) roles.push('code_executor');
  if (needsLoop || needsGrounding || needsCode) roles.push('verifier_critic');
  return {
    strategy: 'room_scoped_model_portfolio',
    role_assignments: uniqueStrings(roles, { max: 12, lower: true }),
    selection_basis: ['task_phase', 'room_package', 'risk', 'evidence_requirement', 'tool_permission', 'cost_latency_budget'],
    note: 'DdalGgak is not a single-model assistant; the room can route different phases to specialized model/provider roles.',
  };
}

export function buildRoomModelPolicy(pkg = {}, { intent = null } = {}) {
  const row = asObject(pkg);
  const tags = new Set([...asArray(row.tags), row.domain_label, row.default_depth].map((v) => cleanText(v, { lower: true })));
  const text = packageSearchText(row);
  const roles = ['concierge_router', 'delivery_synthesizer', 'idle_structurer'];
  const evidenceNeeded = /(research|paper|finance|health|local|source|evidence|claim|citation|nutrition|portfolio)/i.test(text);
  const codeNeeded = /(code|repo|patch|test|build|implementation|autonomous_code_loop)/i.test(text);
  const loopNeeded = row.default_depth === 'loop' || tags.has('loop');
  if (evidenceNeeded) roles.push('source_grounder');
  if (codeNeeded) roles.push('code_executor');
  if (loopNeeded || evidenceNeeded || codeNeeded) roles.push('verifier_critic');
  for (const extra of asArray(asObject(intent).model_strategy?.role_assignments)) roles.push(extra);
  const unique = uniqueStrings(roles, { max: 12, lower: true });
  return {
    strategy: 'room_scoped_model_portfolio',
    default_assignment: unique.map((role) => {
      const found = MULTI_MODEL_ROLE_LIBRARY.find((item) => item.role === role) || { role, purpose: 'Room-specific model role.', preferred_tier: 'general_reasoning', fallback_tier: 'fast_low_latency' };
      return { ...found };
    }),
    routing_signals: ['room_intent_card', 'active_loop_phase', 'artifact_type', 'evidence_requirement', 'risk_profile', 'tool_permission', 'latency_budget', 'cost_budget'],
    governance: {
      footer_required: true,
      log_provider_and_model_per_response: true,
      single_model_fallback_allowed: true,
      provider_secret_export: 'never',
      durable_model_policy_change: 'trial_then_user_or_goc_approval',
    },
  };
}

export const DEFAULT_ROOM_PACKAGE_LIBRARY_VERSION = '2026-07-05.default-room-library.v2.multi-model';

export const DEFAULT_ROOM_PACKAGE_LIBRARY = [
  {
    package_id: 'autonomous_code_loop',
    title: 'Autonomous Code Loop Room',
    domain_label: 'code_review',
    default_depth: 'loop',
    description: 'Patch, test, review, and iterate on a software repository with a safe bounded loop and visible verification gates.',
    agents: ['implementation_planner', 'builder', 'reviewer', 'verifier', 'delivery_synthesizer'],
    skills: ['repo_orientation', 'patch_plan', 'safe_file_edit', 'test_command_runner', 'failure_triage', 'artifact_packaging'],
    memory_schema: ['repo_contract', 'test_commands', 'known_failures', 'patch_history', 'review_findings', 'deployment_constraints'],
    memory_hierarchy: ['room_profile', 'repo_contract', 'task_packet', 'plan_memory', 'execution_feedback', 'known_failures', 'artifact_register'],
    loop_policy: { default_iterations: 3, staged_iterations: 5, verify_each_iteration: true, stop_when: ['tests_pass', 'review_clean', 'user_stop', 'iteration_budget_exceeded'] },
    activation_cues: ['code', 'repo', 'repository', 'patch', 'test', 'build', 'bug', 'implementation', 'PR', '코드', '레포', '패치', '테스트', '구현', '버그'],
    examples: [
      { user: 'Patch this bug and run the tests.', room: 'Plan, edit, test, review, then summarize changed files and remaining risks.' },
      { user: 'Make this feature work end-to-end.', room: 'Use a bounded build → verify → review loop rather than a one-shot answer.' },
    ],
    tags: ['code', 'loop', 'testing', 'autonomous'],
  },
  {
    package_id: 'research_paper_factory',
    title: 'Research Paper Factory Room',
    domain_label: 'research_paper',
    default_depth: 'loop',
    description: 'Develop a research idea into related-work map, method, experiment plan, implementation tasks, and paper outline.',
    agents: ['research_scout', 'novelty_critic', 'method_designer', 'experiment_planner', 'implementation_planner', 'paper_synthesizer'],
    skills: ['related_work_mapping', 'claim_evidence_ledger', 'novelty_risk_review', 'method_decomposition', 'experiment_table_design', 'latex_outline_drafting'],
    memory_schema: ['research_claims', 'related_work', 'novelty_gaps', 'rejected_framings', 'method_decisions', 'evaluation_metrics', 'paper_outline'],
    memory_hierarchy: ['room_profile', 'research_problem', 'claim_ledger', 'related_work_map', 'method_state', 'experiment_state', 'paper_sections'],
    loop_policy: { default_iterations: 3, staged_iterations: 5, verify_each_iteration: true, stop_when: ['claim_stabilized', 'experiment_plan_ready', 'user_stop'] },
    activation_cues: ['paper', 'research', 'paper writing', 'draft', 'SIGIR', 'novelty', 'methodology', 'experiment', '논문', '논문 작성', '작성', '연구', '노벨티', '방법론', '실험', '평가'],
    examples: [
      { user: 'Turn this rough idea into a paper plan.', room: 'Separate claim, related work gap, method, evaluation, and risky assumptions.' },
      { user: 'Find a less crowded framing.', room: 'Use novelty critic before writing or coding.' },
    ],
    tags: ['research', 'paper', 'experiments', 'loop'],
  },
  {
    package_id: 'literature_review_lab',
    title: 'Literature Review Lab',
    domain_label: 'research_paper',
    default_depth: 'team',
    description: 'Build a grounded related-work map from papers, datasets, methods, and claims without overclaiming novelty.',
    agents: ['paper_finder', 'taxonomy_builder', 'claim_checker', 'gap_synthesizer'],
    skills: ['paper_search_plan', 'citation_matrix', 'taxonomy_extraction', 'evidence_grading', 'gap_summary'],
    memory_schema: ['papers', 'claim_matrix', 'method_taxonomy', 'datasets', 'open_questions', 'novelty_risks'],
    memory_hierarchy: ['query_plan', 'paper_queue', 'paper_cards', 'claim_matrix', 'taxonomy', 'gap_report'],
    loop_policy: { default_iterations: 2, staged_iterations: 4, verify_each_iteration: true, stop_when: ['coverage_sufficient', 'user_stop'] },
    activation_cues: ['related work', 'literature', 'survey', 'papers', 'citation', '관련 연구', '서베이', '논문 조사', '레퍼런스'],
    examples: [{ user: 'Map related work for this topic.', room: 'Produce a claim matrix and what remains unverified.' }],
    tags: ['literature', 'research', 'evidence'],
  },
  {
    package_id: 'experiment_bench_builder',
    title: 'Experiment Bench Builder Room',
    domain_label: 'research_paper',
    default_depth: 'loop',
    description: 'Convert a research method into reproducible benchmarks, baselines, metrics, scripts, and result tables.',
    agents: ['benchmark_designer', 'dataset_builder', 'baseline_builder', 'experiment_runner', 'result_reviewer'],
    skills: ['synthetic_task_generation', 'baseline_matrix', 'metric_contract', 'reproducibility_checklist', 'result_table_writer'],
    memory_schema: ['benchmark_specs', 'baselines', 'metrics', 'run_manifests', 'failure_cases', 'result_tables'],
    memory_hierarchy: ['method_claim', 'benchmark_specs', 'baseline_contracts', 'run_log', 'result_tables', 'diagnostics'],
    loop_policy: { default_iterations: 3, staged_iterations: 5, verify_each_iteration: true, stop_when: ['baseline_results_exist', 'diagnostics_written', 'user_stop'] },
    activation_cues: ['benchmark', 'baseline', 'metric', 'evaluation', 'experiment code', '평가', '벤치마크', '베이스라인', '실험 코드'],
    examples: [{ user: 'Implement the first eval harness.', room: 'Generate benchmark specs first, then code, run, and review outputs.' }],
    tags: ['experiment', 'benchmark', 'reproducible'],
  },
  {
    package_id: 'telegram_product_room',
    title: 'Telegram Product Room',
    domain_label: 'product_ops',
    default_depth: 'team',
    description: 'Evolve a Telegram-based AI product through UX observation, issue triage, copy changes, and small feature patches.',
    agents: ['ux_observer', 'product_planner', 'implementation_planner', 'bug_triager', 'release_synthesizer'],
    skills: ['telegram_transcript_review', 'user_journey_mapping', 'command_surface_simplification', 'bug_repro', 'release_notes'],
    memory_schema: ['room_use_cases', 'ux_pain_points', 'command_confusions', 'bug_reports', 'release_decisions', 'demo_scripts'],
    memory_hierarchy: ['room_profile', 'transcript_observations', 'pain_points', 'patch_queue', 'release_notes'],
    loop_policy: { default_iterations: 2, staged_iterations: 4, verify_each_iteration: true, stop_when: ['patch_validated', 'demo_ready', 'user_stop'] },
    activation_cues: ['telegram', 'bot', 'UX', 'command', '사용성', '명령어', '텔레그램', '데모', '제품'],
    examples: [{ user: 'Make this Telegram flow less confusing.', room: 'Inspect transcript, identify friction, patch command copy, test focused paths.' }],
    tags: ['telegram', 'product', 'ux', 'loop'],
  },
  {
    package_id: 'meeting_prep_council',
    title: 'Meeting Prep Council Room',
    domain_label: 'meeting_prep',
    default_depth: 'team',
    description: 'Prepare recurring meetings by combining recent context, open decisions, risks, and next actions.',
    agents: ['context_curator', 'agenda_builder', 'critic', 'action_synthesizer'],
    skills: ['recent_context_digest', 'agenda_template', 'risk_list', 'decision_log_update', 'followup_email_draft'],
    memory_schema: ['meeting_series', 'stakeholder_feedback', 'agenda_items', 'open_questions', 'action_items', 'decisions'],
    memory_hierarchy: ['meeting_profile', 'recent_feedback', 'agenda', 'decision_log', 'action_items'],
    loop_policy: { default_iterations: 2, staged_iterations: 3, verify_each_iteration: true, stop_when: ['agenda_ready', 'action_items_clear'] },
    activation_cues: ['meeting', 'agenda', 'professor', 'sync', '회의', '미팅', '교수님', '면담', '월요일'],
    examples: [{ user: 'Prepare for Monday meeting.', room: 'Summarize feedback, risky claims, demo status, and next decisions.' }],
    tags: ['meeting', 'agenda', 'council'],
  },
  {
    package_id: 'personal_research_assistant',
    title: 'Personal Research Assistant Room',
    domain_label: 'research_ops',
    default_depth: 'team',
    description: 'Maintain research directions, advisor feedback, implementation status, and paper/demo priorities over time.',
    agents: ['research_memory_curator', 'advisor_feedback_interpreter', 'implementation_tracker', 'novelty_critic'],
    skills: ['feedback_extraction', 'direction_comparison', 'research_decision_log', 'demo_plan_synthesis'],
    memory_schema: ['advisor_feedback', 'research_directions', 'discarded_topics', 'implementation_status', 'paper_deadlines', 'demo_assets'],
    memory_hierarchy: ['advisor_feedback', 'current_direction', 'discarded_topics', 'implementation_state', 'next_meeting_packet'],
    loop_policy: { default_iterations: 2, staged_iterations: 4, verify_each_iteration: true, stop_when: ['decision_packet_ready', 'user_stop'] },
    activation_cues: ['advisor', 'paper direction', 'research plan', '교수님', '논문 방향', '연구 방향', '피드백'],
    examples: [{ user: 'Use the professor feedback to decide what to do next.', room: 'Separate feedback, constraints, options, and recommendation.' }],
    tags: ['research_ops', 'memory', 'feedback'],
  },
  {
    package_id: 'finance_research_guarded',
    title: 'Guarded Finance Research Room',
    domain_label: 'portfolio_research',
    default_depth: 'team',
    description: 'Research markets and portfolio questions with evidence-first summaries and explicit non-trading boundaries.',
    agents: ['market_researcher', 'portfolio_context_curator', 'risk_reviewer', 'thesis_synthesizer'],
    skills: ['market_brief', 'source_freshness_check', 'risk_counterargument', 'thesis_update', 'watchlist_maintenance'],
    memory_schema: ['watchlist', 'holdings_context', 'risk_tolerance', 'investment_theses', 'rejected_assumptions', 'source_quality_notes'],
    memory_hierarchy: ['risk_boundary', 'watchlist', 'market_evidence', 'thesis_log', 'decision_notes'],
    loop_policy: { default_iterations: 2, staged_iterations: 3, verify_each_iteration: true, stop_when: ['risk_review_complete', 'user_stop'] },
    activation_cues: ['stock', 'portfolio', 'market', 'risk', '주식', '포트폴리오', '투자', '시장', '종목'],
    examples: [{ user: 'What should I watch next week?', room: 'Give research-only watchlist framing, never execute or imply certainty.' }],
    tags: ['finance', 'risk', 'evidence'],
  },
  {
    package_id: 'local_recommendation_room',
    title: 'Local Recommendation Room',
    domain_label: 'local_recommendation',
    default_depth: 'ask',
    description: 'Recommend restaurants, places, services, or lessons while tracking user preferences and freshness limits.',
    agents: ['preference_curator', 'local_search_scout', 'option_ranker', 'uncertainty_reviewer'],
    skills: ['preference_extraction', 'location_constraint_handling', 'source_needed_notice', 'option_comparison', 'followup_question_minimization'],
    memory_schema: ['home_area', 'preferred_areas', 'excluded_categories', 'favorite_styles', 'visited_places', 'freshness_needs'],
    memory_hierarchy: ['location_boundary', 'preference_memory', 'candidate_options', 'freshness_warning', 'decision_reason'],
    loop_policy: { default_iterations: 1, staged_iterations: 2, verify_each_iteration: false, stop_when: ['options_sufficient'] },
    activation_cues: ['near', 'restaurant', 'lesson', 'place', 'recommend', '근처', '맛집', '학원', '추천', '동네', '서울대입구'],
    examples: [{ user: 'Recommend a place near here.', room: 'Use stored preferences, but mark anything current as needing source confirmation.' }],
    tags: ['local', 'recommendation', 'preferences'],
  },
  {
    package_id: 'nutrition_meal_tracker',
    title: 'Nutrition & Meal Tracker Room',
    domain_label: 'nutrition_tracker',
    default_depth: 'ask',
    description: 'Estimate meals, remember preferences with approval, and propose practical next meals without medical overclaiming.',
    agents: ['food_image_interpreter', 'nutrition_estimator', 'meal_history_tracker', 'next_meal_planner'],
    skills: ['meal_log_extraction', 'calorie_uncertainty_range', 'macro_balance_check', 'dietary_exclusion_memory', 'next_meal_suggestion'],
    memory_schema: ['meal_log', 'estimated_calories', 'macros', 'diet_preferences', 'allergies', 'restrictions', 'weekly_patterns'],
    memory_hierarchy: ['health_safety_boundary', 'today_meals', 'preferences', 'restrictions', 'weekly_pattern'],
    loop_policy: { default_iterations: 1, staged_iterations: 2, verify_each_iteration: false, stop_when: ['meal_advice_given'] },
    activation_cues: ['meal', 'food', 'nutrition', 'calorie', 'protein', 'diet', '식사', '음식', '영양', '칼로리', '단백질', '식단'],
    examples: [{ user: 'I only ate an apple and nuts today.', room: 'Estimate deficiency, suggest next meal, ask before saving health memory.' }],
    tags: ['nutrition', 'meal', 'health_boundary'],
  },
  {
    package_id: 'music_learning_room',
    title: 'Music Learning Room',
    domain_label: 'music_learning',
    default_depth: 'team',
    description: 'Help choose instruments, practice plans, lesson options, and taste-aware learning paths.',
    agents: ['taste_curator', 'instrument_advisor', 'practice_planner', 'local_lesson_scout'],
    skills: ['taste_profile_extraction', 'instrument_tradeoff', 'practice_schedule', 'lesson_option_checklist', 'playlist_to_skill_map'],
    memory_schema: ['favorite_artists', 'instrument_interests', 'practice_constraints', 'lesson_locations', 'gear_budget', 'progress_notes'],
    memory_hierarchy: ['taste_profile', 'learning_goal', 'practice_constraints', 'lesson_candidates', 'progress_log'],
    loop_policy: { default_iterations: 2, staged_iterations: 3, verify_each_iteration: false, stop_when: ['learning_plan_ready'] },
    activation_cues: ['music', 'guitar', 'bass', 'band', 'lesson', '음악', '기타', '베이스', '밴드', '학원', '연습'],
    examples: [{ user: 'Should I learn bass or guitar?', room: 'Use taste profile and practice constraints, then suggest first month plan.' }],
    tags: ['music', 'learning', 'local'],
  },
  {
    package_id: 'writing_workshop_loop',
    title: 'Writing Workshop Loop Room',
    domain_label: 'creative_writing',
    default_depth: 'loop',
    description: 'Draft, critique, revise, and maintain continuity for creative or long-form writing.',
    agents: ['plot_planner', 'draft_writer', 'continuity_reviewer', 'style_editor', 'reader_advocate'],
    skills: ['outline_to_scene', 'continuity_bible', 'voice_matching', 'revision_pass', 'reader_feedback_synthesis'],
    memory_schema: ['canon_facts', 'characters', 'plot_threads', 'style_rules', 'revision_history', 'discarded_versions'],
    memory_hierarchy: ['story_bible', 'current_scene_goal', 'draft', 'continuity_findings', 'revision_log'],
    loop_policy: { default_iterations: 3, staged_iterations: 5, verify_each_iteration: true, stop_when: ['scene_ready', 'user_stop'] },
    activation_cues: ['story', 'novel', 'scene', 'chapter', 'character', '소설', '글쓰기', '장면', '챕터', '캐릭터', '대사'],
    examples: [{ user: 'Write this scene and make it less flat.', room: 'Draft, review continuity/style, revise once, then summarize options.' }],
    tags: ['writing', 'creative', 'loop'],
  },
  {
    package_id: 'data_analysis_lab',
    title: 'Data Analysis Lab',
    domain_label: 'data_analysis',
    default_depth: 'team',
    description: 'Turn files or tables into validated analysis, charts, caveats, and reproducible notes.',
    agents: ['data_profiler', 'analysis_planner', 'stat_reviewer', 'chart_synthesizer'],
    skills: ['schema_profile', 'missingness_check', 'analysis_notebook_plan', 'chart_selection', 'interpretation_guardrails'],
    memory_schema: ['datasets', 'schema_notes', 'cleaning_decisions', 'analysis_questions', 'chart_specs', 'caveats'],
    memory_hierarchy: ['dataset_contract', 'schema_profile', 'analysis_plan', 'results', 'caveats'],
    loop_policy: { default_iterations: 2, staged_iterations: 4, verify_each_iteration: true, stop_when: ['analysis_answered', 'user_stop'] },
    activation_cues: ['data', 'csv', 'spreadsheet', 'chart', 'analysis', '데이터', '분석', '표', '차트', '그래프'],
    examples: [{ user: 'Analyze this CSV.', room: 'Profile schema first, then analyze, then state caveats.' }],
    tags: ['data', 'analysis', 'charts'],
  },
  {
    package_id: 'email_inbox_triage',
    title: 'Email Inbox Triage Room',
    domain_label: 'personal_ops',
    default_depth: 'team',
    description: 'Summarize, prioritize, draft, and follow up on email without sending unless explicitly approved.',
    agents: ['inbox_summarizer', 'priority_classifier', 'reply_drafter', 'followup_tracker'],
    skills: ['thread_summary', 'action_item_extraction', 'reply_template', 'tone_adjustment', 'send_approval_gate'],
    memory_schema: ['contacts', 'recurring_threads', 'response_preferences', 'open_followups', 'decision_deadlines'],
    memory_hierarchy: ['account_boundary', 'thread_cards', 'priority_queue', 'drafts', 'followups'],
    loop_policy: { default_iterations: 2, staged_iterations: 3, verify_each_iteration: true, stop_when: ['drafts_ready', 'user_stop'] },
    activation_cues: ['email', 'inbox', 'reply', 'follow up', '메일', '이메일', '답장', '팔로업'],
    examples: [{ user: 'Summarize urgent emails and draft replies.', room: 'Draft only; ask before sending.' }],
    tags: ['email', 'inbox', 'approval'],
  },
  {
    package_id: 'calendar_task_planner',
    title: 'Calendar & Task Planner Room',
    domain_label: 'personal_ops',
    default_depth: 'team',
    description: 'Coordinate calendar context, task backlog, reminders, and weekly planning with approval boundaries.',
    agents: ['schedule_curator', 'task_prioritizer', 'energy_planner', 'reminder_synthesizer'],
    skills: ['calendar_digest', 'task_breakdown', 'time_blocking', 'deadline_risk', 'reminder_proposal'],
    memory_schema: ['recurring_events', 'task_backlog', 'deadlines', 'energy_patterns', 'planning_preferences'],
    memory_hierarchy: ['calendar_boundary', 'today_plan', 'backlog', 'deadline_risks', 'rituals'],
    loop_policy: { default_iterations: 2, staged_iterations: 3, verify_each_iteration: false, stop_when: ['plan_ready'] },
    activation_cues: ['calendar', 'schedule', 'todo', 'task', 'deadline', '일정', '할일', '계획', '마감'],
    examples: [{ user: 'Plan my week.', room: 'Use deadlines and recurring commitments; propose changes before scheduling.' }],
    tags: ['calendar', 'tasks', 'planning'],
  },
  {
    package_id: 'travel_planning_room',
    title: 'Travel Planning Room',
    domain_label: 'travel_planning',
    default_depth: 'team',
    description: 'Plan trips with constraints, itinerary options, booking boundaries, and local uncertainty checks.',
    agents: ['destination_researcher', 'itinerary_builder', 'budget_reviewer', 'logistics_checker'],
    skills: ['constraint_collection', 'itinerary_matrix', 'budget_estimation', 'freshness_warning', 'packing_checklist'],
    memory_schema: ['traveler_preferences', 'destinations', 'budget_limits', 'itinerary_versions', 'booking_constraints'],
    memory_hierarchy: ['trip_profile', 'constraints', 'candidate_itineraries', 'logistics_risks', 'final_plan'],
    loop_policy: { default_iterations: 2, staged_iterations: 4, verify_each_iteration: true, stop_when: ['itinerary_ready'] },
    activation_cues: ['travel', 'trip', 'hotel', 'flight', 'itinerary', '여행', '숙소', '항공', '일정', '코스'],
    examples: [{ user: 'Plan a 3-day trip.', room: 'Ask only missing constraints, propose itinerary variants, flag current info needs.' }],
    tags: ['travel', 'planning'],
  },
  {
    package_id: 'shopping_decision_room',
    title: 'Shopping Decision Room',
    domain_label: 'shopping_research',
    default_depth: 'team',
    description: 'Compare products using requirements, tradeoffs, freshness limits, and post-purchase notes.',
    agents: ['requirements_curator', 'product_researcher', 'tradeoff_reviewer', 'decision_synthesizer'],
    skills: ['requirements_matrix', 'spec_comparison', 'review_quality_check', 'price_freshness_notice', 'shortlist_builder'],
    memory_schema: ['product_requirements', 'budget', 'rejected_options', 'owned_items', 'decision_rationale'],
    memory_hierarchy: ['requirements', 'candidate_products', 'tradeoff_matrix', 'decision_log'],
    loop_policy: { default_iterations: 2, staged_iterations: 3, verify_each_iteration: true, stop_when: ['shortlist_ready'] },
    activation_cues: ['buy', 'purchase', 'compare', 'product', 'shopping', '구매', '비교', '제품', '추천'],
    examples: [{ user: 'Which laptop should I buy?', room: 'Clarify requirements, compare options, and flag price/currentness.' }],
    tags: ['shopping', 'decision'],
  },
  {
    package_id: 'learning_tutor_room',
    title: 'Learning Tutor Room',
    domain_label: 'learning_tutor',
    default_depth: 'team',
    description: 'Teach a subject through diagnosis, examples, practice, feedback, and spaced review notes.',
    agents: ['diagnostic_tutor', 'concept_explainer', 'practice_generator', 'feedback_coach'],
    skills: ['skill_gap_diagnosis', 'worked_examples', 'practice_set', 'rubric_feedback', 'spaced_review_plan'],
    memory_schema: ['learning_goals', 'known_gaps', 'practice_history', 'mistake_patterns', 'review_schedule'],
    memory_hierarchy: ['learning_profile', 'current_concept', 'worked_example', 'practice_attempts', 'mistake_log'],
    loop_policy: { default_iterations: 2, staged_iterations: 4, verify_each_iteration: false, stop_when: ['practice_feedback_given'] },
    activation_cues: ['learn', 'study', 'teach', 'practice', 'explain', '공부', '배우', '설명', '연습', '문제'],
    examples: [{ user: 'Teach me this concept.', room: 'Diagnose level, explain, give practice, then update mistake patterns as proposal.' }],
    tags: ['learning', 'tutor'],
  },
  {
    package_id: 'job_search_room',
    title: 'Job Search Room',
    domain_label: 'career_ops',
    default_depth: 'team',
    description: 'Manage job search materials, role fit, applications, interview prep, and follow-up rituals.',
    agents: ['role_scout', 'resume_tailor', 'cover_letter_drafter', 'interview_coach', 'application_tracker'],
    skills: ['role_requirements_extract', 'resume_mapping', 'cover_letter_outline', 'interview_question_bank', 'application_status_log'],
    memory_schema: ['target_roles', 'resume_versions', 'application_status', 'interview_notes', 'networking_contacts'],
    memory_hierarchy: ['career_profile', 'target_roles', 'materials', 'application_tracker', 'interview_prep'],
    loop_policy: { default_iterations: 2, staged_iterations: 4, verify_each_iteration: true, stop_when: ['application_packet_ready'] },
    activation_cues: ['job', 'resume', 'CV', 'interview', 'career', '취업', '이력서', '면접', '커리어'],
    examples: [{ user: 'Tailor my resume for this role.', room: 'Map requirements to evidence; draft but do not invent experience.' }],
    tags: ['career', 'job'],
  },
  {
    package_id: 'customer_support_triage',
    title: 'Customer Support Triage Room',
    domain_label: 'support_ops',
    default_depth: 'team',
    description: 'Classify incoming support issues, draft replies, detect escalations, and maintain a knowledge base proposal queue.',
    agents: ['ticket_classifier', 'knowledge_base_retriever', 'reply_drafter', 'escalation_reviewer'],
    skills: ['ticket_summary', 'severity_triage', 'kb_match', 'reply_draft', 'escalation_protocol'],
    memory_schema: ['known_issues', 'answer_templates', 'escalation_rules', 'customer_segments', 'resolved_patterns'],
    memory_hierarchy: ['support_policy', 'ticket_queue', 'kb_candidates', 'drafts', 'escalations'],
    loop_policy: { default_iterations: 2, staged_iterations: 4, verify_each_iteration: true, stop_when: ['reply_drafts_ready'] },
    activation_cues: ['support', 'ticket', 'customer', 'complaint', 'CS', '고객', '문의', '티켓', '지원'],
    examples: [{ user: 'Triage these support messages.', room: 'Summarize, classify severity, draft replies, and propose KB updates.' }],
    tags: ['support', 'triage'],
  },
  {
    package_id: 'content_calendar_room',
    title: 'Content Calendar Room',
    domain_label: 'content_ops',
    default_depth: 'team',
    description: 'Plan, draft, repurpose, and review content across channels while preserving brand and approval boundaries.',
    agents: ['audience_researcher', 'content_planner', 'draft_writer', 'brand_reviewer', 'publishing_coordinator'],
    skills: ['content_calendar', 'audience_angle', 'brand_voice_check', 'repurposing_matrix', 'publish_approval_gate'],
    memory_schema: ['brand_voice', 'content_pillars', 'calendar', 'published_posts', 'performance_notes'],
    memory_hierarchy: ['brand_contract', 'content_pillars', 'calendar', 'drafts', 'performance_notes'],
    loop_policy: { default_iterations: 2, staged_iterations: 4, verify_each_iteration: true, stop_when: ['content_batch_ready'] },
    activation_cues: ['content', 'blog', 'post', 'newsletter', 'social', '콘텐츠', '블로그', '포스트', '뉴스레터'],
    examples: [{ user: 'Make a content plan for this week.', room: 'Plan angles, draft snippets, review voice, and request publish approval.' }],
    tags: ['content', 'marketing'],
  },
  {
    package_id: 'ops_runbook_room',
    title: 'Ops Runbook Room',
    domain_label: 'ops_runbook',
    default_depth: 'loop',
    description: 'Diagnose recurring operational issues, update runbooks, and keep incidents separated from long-term policy.',
    agents: ['incident_summarizer', 'diagnosis_planner', 'runbook_editor', 'postmortem_reviewer'],
    skills: ['incident_timeline', 'root_cause_hypothesis', 'runbook_patch', 'postmortem_template', 'rollback_checklist'],
    memory_schema: ['incidents', 'runbooks', 'known_failure_modes', 'rollback_steps', 'postmortems'],
    memory_hierarchy: ['incident_packet', 'runbook', 'diagnosis_log', 'patch_queue', 'postmortem'],
    loop_policy: { default_iterations: 3, staged_iterations: 5, verify_each_iteration: true, stop_when: ['runbook_updated', 'user_stop'] },
    activation_cues: ['incident', 'runbook', 'ops', 'outage', 'rollback', '장애', '운영', '런북', '복구'],
    examples: [{ user: 'Help me diagnose this incident.', room: 'Build timeline, propose hypotheses, update runbook only after approval.' }],
    tags: ['ops', 'runbook', 'loop'],
  },
  {
    package_id: 'legal_policy_review_room',
    title: 'Policy & Contract Review Room',
    domain_label: 'policy_review',
    default_depth: 'team',
    description: 'Review policy or contract text for issues, obligations, ambiguity, and questions for a qualified expert.',
    agents: ['document_summarizer', 'obligation_extractor', 'risk_reviewer', 'question_preparer'],
    skills: ['clause_summary', 'obligation_table', 'ambiguity_detection', 'risk_question_list', 'non_legal_advice_boundary'],
    memory_schema: ['document_versions', 'obligations', 'open_questions', 'risk_flags', 'expert_feedback'],
    memory_hierarchy: ['document_boundary', 'clause_map', 'obligations', 'risk_flags', 'expert_questions'],
    loop_policy: { default_iterations: 2, staged_iterations: 3, verify_each_iteration: true, stop_when: ['review_packet_ready'] },
    activation_cues: ['contract', 'policy', 'terms', 'legal', '계약', '정책', '약관', '법률'],
    examples: [{ user: 'Review this contract.', room: 'Summarize obligations and questions; do not present as legal advice.' }],
    tags: ['policy', 'review', 'risk'],
  },
  {
    package_id: 'health_note_organizer',
    title: 'Health Note Organizer Room',
    domain_label: 'health_notes',
    default_depth: 'team',
    description: 'Organize personal health notes, symptoms, appointments, and questions for clinicians without diagnosis claims.',
    agents: ['symptom_note_curator', 'timeline_builder', 'question_preparer', 'safety_boundary_reviewer'],
    skills: ['symptom_timeline', 'medication_note_summary', 'appointment_prep', 'red_flag_notice', 'medical_advice_boundary'],
    memory_schema: ['symptom_notes', 'appointments', 'questions_for_clinician', 'medication_notes', 'clinician_feedback'],
    memory_hierarchy: ['medical_safety_boundary', 'symptom_timeline', 'appointment_packet', 'questions', 'followup_notes'],
    loop_policy: { default_iterations: 1, staged_iterations: 2, verify_each_iteration: true, stop_when: ['appointment_packet_ready'] },
    activation_cues: ['health', 'symptom', 'doctor', 'medical', '건강', '증상', '병원', '의사', '진료'],
    examples: [{ user: 'Prepare notes for my appointment.', room: 'Organize timeline and questions; avoid diagnosis.' }],
    tags: ['health', 'notes', 'safety'],
  },
  {
    package_id: 'home_admin_room',
    title: 'Home Admin Room',
    domain_label: 'home_admin',
    default_depth: 'team',
    description: 'Track household errands, purchases, repairs, documents, and recurring chores.',
    agents: ['errand_planner', 'document_curator', 'repair_triager', 'reminder_synthesizer'],
    skills: ['errand_batching', 'document_checklist', 'repair_issue_summary', 'recurring_chore_plan', 'approval_before_purchase'],
    memory_schema: ['household_tasks', 'documents', 'recurring_chores', 'vendor_contacts', 'purchase_constraints'],
    memory_hierarchy: ['household_profile', 'task_queue', 'documents', 'vendor_notes', 'reminders'],
    loop_policy: { default_iterations: 2, staged_iterations: 3, verify_each_iteration: false, stop_when: ['task_plan_ready'] },
    activation_cues: ['home', 'errand', 'repair', 'document', '집', '가사', '수리', '서류', '심부름'],
    examples: [{ user: 'Help me organize household tasks.', room: 'Batch errands, track documents, and propose reminders.' }],
    tags: ['home', 'admin'],
  },
  {
    package_id: 'social_memory_room',
    title: 'Social Memory Room',
    domain_label: 'personal_ops',
    default_depth: 'ask',
    description: 'Remember relationship context, gift ideas, conversation notes, and follow-ups with strict privacy boundaries.',
    agents: ['relationship_context_curator', 'gift_idea_scout', 'followup_planner', 'privacy_reviewer'],
    skills: ['contact_context_card', 'gift_preference_log', 'followup_prompt', 'privacy_boundary_check'],
    memory_schema: ['people', 'relationship_notes', 'gift_ideas', 'followup_items', 'privacy_boundaries'],
    memory_hierarchy: ['privacy_boundary', 'person_cards', 'events', 'gift_ideas', 'followups'],
    loop_policy: { default_iterations: 1, staged_iterations: 2, verify_each_iteration: false, stop_when: ['suggestion_ready'] },
    activation_cues: ['friend', 'family', 'gift', 'relationship', '친구', '가족', '선물', '연락', '관계'],
    examples: [{ user: 'Help me remember what to get them.', room: 'Use approved relationship notes; propose memory updates for approval.' }],
    tags: ['social', 'memory', 'privacy'],
  },
  {
    package_id: 'autonomous_research_crawler_safe',
    title: 'Safe Autonomous Research Crawler Room',
    domain_label: 'research_ops',
    default_depth: 'loop',
    description: 'Run bounded web/source research loops with source ledger, uncertainty notes, and stop conditions.',
    agents: ['query_planner', 'source_scout', 'evidence_extractor', 'contradiction_checker', 'brief_synthesizer'],
    skills: ['query_decomposition', 'source_ledger', 'evidence_card', 'contradiction_scan', 'freshness_summary'],
    memory_schema: ['search_queries', 'source_cards', 'evidence_cards', 'contradictions', 'open_questions'],
    memory_hierarchy: ['research_question', 'query_plan', 'source_ledger', 'evidence_cards', 'brief'],
    loop_policy: { default_iterations: 3, staged_iterations: 6, verify_each_iteration: true, stop_when: ['evidence_coverage_met', 'source_budget_exceeded', 'user_stop'] },
    activation_cues: ['find sources', 'web research', 'evidence', 'crawler', '조사', '검색', '근거', '출처', '리서치'],
    examples: [{ user: 'Research this topic thoroughly.', room: 'Plan queries, build source ledger, extract claims, summarize uncertainty.' }],
    tags: ['research', 'web', 'autonomous', 'evidence'],
  },
];



function includesAny(text = '', values = []) {
  const lower = cleanText(text, { lower: true, maxLen: 6000 });
  return asArray(values).some((value) => {
    const key = cleanText(value, { lower: true, maxLen: 80 });
    return key && lower.includes(key);
  });
}

function packageSearchText(pkg = {}) {
  const memorySchema = asObject(pkg.memory_schema);
  return cleanText([
    pkg.package_id,
    pkg.title,
    pkg.description,
    pkg.domain_label,
    ...asArray(pkg.tags),
    ...asArray(pkg.activation_cues),
    ...asArray(pkg.agents),
    ...asArray(pkg.skills),
    ...asArray(pkg.memory_schema),
    ...asArray(memorySchema.object_types || memorySchema.objectTypes),
    ...asArray(memorySchema.hierarchy),
    ...asArray(pkg.memory_hierarchy),
  ].join(' '), { lower: true, maxLen: 6000 });
}

function overlapCount(left = [], right = []) {
  const r = new Set(asArray(right).map((v) => cleanText(v, { lower: true, maxLen: 120 })).filter(Boolean));
  let count = 0;
  for (const value of asArray(left)) {
    const key = cleanText(value, { lower: true, maxLen: 120 });
    if (key && r.has(key)) count += 1;
  }
  return count;
}

function inferTaskHorizon(goal = '') {
  const text = cleanText(goal, { lower: true, maxLen: 6000 });
  if (/(loop|iterate|autonomous|continue|long[-\s]?horizon|multi[-\s]?step|반복|루프|계속|장기|여러\s*단계|며칠|몇\s*주)/i.test(text)) return 'long_horizon';
  if (/(project|room|manage|track|프로젝트|방|관리|추적|기록)/i.test(text)) return 'recurring_room';
  return 'single_turn_or_short_task';
}

function inferArtifactExpectation(goal = '') {
  const text = cleanText(goal, { lower: true, maxLen: 6000 });
  const out = [];
  if (/(paper|manuscript|latex|outline|abstract|논문|초안|아웃라인|원고)/i.test(text)) out.push('paper_or_document');
  if (/(code|repo|patch|test|build|implementation|코드|구현|패치|테스트|빌드)/i.test(text)) out.push('code_or_patch');
  if (/(experiment|benchmark|baseline|metric|evaluation|실험|벤치마크|베이스라인|평가)/i.test(text)) out.push('experiment_or_eval');
  if (/(slide|ppt|presentation|deck|발표|슬라이드|피피티)/i.test(text)) out.push('presentation');
  if (/(meeting|agenda|brief|교수님|미팅|회의|면담|브리핑)/i.test(text)) out.push('meeting_packet');
  if (/(meal|restaurant|food|nutrition|식사|맛집|음식|영양)/i.test(text)) out.push('recommendation_or_log');
  return out.length ? uniqueStrings(out, { max: 12, lower: true }) : ['answer_or_plan'];
}

function inferEvidenceRequirement(goal = '') {
  const text = cleanText(goal, { lower: true, maxLen: 6000 });
  if (/(latest|current|source|citation|verify|verified|search|evidence|근거|출처|최신|확인|검색|검증|실제|영업|가격|주가|종목)/i.test(text)) return 'high';
  if (/(research|paper|finance|health|legal|논문|연구|금융|주식|건강|법률)/i.test(text)) return 'medium_high';
  return 'normal';
}

function inferAutonomy(goal = '') {
  const text = cleanText(goal, { lower: true, maxLen: 6000 });
  if (/(loop|iterate|autonomous|run|execute|patch|test|build|반복|루프|돌려|실행|패치|테스트|고쳐)/i.test(text)) return 'bounded_loop';
  if (/(team|review|council|critic|검토|리뷰|상의|팀)/i.test(text)) return 'team_review';
  return 'ask_or_plan';
}

function inferRiskProfile(goal = '') {
  const text = cleanText(goal, { lower: true, maxLen: 6000 });
  const risks = [];
  if (/(stock|finance|portfolio|investment|trade|주식|투자|포트폴리오|종목)/i.test(text)) risks.push('financial_advice');
  if (/(health|medical|symptom|nutrition|diet|건강|증상|의학|영양|식단)/i.test(text)) risks.push('health_or_personal_data');
  if (/(deploy|delete|credential|secret|api key|배포|삭제|자격증명|시크릿|키)/i.test(text)) risks.push('destructive_or_sensitive_action');
  if (/(paper|research|novelty|claim|논문|연구|노벨티|주장)/i.test(text)) risks.push('research_overclaim');
  if (/(local|nearby|restaurant|academy|근처|주변|맛집|학원|영업|위치)/i.test(text)) risks.push('fresh_local_claim');
  return uniqueStrings(risks, { max: 12, lower: true });
}

export function buildRoomIntentCard(goal = '', { currentProfile = null } = {}) {
  const profile = asObject(currentProfile);
  const artifacts = inferArtifactExpectation(goal);
  const neededSkills = [];
  const neededMemory = [];
  if (artifacts.includes('paper_or_document')) {
    neededSkills.push('related_work_mapping', 'novelty_risk_review', 'latex_outline_drafting');
    neededMemory.push('research_claims', 'advisor_feedback', 'paper_outline');
  }
  if (artifacts.includes('experiment_or_eval')) {
    neededSkills.push('experiment_table_design', 'synthetic_task_generation', 'baseline_matrix');
    neededMemory.push('benchmark_specs', 'run_manifests', 'result_tables');
  }
  if (artifacts.includes('code_or_patch')) {
    neededSkills.push('repo_orientation', 'safe_file_edit', 'test_command_runner', 'failure_triage');
    neededMemory.push('repo_contract', 'known_failures', 'patch_history');
  }
  if (artifacts.includes('meeting_packet')) {
    neededSkills.push('recent_context_digest', 'agenda_template', 'risk_list');
    neededMemory.push('advisor_feedback', 'agenda_items', 'action_items');
  }
  const evidence = inferEvidenceRequirement(goal);
  if (evidence === 'high' || evidence === 'medium_high') {
    neededSkills.push('claim_evidence_ledger', 'source_ledger', 'evidence_grading');
    neededMemory.push('source_cards', 'claim_matrix', 'evidence_cards');
  }
  return {
    kind: 'room_intent_card_v1',
    goal_excerpt: cleanText(goal, { maxLen: 500 }),
    task_horizon: inferTaskHorizon(goal),
    artifact_expectation: uniqueStrings(artifacts, { max: 12, lower: true }),
    evidence_requirement: evidence,
    desired_autonomy: inferAutonomy(goal),
    risk_profile: inferRiskProfile(goal),
    model_strategy: inferModelStrategy(goal, { evidence, autonomy: inferAutonomy(goal), artifacts }),
    needed_skills: uniqueStrings(neededSkills, { max: 24, lower: true }),
    needed_memory: uniqueStrings(neededMemory, { max: 24, lower: true }),
    current_room: {
      preset_id: profile.preset_id || profile.package_id || '',
      domain_label: profile.domain_label || '',
      default_depth: profile.default_depth || '',
    },
    selection_note: 'Intent card is used for package retrieval/composition; it is not a fixed prompt route.',
  };
}

function packageFitBonus(pkg = {}, intent = {}) {
  const text = packageSearchText(pkg);
  let bonus = 0;
  const needs = [...asArray(intent.needed_skills), ...asArray(intent.needed_memory), ...asArray(intent.artifact_expectation), ...asArray(intent.risk_profile)];
  for (const need of needs) {
    const token = cleanText(need, { lower: true, maxLen: 120 }).replace(/_/g, ' ');
    if (token && text.includes(token)) bonus += 1;
  }
  if (intent.desired_autonomy === 'bounded_loop' && pkg.default_depth === 'loop') bonus += 3;
  if (intent.desired_autonomy === 'team_review' && ['team', 'loop'].includes(pkg.default_depth)) bonus += 2;
  if (intent.artifact_expectation?.includes('paper_or_document') && /(research|paper|writing|literature)/i.test(text)) bonus += 3;
  if (intent.artifact_expectation?.includes('experiment_or_eval') && /(experiment|benchmark|baseline|evaluation|metric)/i.test(text)) bonus += 3;
  if (intent.artifact_expectation?.includes('code_or_patch') && /(code|repo|patch|test|build|implementation)/i.test(text)) bonus += 2;
  if (intent.artifact_expectation?.includes('meeting_packet') && /(meeting|agenda|advisor|feedback)/i.test(text)) bonus += 2;
  if (intent.evidence_requirement !== 'normal' && /(evidence|source|claim|citation|ledger|research)/i.test(text)) bonus += 2;
  return bonus;
}

function borrowedComponentsFromPackage(pkg = {}, base = {}, intent = {}) {
  const baseSkills = new Set(asArray(base.skills).map((v) => cleanText(v, { lower: true })));
  const baseMemory = new Set(asArray(base.memory_schema).map((v) => cleanText(v, { lower: true })));
  const baseHierarchy = new Set(asArray(base.memory_hierarchy).map((v) => cleanText(v, { lower: true })));
  const neededSkills = new Set(asArray(intent.needed_skills).map((v) => cleanText(v, { lower: true })));
  const neededMemory = new Set(asArray(intent.needed_memory).map((v) => cleanText(v, { lower: true })));
  const skills = asArray(pkg.skills).filter((skill) => {
    const key = cleanText(skill, { lower: true });
    return key && !baseSkills.has(key) && (neededSkills.has(key) || skillsUsefulForIntent(key, intent));
  });
  const memory = asArray(pkg.memory_schema).filter((item) => {
    const key = cleanText(item, { lower: true });
    return key && !baseMemory.has(key) && (neededMemory.has(key) || memoryUsefulForIntent(key, intent));
  });
  const hierarchy = asArray(pkg.memory_hierarchy).filter((item) => {
    const key = cleanText(item, { lower: true });
    return key && !baseHierarchy.has(key) && (neededMemory.has(key) || memoryUsefulForIntent(key, intent));
  });
  const agents = asArray(pkg.agents).slice(0, 6);
  return {
    skills: uniqueStrings(skills.length ? skills : asArray(pkg.skills).slice(0, 3), { max: 8, lower: true }),
    memory_schema: uniqueStrings(memory.length ? memory : asArray(pkg.memory_schema).slice(0, 3), { max: 8, lower: true }),
    memory_hierarchy: uniqueStrings(hierarchy.length ? hierarchy : asArray(pkg.memory_hierarchy).slice(0, 3), { max: 8, lower: true }),
    agents: uniqueStrings(agents, { max: 3, lower: true }),
    model_roles: buildRoomModelPolicy(pkg, { intent }).default_assignment.map((item) => item.role).slice(0, 4),
  };
}

function skillsUsefulForIntent(skill = '', intent = {}) {
  const key = cleanText(skill, { lower: true });
  if (!key) return false;
  if (intent.artifact_expectation?.includes('experiment_or_eval') && /(experiment|benchmark|baseline|metric|dataset|result)/.test(key)) return true;
  if (intent.artifact_expectation?.includes('code_or_patch') && /(repo|test|patch|file|triage|runner|build)/.test(key)) return true;
  if (intent.artifact_expectation?.includes('meeting_packet') && /(agenda|feedback|recent|risk|followup|action)/.test(key)) return true;
  if (intent.evidence_requirement !== 'normal' && /(source|evidence|claim|citation|search|freshness)/.test(key)) return true;
  return false;
}

function memoryUsefulForIntent(memory = '', intent = {}) {
  const key = cleanText(memory, { lower: true });
  if (!key) return false;
  if (intent.artifact_expectation?.includes('experiment_or_eval') && /(benchmark|baseline|metric|run|result|diagnostic)/.test(key)) return true;
  if (intent.artifact_expectation?.includes('code_or_patch') && /(repo|test|failure|patch|deploy)/.test(key)) return true;
  if (intent.artifact_expectation?.includes('meeting_packet') && /(advisor|feedback|agenda|action|decision|meeting)/.test(key)) return true;
  if (intent.evidence_requirement !== 'normal' && /(source|evidence|claim|paper|contradiction)/.test(key)) return true;
  return false;
}

function reasonCodesForBorrowedPackage(pkg = {}, intent = {}) {
  const text = packageSearchText(pkg);
  const reasons = [];
  if (intent.artifact_expectation?.includes('experiment_or_eval') && /(experiment|benchmark|baseline|metric)/.test(text)) reasons.push('fills_experiment_or_eval_gap');
  if (intent.artifact_expectation?.includes('code_or_patch') && /(code|repo|patch|test|build)/.test(text)) reasons.push('fills_code_or_execution_gap');
  if (intent.artifact_expectation?.includes('meeting_packet') && /(meeting|agenda|feedback)/.test(text)) reasons.push('fills_meeting_or_feedback_gap');
  if (intent.evidence_requirement !== 'normal' && /(source|evidence|claim|research)/.test(text)) reasons.push('fills_evidence_governance_gap');
  if (intent.desired_autonomy === 'bounded_loop' && pkg.default_depth === 'loop') reasons.push('supports_bounded_loop');
  return uniqueStrings(reasons.length ? reasons : ['nearby_package_with_reusable_components'], { max: 8, lower: true });
}

export function buildDefaultRoomPackageComposition(goal = '', { limit = 6, currentProfile = null } = {}) {
  const intent = buildRoomIntentCard(goal, { currentProfile });
  const raw = recommendDefaultRoomPackages(goal, { limit: Math.max(6, limit), minScore: 1 });
  const ranked = raw
    .map((pkg) => ({ ...pkg, base_score: Number(pkg.score || 0), fit_bonus: packageFitBonus(pkg, intent) }))
    .map((pkg) => ({ ...pkg, composition_score: Number(pkg.base_score || 0) + Number(pkg.fit_bonus || 0) }))
    .sort((a, b) => b.composition_score - a.composition_score || b.base_score - a.base_score || String(a.title).localeCompare(String(b.title)));
  const base = ranked[0] || null;
  if (!base) {
    return {
      kind: 'room_package_composition_v1',
      mode: 'fallback_general_workbench',
      intent_card: intent,
      base_package: null,
      borrowed_packages: [],
      candidates: [],
      governance: defaultCompositionGovernance(),
    };
  }
  const maxBorrowed = intent.desired_autonomy === 'bounded_loop' || intent.artifact_expectation.length > 1 ? 4 : 2;
  const threshold = Math.max(3, Math.floor(Number(base.composition_score || 0) * 0.22));
  const borrowed = [];
  for (const pkg of ranked.slice(1)) {
    if (borrowed.length >= maxBorrowed) break;
    if (Number(pkg.composition_score || 0) < threshold) continue;
    const components = borrowedComponentsFromPackage(pkg, base, intent);
    const useful = components.skills.length || components.memory_schema.length || components.memory_hierarchy.length || components.agents.length;
    const reasons = reasonCodesForBorrowedPackage(pkg, intent);
    if (!useful) continue;
    if (reasons.length === 1 && reasons[0] === 'nearby_package_with_reusable_components' && Number(pkg.composition_score || 0) < Number(base.composition_score || 0) * 0.65) continue;
    borrowed.push({
      package_id: pkg.package_id,
      title: pkg.title,
      domain_label: pkg.domain_label,
      score: pkg.score,
      composition_score: pkg.composition_score,
      reason_codes: reasons,
      borrowed_components: components,
    });
  }
  return {
    kind: 'room_package_composition_v1',
    mode: borrowed.length ? 'retrieve_compose_trial' : 'nearest_base_package',
    intent_card: intent,
    base_package: {
      package_id: base.package_id,
      title: base.title,
      domain_label: base.domain_label,
      score: base.score,
      composition_score: base.composition_score,
      default_depth: base.default_depth,
      model_roles: buildRoomModelPolicy(base, { intent }).default_assignment.map((item) => item.role),
      agent_activation: buildDefaultAgentActivationPolicy(base).roster.map((item) => ({ agent: item.agent, state: item.state })),
    },
    borrowed_packages: borrowed,
    candidates: ranked.slice(0, Math.max(1, Math.min(10, Number(limit) || 6))).map((pkg) => ({
      package_id: pkg.package_id,
      title: pkg.title,
      score: pkg.score,
      fit_bonus: pkg.fit_bonus,
      composition_score: pkg.composition_score,
      default_depth: pkg.default_depth,
    })),
    governance: defaultCompositionGovernance(),
  };
}

function defaultCompositionGovernance() {
  return {
    low_risk_indexing: 'auto_with_audit_log',
    medium_risk_room_patch: 'trial_mode_then_score',
    durable_room_change: 'user_or_goc_approval_required',
    rollback: 'required_for_trial_and_durable_changes',
    improvement_metric: 'task_success_plus_user_acceptance_minus_corrections_stops_unsafe_claims_and_manual_configuration',
  };
}

export function formatDefaultRoomPackageComposition(composition = {}) {
  const row = asObject(composition);
  const intent = asObject(row.intent_card);
  const base = asObject(row.base_package);
  const lines = ['🧭 Room package selection'];
  lines.push(`- mode: ${row.mode || 'nearest_base_package'}`);
  lines.push(`- task horizon: ${intent.task_horizon || '-'}`);
  lines.push(`- artifacts: ${asArray(intent.artifact_expectation).join(', ') || '-'}`);
  lines.push(`- evidence: ${intent.evidence_requirement || 'normal'} · autonomy=${intent.desired_autonomy || 'ask_or_plan'}`);
  if (intent.model_strategy?.strategy) lines.push(`- model strategy: ${intent.model_strategy.strategy} · roles=${asArray(intent.model_strategy.role_assignments).join(', ') || '-'}`);
  if (asArray(intent.risk_profile).length) lines.push(`- risk: ${asArray(intent.risk_profile).join(', ')}`);
  if (base.package_id) lines.push(`- base package: ${base.package_id} · ${base.title} · score=${base.composition_score ?? base.score ?? '-'}`);
  if (asArray(base.agent_activation).length) lines.push(`- base agent states: ${asArray(base.agent_activation).slice(0, 8).map((item) => `${item.agent}:${item.state}`).join(', ')}`);
  const borrowed = asArray(row.borrowed_packages);
  if (borrowed.length) {
    lines.push('- borrowed components:');
    for (const item of borrowed.slice(0, 5)) {
      const components = asObject(item.borrowed_components);
      lines.push(`  - ${item.package_id} · ${asArray(item.reason_codes).join(', ') || 'component_gap_fill'}`);
      if (asArray(components.skills).length) lines.push(`    skills: ${asArray(components.skills).slice(0, 4).join(', ')}`);
      if (asArray(components.memory_schema).length) lines.push(`    memory: ${asArray(components.memory_schema).slice(0, 4).join(', ')}`);
      if (asArray(components.model_roles).length) lines.push(`    model roles: ${asArray(components.model_roles).slice(0, 4).join(', ')}`);
    }
  }
  const candidates = asArray(row.candidates).slice(0, 5);
  if (candidates.length > 1) {
    lines.push('- alternatives:');
    for (const item of candidates) lines.push(`  - ${item.package_id}: score=${item.composition_score ?? item.score}`);
  }
  lines.push('- policy: not a fixed prompt route; low-risk indexing can be automatic, durable room changes require user/GoC approval.');
  return lines.join('\n');
}

export function listDefaultRoomPackages({ limit = 100, category = '' } = {}) {
  const cat = cleanText(category, { lower: true, maxLen: 120 });
  const rows = cat
    ? DEFAULT_ROOM_PACKAGE_LIBRARY.filter((pkg) => [pkg.domain_label, ...(pkg.tags || [])].some((v) => cleanText(v, { lower: true }).includes(cat)))
    : DEFAULT_ROOM_PACKAGE_LIBRARY;
  return rows.slice(0, Math.max(1, Math.min(100, Number(limit) || 100))).map((pkg) => ({ ...pkg }));
}

export function getDefaultRoomPackage(packageId = '') {
  const id = cleanText(packageId, { lower: true, maxLen: 160 }).replace(/\s+/g, '_');
  if (!id) return null;
  const found = DEFAULT_ROOM_PACKAGE_LIBRARY.find((pkg) => cleanText(pkg.package_id, { lower: true }) === id || cleanText(pkg.title, { lower: true }).replace(/\s+/g, '_') === id);
  return found ? { ...found } : null;
}

function tokenSet(value = '') {
  const text = cleanText(value, { lower: true, maxLen: 4000 });
  const tokens = text.match(/[a-z0-9가-힣]{2,}/g) || [];
  return new Set(tokens);
}

export function scoreDefaultRoomPackage(goal = '', pkg = {}) {
  const text = cleanText(goal, { lower: true, maxLen: 4000 });
  if (!text) return 0;
  let score = 0;
  const goalTokens = tokenSet(text);
  const memorySchema = asObject(pkg.memory_schema);
  const fields = [
    pkg.title,
    pkg.description,
    pkg.domain_label,
    ...asArray(pkg.tags),
    ...asArray(pkg.activation_cues),
    ...asArray(pkg.agents),
    ...asArray(pkg.skills),
    ...asArray(pkg.memory_schema),
    ...asArray(memorySchema.object_types || memorySchema.objectTypes),
    ...asArray(memorySchema.hierarchy),
  ].join(' ');
  const pkgTokens = tokenSet(fields);
  for (const token of goalTokens) {
    if (pkgTokens.has(token)) score += 1;
  }
  for (const cue of asArray(pkg.activation_cues)) {
    const c = cleanText(cue, { lower: true, maxLen: 120 });
    if (c && text.includes(c)) score += 4;
  }
  for (const tag of asArray(pkg.tags)) {
    const t = cleanText(tag, { lower: true, maxLen: 80 });
    if (t && text.includes(t)) score += 2;
  }
  if (pkg.default_depth === 'loop' && /(loop|iterate|improve|autonomous|반복|루프|개선|계속)/i.test(text)) score += 3;
  return score;
}

export function recommendDefaultRoomPackages(goal = '', { limit = 5, minScore = 1 } = {}) {
  return DEFAULT_ROOM_PACKAGE_LIBRARY
    .map((pkg) => ({ ...pkg, score: scoreDefaultRoomPackage(goal, pkg) }))
    .filter((pkg) => pkg.score >= minScore)
    .sort((a, b) => b.score - a.score || String(a.title).localeCompare(String(b.title)))
    .slice(0, Math.max(1, Math.min(20, Number(limit) || 5)));
}

export function roomTemplateFromDefaultPackage(pkg = {}) {
  const row = asObject(pkg);
  return {
    room_name: row.title || 'AI Work Room',
    purpose: row.description || 'A specialized AI room for recurring work.',
    default_depth: row.default_depth || 'team',
    agent_roles: uniqueStrings(row.agents || [], { max: 24, lower: true }),
    memory_schema: uniqueStrings(row.memory_schema || [], { max: 64, lower: true }),
    prompt_policy: {
      token_budget: row.default_depth === 'loop' ? 'large_for_loop' : 'adaptive',
      compression: 'memory_hierarchy_first',
      default_style: 'room_package_guided',
      skills: uniqueStrings(row.skills || [], { max: 24, lower: true }),
    },
    context_policy: {
      default_scope: 'room_local_first',
      cross_room_memory: 'ask_before_import',
      private_memory: 'role_filtered_least_privilege',
      memory_hierarchy: uniqueStrings(row.memory_hierarchy || [], { max: 24, lower: true }),
    },
    approval_policy: {
      ...COMMON_AUTONOMY,
      default: 'candidate_then_review_for_long_term_changes',
    },
    model_policy: buildRoomModelPolicy(row),
    agent_activation_policy: buildDefaultAgentActivationPolicy(row),
    examples: asArray(row.examples),
    tags: uniqueStrings(row.tags || [], { max: 24, lower: true }),
    loop_policy: asObject(row.loop_policy),
    preset_id: row.package_id,
    skills: uniqueStrings(row.skills || [], { max: 24, lower: true }),
    memory_hierarchy: uniqueStrings(row.memory_hierarchy || [], { max: 24, lower: true }),
  };
}

export function formatDefaultRoomPackageList(packages = [], { includeScores = false } = {}) {
  const rows = asArray(packages);
  if (!rows.length) return '사용 가능한 default room preset을 찾지 못했습니다.';
  const lines = ['🧰 Default Room Presets'];
  for (const pkg of rows) {
    lines.push(`- ${pkg.package_id}: ${pkg.title}${includeScores && Number.isFinite(pkg.score) ? ` · score=${pkg.score}` : ''}`);
    lines.push(`  depth=${pkg.default_depth || 'team'} · agents=${asArray(pkg.agents).slice(0, 5).join(', ')}`);
    lines.push(`  activation=${buildDefaultAgentActivationPolicy(pkg).roster.slice(0, 5).map((item) => `${item.agent}:${item.state}`).join(', ')}`);
    lines.push(`  memory=${asArray(pkg.memory_schema).slice(0, 5).join(', ')}`);
  }
  return lines.join('\n');
}

export function formatDefaultRoomPackageDetail(pkg = null) {
  const row = asObject(pkg);
  if (!row.package_id) return 'Default room preset을 찾지 못했습니다.';
  const lines = [
    `🧰 Default Room Preset: ${row.title}`,
    `- id: ${row.package_id}`,
    `- domain: ${row.domain_label || 'general_workbench'}`,
    `- depth: ${row.default_depth || 'team'}`,
    `- purpose: ${row.description || '-'}`,
    `- agents: ${asArray(row.agents).join(', ') || '-'}`,
    `- skills: ${asArray(row.skills).join(', ') || '-'}`,
    `- memory hierarchy: ${asArray(row.memory_hierarchy).join(' → ') || '-'}`,
    `- memory objects: ${asArray(row.memory_schema).join(', ') || '-'}`,
    `- model roles: ${buildRoomModelPolicy(row).default_assignment.map((item) => item.role).join(', ') || '-'}`,
    `- agent activation: ${buildDefaultAgentActivationPolicy(row).roster.map((item) => `${item.agent}:${item.state}`).join(', ') || '-'}`,
  ];
  const loop = asObject(row.loop_policy);
  if (Object.keys(loop).length) {
    lines.push(`- loop: default=${loop.default_iterations || '-'} · staged=${loop.staged_iterations || '-'} · verify_each=${loop.verify_each_iteration !== false}`);
  }
  if (asArray(row.examples).length) {
    lines.push('- examples:');
    for (const ex of asArray(row.examples).slice(0, 3)) {
      lines.push(`  - User: ${ex.user}`);
      lines.push(`    Room: ${ex.room}`);
    }
  }
  return lines.join('\n');
}
