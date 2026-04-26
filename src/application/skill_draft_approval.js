import crypto from 'node:crypto';

function clean(value = '', max = 500) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, max);
}

function slugify(value = '') {
  const ascii = clean(value, 80)
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  return ascii || 'custom_skill';
}

function inferSideEffect(text = '') {
  if (/예약|구매|주문|삭제|수정|전송|배포|commit|promote|install|delete|send|book|buy|order/i.test(text)) return 'requires_confirmation';
  if (/검색|조회|api|웹|주변|latest|search|lookup|nearby/i.test(text)) return 'read_only';
  return 'none';
}

function inferCredentialRequirements(text = '') {
  const reqs = [];
  if (/kakao|카카오/i.test(text)) reqs.push({ id: 'kakao_api_key', required: false, note: 'Needed only for direct Kakao API execution.' });
  if (/naver|네이버/i.test(text)) reqs.push({ id: 'naver_api_key', required: false, note: 'Needed only for direct Naver API execution.' });
  if (/google|구글|maps?/i.test(text)) reqs.push({ id: 'google_maps_api_key', required: false, note: 'Needed only for direct Google Maps execution.' });
  return reqs;
}

function inferTags(text = '') {
  const tags = ['draft', 'user_approved'];
  if (/음식|메뉴|영양|식사|food|meal|nutrition/i.test(text)) tags.push('food');
  if (/검색|주변|지도|배달|search|nearby|delivery/i.test(text)) tags.push('search');
  if (/기억|기록|저장|memory|history|log/i.test(text)) tags.push('memory');
  if (/코드|패치|repo|code|patch/i.test(text)) tags.push('coding');
  return [...new Set(tags)].slice(0, 8);
}

export function buildSkillDraftFromRequest({ request = '', source = 'telegram', createdBy = '' } = {}) {
  const text = clean(request, 2000);
  if (!text) return null;
  const slug = slugify(text);
  const id = `skill.draft.${slug}.v1`;
  const sideEffect = inferSideEffect(text);
  const tags = inferTags(text);
  return {
    id,
    name: `Draft Skill: ${clean(text, 48)}`,
    description: `User-approved draft skill generated from request: ${text}`,
    skill_type: sideEffect === 'none' ? 'prompt_only' : 'tool_or_prompt_draft',
    trust_level: 'draft_requires_review',
    side_effect_level: sideEffect,
    credential_requirements: inferCredentialRequirements(text),
    execution_adapter: {
      type: 'draft_prompt_template',
      instructions: [
        'Use this skill only after user approval.',
        'Keep actions within declared side_effect_level.',
        'If credentials or external calls are needed, ask for explicit confirmation first.',
        `Original request: ${text}`,
      ],
    },
    source_package: {
      kind: 'telegram_skill_draft',
      source,
      created_by: createdBy,
      original_request: text,
    },
    tags,
    lifecycle: {
      status: 'draft_pending_user_approval',
      created_at: new Date().toISOString(),
    },
  };
}

export function buildSkillDraftApprovalState({ draft = null, chatId = '', userId = '' } = {}) {
  if (!draft?.id) return null;
  const token = crypto.createHash('sha1').update(JSON.stringify({ id: draft.id, chatId, userId, created_at: draft?.lifecycle?.created_at || '' })).digest('hex').slice(0, 16);
  return {
    kind: 'skill_draft_approval',
    token,
    draft,
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
  };
}

export function formatSkillDraftApprovalMessage(state = {}) {
  const draft = state?.draft || {};
  return [
    '🧩 skill 초안 승인 필요',
    `id=${draft.id || '(missing)'}`,
    `name=${draft.name || '(missing)'}`,
    `side_effect=${draft.side_effect_level || 'unknown'}`,
    `trust=${draft.trust_level || 'unknown'}`,
    `credentials=${Array.isArray(draft.credential_requirements) && draft.credential_requirements.length ? draft.credential_requirements.map((r) => r.id || r.name || r).join(', ') : '(none)'}`,
    '',
    '승인하면 GoC skill package로 publish/install을 시도합니다. side_effect가 read_only보다 높으면 실제 실행 전 추가 확인을 유지해야 합니다.',
  ].join('\n');
}

export function isSkillDraftApprovalCallbackData(data = '') {
  const raw = String(data || '').trim();
  return raw.startsWith('approve_skill:') || raw.startsWith('reject_skill:');
}

export function parseSkillDraftApprovalCallbackData(data = '') {
  const raw = String(data || '').trim();
  const [action, token] = raw.split(':');
  return {
    action: action === 'approve_skill' ? 'approve' : (action === 'reject_skill' ? 'reject' : ''),
    token: String(token || '').trim(),
  };
}
