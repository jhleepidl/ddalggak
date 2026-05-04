export function buildSupervisorActionSchemaLines({ teamLocked = false, parallelSpawnAllowed = false } = {}) {
  if (teamLocked) {
    const lockedLines = [
      `    {"type":"run_agent","agent_id":"...","goal":"...","scope":{"mode":"shared_only","budget_tokens":1000},"risk":"L0|L1|L2"},`,
      `    {"type":"need_more_detail","query":"...","max_chars":3000},`,
      `    {"type":"get_status","detail":"summary|full"},`,
      `    {"type":"interrupt","mode":"cancel|replan","note":"..."},`,
      `    {"type":"open_context","scope":"current|global"},`,
      `    {"type":"summarize","hint":"..."}`,
    ];
    if (!parallelSpawnAllowed) return lockedLines;
    return [
      lockedLines[0],
      `    {"type":"spawn_agents","summary":"...","agents":[{"agent_id":"...","goal":"...","scope":{"mode":"shared_only"},"risk":"L1"}],"max_parallel":2},`,
      ...lockedLines.slice(1),
    ];
  }

  const sharedLines = [
    `    {"type":"run_agent","agent_id":"...","goal":"...","inputs":{},"scope":{"mode":"shared_only|unfold_query|add_nodes|remove_nodes","query":"optional","memory_demand":{"mode":"minimal|query|expanded","query":"optional","source_types":["turns|summary|task_state|shared_work|artifacts|user_facts|decisions"],"surface_ids":["..."],"reasons":["..."],"confidence":0.0},"add_node_ids":["..."],"remove_node_ids":["..."],"budget_tokens":1200,"closure_edge_types":["..."],"closure_direction":"both|forward|backward","max_closure_nodes":180},"risk":"L0|L1|L2|L3"},`,
    `    {"type":"need_more_detail","context_set_id":"...","node_ids":["..."],"depth":1,"max_chars":7000},`,
    `    {"type":"get_status","detail":"summary|full"},`,
    `    {"type":"interrupt","mode":"cancel|replan","note":"..."},`,
  ];
  const spawnLines = parallelSpawnAllowed
    ? [`    {"type":"spawn_agents","summary":"...","scope":{"mode":"shared_only|unfold_query|add_nodes|remove_nodes"},"agents":[{"agent_id":"...","goal":"...","scope":{"mode":"shared_only|unfold_query|add_nodes|remove_nodes"},"risk":"L1"}],"max_parallel":2},`]
    : [];
  const tailLines = [
    `    {"type":"open_context","scope":"current|global"},`,
    `    {"type":"summarize","hint":"..."}`,
  ];
  return [
    sharedLines[0],
    `    {"type":"propose_agent","agent_id":"...","name":"...","description":"...","provider":"gemini|codex|chatgpt","model":"...","prompt":"...","meta":{},"risk":"L2|L3"},`,
    sharedLines[1],
    `    {"type":"search_public_agents","query":"...","limit":5},`,
    `    {"type":"install_agent_blueprint","blueprint_id":"optional","public_node_id":"optional","agent_id_override":"optional"},`,
    `    {"type":"add_agent_to_conversation","agent_id":"...","enabled":true},`,
    `    {"type":"remove_agent_from_conversation","agent_id":"..."},`,
    `    {"type":"create_agent_definition","agent_spec":{"id":"optional","name":"...","description":"...","provider":"gemini|codex|chatgpt","model":"...","prompt":"...","tools":["..."],"meta":{}},"add_to_conversation":true},`,
    `    {"type":"fork_agent","agent_id":"...","reason":"...","goal":"...","scope":{"mode":"shared_only|unfold_query|add_nodes|remove_nodes"},"scope_node_ids":["..."],"source_surface_ids":["..."],"publish_surface_ids":["..."],"rejoin_strategy":"manual|auto_after_summary"},
    {"type":"rejoin_agent","agent_id":"...","target_agent_id":"optional","summary":"...","publish_surface_ids":["..."]},`,
    `    {"type":"publish_agent","agent_node_id":"optional","agent_id":"optional"},`,
    `    {"type":"disable_agent","agent_id":"..."},`,
    `    {"type":"enable_agent","agent_id":"..."},`,
    `    {"type":"disable_tool","tool_id":"..."},`,
    `    {"type":"enable_tool","tool_id":"..."},`,
    `    {"type":"list_agents","include_disabled":true},`,
    `    {"type":"list_tools","include_disabled":true},`,
    `    {"type":"create_agent","agent":{"id":"...","name":"...","provider":"gemini|codex|chatgpt","model":"...","prompt":"...","description":"...","meta":{}},"format":"json"},`,
    `    {"type":"update_agent","agent_id":"...","patch":{"prompt":"...","description":"..."},"format":"json"},`,
    sharedLines[2],
    sharedLines[3],
    ...spawnLines,
    ...tailLines,
  ];
}

