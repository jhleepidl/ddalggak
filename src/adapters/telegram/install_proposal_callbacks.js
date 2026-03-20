import { getPendingInstallProposal, archivePendingInstallProposal, buildInstallProposalPrompt } from '../../application/install_proposal_state.js';
import { getCredentialCoverageForProposal } from '../../application/credential_binding.js';
import { applyInstallProposalActionsToTeam, autoInstallRuntimeSupport } from '../../application/tool_install_adapter.js';
import { getSessionTeamState, storePendingTeam, applyPendingTeam } from '../../application/team_configuration.js';

export async function handleTelegramInstallProposalCallback({ q, bot, chatId, userId, data, deps = {} }) {
  if (!String(data || '').trim().startsWith('team_install:')) return false;
  const {
    chatSessionStore,
    resolveCurrentJobIdForChat,
    loadSupervisorRuntime,
    runSupervisorChat,
    normalizeForceMode,
    jobs,
  } = deps;
  const action = String(data.split(':')[1] || '').trim().toLowerCase();
  const proposalState = getPendingInstallProposal(chatSessionStore, chatId);
  if (!proposalState) {
    await bot.answerCallbackQuery(q.id, { text: 'no pending install proposal' });
    return true;
  }
  const coverage = getCredentialCoverageForProposal(chatId, proposalState.proposal || {});
  let runtime = null;
  try {
    const currentJobId = resolveCurrentJobIdForChat?.(chatId);
    if (currentJobId && typeof loadSupervisorRuntime === 'function') {
      runtime = await loadSupervisorRuntime(currentJobId, { telegramUserId: userId, includeContext: false, includeGlobal: false });
    }
  } catch {}
  let teamState = getSessionTeamState(chatSessionStore, chatId);
  const prompt = buildInstallProposalPrompt(proposalState, { hasPendingTeam: !!teamState.pending_team, chatId });
  if (action === 'dismiss') {
    archivePendingInstallProposal(chatSessionStore, chatId, 'dismissed');
    await bot.answerCallbackQuery(q.id, { text: 'dismissed' });
    await bot.sendMessage(chatId, '✅ install proposal을 닫았습니다.');
    return true;
  }
  if (action === 'credential_help') {
    await bot.answerCallbackQuery(q.id, { text: 'credential help' });
    await bot.sendMessage(chatId, [
      '🔐 credential binding 안내',
      ...coverage.missing_keys.map((key) => `- /credential set ${key} <secret> --resume`),
      '- /credential pending',
      '- /credential list',
      '',
      '주의: 채팅 명령으로 입력한 secret은 Telegram 대화에 남습니다. 가능하면 환경 변수/비밀 저장소를 우선 사용하세요.',
    ].filter(Boolean).join('\n'));
    return true;
  }
  if (action === 'install_pending') {
    const baseTeam = teamState.pending_team || teamState.active_team || null;
    if (baseTeam) {
      const patched = applyInstallProposalActionsToTeam(baseTeam, proposalState.proposal || {}).team;
      storePendingTeam(chatSessionStore, chatId, patched);
      const currentJobId = resolveCurrentJobIdForChat?.(chatId);
      autoInstallRuntimeSupport({ proposal: proposalState.proposal || {}, jobs, jobId: currentJobId });
    }
    archivePendingInstallProposal(chatSessionStore, chatId, 'installed_pending', { apply_state: 'pending' });
    await bot.answerCallbackQuery(q.id, { text: 'stored as pending' });
    await bot.sendMessage(chatId, '✅ install proposal을 pending 상태로 보관했습니다.');
    return true;
  }
  if (action === 'apply_active_resume') {
    if (!coverage.all_satisfied && coverage.missing_keys.length > 0) {
      await bot.answerCallbackQuery(q.id, { text: 'credential required' });
      await bot.sendMessage(chatId, [
        '⚠️ 먼저 필요한 credential을 바인딩해 주세요.',
        ...coverage.missing_keys.map((key) => `- /credential set ${key} <secret> --resume`),
      ].join('\n'));
      return true;
    }
    const baseTeam = teamState.pending_team || teamState.active_team || null;
    if (baseTeam) {
      const patched = applyInstallProposalActionsToTeam(baseTeam, proposalState.proposal || {}).team;
      storePendingTeam(chatSessionStore, chatId, patched);
      const currentJobId = resolveCurrentJobIdForChat?.(chatId);
      autoInstallRuntimeSupport({ proposal: proposalState.proposal || {}, jobs, jobId: currentJobId });
      teamState = getSessionTeamState(chatSessionStore, chatId);
    }
    let activeTeam = teamState.active_team || null;
    if (teamState.pending_team) {
      activeTeam = await applyPendingTeam({ sessionStore: chatSessionStore, chatId, runtime });
      teamState = getSessionTeamState(chatSessionStore, chatId);
    }
    archivePendingInstallProposal(chatSessionStore, chatId, 'applied_active', { apply_state: 'active' });
    await bot.answerCallbackQuery(q.id, { text: 'resuming with active team' });
    await bot.sendMessage(chatId, '✅ install proposal을 반영했고 같은 요청을 재개합니다.');
    const resume = proposalState.resume_request && typeof proposalState.resume_request === 'object' ? proposalState.resume_request : null;
    if (resume?.message && typeof runSupervisorChat === 'function') {
      await runSupervisorChat(bot, chatId, userId, resume.message, {
        debug: false,
        chatInfo: resume.chat_info && typeof resume.chat_info === 'object' ? resume.chat_info : { chat_id: String(chatId || '') },
        inputKind: resume.input_kind || 'install_resume',
        telegramMessageId: resume.telegram_message_id || null,
        userReplyToMessageId: resume.user_reply_to_message_id || null,
        forceMode: normalizeForceMode?.(resume.force_mode || 'normal') || 'normal',
        teamConfig: activeTeam || teamState.active_team || null,
      });
    } else if (prompt?.text) {
      await bot.sendMessage(chatId, prompt.text);
    }
    return true;
  }
  await bot.answerCallbackQuery(q.id, { text: 'unknown install action' });
  return true;
}
