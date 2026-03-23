function asArray(value) { return Array.isArray(value) ? value : []; }
function clean(value = '') { return String(value || '').trim(); }
function cleanId(value = '') { return clean(value).toLowerCase(); }
const ROLE_LABELS = { researcher: '조사', builder: '구현', reviewer: '검토', synthesizer: '최종 정리', operator: '진행 운영' };
const EXECUTION_PATTERN_LABELS = {
  single_specialist: '단일 전문 agent가 바로 처리',
  sequential_pipeline: '순차 파이프라인',
  parallel_research_then_review_then_synthesize: '병렬 조사 → 검토 → 최종 정리',
  builder_reviewer_loop: '구현 ↔ 검토 반복',
  multi_research_adjudication: '상반된 관점 토의 → 판정 → 최종 정리',
  operator_gated_workflow: '운영 게이트 포함 워크플로우',
};
const VISIBILITY_LABELS = {
  summary_only: '요약만 확인',
  summaries_plus_selected_evidence: '요약 + 선택된 핵심 근거',
  upstream_outputs_only: '상위 결과물만 확인',
  full_context: '전체 문맥 확인',
};
const PAYLOAD_LABELS = {
  summary_only: '요약',
  summary_plus_key_evidence: '요약 + 핵심 근거',
  review_summary_only: '검토 요약',
  approved_summary_only: '승인된 요약',
  draft_plus_change_summary: '초안 + 변경 요약',
  evidence_bundle: '근거 묶음',
  claim_plus_supporting_evidence: '핵심 주장 + 지지 근거',
  counterargument_plus_risks: '반대 의견 + 리스크 근거',
};
const SKILL_LABELS = {
  web_search: { label: '웹 조사', detail: '필요한 공개 자료를 빠르게 찾음' },
  source_triage: { label: '출처 선별', detail: '믿을 만한 자료만 추림' },
  evidence_mapping: { label: '근거 정리', detail: '주장과 근거를 연결' },
  news_clustering: { label: '뉴스 묶음화', detail: '관련 이슈를 테마별로 정리' },
  dart_analysis: { label: '공시 해석', detail: '공시와 실적 숫자를 읽음' },
  table_extraction: { label: '표 추출', detail: '숫자 표를 꺼내 비교 가능하게 만듦' },
  financial_comparison: { label: '재무 비교', detail: '기업/기간별 수치를 비교' },
  contradiction_check: { label: '모순 점검', detail: '앞뒤가 맞지 않는 부분을 찾음' },
  adversarial_review: { label: '반박 검토', detail: '취약한 논리를 공격적으로 점검' },
  evidence_validation: { label: '근거 검증', detail: '증거의 신뢰도와 적합성을 확인' },
  structured_summary: { label: '구조화 요약', detail: '핵심 내용을 항목별로 정리' },
  report_synthesis: { label: '최종 보고서 작성', detail: '여러 결과를 한 답변으로 합침' },
  approval_gate: { label: '승인 게이트', detail: '외부 실행 전 승인 여부를 관리' },
  run_control: { label: '실행 제어', detail: '흐름과 상태를 관리' },
  code_editing: { label: '코드 수정', detail: '파일 변경 초안을 작성' },
  implementation_planning: { label: '구현 설계', detail: '수정 계획과 순서를 설계' },
  argument_structuring: { label: '논리 구조화', detail: '찬반 논리를 구조화' },
  market_mapping: { label: '시장 지도 작성', detail: '시장 흐름과 섹터를 빠르게 훑음' },
  company_screening: { label: '종목 스크리닝', detail: '관심 후보를 추려냄' },
  catalyst_mapping: { label: '촉매 추적', detail: '주가를 움직일 이벤트를 정리' },
  market_news_scan: { label: '시장 뉴스 스캔', detail: '최근 시장 뉴스 변화를 훑음' },
  thesis_stress_test: { label: '투자 논리 스트레스 테스트', detail: '가정이 깨지는 지점을 찾음' },
  upside_case_building: { label: '상승 시나리오 설계', detail: '상승 근거와 조건을 정리' },
  downside_case_building: { label: '하락 시나리오 설계', detail: '리스크 경로를 정리' },
  risk_signal_mapping: { label: '리스크 신호 추적', detail: '경고 신호를 정리' },
  growth_signal_mapping: { label: '성장 신호 추적', detail: '긍정 신호를 정리' },
  investment_synthesis: { label: '투자 결론 정리', detail: '판단 포인트를 한 장으로 정리' },
  portfolio_briefing: { label: '포트폴리오 브리핑', detail: '의사결정 포인트를 짧게 브리핑' },
  'skill.claim_evidence_audit.v1': { label: '주장-근거 감사', detail: '주장과 근거를 대조해 허점을 찾음' },
  'skill.context_selection_policy.v1': { label: '문맥 선택 정책', detail: '어떤 context를 볼지 선택 규칙을 세움' },
  'skill.kr_equity_analysis.v1': { label: '한국 주식 분석', detail: '한국 주식 분석 체크리스트를 적용' },
  'skill.run_trace_debugging.v1': { label: '런 트레이스 디버깅', detail: 'stalled run과 reroute 문제를 추적' },
  'skill.telegram_briefing.v1': { label: '텔레그램 브리핑', detail: '짧고 안정적인 채팅 응답 형식으로 정리' },
  'skill.thread_team_reconciliation.v1': { label: '스레드 팀 동기화', detail: '팀 멤버십과 실행 상태를 안전하게 맞춤' },
};
const TOOL_LABELS = {
  web_search: { label: '웹 검색' },
  news_scan: { label: '뉴스 스캔' },
  spreadsheet_reasoning: { label: '스프레드시트 추론' },
  read_only_fs: { label: '워크스페이스 읽기 전용' },
  workspace_fs: { label: '워크스페이스 파일 읽기/쓰기' },
  code_exec: { label: '코드 실행' },
  context_graph: { label: 'GoC context 그래프' },
  conversation_team_store: { label: '대화 팀 저장소' },
  runtime_trace: { label: '런타임 트레이스' },
  uploaded_files: { label: '업로드 파일' },
};
const GENERIC_AGENT_NAMES = new Set(['generalist researcher','researcher','operator','builder','reviewer','synthesizer','planner','coder','critic','critic_or_reviewer']);
export function inferTaskDomain(text = '') {
  const lower = clean(text).toLowerCase();
  if (/주식|증시|시장|투자|종목|기업|실적|밸류|공시|뉴스|리포트|sector|stock|market|invest|equity|earnings|filing/.test(lower)) return 'investing';
  if (/코드|구현|리팩토|버그|에러|테스트|패치|refactor|code|bug|test|implementation|patch|repo|commit/.test(lower)) return 'engineering';
  if (/법률|계약|규제|compliance|policy|legal/.test(lower)) return 'compliance';
  return 'general';
}
export function inferAgentSpecialty({ name = '', purpose = '', taskText = '', skills = [] } = {}) {
  const local = `${clean(name)} ${clean(purpose)} ${asArray(skills).join(' ')}`.toLowerCase();
  const global = clean(taskText).toLowerCase();
  if (/bull|낙관|upside|growth/.test(local)) return 'bull';
  if (/bear|비관|risk|downside/.test(local)) return 'bear';
  if (/news|뉴스|catalyst/.test(local)) return 'news';
  if (/filing|공시|dart|financial|실적/.test(local)) return 'filings';
  if (/compare|비교|screen|발굴/.test(local)) return 'compare';
  if (/review|검토|critic|stress/.test(local)) return 'review';
  if (/synth|summary|정리|memo|보고서|final/.test(local)) return 'synthesis';
  if (/operator|gate|승인|coord/.test(local)) return 'ops';
  if (/code|구현|build|patch/.test(local)) return 'build';
  if (/news|뉴스|catalyst/.test(global)) return 'news';
  if (/filing|공시|dart|financial|실적/.test(global)) return 'filings';
  if (/compare|비교|screen|발굴/.test(global)) return 'compare';
  if (/review|검토|critic|stress/.test(global)) return 'review';
  if (/synth|summary|정리|memo|보고서|final/.test(global)) return 'synthesis';
  if (/operator|gate|승인|coord/.test(global)) return 'ops';
  if (/code|구현|build|patch/.test(global)) return 'build';
  return '';
}
function isGenericAgentName(name = '') { return GENERIC_AGENT_NAMES.has(clean(name).toLowerCase()); }
function isPlaceholderPurpose(purpose = '') {
  const value = clean(purpose);
  if (!value) return true;
  if (/^(research_fit|enabled|candidate|structured fallback candidate)(,|$)/i.test(value)) return true;
  if (/^(research_fit|enabled|candidate|structured fallback candidate|research_fit,enabled|enabled,research_fit)$/i.test(value)) return true;
  if (/^[a-z0-9_, -]{3,40}$/i.test(value) && /(fit|enabled|candidate|default)/i.test(value)) return true;
  return false;
}
export function describeSkill(skillId = '') {
  const key = cleanId(skillId); const meta = SKILL_LABELS[key];
  if (meta) return { skill_id: key, ...meta };
  return { skill_id: key, label: clean(skillId).replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()), detail: '' };
}
export function formatSkillLabels(skillIds = [], { max = 4, includeDetails = false } = {}) {
  return asArray(skillIds).map((skillId) => describeSkill(skillId)).slice(0, Math.max(1, Number(max) || 4)).map((meta) => includeDetails && meta.detail ? `${meta.label} (${meta.detail})` : meta.label);
}
export function describeTool(toolId = '') {
  const key = cleanId(toolId);
  const meta = TOOL_LABELS[key];
  if (meta) return { tool_id: key, ...meta };
  return { tool_id: key, label: clean(toolId).replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) };
}
export function formatToolLabels(toolIds = [], { max = 4 } = {}) {
  return asArray(toolIds).map((toolId) => describeTool(toolId)).slice(0, Math.max(1, Number(max) || 4)).map((meta) => meta.label);
}
export function roleLabel(roleId = '') { return ROLE_LABELS[cleanId(roleId)] || clean(roleId) || '역할 미지정'; }
export function resolveAgencyOverlayMeta(row = {}) {
  const source = row && typeof row === 'object' ? row : {};
  const overlay = source.agency_overlay && typeof source.agency_overlay === 'object'
    ? source.agency_overlay
    : (source.agencyOverlay && typeof source.agencyOverlay === 'object'
      ? source.agencyOverlay
      : (source.metadata?.agency_overlay && typeof source.metadata.agency_overlay === 'object' ? source.metadata.agency_overlay : {}));
  const display = overlay.display && typeof overlay.display === 'object' ? overlay.display : {};
  const title = clean(display.title || overlay.title || source.agency_overlay_title || source.agencyOverlayTitle || '');
  const overlayId = clean(source.agency_overlay_id || source.agencyOverlayId || overlay.overlay_id || overlay.overlayId || source.metadata?.agency_overlay_id || '');
  return { overlay_id: overlayId, title };
}
export function formatRoleOverlayProfile(roleId = '', row = {}, { includeBaseLabel = false } = {}) {
  const baseRole = roleLabel(roleId || row?.role || row?.role_id || row?.roleId || row?.role_label || row?.roleLabel || '');
  const overlayMeta = resolveAgencyOverlayMeta(row);
  if (!overlayMeta.title) return includeBaseLabel ? `base=${baseRole}` : baseRole;
  return includeBaseLabel ? `base=${baseRole} · overlay=${overlayMeta.title}` : `${baseRole} + ${overlayMeta.title} overlay`;
}
export function humanizeExecutionPattern(pattern = '') { return EXECUTION_PATTERN_LABELS[cleanId(pattern)] || clean(pattern) || '미정'; }
export function humanizeVisibility(visibility = '') { return VISIBILITY_LABELS[cleanId(visibility)] || clean(visibility) || '미정'; }
export function humanizeHandoffPayload(payload = '') { return PAYLOAD_LABELS[cleanId(payload)] || clean(payload) || '요약'; }
export function humanizeModel(provider = '', model = '') {
  const modelText = clean(model); const providerText = cleanId(provider);
  if (!modelText && !providerText) return '(미지정)';
  const modelLabel = modelText.replace(/^gemini-2\.5-pro$/i, 'Gemini 2.5 Pro').replace(/^gpt-5-codex$/i, 'GPT-5 Codex').replace(/^gpt-5\.4$/i, 'GPT-5.4');
  if (!providerText) return modelLabel;
  const providerLabel = providerText === 'chatgpt' ? 'ChatGPT' : providerText === 'gemini' ? 'Gemini' : providerText === 'codex' ? 'Codex' : providerText;
  return `${providerLabel} · ${modelLabel}`;
}
export function suggestAgentDisplayName({ name = '', role = '', purpose = '', taskText = '', skills = [], index = 1 } = {}) {
  const current = clean(name); if (current && !isGenericAgentName(current)) return current;
  const roleId = cleanId(role); const specialty = inferAgentSpecialty({ name: current, purpose, taskText, skills }); const domain = inferTaskDomain(`${taskText} ${purpose}`);
  let title = '';
  if (roleId === 'researcher') {
    if (specialty === 'bull') title = '상승 시나리오 분석가';
    else if (specialty === 'bear') title = '리스크 시나리오 분석가';
    else if (specialty === 'news') title = domain === 'investing' ? '시장 뉴스 레이더' : '뉴스 레이더';
    else if (specialty === 'filings') title = domain === 'investing' ? '공시·실적 해석가' : '문서 근거 분석가';
    else if (specialty === 'compare') title = domain === 'investing' ? '종목 비교 조사관' : '비교 조사 분석가';
    else if (domain === 'investing') title = index === 1 ? '시장 지도 조사관' : '투자 아이디어 조사관';
    else if (domain === 'engineering') title = '기술 조사 분석가';
    else title = '핵심 근거 조사관';
  } else if (roleId === 'reviewer') title = domain === 'investing' ? '투자 논리 검증관' : domain === 'engineering' ? '설계·품질 검토자' : '주장 검증관';
  else if (roleId === 'synthesizer') title = domain === 'investing' ? '투자 결론 정리자' : domain === 'engineering' ? '최종 제안 정리자' : '최종 답변 편집자';
  else if (roleId === 'builder') title = domain === 'engineering' ? '구현 설계자' : '실행 설계자';
  else if (roleId === 'operator') title = '진행 코디네이터';
  return title || current || `${roleLabel(roleId)} agent`;
}
export function autoPurposeForAgent({ role = '', purpose = '', taskText = '', name = '', skills = [] } = {}) {
  const existing = clean(purpose); if (existing && existing !== clean(taskText) && !isPlaceholderPurpose(existing)) return existing;
  const roleId = cleanId(role); const specialty = inferAgentSpecialty({ name, purpose, taskText, skills }); const domain = inferTaskDomain(taskText);
  if (roleId === 'researcher') {
    if (specialty === 'bull') return '상승 여지를 만드는 근거와 조건을 정리한다';
    if (specialty === 'bear') return '하락 리스크와 깨질 수 있는 가정을 정리한다';
    if (specialty === 'news') return '최근 뉴스·이벤트·촉매를 수집해 시장 영향을 정리한다';
    if (specialty === 'filings') return '공시·실적·숫자 근거를 확인해 해석한다';
    if (domain === 'investing') return '투자 판단에 필요한 핵심 근거를 빠르게 모은다';
    return '필요한 근거와 사실관계를 조사한다';
  }
  if (roleId === 'reviewer') return domain === 'investing' ? '투자 논리의 약점, 누락, 모순을 검토한다' : '결과의 약점과 리스크를 검토한다';
  if (roleId === 'synthesizer') return '여러 결과를 합쳐 최종 답변을 사용자 친화적으로 정리한다';
  if (roleId === 'builder') return '실제 변경안과 실행 계획을 만든다';
  if (roleId === 'operator') return '흐름과 handoff를 관리하고 필요한 경우 승인 단계를 거친다';
  return '';
}
export function defaultSkillsForAgent({ role = '', taskText = '', purpose = '', name = '' } = {}) {
  const roleId = cleanId(role); const domain = inferTaskDomain(`${taskText} ${purpose}`); const specialty = inferAgentSpecialty({ name, purpose, taskText, skills: [] });
  if (roleId === 'builder') return ['implementation_planning', 'code_editing'];
  if (roleId === 'reviewer') return domain === 'investing' ? ['thesis_stress_test', 'contradiction_check', 'evidence_validation'] : ['evidence_validation', 'contradiction_check'];
  if (roleId === 'synthesizer') return domain === 'investing' ? ['investment_synthesis', 'structured_summary', 'portfolio_briefing'] : ['structured_summary', 'report_synthesis'];
  if (roleId === 'operator') return ['run_control', 'approval_gate'];
  if (specialty === 'news') return domain === 'investing' ? ['market_news_scan', 'source_triage', 'catalyst_mapping'] : ['web_search', 'source_triage', 'news_clustering'];
  if (specialty === 'filings') return ['dart_analysis', 'financial_comparison', 'table_extraction'];
  if (specialty === 'bull') return ['growth_signal_mapping', 'upside_case_building', 'evidence_mapping'];
  if (specialty === 'bear') return ['risk_signal_mapping', 'downside_case_building', 'evidence_mapping'];
  if (domain === 'investing') return ['market_mapping', 'company_screening', 'evidence_mapping'];
  return ['web_search', 'source_triage', 'evidence_mapping'];
}
export function buildReadableInteractionLines(spec = {}, shortcutPolicy = null) {
  const row = spec && typeof spec === 'object' ? spec : {}; const policies = row.policies && typeof row.policies === 'object' ? row.policies : {};
  const lines = [`흐름: ${humanizeExecutionPattern(row.execution_pattern)}`, `최종 답변 담당: ${clean(row.final_answer_owner) || '미정'}`];
  if (policies.reviewer_visibility) lines.push(`검토자는: ${humanizeVisibility(policies.reviewer_visibility)}`);
  if (policies.synthesizer_visibility) lines.push(`최종 정리자는: ${humanizeVisibility(policies.synthesizer_visibility)}`);
  if (typeof policies.builder_direct_response === 'boolean') lines.push(`Builder 직접 응답: ${policies.builder_direct_response ? '허용' : '비허용'}`);
  if (shortcutPolicy && typeof shortcutPolicy === 'object') {
    const enabled = shortcutPolicy.enabled !== false; const maxRecentTurns = Number.isFinite(Number(shortcutPolicy.max_recent_turns)) ? Number(shortcutPolicy.max_recent_turns) : null;
    lines.push(`짧은 후속 질문 shortcut: ${enabled ? '켜짐' : '꺼짐'}${maxRecentTurns ? ` · 최근 ${maxRecentTurns}턴 범위` : ''}`);
  }
  const handoffs = asArray(row.handoffs).slice(0, 6);
  if (handoffs.length > 0) { lines.push('handoff:'); for (const handoff of handoffs) lines.push(`- ${clean(handoff.from) || 'Unknown'} → ${clean(handoff.to) || 'Unknown'} · ${humanizeHandoffPayload(handoff.payload)}`); }
  return lines;
}
export function shouldAutoRenameAgent(name = '') { return isGenericAgentName(name); }
