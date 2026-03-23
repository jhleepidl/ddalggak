import { buildTeamInstallProposal } from './install_proposal.js';
import { getCredentialCoverageForProposal } from './credential_binding.js';

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function clean(value = '') {
  return String(value || '').trim();
}

function normalizeApplyState(value = 'pending') {
  return String(value || '').trim().toLowerCase() === 'active' ? 'active' : 'pending';
}

function normalizeStatus(value = 'awaiting_install_approval') {
  const key = String(value || '').trim().toLowerCase();
  if (['awaiting_install_approval', 'installed_pending', 'applied_active', 'dismissed'].includes(key)) return key;
  return 'awaiting_install_approval';
}

function normalizeResumeRequest(raw = {}) {
  const row = asObject(raw);
  const message = clean(row.message);
  if (!message) return null;
  return {
    message,
    input_kind: clean(row.input_kind || row.inputKind || 'chat_message') || 'chat_message',
    force_mode: clean(row.force_mode || row.forceMode || 'normal') || 'normal',
    telegram_message_id: Number.isFinite(Number(row.telegram_message_id)) ? Number(row.telegram_message_id) : null,
    user_reply_to_message_id: Number.isFinite(Number(row.user_reply_to_message_id)) ? Number(row.user_reply_to_message_id) : null,
    chat_info: row.chat_info && typeof row.chat_info === 'object' ? row.chat_info : null,
  };
}


function proposalHasActionableBlockingGap(proposal = null) {
  const row = proposal && typeof proposal === 'object' ? proposal : {};
  if (row.blocking === true) return true;
  const requirements = row.requirements && typeof row.requirements === 'object' ? row.requirements : {};
  const sections = [requirements.capabilities, requirements.external_tools, requirements.credentials, requirements.skills];
  return sections.some((entries) => Array.isArray(entries) && entries.some((entry) => String(entry?.severity || 'blocking').trim().toLowerCase() === 'blocking'));
}

export function shouldResumeInstallProposal(state = {}) {
  const normalized = normalizeInstallProposalState(state);
  if (!normalized?.resume_request?.message) return false;
  return proposalHasActionableBlockingGap(normalized.proposal);
}

export function isActionableInstallProposalState(state = {}) {
  const normalized = normalizeInstallProposalState(state);
  if (!normalized) return false;
  return proposalHasActionableBlockingGap(normalized.proposal);
}

export function normalizeInstallProposalState(raw = {}) {
  const row = asObject(raw);
  const proposal = row.proposal && typeof row.proposal === 'object' ? row.proposal : null;
  if (!proposal) return null;
  return {
    kind: 'team_install_proposal_state',
    version: 1,
    status: normalizeStatus(row.status),
    apply_state: normalizeApplyState(row.apply_state || row.applyState || proposal?.apply_state || 'pending'),
    source: clean(row.source || proposal?.source || 'execution_gap') || 'execution_gap',
    created_at: clean(row.created_at || row.createdAt || new Date().toISOString()) || new Date().toISOString(),
    updated_at: clean(row.updated_at || row.updatedAt || row.created_at || row.createdAt || new Date().toISOString()) || new Date().toISOString(),
    proposal,
    resume_request: normalizeResumeRequest(row.resume_request || row.resumeRequest || null),
    summary: clean(row.summary || '') || undefined,
  };
}

export function createPendingInstallProposalState({ proposal = null, resumeRequest = null, source = '', applyState = 'pending', summary = '' } = {}) {
  const normalizedProposal = proposal && typeof proposal === 'object' ? proposal : null;
  if (!normalizedProposal) return null;
  const now = new Date().toISOString();
  return normalizeInstallProposalState({
    kind: 'team_install_proposal_state',
    version: 1,
    status: 'awaiting_install_approval',
    apply_state: normalizeApplyState(applyState || normalizedProposal?.apply_state || 'pending'),
    source: clean(source || normalizedProposal?.source || 'execution_gap') || 'execution_gap',
    created_at: now,
    updated_at: now,
    proposal: normalizedProposal,
    resume_request: resumeRequest,
    summary,
  });
}

export function buildInstallProposalStateFromExecution({ team = {}, runtime = null, execution = null, applyState = 'pending', resumeRequest = null, source = 'execution_gap' } = {}) {
  const proposal = buildTeamInstallProposal({ team, runtime, execution, applyState });
  if (!proposal || Number(proposal.gap_count || 0) <= 0) return null;
  if (!proposalHasActionableBlockingGap(proposal)) return null;
  return createPendingInstallProposalState({
    proposal,
    resumeRequest,
    source,
    applyState: proposal.apply_state || applyState,
    summary: proposal.gap_preview_lines?.[0] || '',
  });
}

