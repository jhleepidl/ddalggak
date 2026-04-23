import { buildTeamBlueprint, installTeamBlueprintToSession, normalizeTeamBlueprint } from '../../application/team_blueprint_runtime.js';
import { buildTeamInstallProposal, formatTeamInstallProposalMessage } from '../../application/install_proposal.js';
import { buildInstallProposalPrompt, createPendingInstallProposalState, getPendingInstallProposal, archivePendingInstallProposal, shouldResumeInstallProposal } from '../../application/install_proposal_state.js';
import { formatManifestRequirementLines, normalizeManifestRequirements } from '../../shared/manifest_requirements.js';
import { applyInstallProposalActionsToTeam, autoInstallRuntimeSupport } from '../../application/tool_install_adapter.js';
import { getCredentialBindingState, getCredentialCoverageForProposal } from '../../application/credential_binding.js';
import { syncSkillPackagesFromGoC } from '../../application/skill_package_runtime.js';

function clean(value = '') { return String(value || '').trim(); }
function parseApplyStateTokens(tokens = []) {
  const joined = Array.isArray(tokens) ? tokens.join(' ') : String(tokens || '');
  return /--(?:apply|active)\b/i.test(joined) ? 'active' : 'pending';
}
function currentTeamForManifest(teamState = {}) { return teamState.pending_team || teamState.active_team || null; }
function getCurrentThreadId(runtime = null) { return clean(runtime?.map?.threadId || runtime?.threadId || ''); }
function buildManifestWithSessionState(baseTeam, { runtime = null, applyState = 'pending', source = 'telegram', sessionInstallProposal = null, credentialBindingState = null } = {}) {
  return buildTeamBlueprint(baseTeam, { runtime, applyState, source, installProposalState: sessionInstallProposal, credentialBindingState });
}

function collectTeamSkillIds(team = {}) {
  const agents = Array.isArray(team?.agents) ? team.agents : [];
  const out = [];
  const seen = new Set();
  for (const agent of agents) {
    const items = Array.isArray(agent?.attached_skill_ids) ? agent.attached_skill_ids : (Array.isArray(agent?.attachedSkillIds) ? agent.attachedSkillIds : (Array.isArray(agent?.skills) ? agent.skills : []));
    for (const raw of items) {
      const value = clean(raw).toLowerCase();
      if (!value || seen.has(value)) continue;
      seen.add(value);
      out.push(value);
    }
  }
  return out.slice(0, 24);
}


