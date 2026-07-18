import path from 'node:path';
import { cleanText, readJson, sha256, writeJsonAtomic } from './fs_utils.js';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export function roomInboxItemId(kind = '', source = '') {
  return `${cleanText(kind).toLowerCase()}:${sha256(`${cleanText(kind)}\n${cleanText(source)}`).slice(0, 12)}`;
}

export function roomGovernancePath(roomStateRoot = '') {
  return path.join(roomStateRoot, 'governance.json');
}

export function readRoomGovernance(roomStateRoot = '') {
  const current = readJson(roomGovernancePath(roomStateRoot), null);
  return current && typeof current === 'object' ? current : {
    schema_version: 'ai_rooms.room_governance/v1',
    decisions: [],
    corrections: [],
    updated_at: null,
  };
}

export function appendRoomGovernanceDecision(roomStateRoot = '', decision = {}) {
  const current = readRoomGovernance(roomStateRoot);
  const row = {
    decision_id: cleanText(decision.decision_id) || `decision-${Date.now()}-${sha256(JSON.stringify(decision)).slice(0, 8)}`,
    item_id: cleanText(decision.item_id),
    item_kind: cleanText(decision.item_kind).toLowerCase(),
    action: cleanText(decision.action).toLowerCase(),
    note: cleanText(decision.note).slice(0, 2400),
    actor: cleanText(decision.actor || 'user').slice(0, 160),
    source_run_id: cleanText(decision.source_run_id).slice(0, 200),
    created_at: decision.created_at || new Date().toISOString(),
  };
  const decisions = [...asArray(current.decisions), row].slice(-1000);
  writeJsonAtomic(roomGovernancePath(roomStateRoot), {
    ...current,
    schema_version: 'ai_rooms.room_governance/v1',
    decisions,
    updated_at: row.created_at,
  });
  return row;
}

export function appendRoomGovernanceCorrection(roomStateRoot = '', correction = {}) {
  const current = readRoomGovernance(roomStateRoot);
  const row = {
    correction_id: cleanText(correction.correction_id) || `correction-${Date.now()}-${sha256(cleanText(correction.text)).slice(0, 8)}`,
    text: cleanText(correction.text).slice(0, 2400),
    scope: cleanText(correction.scope || 'room').toLowerCase(),
    status: cleanText(correction.status || 'accepted').toLowerCase(),
    applies_to: cleanText(correction.applies_to || 'next_run').toLowerCase(),
    actor: cleanText(correction.actor || 'user').slice(0, 160),
    source_run_id: cleanText(correction.source_run_id).slice(0, 200),
    contract_revision: Number(correction.contract_revision || 0) || null,
    created_at: correction.created_at || new Date().toISOString(),
  };
  const corrections = [...asArray(current.corrections), row].slice(-500);
  writeJsonAtomic(roomGovernancePath(roomStateRoot), {
    ...current,
    schema_version: 'ai_rooms.room_governance/v1',
    corrections,
    updated_at: row.created_at,
  });
  return row;
}

function latestDecisionMap(governance = {}) {
  const map = new Map();
  for (const decision of asArray(governance.decisions)) {
    if (decision?.item_id) map.set(String(decision.item_id), decision);
  }
  return map;
}

