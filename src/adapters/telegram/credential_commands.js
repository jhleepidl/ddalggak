import {
  bindCredentialForChat,
  clearCredentialForChat,
  getCredentialBindingState,
  getCredentialCoverageForProposal,
} from '../../application/credential_binding.js';
import { getPendingInstallProposal, archivePendingInstallProposal } from '../../application/install_proposal_state.js';
import { getSessionTeamState, storePendingTeam, applyPendingTeam } from '../../application/team_configuration.js';
import { applyInstallProposalActionsToTeam, autoInstallRuntimeSupport } from '../../application/tool_install_adapter.js';

function clean(value = '') { return String(value || '').trim(); }

export async function handleTelegramCredentialCommand(context = {}) {
  const {
    bot,
    chatId,
    rawArgs = '',
    chatSessionStore,
    resolveLiveJobIdForChat,
    jobs,
    loadSupervisorRuntime,
    userId,
    runSupervisorChat,
    normalizeForceMode,
  } = context;
  const restText = clean(rawArgs.replace(/^\/credential\s*/i, ''));
  const parts = restText.split(/\s+/).filter(Boolean);
  const sub = clean(parts[0] || '').toLowerCase();
  const proposalState = getPendingInstallProposal(chatSessionStore, chatId);
  const bindingState = getCredentialBindingState(chatSessionStore, chatId);

  if (!sub || sub === 'list') {
    const lines = [
      'Credential bindings',
      ...(bindingState.bindings.length > 0 ? bindingState.bindings.map((entry) => `- ${entry.credential_key} · ${entry.source} · ${entry.masked_value || '(bound)'}`) : ['- (bound credential 없음)']),
    ];
    if (proposalState) {
      const coverage = getCredentialCoverageForProposal(chatId, proposalState.proposal || {});
      lines.push('', 'Pending proposal coverage', `- missing: ${coverage.missing_keys.join(', ') || '(none)'}`);
    }
    await bot.sendMessage(chatId, lines.join('\n'));
    return true;
  }

  if (sub === 'pending') {
    if (!proposalState) {
      await bot.sendMessage(chatId, '대기 중인 credential request가 없습니다.');
      return true;
    }
    const coverage = getCredentialCoverageForProposal(chatId, proposalState.proposal || {});
    await bot.sendMessage(chatId, [
      'Pending credential requests',
      `- missing: ${coverage.missing_keys.join(', ') || '(none)'}`,
      `- bound: ${coverage.bound_keys.join(', ') || '(none)'}`,
      '',
      ...coverage.missing_keys.map((key) => `/credential set ${key} <secret> --resume`),
    ].join('\n'));
    return true;
  }

  if (sub === 'clear') {
    const key = clean(parts[1] || '');
    if (!key) {
      await bot.sendMessage(chatId, 'Usage: /credential clear <KEY>');
      return true;
    }
    clearCredentialForChat(chatSessionStore, chatId, key);
    await bot.sendMessage(chatId, `✅ credential 해제: ${key.toUpperCase()}`);
    return true;
  }

  if (sub === 'set' || sub === 'bind') {
    const resume = parts.includes('--resume') || parts.includes('--apply');
    const filtered = parts.filter((item) => item !== '--resume' && item !== '--apply');
    const key = clean(filtered[1] || '');
    const value = clean(filtered.slice(2).join(' '));
    if (!key || !value) {
      await bot.sendMessage(chatId, 'Usage: /credential set <KEY> <secret> [--resume]');
      return true;
    }
    const bound = bindCredentialForChat(chatSessionStore, chatId, key, value, { source: 'telegram_command' });
    await bot.sendMessage(chatId, `✅ credential 바인딩 완료: ${bound.credential_key} (${bound.masked_value || 'bound'})`);
    if (!proposalState) return true;
    const coverage = getCredentialCoverageForProposal(chatId, proposalState.proposal || {});
    if (!coverage.all_satisfied || !resume) {
      await bot.sendMessage(chatId, coverage.all_satisfied
        ? '이제 /team proposal apply 로 재개할 수 있습니다.'
        : `아직 필요한 credential: ${coverage.missing_keys.join(', ')}`);
      return true;
    }
    let runtime = null;
    try {
      const jobId = resolveLiveJobIdForChat?.(chatId);
      if (jobId && typeof loadSupervisorRuntime === 'function') {
        runtime = await loadSupervisorRuntime(jobId, { telegramUserId: userId, includeContext: false, includeGlobal: false });
      }
    } catch {}
    let teamState = getSessionTeamState(chatSessionStore, chatId);
    const baseTeam = teamState.pending_team || teamState.active_team || null;
    if (baseTeam) {
      const patched = applyInstallProposalActionsToTeam(baseTeam, proposalState.proposal || {}).team;
      storePendingTeam(chatSessionStore, chatId, patched);
      autoInstallRuntimeSupport({ proposal: proposalState.proposal || {}, jobs, jobId: resolveLiveJobIdForChat?.(chatId) });
      teamState = getSessionTeamState(chatSessionStore, chatId);
    }
    let activeTeam = teamState.active_team || null;
    if (teamState.pending_team) {
      activeTeam = await applyPendingTeam({ sessionStore: chatSessionStore, chatId, runtime });
    }
    archivePendingInstallProposal(chatSessionStore, chatId, 'applied_active', { apply_state: 'active' });
    const resumeRequest = proposalState.resume_request && typeof proposalState.resume_request === 'object' ? proposalState.resume_request : null;
    if (resumeRequest?.message && typeof runSupervisorChat === 'function') {
      await bot.sendMessage(chatId, '✅ credential이 충족되어 같은 요청을 재개합니다.');
      await runSupervisorChat(bot, chatId, userId, resumeRequest.message, {
        debug: false,
        chatInfo: resumeRequest.chat_info && typeof resumeRequest.chat_info === 'object' ? resumeRequest.chat_info : { chat_id: String(chatId || '') },
        inputKind: resumeRequest.input_kind || 'install_resume',
        telegramMessageId: resumeRequest.telegram_message_id || null,
        userReplyToMessageId: resumeRequest.user_reply_to_message_id || null,
        forceMode: normalizeForceMode?.(resumeRequest.force_mode || 'normal') || 'normal',
        teamConfig: activeTeam || getSessionTeamState(chatSessionStore, chatId).active_team || null,
      });
    }
    return true;
  }

  await bot.sendMessage(chatId, 'Usage: /credential [list|pending|set <KEY> <secret> [--resume]|clear <KEY>]');
  return true;
}
