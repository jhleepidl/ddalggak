import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function clean(value = '', maxLen = 2000) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function cleanId(value = '', fallback = '') {
  const text = clean(value, 180)
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return text || fallback;
}

function defaultCatalogPath() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../config/collaboration_profiles.json');
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return {};
  }
}

function normalizeProfile(raw = {}) {
  const row = asObject(raw);
  return {
    id: cleanId(row.id),
    title: clean(row.title, 240),
    title_ko: clean(row.title_ko, 240),
    status: cleanId(row.status, 'experimental'),
    runtime_support: cleanId(row.runtime_support, 'metadata_only'),
    description: clean(row.description, 1600),
    description_ko: clean(row.description_ko, 1600),
    execution_pattern: cleanId(row.execution_pattern, 'task_adaptive'),
    min_participants: Math.max(1, Number(row.min_participants || 1)),
    max_participants: Math.max(1, Number(row.max_participants || row.min_participants || 1)),
    relative_cost: clean(row.relative_cost, 80),
    room_awareness: cleanId(row.room_awareness, 'shared_goal_only'),
    initial_visibility: cleanId(row.initial_visibility, 'adaptive'),
    synthesis_required: row.synthesis_required === true,
    diversity_contract: asObject(row.diversity_contract),
    activation_policy: asObject(row.activation_policy),
    good_for: asArray(row.good_for).map((item) => clean(item, 300)).filter(Boolean),
    not_for: asArray(row.not_for).map((item) => clean(item, 300)).filter(Boolean),
  };
}

export function loadCollaborationProfileCatalog({ catalogPath = '' } = {}) {
  const sourcePath = path.resolve(catalogPath || defaultCatalogPath());
  const parsed = asObject(readJson(sourcePath));
  return {
    schema_version: clean(parsed.schema_version || 'ai_rooms.collaboration_profile_catalog/v1', 120),
    catalog_version: clean(parsed.catalog_version || 'unknown', 160),
    source_path: sourcePath,
    profiles: asArray(parsed.profiles).map(normalizeProfile).filter((row) => row.id),
  };
}

export function listCollaborationProfiles({ query = '', includePreview = true, catalogPath = '' } = {}) {
  const catalog = loadCollaborationProfileCatalog({ catalogPath });
  const q = clean(query, 300).toLowerCase();
  return {
    ...catalog,
    profiles: catalog.profiles.filter((profile) => {
      if (!includePreview && profile.runtime_support !== 'native') return false;
      if (!q) return true;
      const haystack = [
        profile.id,
        profile.title,
        profile.title_ko,
        profile.description,
        profile.description_ko,
        profile.execution_pattern,
        ...profile.good_for,
        ...profile.not_for,
      ].join(' ').toLowerCase();
      return haystack.includes(q);
    }),
  };
}

export function getCollaborationProfile(profileId = '', options = {}) {
  const id = cleanId(profileId);
  if (!id) return null;
  return loadCollaborationProfileCatalog(options).profiles.find((profile) => profile.id === id) || null;
}

export function resolveRoomCollaborationProfile(roomProfile = {}, options = {}) {
  const row = asObject(roomProfile);
  const requestedId = cleanId(
    row.collaboration_profile_id
      || row.collaborationProfileId
      || asObject(row.collaboration).profile_id
      || asObject(row.collaboration).profileId
      || 'auto',
    'auto'
  );
  return getCollaborationProfile(requestedId, options) || getCollaborationProfile('auto', options);
}

export function buildCollaborationInteractionPatch(profileOrId = 'auto', options = {}) {
  const profile = typeof profileOrId === 'string'
    ? getCollaborationProfile(profileOrId, options)
    : normalizeProfile(profileOrId);
  if (!profile || profile.id === 'auto') return {};
  return {
    execution_pattern: profile.execution_pattern,
    collaboration_profile_id: profile.id,
    collaboration_contract: {
      profile_id: profile.id,
      room_awareness: profile.room_awareness,
      initial_visibility: profile.initial_visibility,
      min_participants: profile.min_participants,
      max_participants: profile.max_participants,
      synthesis_required: profile.synthesis_required,
      diversity_contract: Object.keys(profile.diversity_contract).length ? profile.diversity_contract : undefined,
      activation_policy: Object.keys(profile.activation_policy).length ? profile.activation_policy : undefined,
      runtime_support: profile.runtime_support,
    },
  };
}

function supportBadge(profile) {
  if (profile.runtime_support === 'native' && profile.status === 'stable') return '✅';
  if (profile.runtime_support === 'native') return '🧪';
  return '👀';
}

export function formatCollaborationProfileListForTelegram({ query = '', catalogPath = '' } = {}) {
  const catalog = listCollaborationProfiles({ query, catalogPath });
  const lines = [
    `🤝 Collaboration profiles · ${catalog.catalog_version}`,
    '명시적으로 선택한 profile만 Room 실행 패턴을 고정합니다. 기본값 auto는 현재 router를 유지합니다.',
    '',
  ];
  for (const profile of catalog.profiles) {
    lines.push(`${supportBadge(profile)} ${profile.id} · ${profile.title_ko || profile.title}`);
    lines.push(`  ${profile.description_ko || profile.description}`);
    lines.push(`  pattern=${profile.execution_pattern} · cost=${profile.relative_cost || 'unknown'} · support=${profile.runtime_support}`);
  }
  lines.push('', '상세: /collab show <profile_id>');
  lines.push('적용: /collab use <profile_id>');
  lines.push('초기화: /collab reset');
  return lines.join('\n');
}

export function formatCollaborationProfileDetailForTelegram(profile = null) {
  if (!profile) return 'Collaboration profile을 찾지 못했습니다.';
  const lines = [
    `${supportBadge(profile)} ${profile.title_ko || profile.title}`,
    `ID: ${profile.id}`,
    `상태: ${profile.status} · runtime support: ${profile.runtime_support}`,
    `실행 패턴: ${profile.execution_pattern}`,
    `참여자: ${profile.min_participants}-${profile.max_participants} · 예상 비용: ${profile.relative_cost || 'unknown'}`,
    `Room awareness: ${profile.room_awareness}`,
    `초기 가시성: ${profile.initial_visibility}`,
    '',
    profile.description_ko || profile.description,
  ];
  if (profile.good_for.length) lines.push('', '적합:', ...profile.good_for.map((item) => `- ${item}`));
  if (profile.not_for.length) lines.push('', '부적합:', ...profile.not_for.map((item) => `- ${item}`));
  if (profile.runtime_support !== 'native') {
    lines.push('', '이 profile은 아직 preview입니다. Room 설정에 저장할 수 있지만 production 실행 패턴으로 강제 적용되지는 않습니다.');
  } else {
    lines.push('', `적용: /collab use ${profile.id}`);
  }
  return lines.join('\n');
}