export function buildRoomNativeInbox({ status = {}, receipts = [], artifacts = [], governance = null } = {}) {
  const decisions = latestDecisionMap(governance || {});
  const items = [];
  const runId = cleanText(status.focus_run_id);

  if (String(status.focus_status || '').toLowerCase() === 'awaiting_approval' && runId) {
    const id = roomInboxItemId('approval', runId);
    const decision = decisions.get(id);
    if (!decision || !['approve', 'reject'].includes(decision.action)) {
      items.push({
        item_id: id,
        kind: 'approval',
        severity: 'attention',
        title: '현재 Room 실행이 승인을 기다리고 있습니다.',
        detail: `run ${runId}`,
        source_run_id: runId,
        actions: ['approve', 'reject'],
      });
    }
  }

  for (const blocker of asArray(status.open_blockers)) {
    const text = cleanText(typeof blocker === 'string' ? blocker : blocker?.text || blocker?.summary || blocker?.message || JSON.stringify(blocker));
    if (!text) continue;
    const id = roomInboxItemId('blocker', `${runId}\n${text}`);
    const decision = decisions.get(id);
    if (decision?.action === 'resolve') continue;
    items.push({
      item_id: id,
      kind: 'blocker',
      severity: 'blocking',
      title: text,
      detail: runId ? `run ${runId}` : '',
      source_run_id: runId,
      actions: ['resolve'],
      resolution_semantics: 'owner_resolution_note_required',
    });
  }

  for (const artifact of asArray(artifacts)) {
    if (cleanText(artifact?.approval_state).toLowerCase() !== 'pending') continue;
    const artifactPath = cleanText(artifact?.relative_path || artifact?.location || artifact?.artifact_id);
    if (!artifactPath) continue;
    const id = roomInboxItemId('artifact', `${runId}\n${artifactPath}`);
    const decision = decisions.get(id);
    if (decision && ['approve', 'reject'].includes(decision.action)) continue;
    items.push({
      item_id: id,
      kind: 'artifact',
      severity: 'attention',
      title: `산출물 외부 전송 승인: ${artifactPath}`,
      detail: artifact?.receipt_hash ? `receipt ${String(artifact.receipt_hash).slice(0, 16)}` : '',
      source_run_id: runId,
      artifact_id: cleanText(artifact?.artifact_id),
      artifact_path: artifactPath,
      actions: ['approve', 'reject'],
    });
  }

  for (const receipt of asArray(receipts)) {
    for (const validation of asArray(receipt?.reported?.validations)) {
      const statusText = cleanText(validation?.status || 'reported').toLowerCase();
      if (!/(fail|error|blocked|timeout)/i.test(statusText)) continue;
      const name = cleanText(validation?.name || validation?.command || 'validation');
      const evidence = cleanText(validation?.evidence || '');
      const id = roomInboxItemId('validation', `${receipt.receipt_hash || receipt.receipt_id}\n${name}\n${statusText}`);
      const decision = decisions.get(id);
      if (decision?.action === 'resolve') continue;
      items.push({
        item_id: id,
        kind: 'validation',
        severity: 'warning',
        title: `${name} · ${statusText}`,
        detail: evidence,
        source_run_id: cleanText(receipt.run_id || runId),
        receipt_hash: cleanText(receipt.receipt_hash),
        actions: ['resolve'],
        resolution_semantics: 'acknowledgement_only',
      });
    }
  }

  return {
    schema_version: 'ai_rooms.room_inbox/v1',
    room_id: cleanText(status.room_id),
    run_id: runId || null,
    status: cleanText(status.focus_status),
    items: items.slice(0, 100),
    totals: {
      approvals: items.filter((item) => ['approval', 'artifact'].includes(item.kind)).length,
      blockers: items.filter((item) => item.kind === 'blocker').length,
      failed_validations: items.filter((item) => item.kind === 'validation').length,
      total: items.length,
    },
  };
}

export function normalizeInboxAction(action = '') {
  const clean = cleanText(action).toLowerCase();
  if (['approve', 'approved', 'accept', 'accepted'].includes(clean)) return 'approve';
  if (['reject', 'rejected', 'deny', 'denied'].includes(clean)) return 'reject';
  if (['resolve', 'resolved', 'ack', 'acknowledge', 'acknowledged'].includes(clean)) return 'resolve';
  return '';
}

export function findInboxItem(inbox = {}, itemIdOrNumber = '') {
  const items = asArray(inbox.items);
  const target = cleanText(itemIdOrNumber);
  if (/^\d+$/.test(target)) return items[Number(target) - 1] || null;
  return items.find((item) => String(item.item_id) === target) || null;
}
