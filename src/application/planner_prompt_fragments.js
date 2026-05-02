export function buildSharedPlannerConstraintLines() {
  return [
    '- team must have 1 to 6 agents',
    '- each agent role must be one of: researcher, builder, reviewer, synthesizer, operator',
    '- if the request asks for implementation or shipping software artifacts, include a builder unless the user explicitly rejects code-writing roles',
    '- if multiple upstream agents exist, include a synthesizer unless the user explicitly rejects it',
    '- final_answer_owner must be a real participant who can plausibly deliver the final answer',
    '- preserve execution metadata in structure_v2 participants: provider_spec, provider_runtime_config, runtime_capabilities_required, runtime_capabilities_optional, external_tool_requirements, external_tool_preferences, memory_contract, context_policy',
    '- choose models only from the supported model list or the listed model node inventory',
    '- mark runtime_capabilities_required only for capabilities that are actually available in the runtime/tool list; otherwise put them in runtime_capabilities_optional or external_tool_preferences and continue with a feasible team',
    '- do not invent blocking Web/Shell requirements just because they would be useful; prefer optional preferences unless the runtime explicitly advertises web_browse or shell_exec',
  ];
}

export function buildPlannerCreateConstraintLines() {
  return [
    ...buildSharedPlannerConstraintLines(),
    '- prefer existing executable skill ids from the registry for attached_skill_ids',
    '- default model preference: researcher=gemini-3-flash-preview, builder=gpt-5-codex, reviewer/synthesizer=gpt-5.4 unless the user explicitly requests a different model',
  ];
}

export function buildPlannerRefinementRuleLines() {
  return [
    '- return the full next team, not a patch',
    '- preserve existing strong agents unless the instruction clearly asks to remove or replace them',
    '- if the instruction only changes model/provider/tools for one agent, keep the same roster size, names, roles, final_answer_owner, and handoffs unless the instruction explicitly says otherwise',
    '- if the team still needs implementation coverage, preserve or add a builder; do not leave a research-only roster for build-heavy work',
    '- if multiple upstream agents remain, keep or add a synthesizer unless the user rejects it',
    '- preserve execution metadata in structure_v2 participants: provider_spec, provider_runtime_config, runtime_capabilities_required, runtime_capabilities_optional, external_tool_requirements, external_tool_preferences, memory_contract, context_policy',
    '- choose models only from the supported model list or the listed model node inventory',
  ];
}

export function buildPlannerOutputSchemaLines({ proposalMode = 'create', compactParticipants = false } = {}) {
  const metadataLine = `    "metadata": {"team_name": "...", "composition_mode": "freeform", "proposal_mode": "${proposalMode}"},`;
  const participantLines = compactParticipants
    ? [
        '    "participants": [{"participant_id":"...","kind":"agent","name":"...","role":"researcher|builder|reviewer|synthesizer|operator","purpose":"...","provider_spec":{"provider":"gemini|codex|chatgpt|openai_compatible","model":"..."},"runtime_capabilities_required":["filesystem_read|filesystem_write|shell_exec|web_browse"],"runtime_capabilities_optional":["..."],"external_tool_requirements":["..."],"external_tool_preferences":["..."],"attached_skill_ids":["skill...."],"generated_skill_briefs":[{"label":"...","goal":"...","checklist":["...","..."]}],"memory_contract":{"publish_surface_ids":["handoff_summary"]},"context_policy":{"reads":{"grants":["shared_summary"]},"writes":{"publish_targets":["handoff_summary"]}}}],',
      ]
    : [
        '    "participants": [',
        '      {',
        '        "participant_id": "...",',
        '        "kind": "agent",',
        '        "name": "...",',
        '        "role": "researcher|builder|reviewer|synthesizer|operator",',
        '        "purpose": "...",',
        '        "provider_spec": {"provider": "gemini|codex|chatgpt|openai_compatible", "model": "..."},',
        '        "runtime_capabilities_required": ["filesystem_read|filesystem_write|shell_exec|web_browse"],',
        '        "runtime_capabilities_optional": ["..."],',
        '        "external_tool_requirements": ["..."],',
        '        "external_tool_preferences": ["..."],',
        '        "attached_skill_ids": ["skill...."],',
        '        "generated_skill_briefs": [{"label":"...","goal":"...","checklist":["...","..."]}],',
        '        "memory_contract": {"publish_surface_ids": ["handoff_summary"]},',
        '        "context_policy": {"reads": {"grants": ["shared_summary"]}, "writes": {"publish_targets": ["handoff_summary"]}}',
        '      }',
        '    ],',
      ];

  return [
    'Preferred output schema (source of truth is structure_v2; duplicate top-level fields are optional):',
    '{',
    '  "team_name": "...",',
    '  "reasoning_summary": ["..."],',
    '  "structure_v2": {',
    '    "kind": "team_structure_v2",',
    '    "version": 2,',
    metadataLine,
    ...participantLines,
    '    "topology": {"pattern": "router|supervisor|sequential|parallel|debate|committee|graph|hybrid", "execution_pattern": "...", "edges": [{"from": "...", "to": "...", "payload": "summary_plus_key_evidence"}], "final_participant_id": "..."},',
    '    "interaction_policy": {"visibility": {"reviewer_visibility": "...", "synthesizer_visibility": "..."}},',
    '    "knowledge_surface": {"profile_id": "...", "display_name": "...", "docs": [{"doc_id": "plan", "file_name": "..."}]},',
    '    "memory_policy": {"stable_semantic_slots": ["decisions", "artifacts"], "migration_strategy": "semantic_slot_preserving"},',
    '    "control_policy": {"runtime_execution": {"continuous_improvement": {"enabled": false, "max_turns": 8}}}',
    '  }',
    '}',
  ];
}
