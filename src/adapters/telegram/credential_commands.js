import {
  bindCredentialForChat,
  bindCredentialReferenceForChat,
  clearCredentialForChat,
  describeCredentialBindingTarget,
  getCredentialBindingState,
  getCredentialCoverageForProposal,
} from '../../application/credential_binding.js';
import { getPendingInstallProposal, archivePendingInstallProposal } from '../../application/install_proposal_state.js';
import { getSessionTeamState, storePendingTeam, applyPendingTeam } from '../../application/team_configuration.js';
import { applyInstallProposalActionsToTeam, autoInstallRuntimeSupport } from '../../application/tool_install_adapter.js';

function clean(value = '') { return String(value || '').trim(); }

function buildReferenceUsageLine(key = '') {
  const normalized = clean(key).toUpperCase() || 'OPENAI_API_KEY';
  return `/credential bind ${normalized} env ${normalized} --resume`;
}

function buildSetUsageLine(key = '') {
  const normalized = clean(key).toUpperCase() || 'OPENAI_API_KEY';
  return `/credential set ${normalized} <secret> --resume`;
}

async function maybeResumePendingProposal(context = {}) {
  const {
    bot,
    chatId,
    chatSessionStore,
    resolveLiveJobIdForChat,
    jobs,
    loadSupervisorRuntime,
    userId,
    runSupervisorChat,
    normalizeForceMode,
    proposalState,
  } = context;
  if (!proposalState) return true;
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
    chatType = '',
    telegramMessageId = null,
  } = context;
  const restText = clean(rawArgs.replace(/^\/credential\s*/i, ''));
  const parts = restText.split(/\s+/).filter(Boolean);
  const sub = clean(parts[0] || '').toLowerCase();
  const proposalState = getPendingInstallProposal(chatSessionStore, chatId);
  const bindingState = getCredentialBindingState(chatSessionStore, chatId, { includeResolution: true });

  if (!sub || sub === 'list') {
    const lines = [
      'Credential bindings',
      ...(bindingState.bindings.length > 0
        ? bindingState.bindings.map((entry) => `- ${entry.credential_key} · ${describeCredentialBindingTarget(entry) || entry.source} · ${entry.resolved ? 'resolved' : 'unresolved'}`)
        : ['- (bound credential 없음)']),
    ];
    if (proposalState) {
      const coverage = getCredentialCoverageForProposal(chatSessionStore, chatId, proposalState.proposal || {});
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
    const coverage = getCredentialCoverageForProposal(chatSessionStore, chatId, proposalState.proposal || {});
    const usageLines = coverage.missing_keys.flatMap((key) => [
      buildReferenceUsageLine(key),
      buildSetUsageLine(key),
    ]);
    await bot.sendMessage(chatId, [
      'Pending credential requests',
      `- missing: ${coverage.missing_keys.join(', ') || '(none)'}`,
      `- bound: ${coverage.bound_keys.join(', ') || '(none)'}`,
      '',
      ...usageLines,
      '',
      'env reference 바인딩이 기본 권장이고, 필요하면 그룹/개인 chat 어디서든 /credential set fallback을 사용할 수 있습니다.',
      '보안상 raw secret이 Telegram 히스토리에 남을 수 있으니, 가능하면 로컬 secret store 또는 서버 환경변수에 직접 저장한 뒤 /credential bind를 우선 사용하세요.',
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

  if (sub === 'set') {
    const resume = parts.includes('--resume') || parts.includes('--apply');
    const filtered = parts.filter((item) => item !== '--resume' && item !== '--apply');
    const key = clean(filtered[1] || '');
    const secret = clean(filtered.slice(2).join(' '));
    if (!key || !secret) {
      await bot.sendMessage(chatId, 'Usage: /credential set <KEY> <secret> [--resume]');
      return true;
    }
    const bound = bindCredentialForChat(chatSessionStore, chatId, key, secret, {
      source: 'telegram_secret_binding',
      deliveryMethod: 'job_env',
    });
    try {
      if (telegramMessageId != null && typeof bot.deleteMessage === 'function') {
        await bot.deleteMessage(chatId, telegramMessageId);
      }
    } catch {}
    const isPrivateChat = clean(chatType).toLowerCase() === 'private';
    await bot.sendMessage(chatId, [
      `${isPrivateChat ? '✅' : '⚠️'} credential 저장: ${bound.credential_key}`,
      '- raw secret은 session 파일에 저장하지 않고, job 실행 때만 scoped env로 주입됩니다.',
      '- 입력한 secret은 Telegram 히스토리와 운영 로그에 남을 수 있습니다.',
      '- 가능하면 로컬 secret store 또는 서버 환경변수에 직접 저장한 뒤 /credential bind <KEY> env <ENV_KEY> 경로를 우선 사용하세요.',
      ...(isPrivateChat ? ['- 현재는 private chat이라 fallback 사용에 더 적합합니다.'] : ['- 현재는 group chat이므로 노출 위험이 더 큽니다. 가능하면 set 직후 메시지를 삭제하거나 rotate 하세요.']),
    ].join('\n'));
    if (!proposalState) return true;
    const coverage = getCredentialCoverageForProposal(chatSessionStore, chatId, proposalState.proposal || {});
    if (!coverage.all_satisfied || !resume) {
      await bot.sendMessage(chatId, coverage.all_satisfied
        ? '이제 /team proposal apply 로 재개할 수 있습니다.'
        : `아직 필요한 credential: ${coverage.missing_keys.join(', ')}`);
      return true;
    }
    return maybeResumePendingProposal({
      bot,
      chatId,
      chatSessionStore,
      resolveLiveJobIdForChat,
      jobs,
      loadSupervisorRuntime,
      userId,
      runSupervisorChat,
      normalizeForceMode,
      proposalState,
    });
  }

  if (sub === 'bind') {
    const resume = parts.includes('--resume') || parts.includes('--apply');
    const filtered = parts.filter((item) => item !== '--resume' && item !== '--apply');
    const key = clean(filtered[1] || '');
    const bindingMode = clean(filtered[2] || '').toLowerCase();
    const reference = clean(filtered.slice(3).join(' '));
    if (!key || bindingMode !== 'env' || !reference) {
      await bot.sendMessage(chatId, 'Usage: /credential bind <KEY> env <ENV_KEY> [--resume]');
      return true;
    }
    const bound = bindCredentialReferenceForChat(chatSessionStore, chatId, key, {
      referenceType: 'env_var',
      reference,
      source: 'telegram_reference_binding',
      deliveryMethod: 'job_env',
    });
    const resolvedState = getCredentialBindingState(chatSessionStore, chatId, { includeResolution: true });
    const entry = resolvedState.bindings.find((item) => item.credential_key === bound.credential_key);
    await bot.sendMessage(chatId, `✅ credential reference 바인딩: ${bound.credential_key} ← ${describeCredentialBindingTarget(bound) || reference}${entry?.resolved ? '' : ' (현재 프로세스에서 unresolved)'}`);
    if (!proposalState) return true;
    const coverage = getCredentialCoverageForProposal(chatSessionStore, chatId, proposalState.proposal || {});
    if (!coverage.all_satisfied || !resume) {
      await bot.sendMessage(chatId, coverage.all_satisfied
        ? '이제 /team proposal apply 로 재개할 수 있습니다.'
        : `아직 필요한 credential: ${coverage.missing_keys.join(', ')}`);
      return true;
    }
    return maybeResumePendingProposal({
      bot,
      chatId,
      chatSessionStore,
      resolveLiveJobIdForChat,
      jobs,
      loadSupervisorRuntime,
      userId,
      runSupervisorChat,
      normalizeForceMode,
      proposalState,
    });
  }

  await bot.sendMessage(chatId, 'Usage: /credential [list|pending|set <KEY> <secret> [--resume]|bind <KEY> env <ENV_KEY> [--resume]|clear <KEY>]\n권장: 로컬 secret store / 서버 env에 저장 후 bind');
  return true;
}
