function clean(value = '') { return String(value || '').trim(); }
function cleanId(value = '') { return clean(value).toLowerCase().replace(/[^a-z0-9가-힣_:\-]+/g, '_').replace(/^_+|_+$/g, ''); }
function uniq(values = [], max = 12) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(values) ? values : []) {
    const value = cleanId(raw);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
    if (out.length >= max) break;
  }
  return out;
}

const ROLE_PATTERNS = [
  { role: 'reviewer', patterns: [/reviewer/, /review/, /critic/, /검토자/, /검토/, /리뷰어/, /리뷰/, /비평/] },
  { role: 'tester', patterns: [/tester/, /test/, /qa/, /검증/, /테스트/, /검사/] },
  { role: 'researcher', patterns: [/researcher/, /research/, /조사자/, /조사/, /리서처/, /리서치/] },
  { role: 'artifact_verifier', patterns: [/artifact\s*verifier/, /verifier/, /산출물\s*검증/, /문서\s*검증/, /아티팩트\s*검증/] },
  { role: 'arbiter', patterns: [/arbiter/, /judge/, /moderator/, /판정/, /중재/, /결정자/] },
  { role: 'synthesizer', patterns: [/synthesizer/, /synthesis/, /종합/, /취합/] },
  { role: 'builder', patterns: [/builder/, /writer/, /implementer/, /developer/, /작성자/, /구현자/, /개발자/] },
];

function inferRequiredRoles(text = '') {
  const roles = [];
  for (const item of ROLE_PATTERNS) {
    if (item.patterns.some((pattern) => pattern.test(text))) roles.push(item.role);
  }
  return uniq(roles, 8);
}

function inferTeamStyle(text = '', requiredRoles = []) {
  if (/red[-\s]?team|레드팀|반대\s*관점|공격적\s*검토|비판적으로/.test(text)) return 'red_team';
  if (/debate|토론|논쟁|서로\s*토의|회의하듯|회의\s*하듯/.test(text)) return 'debate';
  if (/parallel|병렬|나눠서|각자|동시에/.test(text)) return 'parallel';
  if (/committee|패널|위원회|여러\s*전문가|복수\s*전문가/.test(text)) return 'committee';
  if (requiredRoles.includes('reviewer') || /검토|리뷰|review|critic/.test(text)) return 'review';
  if (requiredRoles.includes('researcher')) return 'research';
  return 'team';
}

export function inferUserOrchestrationIntent(taskText = '', { explicitTeamHint = false } = {}) {
  const text = clean(taskText).toLowerCase();
  if (!text && !explicitTeamHint) {
    return {
      team_intent: 'neutral',
      team_style: 'none',
      required_roles: [],
      forbidden_roles: [],
      min_team_size: 1,
      debt_policy: 'normal',
      reason_codes: [],
    };
  }

  const reasonCodes = [];
  const forbiddenRoles = [];
  const avoidTeam = /single[-\s]?agent|solo|혼자|단독|한\s*명|팀\s*(쓰지|사용하지)\s*말|여러\s*agent\s*말고|no\s+team|without\s+team/.test(text);
  const explicitTeam = explicitTeamHint
    || /팀으로|팀\s*수행|팀\s*작업|여러\s*(agent|에이전트|역할|관점|전문가)|multi[-\s]?agent|agent\s*team|collaborat|협업|분담|나눠서|회의하듯|토론|debate|reviewer\s*붙|검토자\s*붙|리뷰어\s*붙|red[-\s]?team|레드팀/.test(text);
  const preferredTeam = !explicitTeam && /가능하면\s*검토|검토까지|리뷰까지|여러\s*관점|second\s+opinion|double[-\s]?check/.test(text);

  if (avoidTeam) reasonCodes.push('user_requested_single_or_minimal');
  if (explicitTeam) reasonCodes.push('user_explicitly_requested_team');
  if (preferredTeam) reasonCodes.push('user_preferred_team_review');

  const requiredRoles = inferRequiredRoles(text);
  if (explicitTeam && requiredRoles.length === 0) {
    if (/글|문서|draft|write|작성|수정|edit|editor/.test(text)) requiredRoles.push('reviewer');
    else requiredRoles.push('reviewer');
  }
  if (avoidTeam) forbiddenRoles.push('optional_panel');

  const teamIntent = avoidTeam ? 'avoid' : (explicitTeam ? 'explicit' : (preferredTeam ? 'preferred' : 'neutral'));
  const teamStyle = teamIntent === 'avoid' ? 'minimal' : inferTeamStyle(text, requiredRoles);
  return {
    team_intent: teamIntent,
    team_style: teamStyle,
    required_roles: uniq(requiredRoles, 8),
    forbidden_roles: uniq(forbiddenRoles, 4),
    min_team_size: teamIntent === 'explicit' ? Math.max(2, requiredRoles.length || 2) : (teamIntent === 'preferred' ? 2 : 1),
    debt_policy: teamIntent === 'explicit' ? 'user_requested_overhead' : (teamIntent === 'preferred' ? 'soft_overhead' : 'normal'),
    reason_codes: reasonCodes,
  };
}

export function candidateSatisfiesUserOrchestrationIntent(candidate = {}, intent = {}) {
  const row = intent && typeof intent === 'object' ? intent : inferUserOrchestrationIntent('');
  const roles = uniq(candidate.roles || candidate.role_ids || candidate.team?.agents?.map((agent) => agent.role), 16);
  const roleSet = new Set(roles);
  const agentCount = Number(candidate.agent_count || candidate.team?.agents?.length || roles.length || 1);
  const missingRequiredRoles = uniq(row.required_roles || [], 8).filter((role) => !roleSet.has(cleanId(role)));
  const minTeamSize = Number(row.min_team_size || 1);
  const teamSizeSatisfied = agentCount >= minTeamSize;
  const teamIntent = cleanId(row.team_intent || 'neutral');
  if (teamIntent === 'neutral') {
    return { satisfied: true, missing_required_roles: [], team_size_satisfied: true, reason: 'neutral' };
  }
  if (teamIntent === 'avoid') {
    return {
      satisfied: agentCount <= 1 || roles.includes('solo'),
      missing_required_roles: [],
      team_size_satisfied: true,
      reason: agentCount <= 1 || roles.includes('solo') ? 'minimal_team_satisfied' : 'user_requested_minimal_but_team_candidate',
    };
  }
  const satisfied = teamSizeSatisfied && missingRequiredRoles.length === 0;
  return {
    satisfied,
    missing_required_roles: missingRequiredRoles,
    team_size_satisfied: teamSizeSatisfied,
    reason: satisfied ? 'user_team_intent_satisfied' : 'user_team_intent_mismatch',
  };
}

export function summarizeUserOrchestrationIntent(intent = {}) {
  const row = intent && typeof intent === 'object' ? intent : {};
  return {
    team_intent: cleanId(row.team_intent || 'neutral') || 'neutral',
    team_style: cleanId(row.team_style || 'none') || 'none',
    required_roles: uniq(row.required_roles || [], 8),
    forbidden_roles: uniq(row.forbidden_roles || [], 4),
    min_team_size: Number(row.min_team_size || 1),
    debt_policy: cleanId(row.debt_policy || 'normal') || 'normal',
    reason_codes: uniq(row.reason_codes || [], 8),
  };
}
