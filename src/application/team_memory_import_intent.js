function clean(value = '') { return String(value || '').trim(); }
function cleanId(value = '') { return clean(value).toLowerCase().replace(/[^a-z0-9가-힣_:\-]+/g, '_').replace(/^_+|_+$/g, ''); }
function asArray(value) { return Array.isArray(value) ? value : []; }
function uniq(values = [], max = 10) {
  const out = [];
  const seen = new Set();
  for (const raw of asArray(values)) {
    const value = cleanId(raw);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
    if (out.length >= max) break;
  }
  return out;
}

export function inferTargetTeamFromText(text = '', fallback = 'general') {
  const value = clean(text).toLowerCase();
  if (/코딩팀|구현팀|개발팀|coding\s*team|implementation\s*team|code\s*team|repo|patch|코드|구현|개발|테스트|test/.test(value)) return 'coding';
  if (/논문작성팀|논문\s*팀|paper\s*(writing)?\s*team|writing\s*team|manuscript|논문|paper|초록|abstract|related\s*work|실험\s*결과|method\s*section/.test(value)) return 'paper';
  if (/발표팀|슬라이드팀|presentation\s*team|slide\s*team|slides?|발표|슬라이드|피치덱|deck/.test(value)) return 'presentation';
  if (/리뷰팀|검토팀|review\s*team|critic\s*team|red[-\s]?team|레드팀|비판|검토|리뷰/.test(value)) return 'review';
  const fb = cleanId(fallback || 'general');
  return ['coding', 'paper', 'presentation', 'review', 'general'].includes(fb) ? fb : 'general';
}

export function projectionProfileForTeam(targetTeam = 'general', text = '') {
  const direct = inferTargetTeamFromText(text, targetTeam);
  if (direct === 'coding') return 'coding';
  if (direct === 'paper') return 'paper';
  if (direct === 'presentation') return 'presentation';
  if (direct === 'review') return 'review';
  return 'general';
}

function inferTopic(text = '') {
  const value = clean(text);
  if (!value) return 'current_topic';
  if (/같은\s*주제|이\s*주제|현재\s*주제|current\s*topic|same\s*topic|this\s*topic|이어(?:서|받아서)/i.test(value)) return 'current_topic';
  const m = value.match(/(?:주제|topic|about|regarding)[:\s]+([^.,\n]{3,80})/i);
  if (m) return cleanId(m[1]).slice(0, 64) || 'current_topic';
  return 'current_topic';
}

export function inferMemoryImportIntent(taskText = '', { targetTeam = '', explicitHint = false } = {}) {
  const text = clean(taskText).toLowerCase();
  const reasonCodes = [];
  const mentionsMemory = /memory|memories|remembered|saved\s*(context|memory|notes)|메모리|기억|저장된|저장해둔|이전\s*메모|프로젝트\s*메모/.test(text);
  const mentionsImport = /import|load|reuse|bring|use\s+.*memory|가져와|불러와|활용|재사용|이어(?:서|받아서)|넘겨|전달/.test(text);
  const mentionsSameTopic = /같은\s*주제|이\s*주제|현재\s*주제|same\s*topic|current\s*topic|this\s*topic/.test(text);
  const detectedTeam = inferTargetTeamFromText(text, targetTeam || 'general');
  const hasTeamHandoff = detectedTeam !== 'general' && /(맡겨|넘겨|assign|delegate|에게|한테|코딩팀|구현팀|개발팀|논문작성팀|논문\s*팀|paper\s*(writing)?\s*team|presentation\s*team|slide\s*team|review\s*team|critic\s*team|리뷰팀|검토팀)/.test(text);
  const explicit = explicitHint || (mentionsMemory && mentionsImport) || (mentionsSameTopic && (mentionsImport || hasTeamHandoff));
  const suggested = !explicit && (mentionsMemory || mentionsSameTopic || hasTeamHandoff);
  if (explicit) reasonCodes.push('user_explicitly_requested_memory_import');
  if (suggested) reasonCodes.push('memory_import_suggested_by_context');
  if (mentionsSameTopic) reasonCodes.push('same_topic_memory_requested');
  if (hasTeamHandoff) reasonCodes.push('target_team_handoff');

  const projectionProfile = projectionProfileForTeam(detectedTeam, text);
  return {
    import_intent: explicit ? 'explicit' : (suggested ? 'suggested' : 'none'),
    topic: inferTopic(taskText),
    target_team: detectedTeam,
    projection_profile: projectionProfile,
    mode: 'snapshot',
    scope: mentionsSameTopic ? 'current_topic' : 'project',
    previous_result_policy: /무시|버리고|exclude|without\s+previous|from\s+scratch|새로|처음부터|마음에\s*안|별로/.test(text) ? 'exclude' : (/참고만|summarize|summary|요약만/.test(text) ? 'summarize_only' : 'optional'),
    permissions: {
      read_only: true,
      allow_propose_update: true,
      direct_write: false,
    },
    fork_policy: /둘\s*다|각자|병렬|parallel|fork|branch/.test(text) ? 'fork_on_branch' : 'none',
    reason_codes: uniq(reasonCodes, 8),
  };
}

export function summarizeMemoryImportIntent(intent = {}) {
  const row = intent && typeof intent === 'object' ? intent : {};
  const importIntent = cleanId(row.import_intent || 'none') || 'none';
  const targetTeam = cleanId(row.target_team || 'general') || 'general';
  const profile = cleanId(row.projection_profile || projectionProfileForTeam(targetTeam)) || 'general';
  return {
    import_intent: ['explicit', 'suggested', 'none'].includes(importIntent) ? importIntent : 'none',
    topic: cleanId(row.topic || 'current_topic') || 'current_topic',
    target_team: ['coding', 'paper', 'presentation', 'review', 'general'].includes(targetTeam) ? targetTeam : 'general',
    projection_profile: ['coding', 'paper', 'presentation', 'review', 'general'].includes(profile) ? profile : 'general',
    mode: cleanId(row.mode || 'snapshot') || 'snapshot',
    scope: cleanId(row.scope || 'project') || 'project',
    previous_result_policy: cleanId(row.previous_result_policy || 'optional') || 'optional',
    permissions: {
      read_only: row.permissions?.read_only !== false,
      allow_propose_update: row.permissions?.allow_propose_update !== false,
      direct_write: row.permissions?.direct_write === true,
    },
    fork_policy: cleanId(row.fork_policy || 'none') || 'none',
    reason_codes: uniq(row.reason_codes || [], 8),
  };
}
