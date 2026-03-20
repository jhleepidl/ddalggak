function clean(value = '') { return String(value || '').trim(); }

export const EXECUTION_ROLE_OPTIONS = Object.freeze([
  { id: 'researcher', label: 'Researcher', stability: 'stable', description: '조사, 비교, 근거 수집, 분석 초안 생성' },
  { id: 'builder', label: 'Builder', stability: 'stable', description: '코드, 노트북, 문서/산출물 구현' },
  { id: 'reviewer', label: 'Reviewer', stability: 'stable', description: '검토, 비판, 리스크 점검, 승인 게이트' },
  { id: 'synthesizer', label: 'Synthesizer', stability: 'stable', description: '여러 upstream 결과를 합쳐 최종 응답 생성' },
  { id: 'operator', label: 'Operator', stability: 'stable', description: '운영성 작업, gated workflow, 실행 조율' },
]);

export const STRUCTURE_PARTICIPANT_KIND_OPTIONS = Object.freeze([
  { id: 'agent', execution_support: 'native', description: '실제 실행 가능한 일반 LLM participant' },
  { id: 'judge', execution_support: 'native', description: '판정/최종 adjudication participant' },
  { id: 'gate', execution_support: 'schema-first', description: 'approval / hold / checkpoint용 gate participant' },
  { id: 'tool_proxy', execution_support: 'schema-first', description: '툴이나 외부 시스템을 대표하는 proxy participant' },
  { id: 'workflow_step', execution_support: 'compatibility', description: '구조상 step participant. 현재는 agent-compatible step으로 제한적 실행' },
  { id: 'human', execution_support: 'schema-first', description: '사람 승인/입력 대기 participant' },
  { id: 'memory_node', execution_support: 'schema-first', description: 'memory/context 전용 participant' },
]);

export const STRUCTURE_PATTERN_OPTIONS = Object.freeze([
  { id: 'single', runtime_support: 'stable', description: '단일 specialist가 바로 답변' },
  { id: 'router', runtime_support: 'stable', description: 'router가 specialist를 고르는 구조' },
  { id: 'supervisor', runtime_support: 'stable', description: 'supervisor가 worker를 배치하고 합성' },
  { id: 'sequential', runtime_support: 'stable', description: '순차 pipeline. A -> B -> C' },
  { id: 'parallel', runtime_support: 'partial', description: 'fan-out 후 merge/synthesizer로 합류. topology-aware stage/parallel group 힌트 지원' },
  { id: 'debate', runtime_support: 'partial', description: '주장/반박 후 judge 또는 synthesizer가 판정. rebuttal/adjudication validator 지원' },
  { id: 'committee', runtime_support: 'experimental', description: '동등 참여자들이 vote/consensus를 내는 구조' },
  { id: 'graph', runtime_support: 'experimental', description: '명시적 node/edge를 가진 topology. cycle/isolated-node validator 지원' },
  { id: 'workflow', runtime_support: 'partial', description: '승인/반복/loop가 있는 workflow 중심 구조' },
  { id: 'hybrid', runtime_support: 'stable', description: '여러 패턴을 섞되 compatibility layer로 실행' },
]);

export function formatTeamSchemaSupportBadge(value = '') {
  const key = clean(value).toLowerCase();
  if (key === 'native' || key === 'stable') return 'stable';
  if (key === 'partial' || key === 'compatibility') return 'partial';
  if (key === 'experimental' || key === 'schema-first') return 'experimental';
  return key || 'unknown';
}

export function buildTeamSchemaOptionsText() {
  const lines = [
    'Team structure options',
    '',
    '실행 호환 role (현재 planner/runtime에서 가장 안정적)',
    ...EXECUTION_ROLE_OPTIONS.map((row) => `- ${row.id}: ${row.description} [${formatTeamSchemaSupportBadge(row.stability)}]`),
    '',
    'structure_v2 participant kind',
    ...STRUCTURE_PARTICIPANT_KIND_OPTIONS.map((row) => `- ${row.id}: ${row.description} [${formatTeamSchemaSupportBadge(row.execution_support)}]`),
    '',
    'structure_v2 pattern',
    ...STRUCTURE_PATTERN_OPTIONS.map((row) => `- ${row.id}: ${row.description} [${formatTeamSchemaSupportBadge(row.runtime_support)}]`),
    '',
    '추천 사용법',
    '- /team create <설명> 에서 role/pattern을 자연어로 직접 지정할 수 있습니다.',
    '- 예: "researcher 2명 + reviewer + synthesizer로 parallel 구조"',
    '- 예: "pro/con debate 후 judge가 최종 판정"',
    '- 예: "router가 요청을 분기하고 builder는 직접 유저에게 답하지 않게"',
    '',
    '참고',
    '- 현재 runtime assembly는 structure_v2/topology를 우선 읽고, 일부 executor 경로는 compatibility layer를 함께 사용합니다.',
    '- gate / human / memory_node / graph / committee는 schema-first 지원이며 일부는 preview/validation 위주입니다.',
  ];
  return lines.join('\n');
}

export function buildTeamSchemaOptionsSummaryLines() {
  return [
    `- /team options: role / participant kind / pattern 선택지 보기`,
    `  role=${EXECUTION_ROLE_OPTIONS.map((row) => row.id).join(', ')}`,
    `  pattern=${STRUCTURE_PATTERN_OPTIONS.map((row) => row.id).join(', ')}`,
  ];
}

export function buildPlannerSchemaHintText() {
  return [
    `Execution-compatible roles: ${EXECUTION_ROLE_OPTIONS.map((row) => row.id).join(', ')}`,
    `structure_v2 participant kinds: ${STRUCTURE_PARTICIPANT_KIND_OPTIONS.map((row) => row.id).join(', ')}`,
    `structure_v2 patterns: ${STRUCTURE_PATTERN_OPTIONS.map((row) => row.id).join(', ')}`,
    'Prefer stable/native options unless the user explicitly asks for a more experimental pattern.',
  ].join('\n');
}
