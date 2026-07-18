function clean(value = '', max = 600) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1)).trim()}…`;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

const STATUS_LABELS = {
  queued: '시작 대기',
  running: '작업 중',
  paused: '일시정지',
  awaiting_approval: '승인 대기',
  completed: '완료',
  completed_with_blockers: '확인 필요',
  failed: '실패',
  cancelled: '취소됨',
};

export function roomNativePrimaryPathEnabled({ env = process.env, service = null } = {}) {
  if (service?.isEnabled?.() !== true) return false;
  const raw = String(env.ROOM_NATIVE_PRIMARY_USER_PATH ?? 'true').trim().toLowerCase();
  return !['0', 'false', 'no', 'off'].includes(raw);
}

export function hasRoomNativeUserState(status = {}, contract = null) {
  return Boolean(
    status?.focus_run_id
    || status?.active_run_id
    || status?.contract_revision
    || contract?.contract_hash
    || contract?.goal
    || contract?.objective,
  );
}

export function roomStatusLabel(status = '') {
  const key = String(status || '').trim().toLowerCase();
  return STATUS_LABELS[key] || (key ? key : '아직 시작하지 않음');
}

function progressLine(status = {}) {
  const total = Number(status.stage_total || 0);
  const done = Number(status.stage_done_count || 0);
  if (!total) return '';
  const percent = Math.min(100, Math.max(0, Math.round((done / total) * 100)));
  return `${done}/${total} · ${percent}%`;
}

function recommendedAction(status = {}, contract = null) {
  const current = String(status.focus_status || '').trim().toLowerCase();
  if (status.active_run_id && current === 'running') return '작업이 진행 중입니다. /status 또는 /room timeline으로 확인하세요.';
  if (['paused', 'failed', 'awaiting_approval', 'running'].includes(current) && status.focus_run_id) return '/continue로 이어가세요.';
  if (current === 'completed_with_blockers' || asArray(status.open_blockers).length) return '/inbox에서 남은 문제를 확인하고 처리하세요.';
  if (current === 'completed') return '결과를 확인하고 다음 목표는 /run <목표>로 시작하세요.';
  if (status.next_action) return clean(status.next_action, 500);
  if (contract?.continuity?.next_action) return clean(contract.continuity.next_action, 500);
  return '/run <목표>로 첫 작업을 시작하세요.';
}

export function buildRoomNativeReplyKeyboard(status = {}) {
  const current = String(status.focus_status || '').trim().toLowerCase();
  const resumable = Boolean(status.focus_run_id && ['paused', 'failed', 'awaiting_approval', 'running'].includes(current));
  const firstRow = resumable ? ['/continue', '/status'] : ['/brief', '/status'];
  return {
    keyboard: [
      firstRow.map((text) => ({ text })),
      [{ text: '/artifacts' }, { text: '/inbox' }],
      [{ text: '/sources' }, { text: '/rules' }],
    ],
    resize_keyboard: true,
    one_time_keyboard: true,
    selective: true,
  };
}

export function buildRoomNativeHomeCard({ status = {}, contract = null } = {}) {
  const blockers = asArray(status.open_blockers);
  const progress = progressLine(status);
  const goal = clean(status.goal || contract?.goal || status.objective || contract?.objective || '', 500);
  const objective = clean(status.objective || contract?.objective || '', 500);
  const lines = [
    '🏠 AI Room',
    goal ? `목표: ${goal}` : '목표: 아직 설정되지 않음',
    objective && objective !== goal ? `현재 작업: ${objective}` : '',
    `상태: ${roomStatusLabel(status.focus_status)}`,
    progress ? `진행: ${progress}` : '',
    status.current_stage_id ? `현재 단계: ${status.current_stage_id}` : '',
    blockers.length ? `확인 필요: blocker ${blockers.length}개` : '',
    '',
    `다음: ${recommendedAction(status, contract)}`,
  ].filter(Boolean);

  if (!hasRoomNativeUserState(status, contract)) {
    lines.push('', '시작 방법:', '/run <하고 싶은 일>', '예: /run 이 프로젝트의 실패 테스트를 고치고 검증해줘');
  } else {
    lines.push('', '아래 버튼이나 같은 명령을 사용하면 됩니다.');
  }

  return {
    text: lines.join('\n'),
    options: { reply_markup: buildRoomNativeReplyKeyboard(status) },
  };
}

export function formatRoomNativeUserBrief({ status = {}, contract = null } = {}) {
  const blockers = asArray(status.open_blockers);
  const lines = [
    '🧭 Room Brief',
    `목표: ${clean(status.goal || contract?.goal || status.objective || contract?.objective || '아직 설정되지 않음', 600)}`,
    `상태: ${roomStatusLabel(status.focus_status)}`,
    progressLine(status) ? `진행: ${progressLine(status)}` : '',
    status.current_stage_id ? `현재 단계: ${status.current_stage_id}` : '',
    status.next_stage_id && status.next_stage_id !== status.current_stage_id ? `다음 단계: ${status.next_stage_id}` : '',
    `다음 행동: ${recommendedAction(status, contract)}`,
    blockers.length ? `미해결 blocker: ${blockers.length}개` : '',
    status.receipt_count ? `검증 기록: ${status.receipt_count}개` : '',
    '',
    status.active_run_id ? '제어: /pause · /cancel' : '새 작업: /run <목표>',
    '세부 기록: /room timeline · /room receipts',
  ].filter(Boolean);
  return lines.join('\n');
}

export function formatRoomNativeUserSources(contract = null) {
  if (!contract) return '📚 Room Sources\n아직 Room Contract가 없습니다. /run <목표>로 작업을 시작하세요.';
  const authoritative = asArray(contract.sources?.authoritative);
  const excluded = asArray(contract.sources?.excluded);
  return [
    '📚 Room Sources',
    '',
    '신뢰하는 근거:',
    ...(authoritative.length ? authoritative.map((item) => `- ${clean(item?.label || item?.location || item?.path || item, 500)}`) : ['- 아직 명시된 근거 없음']),
    '',
    '사용하지 않을 근거:',
    ...(excluded.length ? excluded.map((item) => `- ${clean(item?.label || item?.location || item?.path || item, 500)}`) : ['- 없음']),
    '',
    '새 근거를 추가하려면 파일을 업로드하거나 다음 작업 요청에 출처 범위를 명시하세요.',
  ].join('\n');
}

export function formatRoomNativeUserRules(contract = null) {
  if (!contract) return '📌 Room Rules & Corrections\n아직 Room Contract가 없습니다. /run <목표>로 작업을 시작하세요.';
  const rules = asArray(contract.constraints);
  const corrections = asArray(contract.corrections).filter((row) => String(row?.status || 'active').toLowerCase() === 'active');
  return [
    '📌 Room Rules & Corrections',
    '',
    '현재 규칙:',
    ...(rules.length ? rules.map((item, index) => `${index + 1}. ${clean(item, 700)}`) : ['- 없음']),
    '',
    '활성 정정:',
    ...(corrections.length ? corrections.map((item, index) => `${index + 1}. ${clean(item?.text || item?.correction_text || item, 700)}`) : ['- 없음']),
    '',
    '추가: /rule <지침>',
    '정정: /correct <앞으로 반복하지 않을 내용>',
  ].join('\n');
}

function formatBytes(bytes = 0) {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value < 0) return '-';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
  return `${(value / (1024 * 1024)).toFixed(value < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

export function formatRoomNativeArtifacts(result = {}) {
  if (!result.run_id) return '📎 Room Artifacts\n아직 표시할 Room 산출물이 없습니다.';
  const artifacts = asArray(result.artifacts);
  const lines = [
    `📎 Room Artifacts · ${result.run_id}`,
    `상태: ${roomStatusLabel(result.status)}${result.contract_revision ? ` · contract v${result.contract_revision}` : ''}`,
    '',
  ];
  if (!artifacts.length) {
    lines.push('- 전달 가능한 산출물이 아직 없습니다.', '', '변경 파일과 테스트 증거는 /room receipts에서 확인할 수 있습니다.');
    return lines.join('\n');
  }
  for (const [index, item] of artifacts.entries()) {
    const label = clean(item?.label || item?.title || item?.name || item?.relative_path || item?.path || item?.location || item, 500);
    const artifactPath = clean(item?.relative_path || item?.path || item?.location || '', 700);
    const badges = [
      item?.available === false ? '없음' : formatBytes(item?.bytes),
      item?.previewable ? '미리보기' : '',
      item?.sendable ? '전송 가능' : item?.available === false ? '' : '전송 제한',
      item?.approval_state && item.approval_state !== 'not_required' ? `승인 ${item.approval_state}` : '',
    ].filter(Boolean);
    lines.push(`${index + 1}. ${label || 'artifact'}${badges.length ? ` · ${badges.join(' · ')}` : ''}`);
    if (artifactPath && artifactPath !== label) lines.push(`   ${artifactPath}`);
    const evidence = [item?.provider, item?.stage_id, item?.receipt_hash ? `receipt ${String(item.receipt_hash).slice(0, 12)}` : ''].filter(Boolean);
    if (evidence.length) lines.push(`   ${evidence.join(' · ')}`);
    if (item?.available === false && item?.error) lines.push(`   확인 필요: ${clean(item.error, 300)}`);
  }
  lines.push('', '미리보기: /artifacts preview <번호>', '파일 받기: /send <번호>', '실행 증거: /room receipts');
  return lines.join('\n');
}

export function formatRoomNativeArtifactPreview(result = {}) {
  const preview = result?.preview || {};
  const artifact = preview?.artifact || result?.artifact || {};
  const artifactPath = clean(artifact?.relative_path || artifact?.location || '', 700);
  const body = String(preview?.text || '');
  return [
    `👁️ Artifact Preview · ${artifactPath || artifact?.label || '-'}`,
    `크기: ${formatBytes(preview.total_bytes || artifact?.bytes)}${preview.truncated ? ` · 앞 ${formatBytes(preview.bytes_read)}만 표시` : ''}`,
    artifact?.receipt_hash ? `receipt: ${String(artifact.receipt_hash).slice(0, 16)}` : '',
    '',
    body || '(빈 파일)',
    preview.truncated ? '\n… 전체 파일은 /send로 받으세요.' : '',
  ].filter((value, index) => value || index === 3).join('\n');
}

export function formatRoomNativeInbox(inbox = {}, { companionPending = 0 } = {}) {
  const items = asArray(inbox.items);
  const lines = [
    '📥 Room Inbox',
    `승인 ${inbox?.totals?.approvals || 0} · blocker ${inbox?.totals?.blockers || 0} · 실패 검증 ${inbox?.totals?.failed_validations || 0}`,
    companionPending ? `정정/메모리 제안 ${Number(companionPending || 0)}` : '',
    '',
  ].filter((value, index) => value || index === 3);
  if (!items.length && !companionPending) {
    lines.push('현재 사용자가 처리할 항목이 없습니다.', '', '현재 상태: /status');
    return lines.join('\n');
  }
  for (const [index, item] of items.entries()) {
    const kind = item.kind === 'approval' ? '승인' : item.kind === 'artifact' ? '산출물 승인' : item.kind === 'blocker' ? 'blocker' : '검증 실패';
    lines.push(`${index + 1}. [${kind}] ${clean(item.title, 800)}`);
    if (item.detail) lines.push(`   ${clean(item.detail, 800)}`);
    lines.push(`   id=${item.item_id} · action=${asArray(item.actions).join('|')}`);
    if (item.resolution_semantics === 'acknowledgement_only') lines.push('   주의: resolve는 실패를 통과로 바꾸지 않고 확인 기록만 남깁니다.');
    if (item.resolution_semantics === 'owner_resolution_note_required') lines.push('   주의: blocker를 닫으려면 결정 또는 수용 근거 메모가 필요합니다.');
  }
  lines.push('', '처리: /inbox approve|reject|resolve <번호|id> [메모]', 'blocker resolve에는 메모가 필수입니다.');
  if (companionPending) lines.push('정정 제안: /correct proposals');
  lines.push('상세 증거: /room receipts');
  return lines.join('\n');
}

function receiptSummary(receipts = []) {
  let files = 0;
  let validations = 0;
  let failedValidations = 0;
  let blockers = 0;
  const changed = [];
  for (const receipt of receipts) {
    const fileRows = asArray(receipt?.workspace?.files_changed);
    files += fileRows.length || Number(receipt?.file_change_count || 0);
    for (const row of fileRows) {
      const p = clean(row?.path || row?.file || '', 240);
      if (p && !changed.includes(p)) changed.push(p);
    }
    const validationRows = asArray(receipt?.reported?.validations);
    validations += validationRows.length || Number(receipt?.validation_count || 0);
    failedValidations += validationRows.filter((row) => /fail|error|blocked/i.test(String(row?.status || ''))).length;
    blockers += asArray(receipt?.reported?.blocking_issues).length || Number(receipt?.blocker_count || 0);
  }
  return { files, validations, failedValidations, blockers, changed: changed.slice(0, 5) };
}

export function formatRoomNativeCompletion({ result = {}, status = {}, receipts = [] } = {}) {
  const needsAttention = result?.needs_attention === true || asArray(status.open_blockers).length > 0;
  const summary = clean(
    result?.finalStage?.structured?.user_message
      || result?.finalStage?.structured?.summary
      || result?.finalStage?.output_excerpt
      || '',
    1800,
  );
  const evidence = receiptSummary(receipts);
  const runId = result?.run?.paths?.runId || status.focus_run_id || '';
  const lines = [
    needsAttention ? '⚠️ 작업은 끝났지만 확인이 필요합니다' : '✅ 작업을 완료했습니다',
    summary,
    '',
    runId ? `run: ${runId}` : '',
    evidence.files ? `변경 파일: ${evidence.files}개${evidence.changed.length ? ` · ${evidence.changed.join(', ')}` : ''}` : '변경 파일: 없음 또는 미보고',
    evidence.validations ? `검증: ${evidence.validations}개${evidence.failedValidations ? ` · 실패/오류 ${evidence.failedValidations}개` : ' · 통과'}` : '검증: 미보고',
    needsAttention || evidence.blockers ? `남은 blocker: ${Math.max(evidence.blockers, asArray(status.open_blockers).length)}개` : '',
    status.next_action ? `다음 행동: ${clean(status.next_action, 500)}` : '',
    '',
    '확인: /artifacts · /inbox · /room receipts · /room timeline',
    '다음 작업: /run <목표>',
  ];
  return lines.filter((value, index) => value || index === 2 || index === 8).join('\n');
}

export function formatRoomNativeActionError(error, { action = '작업', status = null } = {}) {
  const code = String(error?.code || '').trim();
  const message = clean(error?.message || error || 'unknown error', 900);
  if (code === 'ROOM_RUN_ALREADY_ACTIVE') {
    return [`이미 Room 작업이 실행 중입니다.`, status?.focus_run_id ? `run: ${status.focus_run_id}` : '', '확인: /status · /room timeline', '중단: /cancel'].filter(Boolean).join('\n');
  }
  if (code === 'ROOM_RUN_NOT_FOUND') {
    return '이어갈 Room 작업을 찾지 못했습니다.\n새 작업: /run <목표>\n최근 상태: /status';
  }
  if (code === 'ROOM_WORKSPACE_REVISION_DRIFT') {
    return ['workspace가 마지막 checkpoint 이후 바뀌어 안전하게 재개하지 않았습니다.', `예상 revision: ${clean(error?.expected_revision || '', 120) || '-'}`, `현재 revision: ${clean(error?.actual_revision || '', 120) || '-'}`, '먼저 변경 내용을 확인한 뒤 새 /run으로 시작하거나 운영자가 drift 정책을 검토하세요.'].join('\n');
  }
  if (code === 'ROOM_CONTRACT_REVISION_DRIFT') {
    return 'Room 규칙이나 계약이 checkpoint 이후 바뀌어 재개하지 않았습니다.\n/room contract로 확인한 뒤 새 /run으로 시작하세요.';
  }
  return `${action} 실패: ${message}\n상태 확인: /status · 진단: /doctor`;
}
