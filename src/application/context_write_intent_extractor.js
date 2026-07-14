import crypto from 'node:crypto';

function clean(value = '') { return String(value ?? '').trim(); }
function asObject(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function asArray(value) { return Array.isArray(value) ? value : []; }
function stableHash(value = '') { return crypto.createHash('sha1').update(String(value || '')).digest('hex').slice(0, 12); }
function clip(value = '', max = 1200) { const s = String(value || ''); return s.length > max ? `${s.slice(0, max)}…` : s; }

function linesMatching(text = '', patterns = []) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => patterns.some((pattern) => pattern.test(line)))
    .slice(0, 8)
    .map((line) => line.replace(/^[-*•]\s*/, ''));
}

function makeIntentId(parts = []) {
  return `intent_${stableHash(parts.join(':'))}`;
}

export function extractContextWriteIntentsFromAgentResult({
  agentId = '',
  roleId = '',
  goal = '',
  result = {},
  preparedContext = null,
  deliveryRequirements = null,
  collaborationLane = null,
} = {}) {
  const output = clean(result?.output || result?.text || '');
  const provider = clean(result?.provider || '');
  const model = clean(result?.model || '');
  const role = clean(roleId || agentId || 'agent').toLowerCase();
  const snapshotId = clean(preparedContext?.context_info?.snapshot_id || preparedContext?.context_info?.context_projection?.snapshot_id || '');
  const projectionId = clean(preparedContext?.context_info?.projection_id || preparedContext?.context_info?.context_projection?.projection_id || '');
  const actor = `agent:${clean(agentId || role || 'agent')}`;
  const lane = asObject(collaborationLane);
  const laneId = clean(lane.lane_id || lane.laneId);
  const intents = [];

  intents.push({
    id: makeIntentId([actor, 'activity', projectionId, output.slice(0, 120)]),
    actor,
    intent_type: 'append_event',
    payload: {
      atom_type: 'event',
      event_type: 'agent_run_completed',
      title: `${clean(agentId || role || 'agent')} completed`,
      canonical_text_en: clip(output, 900),
      structured: {
        role_id: role,
        provider,
        model,
        output_chars: output.length,
        projection_id: projectionId || undefined,
        delivery_requirements: asObject(deliveryRequirements),
        lane_id: laneId || undefined,
        collaboration_lane: laneId ? lane : undefined,
      },
    },
    preconditions: snapshotId ? { base_snapshot_id: snapshotId } : {},
  });

  if (provider || model) {
    intents.push({
      id: makeIntentId([actor, 'usage', provider, model, projectionId]),
      actor,
      intent_type: 'record_usage',
      payload: {
        atom_type: 'usage_event',
        provider,
        model,
        role_id: role,
        projection_id: projectionId || undefined,
        output_chars: output.length,
      },
      preconditions: snapshotId ? { base_snapshot_id: snapshotId } : {},
    });
  }

  const findingLines = linesMatching(output, [/\bfinding\b/i, /\bissue\b/i, /\brisk\b/i, /\bblocker\b/i, /\bwarning\b/i, /리스크|문제|차단|경고/]);
  if (findingLines.length || role.includes('review')) {
    const findingText = findingLines.length ? findingLines.join('\n') : clip(output, 900);
    intents.push({
      id: makeIntentId([actor, 'review_finding', projectionId, findingText.slice(0, 120)]),
      actor,
      intent_type: 'assert_atom',
      payload: {
        id: `atom_review_${stableHash(`${actor}:${projectionId}:${findingText}`)}`,
        atom_type: 'review_finding',
        title: `${clean(agentId || role || 'agent')} review finding`,
        canonical_text_en: findingText,
        structured: {
          role_id: role,
          goal: clip(goal, 500),
          provider,
          model,
          projection_id: projectionId || undefined,
          lane_id: laneId || undefined,
          collaboration_lane: laneId ? lane : undefined,
        },
        tags: ['review', role, laneId].filter(Boolean),
        evidence_refs: projectionId ? [`projection:${projectionId}`] : [],
        confidence: 0.7,
      },
      preconditions: snapshotId ? { base_snapshot_id: snapshotId } : {},
    });
  }

  const verificationLines = linesMatching(output, [/\btest\b/i, /\bbuild\b/i, /\blint\b/i, /\btypecheck\b/i, /\bverify\b/i, /검증|테스트|빌드/]);
  if (verificationLines.length) {
    intents.push({
      id: makeIntentId([actor, 'verification', projectionId, verificationLines.join('|')]),
      actor,
      intent_type: 'assert_atom',
      payload: {
        id: `atom_verification_${stableHash(`${actor}:${projectionId}:${verificationLines.join('|')}`)}`,
        atom_type: 'verification_result',
        title: `${clean(agentId || role || 'agent')} verification notes`,
        canonical_text_en: verificationLines.join('\n'),
        structured: { role_id: role, provider, model, projection_id: projectionId || undefined, lane_id: laneId || undefined, collaboration_lane: laneId ? lane : undefined },
        tags: ['verification', role, laneId].filter(Boolean),
        evidence_refs: projectionId ? [`projection:${projectionId}`] : [],
        confidence: 0.75,
      },
      preconditions: snapshotId ? { base_snapshot_id: snapshotId } : {},
    });
  }

  return intents;
}