export function getPendingInstallProposal(sessionStore, chatId) {
  const session = sessionStore?.get?.(chatId);
  return normalizeInstallProposalState(session?.pending_install_proposal || null);
}

export function setPendingInstallProposal(sessionStore, chatId, state = null) {
  const normalized = normalizeInstallProposalState(state);
  return sessionStore.upsert(chatId, (session) => ({
    ...session,
    pending_install_proposal: normalized,
    awaiting_install_approval: !!normalized,
  }));
}

export function clearPendingInstallProposal(sessionStore, chatId, { preserveLast = true } = {}) {
  const current = getPendingInstallProposal(sessionStore, chatId);
  return sessionStore.upsert(chatId, (session) => ({
    ...session,
    pending_install_proposal: null,
    awaiting_install_approval: false,
    last_install_proposal: preserveLast && current ? current : session?.last_install_proposal || null,
  }));
}


export function archivePendingInstallProposal(sessionStore, chatId, status = 'dismissed', extra = {}) {
  const current = getPendingInstallProposal(sessionStore, chatId);
  if (!current) return null;
  const next = normalizeInstallProposalState({
    ...current,
    ...extra,
    status,
    updated_at: new Date().toISOString(),
  });
  sessionStore.upsert(chatId, (session) => ({
    ...session,
    pending_install_proposal: null,
    awaiting_install_approval: false,
    last_install_proposal: next,
  }));
  return next;
}

export function updatePendingInstallProposalStatus(sessionStore, chatId, status = 'awaiting_install_approval', extra = {}) {
  const current = getPendingInstallProposal(sessionStore, chatId);
  if (!current) return null;
  const next = normalizeInstallProposalState({
    ...current,
    ...extra,
    status,
    updated_at: new Date().toISOString(),
  });
  sessionStore.upsert(chatId, (session) => ({
    ...session,
    pending_install_proposal: next,
    awaiting_install_approval: next.status === 'awaiting_install_approval',
    last_install_proposal: next.status === 'awaiting_install_approval' ? (session?.last_install_proposal || null) : next,
  }));
  return next;
}

export function buildInstallProposalPrompt(state = {}, { hasPendingTeam = false, chatId = '', sessionStore = null } = {}) {
  const normalized = normalizeInstallProposalState(state);
  if (!normalized) return null;
  const proposal = normalized.proposal || {};
  const line = proposal.gap_preview_lines?.[0] || '추가 설치/승인이 필요한 capability gap이 있습니다.';
  const resumeOnApply = shouldResumeInstallProposal(normalized);
  const applyLabel = resumeOnApply
    ? (hasPendingTeam ? 'Apply active + resume' : 'Retry active + resume')
    : (hasPendingTeam ? 'Apply active' : 'Retry active');
  const coverage = chatId ? getCredentialCoverageForProposal(sessionStore, chatId, proposal) : { missing_keys: [] };
  return {
    text: [
      `⚠️ capability proposal 검토 필요`,
      line,
      `blocking=${proposal.blocking ? 'yes' : 'no'} · gaps=${Number(proposal.gap_count || 0)} · credential_requests=${Number(proposal?.actions?.summary?.credential_request_count || 0)}`,
      ...(coverage.missing_keys.length > 0 ? [`missing_credentials=${coverage.missing_keys.join(', ')}`] : []),
      '',
      '선택 (대부분은 실제 tool 설치가 아니라 team requirement / runtime 연결 힌트 반영):',
      (resumeOnApply
        ? `- ${applyLabel}: pending team requirement를 active로 반영하고, blocking gap이면 같은 요청을 재개`
        : `- ${applyLabel}: pending team requirement를 active로 반영 (실제 runtime tool 설치는 자동이 아닐 수 있음)`),
      '- Install pending: 현재 requirement 제안을 pending 상태로 보관',
      ...(coverage.missing_keys.length > 0 ? ['- Credential help: 필요한 secret 바인딩 방법 보기'] : []),
      '- Dismiss: 제안을 닫기',
    ].join('\n'),
    keyboard: [[
      { text: applyLabel, callback_data: 'team_install:apply_active_resume' },
      { text: 'Install pending', callback_data: 'team_install:install_pending' },
      ...(coverage.missing_keys.length > 0 ? [{ text: 'Credential help', callback_data: 'team_install:credential_help' }] : []),
      { text: 'Dismiss', callback_data: 'team_install:dismiss' },
    ]],
  };
}