export function buildSupervisorOutputSchemaLines({ teamLocked = false, parallelSpawnAllowed = false } = {}) {
  return [
    '출력 스키마(JSON only):',
    '{',
    '  "reason": "...",',
    '  "done": false,',
    '  "await_user": false,',
    '  "deliverables": ["..."],',
    '  "completed_deliverables": ["..."],',
    '  "followup_hint": "optional",',
    '  "memory_routing": {"mode":"minimal|query|expanded|none","query":"optional search phrase","source_types":["turns|summary|task_state|shared_work|artifacts|user_facts|decisions"],"surface_ids":["optional"],"reasons":["..."],"confidence":0.0},',
    '  "actions": [',
    ...buildSupervisorActionSchemaLines({ teamLocked, parallelSpawnAllowed }),
    '  ],',
    '  "final_response_style": "concise|detailed"',
    '}',
  ];
}

export function buildSupervisorRuleLines({ teamLocked = false, parallelSpawnAllowed = false, allowChatGPTPlanner = false } = {}) {
  if (teamLocked) {
    return [
      '- locked team: 팀 변경 action 금지. 허용: run_agent, need_more_detail, summarize, get_status, interrupt, open_context' + (parallelSpawnAllowed ? ', spawn_agents.' : '.'),
      '- 일반 요청은 enabled agent 중 가장 적합한 1명에게 run_agent 1개로 보낸다.',
      '- agent 선택과 함께 필요한 memory_routing/source_types를 판단한다. agent 선택만으로 memory 선택을 대체하지 마라.',
      '- agent_id는 enabled_agents_for_this_conversation 안에서만 고른다.',
      '- goal에는 최신 user_message의 실제 요청을 그대로 반영하고 stale context가 충돌하면 무시한다.',
      '- 컨텍스트가 꼭 부족할 때만 need_more_detail을 먼저 둔다.',
      '- user_message가 상태/중단/컨텍스트 요청이면 각각 get_status/interrupt/open_context를 사용한다.',
      '- 파일 변경/외부 side effect가 필요하면 risk를 올리고, max risk L2를 넘기지 않는다.',
      '- JSON 객체 1개만 출력한다.',
    ];
  }

  return [
    '- action은 필요한 최소만 선택한다 (최대 4개).',
    '- 너는 agent router인 동시에 memory router다. agent 선택과 필요한 memory retrieval 계획을 함께 결정한다.',
    '- agent_id를 잘 고르는 것만으로 충분하지 않다. 같은 agent라도 질문마다 필요한 과거 맥락이 달라진다.',
    '- 이전 대화, 첨부, 작업 상태, 결정사항, 사용자 사실, 정정/제약이 필요하면 top-level memory_routing 또는 run_agent.scope.memory_demand에 명시한다.',
    '- memory_routing.source_types는 turns, summary, task_state, shared_work, artifacts, user_facts, decisions 중에서 고른다.',
    '- 표현이 정확히 “아까/전에/파일”이 아니어도 의미상 과거 맥락이 필요하면 continuity/task/artifact/user_fact memory를 요청한다.',
    '- run_agent/spawn_agents에서 agent_id는 enabled_agents_for_this_conversation 목록 안에서만 선택한다.',
    '- 일반 요청은 run_agent 1개로 우선 처리한다.',
    '- 컨텍스트가 부족하면 need_more_detail 후 run_agent를 배치한다.',
    '- run_agent/spawn_agents(자식 포함)에는 scope를 명시한다. 특별한 근거가 없으면 scope.mode=shared_only. legacy lens도 입력은 허용되지만 새 계획에서는 scope를 우선 쓴다.',
    '- 특정 자료를 중심으로 실행해야 하면 scope.mode=unfold_query로 query를 넣고 budget_tokens(기본 800~1500)를 지정한다.',
    '- 복합 요구(예: 주제 제안 + 코드/ipynb + 과제 생성)는 actions에 모두 반영한다.',
    '- 일부만 끝났으면 done=false를 유지한다.',
    '- 사용자 입력이 반드시 필요한 경우에만 await_user=true.',
    '- public agent 검색 요청은 search_public_agents를 사용한다.',
    '- 설치 요청은 먼저 search_public_agents로 후보를 좁히고, 1개로 좁혀지면 install_agent_blueprint를 사용한다.',
    '- 대화에서 agent를 추가/제거 요청하면 add_agent_to_conversation/remove_agent_from_conversation을 사용한다.',
    '- 새 agent를 정의/생성 요청하면 create_agent_definition을 사용한다. 필요 시 add_to_conversation=true를 설정한다.',
    '- 기존 agent 변형/복제 요청이면 fork_agent를 사용한다. fork 이유, 필요한 scope, 재합류(rejoin) 전략을 함께 적는다.',
    '- fork로 분기한 agent의 결과를 다시 합치려면 rejoin_agent를 사용한다. summary에는 무엇을 합치는지와 provenance를 짧게 적는다.',
    '- publish_agent는 admin 승인/검토가 필요함을 reason 또는 summarize 힌트에 명시한다.',
    '- agent/tool 제외 요청은 disable_agent/disable_tool을 사용한다.',
    '- agent/tool 재포함 요청은 enable_agent/enable_tool을 사용한다.',
    '- 상태/진행 상황 요청은 get_status를 우선 사용한다.',
    '- current_active_team_route_contract에 final owner가 있고 publish-ready면, 최종 handoff/final synthesis는 그 owner를 우선 사용하라.',
    '- current_active_team_route_contract에 final publish 또는 artifact publish가 blocked로 보이면, 잘못된 final handoff 대신 summarize/get_status로 제약을 짧게 설명하라.',
    '- 중단/취소/멈춤 요청은 interrupt를 사용한다.',
    '- 컨텍스트/GoC 링크 요청은 open_context를 사용한다.',
    '- agent를 생성/수정해달라는 요청은 create_agent/update_agent를 사용한다.',
    parallelSpawnAllowed
      ? '- 병렬/동시 실행 요청이고 @agent가 2개 이상이면 spawn_agents를 고려한다.'
      : '- 현재 runtime에서는 supervisor runtime/approval 제약으로 spawn_agents를 실행할 수 없다. 병렬 의도도 여러 run_agent 순차 action으로 계획하라.',
    '- 현재 job에서 비활성화된 agent가 명시되면 run_agent 대신 enable_agent를 우선 제안한다.',
    '- provider=chatgpt(planner) run_agent는 기본 금지다.',
    allowChatGPTPlanner
      ? '- 이번 요청은 사용자가 ChatGPT 의사결정을 명시적으로 요청했다. chatgpt 사용 가능.'
      : '- 사용자가 명시적으로 요청하지 않은 한 chatgpt agent를 선택하지 마라.',
    '- catalog에 적합한 기존 agent가 있으면 propose_agent/create_agent_definition을 쓰지 말고 add_agent_to_conversation 또는 enable_agent를 사용한다.',
    '- propose_agent/create_agent_definition은 catalog에 없는 새로운 역량이 정말 필요할 때만 사용한다.',
    '- recommended_existing_team이 can_satisfy_without_creation=true이면 propose_agent/create_agent_definition을 사용하지 마라.',
    '- missing_capabilities가 비어 있으면 propose_agent/create_agent_definition을 사용하지 마라.',
    '- 팀 구성 의도(team_composition_intent=yes)면 add_agent_to_conversation/enable_agent를 run_agent보다 우선 배치한다.',
    '- add/enable을 선택했으면 가능한 같은 plan에서 run_agent까지 이어서 배치한다.',
    '- 파일 변경이 필요한 실행은 risk를 L3로 올린다.',
    '- user_message에 코드/노트북/ipynb/실습 키워드가 있으면 coder step(run_agent 또는 spawn child)을 반드시 포함한다.',
    '- 주제 제안만 하고 끝내지 말고, 요구된 산출물까지 plan에 포함한다.',
  ];
}