export async function handleTelegramTeamBlueprintSubcommand(context = {}) {
  const {
    sub,
    rest = [],
    rawArgs = '',
    bot,
    sendLong,
    chatId,
    userId,
    teamState,
    runtimeForTeam,
    chatSessionStore,
    memoryModeWithFallback,
    requireGocClient,
    applyPendingTeam,
    storePendingTeam,
    formatTeamProposalMessage,
    loadSupervisorRuntime,
    runSupervisorChat,
    normalizeForceMode,
    resolveLiveJobIdForChat,
    jobs,
  } = context;
  if (!['proposal','install-plan','requirements','export','install','import','pull','push'].includes(sub)) return false;

  if (sub === 'proposal' || sub === 'install-plan') {
    const proposalAction = clean(rest[1] || '').toLowerCase();
    const existingProposalState = getPendingInstallProposal(chatSessionStore, chatId);
    const baseTeam = currentTeamForManifest(teamState);
    if (proposalAction === 'dismiss' || proposalAction === 'clear') {
      if (!existingProposalState) {
        await bot.sendMessage(chatId, '대기 중인 capability proposal이 없습니다.');
        return true;
      }
      archivePendingInstallProposal(chatSessionStore, chatId, 'dismissed');
      await bot.sendMessage(chatId, '✅ capability proposal을 닫았습니다.');
      return true;
    }
    if (proposalAction === 'install' || proposalAction === 'pending') {
      if (!baseTeam) {
        await bot.sendMessage(chatId, '먼저 /team suggest <목적> 또는 /team create <자연어 팀 설명> 으로 팀을 제안받아 주세요.');
        return true;
      }
      let state = existingProposalState;
      if (!state) {
        const proposal = buildTeamInstallProposal({ team: baseTeam, runtime: runtimeForTeam, applyState: 'pending' });
        state = createPendingInstallProposalState({ proposal, applyState: 'pending', source: 'team_requirement' });
        if (state) {
          chatSessionStore.upsert(chatId, { pending_install_proposal: state, awaiting_install_approval: true });
        }
      }
      const patched = applyInstallProposalActionsToTeam(teamState.pending_team || baseTeam, state?.proposal || {}).team;
      storePendingTeam(chatSessionStore, chatId, patched);
      autoInstallRuntimeSupport({ proposal: state?.proposal || {}, jobs, jobId: resolveLiveJobIdForChat?.(chatId) });
      const archived = state || getPendingInstallProposal(chatSessionStore, chatId);
      if (archived) archivePendingInstallProposal(chatSessionStore, chatId, 'installed_pending', { apply_state: 'pending' });
      await bot.sendMessage(chatId, '✅ capability proposal을 pending 상태로 보관했습니다. 필요하면 /team apply 후 다시 시도해 주세요.');
      return true;
    }
    if (proposalAction === 'apply' || proposalAction === 'active' || proposalAction === 'resume') {
      if (!existingProposalState) {
        await bot.sendMessage(chatId, '대기 중인 capability proposal이 없습니다. 먼저 /team proposal 로 확인해 주세요.');
        return true;
      }
      const coverage = getCredentialCoverageForProposal(chatSessionStore, chatId, existingProposalState.proposal || {});
      if (!coverage.all_satisfied) {
        await bot.sendMessage(chatId, [
          '⚠️ 먼저 필요한 credential을 바인딩해 주세요.',
          ...coverage.missing_keys.flatMap((key) => [`- /credential bind ${key} env ${key} --resume`, `- /credential set ${key} <secret> --resume`]),
        ].join('\n'));
        return true;
      }
      const patched = baseTeam ? applyInstallProposalActionsToTeam(teamState.pending_team || baseTeam, existingProposalState.proposal || {}).team : null;
      if (patched) storePendingTeam(chatSessionStore, chatId, patched);
      autoInstallRuntimeSupport({ proposal: existingProposalState.proposal || {}, jobs, jobId: resolveLiveJobIdForChat?.(chatId) });
      let activeTeam = teamState.active_team || null;
      if (getCurrentThreadId(runtimeForTeam) || teamState.pending_team || patched) {
        activeTeam = await applyPendingTeam({ sessionStore: chatSessionStore, chatId, runtime: runtimeForTeam });
      }
      archivePendingInstallProposal(chatSessionStore, chatId, 'applied_active', { apply_state: 'active' });
      const shouldResume = shouldResumeInstallProposal(existingProposalState);
      await bot.sendMessage(chatId, shouldResume ? '✅ capability proposal을 반영했고 같은 요청을 재개합니다.' : '✅ capability proposal을 반영했습니다.');
      const resume = existingProposalState.resume_request && typeof existingProposalState.resume_request === 'object' ? existingProposalState.resume_request : null;
      if (shouldResume && resume?.message && typeof runSupervisorChat === 'function') {
        await runSupervisorChat(bot, chatId, userId, resume.message, {
          debug: false,
          chatInfo: resume.chat_info && typeof resume.chat_info === 'object' ? resume.chat_info : { chat_id: String(chatId || '') },
          inputKind: resume.input_kind || 'install_resume',
          telegramMessageId: resume.telegram_message_id || null,
          userReplyToMessageId: resume.user_reply_to_message_id || null,
          forceMode: normalizeForceMode?.(resume.force_mode || 'normal') || 'normal',
          teamConfig: activeTeam || patched || null,
        });
      }
      return true;
    }
    if (!baseTeam && !existingProposalState) {
      await bot.sendMessage(chatId, '먼저 /team suggest <목적> 또는 /team create <자연어 팀 설명> 으로 팀을 제안받아 주세요.');
      return true;
    }
    const proposal = baseTeam
      ? buildTeamInstallProposal({ team: baseTeam, runtime: runtimeForTeam, applyState: teamState.pending_team ? 'active' : 'pending' })
      : existingProposalState?.proposal;
    const prompt = existingProposalState ? buildInstallProposalPrompt(existingProposalState, { hasPendingTeam: !!teamState.pending_team, chatId, sessionStore: chatSessionStore }) : null;
    const coverage = getCredentialCoverageForProposal(chatSessionStore, chatId, proposal || {});
    const bindingState = getCredentialBindingState(chatSessionStore, chatId);
    const lines = [
      existingProposalState ? `pending capability proposal state: ${existingProposalState.status}` : 'capability proposal preview',
      '',
      formatTeamInstallProposalMessage(proposal),
      '',
      `credential bindings: ${bindingState.summary.bound_count}`,
      `credential coverage: missing=${coverage.missing_keys.join(', ') || '(none)'}`,
      ...(prompt ? ['', prompt.text] : []),
      '',
      '명령:',
      '- /team proposal pending',
      '- /team proposal apply',
      '- /team proposal dismiss',
      '- /credential pending',
      '- /credential bind <KEY> env <ENV_KEY> --resume',
      '- /credential set <KEY> <secret> --resume (group/private fallback, Telegram 노출 주의)',
      '- 권장: 로컬 secret store / 서버 env에 저장 후 /credential bind <KEY> env <ENV_KEY>',
    ].filter(Boolean);
    await sendLong(bot, chatId, lines.join('\n'));
    return true;
  }

  if (sub === 'requirements') {
    const baseTeam = currentTeamForManifest(teamState);
    if (!baseTeam) {
      await bot.sendMessage(chatId, '먼저 /team suggest <목적> 또는 /team create <자연어 팀 설명> 으로 팀을 제안받아 주세요.');
      return true;
    }
    const manifest = buildTeamBlueprint(baseTeam, { runtime: runtimeForTeam, applyState: 'pending', credentialBindingState: getCredentialBindingState(chatSessionStore, chatId) });
    const requirementLines = formatManifestRequirementLines(manifest.requirements || normalizeManifestRequirements({}), { maxLines: 12 });
    await sendLong(bot, chatId, [`실행 requirements · ${baseTeam.team_name || 'team_config'}`, ...(requirementLines.length > 0 ? requirementLines : ['- (추가 requirement 없음)'])].join('\n'));
    return true;
  }

  if (sub === 'export') {
    const baseTeam = currentTeamForManifest(teamState);
    if (!baseTeam) {
      await bot.sendMessage(chatId, '내보낼 팀이 없습니다. 먼저 /team suggest <목적> 또는 /team create <자연어 팀 설명> 을 실행해 주세요.');
      return true;
    }
    const applyState = parseApplyStateTokens(rest.slice(1));
    const manifest = buildManifestWithSessionState(baseTeam, {
      runtime: runtimeForTeam,
      applyState,
      sessionInstallProposal: getPendingInstallProposal(chatSessionStore, chatId) || chatSessionStore.get(chatId)?.last_install_proposal || null,
      credentialBindingState: getCredentialBindingState(chatSessionStore, chatId),
    });
    await sendLong(bot, chatId, JSON.stringify(manifest, null, 2));
    return true;
  }

  if (sub === 'install' || sub === 'import') {
    const payload = clean(rawArgs.replace(/^(install|import)\s+/i, ''));
    if (!payload) {
      await bot.sendMessage(chatId, 'Usage: /team install [--apply|--pending] <blueprint JSON>');
      return true;
    }
    const applyState = parseApplyStateTokens(payload.split(/\s+/).slice(0, 3));
    const jsonPayload = payload.replace(/^--(?:apply|active|pending)\s+/i, '').trim();
    try {
      const parsed = JSON.parse(jsonPayload);
      const installed = await installTeamBlueprintToSession({ sessionStore: chatSessionStore, chatId, manifest: parsed, runtime: runtimeForTeam, applyState });
      await sendLong(bot, chatId, [`✅ blueprint를 ${applyState === 'active' ? 'active' : 'pending'} team으로 설치했습니다.`, '', formatTeamProposalMessage(installed.team, { runtime: runtimeForTeam })].join('\n'));
    } catch (e) {
      await bot.sendMessage(chatId, `❌ blueprint 설치 실패: ${String(e?.message ?? e)}`);
    }
    return true;
  }

  if (sub === 'pull') {
    const threadId = getCurrentThreadId(runtimeForTeam);
    if (!threadId || memoryModeWithFallback?.() !== 'goc' || typeof requireGocClient !== 'function') {
      await bot.sendMessage(chatId, '현재 GoC thread에 연결된 runtime이 없어 pull 할 수 없습니다.');
      return true;
    }
    const applyState = parseApplyStateTokens(rest.slice(1));
    try {
      const client = requireGocClient();
      const manifest = await client.getTeamBlueprint({ threadId });
      const installed = await installTeamBlueprintToSession({ sessionStore: chatSessionStore, chatId, manifest, runtime: runtimeForTeam, applyState });
      const syncedSkillIds = collectTeamSkillIds(installed.team);
      let syncedSkillCount = 0;
      if (syncedSkillIds.length > 0) {
        try {
          const synced = await syncSkillPackagesFromGoC({ client, skillIds: syncedSkillIds, threadId, includeDefaults: true });
          syncedSkillCount = synced.length;
        } catch {}
      }
      await sendLong(bot, chatId, [`✅ GoC thread team blueprint를 가져와 ${applyState === 'active' ? 'active' : 'pending'} team으로 반영했습니다.${syncedSkillCount > 0 ? `\n- synced skill packages: ${syncedSkillCount}` : ''}`, '', formatTeamProposalMessage(installed.team, { runtime: runtimeForTeam })].join('\n'));
    } catch (e) {
      await bot.sendMessage(chatId, `❌ GoC blueprint pull 실패: ${String(e?.message ?? e)}`);
    }
    return true;
  }

  if (sub === 'push') {
    const baseTeam = currentTeamForManifest(teamState);
    const threadId = getCurrentThreadId(runtimeForTeam);
    if (!baseTeam) {
      await bot.sendMessage(chatId, '먼저 push 할 팀을 준비해 주세요.');
      return true;
    }
    if (!threadId || memoryModeWithFallback?.() !== 'goc' || typeof requireGocClient !== 'function') {
      await bot.sendMessage(chatId, '현재 GoC thread에 연결된 runtime이 없어 push 할 수 없습니다.');
      return true;
    }
    const applyState = parseApplyStateTokens(rest.slice(1));
    try {
      const manifest = buildManifestWithSessionState(baseTeam, {
        runtime: runtimeForTeam,
        applyState,
        source: 'telegram_push',
        sessionInstallProposal: getPendingInstallProposal(chatSessionStore, chatId) || chatSessionStore.get(chatId)?.last_install_proposal || null,
        credentialBindingState: getCredentialBindingState(chatSessionStore, chatId),
      });
      const client = requireGocClient();
      const saved = await client.installTeamBlueprint({ threadId }, manifest, applyState);
      const normalized = normalizeTeamBlueprint(saved?.manifest || saved?.blueprint || saved || manifest, { runtime: runtimeForTeam, applyState });
      await sendLong(bot, chatId, [`✅ 현재 팀을 GoC thread에 ${applyState === 'active' ? 'active' : 'pending'} team으로 동기화했습니다.`, '', JSON.stringify(normalized.blueprint, null, 2)].join('\n'));
    } catch (e) {
      await bot.sendMessage(chatId, `❌ GoC blueprint push 실패: ${String(e?.message ?? e)}`);
    }
    return true;
  }

  return false;
}
