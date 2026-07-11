import fs from 'node:fs';
import path from 'node:path';
import {
  executeRunCommand,
  executeContinueCommand,
} from "../../application/route_executor.js";
import {
  applyPendingTeam,
  buildTeamTransitionGuardrails,
  formatTeamTransitionGuardrailLines,
  buildTeamConfigurationTemplate,
  createFreeformTeamConfiguration,
  createFreeformTeamConfigurationAdvanced,
  buildTeamListMessage,
  formatSupportedModelLines,
  formatTeamProposalMessage,
  getSessionTeamState,
  hydrateSessionTeamStateFromConversationStore,
  parseTeamTemplate,
  refineTeamConfiguration,
  refineTeamConfigurationAdvanced,
  resetTeamConfiguration,
  storePendingTeam,
  suggestTeamConfiguration,
  validateTeamConfiguration,
  teamConfigChangeRequiresApproval,
  buildTeamSelectionPortfolio,
  formatTeamCandidatePortfolioMessage,
  selectPendingTeamCandidate,
} from "../../application/team_configuration.js";
import { buildTeamBlueprint, installTeamBlueprintToSession, normalizeTeamBlueprint } from '../../application/team_blueprint_runtime.js';
import { buildRoomFirstTeamConfiguration } from '../../application/ai_room_runtime_selection.js';
import {
  buildDirectAskPrompt,
  buildSearchAskFallbackPrompt,
  classifyRoomConciergeRoute,
  shouldUseDirectAskFastPath,
  shouldUseSearchAskPath,
} from '../../application/room_concierge.js';
import { loadRoomConciergeModelFromEnv } from '../../application/room_concierge_model.js';
import { runOpenAICompatiblePrompt } from '../../providers/openai_compatible.js';
import { runCodexExec } from '../../codex.js';
import {
  resolveRoomConciergeModelPolicy,
  shouldEnableConciergeFastPathForPolicy,
} from '../../application/room_concierge_model_policy.js';
import { formatRoomEvolutionSnapshot, proposeRoomEvolution } from '../../application/room_evolution.js';
import { buildRoomDocumentMocPack, formatRoomDocumentInvalidationForTelegram, formatRoomDocumentMocPackForTelegram } from '../../application/room_markdown_moc.js';
import { appendRoomActionNoteFromEvent, buildMaterializedRoomDocsInvalidation, formatRoomDocsSyncResultForTelegram, materializeRoomDocumentMocPack } from '../../application/room_markdown_store.js';
import { buildRoomTopologyLearningCard, evaluateTopologyReplay, formatRoomTopologyLearningCardForTelegram, formatTopologyReplayEvaluationForTelegram } from '../../application/room_topology_learning.js';
import { exportRoomTopologyTrainingDataset, formatRoomTopologyDatasetExportForTelegram } from '../../application/room_topology_trace_export.js';
import { buildDefaultAgentActivationPolicy, deriveAgentTelemetry, formatAgentActivationPolicyForTelegram, formatAgentSpecializationProposalForTelegram, proposeAgentRosterSpecialization } from '../../application/room_agent_policy.js';
import { buildRoomPreferenceDataset, exportRoomPreferenceDataset, formatRoomPreferenceDatasetExportForTelegram, formatRoomPreferenceLearningSummaryForTelegram, formatRoomPreferenceScorerReportForTelegram, scoreRoomPreferenceCandidates } from '../../application/room_preference_learning.js';
import { resolveRoomModelRolePlan, formatRoomModelRolePlanForTelegram } from '../../application/room_model_role_router.js';
import { appendKnowledgeRouteEvent } from '../../application/knowledge_route_event_log.js';
import { appendRoomConversationExchange, appendRoomConversationTurn } from '../../application/room_conversation_ledger.js';
import { appendRoomLoopEvent, buildRoomLoopStartEvent, classifyRoomLoopInterruption, createRoomLoopId, deriveActiveRoomLoop, normalizeRoomLoop, readRoomLoopEvents } from '../../application/room_loop_events.js';
import { appendRoomCompanionEvent, buildCompanionCouncilSession, buildCorrectionMergeProposalEvent, buildRoomCompanionMaterializationCandidateEvent, buildRoomCompanionMemoryExchangeDecisionEvent, buildRoomCompanionMergeProposalDecisionEvent, classifyRoomCorrectionIntent, deriveRoomCompanionState, formatRoomCompanionCouncilLogForTelegram, formatRoomCompanionListForTelegram, formatRoomCompanionMaterializationCandidatesForTelegram, formatRoomCompanionMemoryExchangeProposalsForTelegram, formatRoomCompanionMergeProposalsForTelegram, formatRoomCompanionProfileForTelegram, getRoomCompanionProfile, normalizeAgentMode, normalizeCompanionId, normalizeContextMode, readRoomCompanionEvents, selectRoomCompanionMemoryExchangeProposal } from '../../application/room_companions.js';
import { createRoomContextSnapshot, formatRoomContextProjectionBlock } from '../../application/room_context_projection.js';
import { resolveDdalggakRuntimeConfig, resolveDdalggakRouteRuntimeConfig, formatRuntimeConfigForTelegram, auditDdalggakRuntimeEnv, formatRuntimeConfigDoctorForTelegram } from '../../application/runtime_config.js';
import { appendRoomSelectionRouteEvent, buildRoomSelectionDecision, buildTeamSelectionDecision } from '../../application/room_selection_routing.js';
import { buildTeamInstallProposal, formatTeamInstallProposalMessage } from '../../application/install_proposal.js';
import { buildInstallProposalPrompt, createPendingInstallProposalState, getPendingInstallProposal, archivePendingInstallProposal } from '../../application/install_proposal_state.js';
import { formatManifestRequirementLines, normalizeManifestRequirements } from '../../shared/manifest_requirements.js';
import { handleTelegramTeamBlueprintSubcommand } from './team_blueprint_commands.js';
import { handleTelegramCredentialCommand } from './credential_commands.js';
import { getCredentialBindingState } from '../../application/credential_binding.js';
import { buildTeamSchemaOptionsText, buildTeamSchemaOptionsSummaryLines } from '../../shared/team_schema_catalog.js';
import { buildBenchmarkTeamTemplate, buildBenchmarkTemplateCatalogText } from '../../application/benchmark_team_templates.js';
import { syncRawHistoryToGoC } from '../../application/goc_raw_history_sync.js';
import { getGocRouteCircuitSnapshot } from '../../goc_client.js';
import { normalizeLanguageMetadata, resolveUserSurfaceLocale, userSurfaceLanguageDirective } from '../../application/language_policy.js';
import { appendRuntimeModelFooter } from '../../application/telegram_status_notifications.js';
import { inspectAndPrepareImprovementJob, loadImprovementExecutionContext, runImprovementAutomation, runImprovementCanary, runImprovementEvalGate, runImprovementReview, runImprovementRollback, runImprovementTests, markImprovementPromotion } from '../../application/improvement_orchestrator.js';
import { writeIdleCompactionCandidate, formatIdleCompactionCandidateForTelegram } from '../../application/idle_compaction.js';
import { runRoomIdleMemoryStructuring, formatRoomIdleMemoryStructuringResultForTelegram } from '../../application/room_idle_memory.js';
import { deriveRoomMemoryView, formatRoomMemoryDecisionForTelegram, formatRoomMemoryExplainForTelegram, formatRoomMemoryListForTelegram, formatRoomMemoryProposalsForTelegram, updateRoomMemoryCandidateDecision } from '../../application/room_memory_view.js';
import { syncTelegramApprovedRoomMemoryToGoc } from '../../application/goc_memory_sync.js';
import { buildRoomGovernanceMetrics, formatRoomGovernanceDigestForTelegram, shouldSendRoomGovernanceDigest } from '../../application/room_governance_metrics.js';
import { formatMemoryTopologyForTelegram, planMemoryTopology } from '../../application/memory_topology.js';
import { formatMemoryMaterializationPlanForTelegram, loadLatestMemoryMaterializationPlan, planMemoryMaterialization } from '../../application/memory_materialization_planner.js';
import { createShadowMemoryModule, findMaterializationCandidate, formatShadowMemoryModuleListForTelegram, formatShadowMemoryModuleResultForTelegram, listShadowMemoryModules } from '../../application/memory_materialization_store.js';
import { buildClaimEvidenceLedger, buildPressureOverview, buildRuntimeReviewQueue, formatClaimEvidenceForTelegram, formatPressureOverviewForTelegram, formatReviewQueueForTelegram } from '../../application/runtime_review_inspector.js';
import { listModelNodes } from '../../application/model_node_registry.js';
import { summarizeModelCatalogEntry } from '../../application/model_node_catalog.js';
import { discoverCodexCliModelNodes, discoverGeminiCliModelNodes, discoverOllamaModelNodes } from '../../application/model_node_discovery.js';
import { refreshModelCatalog } from '../../application/model_catalog_refresh.js';
import { listModelNodesWithHealth } from '../../application/model_node_health.js';
import { readRecentModelNodeUsage } from '../../application/model_node_usage_log.js';
import { listLocalSkillPackages } from '../../application/local_skill_catalog.js';
import { formatExternalSkillRuleImportResult, importExternalSkillRuleSource } from '../../application/external_skill_rule_importer.js';
import { formatSkillRulePerformanceSummary, readSkillRulePerformanceStore } from '../../application/skill_rule_performance.js';
import { formatSemanticBoardCards, formatSemanticBoardSummary, importSemanticBoardSource, mirrorSkillPerformanceToSemanticBoard, mirrorSkillRuleImportToSemanticBoard, mirrorLocalSkillCatalogToSemanticBoard, readSemanticBoard, buildPromptProjectionFromBoard, runtimeRuleToSemanticCard, upsertSemanticBoardCards } from '../../application/semantic_board.js';
import { buildSemanticBoardConsistencyReport, formatSemanticBoardRepair, formatSemanticBoardValidation, repairSemanticBoardStore, validateSemanticBoardStore } from '../../application/semantic_board_validator.js';
import { commitContextWriteIntent, compactContextSubstrate, formatContextSubstrateSummary, getContextProjection, listContextOperations, mirrorContextSubstrateToSemanticBoard, mirrorSemanticBoardToContextSubstrate, summarizeContextSubstrate } from '../../application/context_substrate_store.js';
import { selectModelNodeForTask } from '../../application/model_node_selector.js';
import { isChatGptManualFallbackEnabled } from '../../application/chatgpt_provider_bridge.js';
import {
  buildAgentPackageFromSession,
  findAgentPackage,
  formatAgentPackage,
  formatAgentPackageRegistry,
  installAgentPackageToSession,
  readAgentPackageRegistry,
  saveAgentPackageToRegistry,
  sanitizeAgentPackage,
} from '../../application/agent_package_runtime.js';
import {
  buildAgentRoomProfile,
  buildAgentRoomSuggestionMessage,
  buildOperationalControlRedirectMessage,
  formatAgentRoomProfile,
  getAgentRoomProfile,
  isOperationalControlText,
  normalizeRoomAgentRoles,
  upsertAgentRoomProfile,
} from '../../application/agent_room_profile.js';
import { extractTeamCreationSignals } from '../../application/team_signal_extractor.js';
import { buildTeamWorkflowContract, summarizeTeamWorkflowContract } from '../../application/team_workflow_contract.js';
import { buildWorkflowRuntimeExecutionPatch } from '../../application/workflow_execution_contract.js';
import {
  buildRoomPackage,
  buildRoomProfileFromGoal,
  formatDefaultRoomPackageComposition,
  formatDefaultRoomPackageDetail,
  formatDefaultRoomPackageList,
  formatRoomPackageSummary,
  formatRoomComponentLibrary,
  getDefaultRoomPackage,
  listDefaultRoomPackages,
  parseRoomPackageInput,
  recommendDefaultRoomPackages,
  renderRoomMarkdown,
  buildDefaultRoomPackageComposition,
  roomPackageToProfilePatch,
} from '../../application/room_package.js';
import {
  formatRoomGranularityRecommendation,
  recommendRoomGranularity,
} from '../../application/room_granularity_advisor.js';
import {
  appendRoomUsageEvent,
  buildRoomUsageEvent,
  readRoomUsageEvents,
} from '../../application/room_usage_events.js';
import {
  buildWatchTaskContract,
  ensureWatchTaskContract,
  readWatchTaskState,
  setWatchTaskStatus,
  summarizeWatchTaskState,
} from '../../application/watch_task_store.js';

const HELP_TEXT = [
  "Commands:",
  "- /home 또는 /start: Telegram chat을 AI companion room doorway로 열기",
  "- /chat 또는 /c <message>: 이 Telegram room에 요청하기",
  "- /ask 또는 /a <question>: legacy quick-question alias. 일반 사용은 /chat 권장",
  "- /team 또는 /t <goal>: 팀 검토/리뷰 깊이로 답변",
  "- /loop 또는 /l [--loops n] <goal>: bounded loop 작업 시작",
  "- /room 또는 /r: 이 채팅방의 AI Room / Room Package 설정 보기",
  "- /companions 또는 /companion: room companion roster와 memory boundary 보기",
  "- /context project-only|clean-slate|exclude <source>|reset: context 사용 범위 조절",
  "- /agent mode fast|balanced|strict: companion agent 모드 조절",
  "- /correct <정정>: 반복 오류 방지용 room correction 기록",
  "- /task: 장기 작업/loop 상태 보기",
  "- /task loop <목표>: legacy 반복 점검·개선 작업 시작",
  "- /agents: 이 채팅방의 Agent Room 보기",
  "- /agents suggest <목표>: 목표에 맞는 agent 구성 추천",
  "- /review 또는 /rev: 승인/검토가 필요한 항목 보기",
  "- /inbox: room decision inbox(job review, correction, memory exchange) 보기",
  "- /memory 또는 /m: 이 room에 저장된 memory 보기",
  "- /memory proposals|approve|reject|explain: memory 후보 검토/승인/설명",
  "- /rule <자연어 지침>: 명시적 runtime rule 추가",
  "- /skill 또는 /sk: skill 상태 보기",
  "- /board 또는 /b: semantic memory/skill/rule board 요약",
  "- /context 또는 /ctx: primitive context substrate/MVCC snapshot 요약",
  "- /goc 또는 /g: GoC sync/review 링크와 상태 보기",
  "- /config 또는 /cfg: 현재 runtime/provider 설정 요약, /config doctor: .env 진단",
  "- /doctor: .env/provider/runtime 진단 바로 실행",
  "- /status 또는 /st: 지금 진행 상황 보기",
  "- /artifacts 또는 /art [limit]: 결과물 보기",
  "- /send <번호|path>: 결과물 전송",
  "- /files 또는 /f [all|workspace|uploads] [limit]: 파일 보기",
  "- /stop [jobId]: 실행 중지",
  "- /help more: 고급/확장 명령 보기",
].join("\n");


const COMMAND_ALIASES = new Map(Object.entries({
  '/c': '/chat',
  '/a': '/ask',
  '/t': '/team',
  '/l': '/loop',
  '/r': '/room',
  '/m': '/memory',
  '/b': '/board',
  '/ctx': '/context',
  '/g': '/goc',
  '/cfg': '/config',
  '/st': '/status',
  '/art': '/artifacts',
  '/f': '/files',
  '/u': '/upload',
  '/rev': '/review',
  '/sk': '/skill',
}));

function normalizeTelegramCommandAlias(cmd = '') {
  const value = String(cmd || '').trim().toLowerCase();
  return COMMAND_ALIASES.get(value) || value;
}

const ADVANCED_HELP_TEXT = [
  "More commands:",
  "- /home 또는 /start: compact onboarding/dashboard 보기",
  "- /quickstart: /home과 같은 빠른 시작 가이드 보기",
  "- /whoami: 현재 chat_id / user_id 확인",
  "- /running: 실행/대기 job 목록 확인",
  "- /credential ...: credential 바인딩/확인",
  "- /pause|/resume|/approve: active loop task 제어",
  "- /task pause|resume|stop|approve: legacy active loop task 제어",
  "- /agents use <roles>: Agent Room 기본 역할 적용",
  "- /agents reset: Agent Room 초기화",
  "- /agents export: 현재 Agent Room을 portable package JSON으로 내보내기",
  "- /agents packages: 저장된 agent package 목록",
  "- /agents clone <package_id>: 저장된 package를 이 채팅방에 설치",
  "- /team: legacy/advanced alias. 일반 사용은 /agents 권장",
  "- /team more: team topology 고급 명령 보기",
  "- /review approve|reject <reason>: 대기 중인 검토/승인 항목 처리",
  "- /inbox: active job review, companion merge proposal, materialization candidate 요약",
  "- /memory: room memory 요약 및 저장된 memory 보기",
  "- /memory proposals|approve|reject|explain: memory 후보 검토/승인/설명",
  "- /memory debug <show|md|kb|topology|pressure|evidence|review|materialize-preview|modules>: 개발/진단용 상세 조회",
  "- /settings ...: legacy alias, 가능하면 /memory 또는 GoC 사용",
  "- /skills 또는 /skill: 현재/예정 agent roster와 대표 skill 보기",
  "- /skill list|score|import <path|json>: skill catalog/score/import",
  "- /board: semantic memory/skill/rule board 요약",
  "- /context: primitive context substrate/MVCC snapshot 요약 또는 /context project-only|clean-slate|exclude|reset",
  "- /companions, /companion switch <id>, /companion profile: AI Companion control surface",
  "- /council ask <message>|log|proposals|approve|reject: visible companion backchannel",
  "- /agent mode fast|balanced|strict: companion agent 모드 조절",
  "- /correct <정정>: room-local correction을 기록하고 durable correction은 reviewable merge proposal 생성",
  "- /correct proposals: companion correction merge proposal 확인",
  "- /correct approve latest|<number>: pending companion merge proposal 명시 승인",
    "- /correct materialize-preview: accepted proposal의 branchable materialization 후보 보기",
  "- /correct reject latest|<number> [reason]: pending companion merge proposal 거절",
  "- /correct promote latest: 최신 correction을 수동으로 merge proposal로 만들기",
  "- /rule import <path|json>: 외부 rule package import",
  "- /models: 연결된 로컬/API/CLI model node 보기",
  "- /tools: 현재 job의 tool 상태 보기",
  "- /upload (+파일 첨부) [메모]: 실행 없이 업로드만 저장",
  "- /chat [--debug] <message>|reset: supervisor chat 실행 또는 세션 초기화",
  "- /rule <자연어 지침>: chat-level agent/runtime 지침 반영 (상세 편집은 GoC)",
  "- /run <goal>: goal 기반 실행 시작",
  "- /continue <jobId>: 기존 job 이어서 실행",
  "- /models refresh: Gemini/Codex/Ollama catalog 즉시 갱신",
  "- /agents export|publish-candidate|packages|clone <id>: agent package 공유/설치",
  "- /goc history push: GoC Board용 raw history snapshot 동기화",
  "- /goc candidate approve <nodeId> [publish]: Board candidate 승격",
  "- /improve <ddalggak|goc> <instruction>: forge 기준 self-improvement job 생성",
  "- /improve status <jobId>: improvement job 상태 보기",
  "- /improve test <jobId>: 테스트 재실행",
  "- /improve canary <jobId>: canary 재실행",
  "- /improve promote <jobId>: restart/promote hook 실행",
  "- /commit <jobId> <message>: 작업 결과 커밋",
  "",
  "Command model:",
  "- /ask = quick answer depth",
  "- /team = team review depth",
  "- /loop = bounded loop depth",
  "- /chat = legacy content plane",
  "- /task = legacy work/control plane",
  "- /room = shareable AI Room setup",
  "- /agents = Agent roster setup",
  "- /review = user decision queue",
  "- /outputs → /artifacts",
  "- /sendfile → /send",
  "- /attach → /upload",
].join("\n");

const TEAM_CORE_HELP_TEXT = [
  "Team commands (advanced alias; 일반 사용은 /agents 권장):",
  "- /team: 현재 low-level team 상태 보기",
  "- /team suggest <목적>: LLM planner로 목적 기반 team 제안 받기",
  "- /team create <설명>: 자연어로 team 만들기",
  "- /team refine <수정>: 현재/대기 team 수정하기",
  "- /team apply: 대기 team 적용",
  "- /team reset: team 초기화",
  "- /team more: 고급 team 명령 보기",
].join("\n");

const TEAM_ADVANCED_HELP_TEXT = [
  "More team commands:",
  "- /team requirements",
  "- /team proposal",
  "- /team export",
  "- /team publish [--public]: 현재 team을 공유 가능한 package로 저장",
  "- /team library [query]: shared team package 목록/검색",
  "- /team package <package_id>: package 상세 보기",
  "- /team clone <package_id>: package를 fresh private memory로 설치",
  "- /team fork <package_id>: package를 fork해서 새 candidate 만들기",
  "- /team install <JSON|package_id>",
  "- /team pull",
  "- /team push",
  "- /team debug templates: 개발자용 benchmark template 목록 보기",
  "- /team validate <JSON>",
  "- /team options",
  "- /team modes",
  ...buildTeamSchemaOptionsSummaryLines(),
].join("\n");


const TEAM_TEMPLATE_DEPRECATED_TEXT = [
  "/team template은 더 이상 일반 사용 흐름에서 권장되지 않습니다.",
  "",
  "목적 기반 팀 구성은 LLM planner가 처리합니다.",
  "- /team suggest <목적>",
  "- /team create <설명>",
  "- /team refine <수정>",
  "- /team apply",
  "",
  "현재/pending 팀의 structured manifest가 필요하면:",
  "- /team export",
  "",
  "개발자용 benchmark template 목록은:",
  "- /team debug templates",
].join("\n");

const TASK_HELP_TEXT = [
  "Task commands:",
  "- /task: active task/loop 상태 보기",
  "- /loop [--loops n] <목표>: 일반 사용자용 bounded loop 시작",
  "- /task loop <목표>: legacy 반복 점검·개선 작업 시작",
  "- /task pause: active loop 일시정지",
  "- /task resume: active loop 재개",
  "- /task stop: active loop 중단",
  "- /task approve: approval 대기 상태 해제",
].join("\n");

const USER_TEAM_GOAL_RESERVED_SUBCOMMANDS = new Set([
  'help', 'details', 'status', 'more', 'suggest', 'create', 'refine', 'apply', 'options', 'roles', 'patterns', 'schema', 'modes', 'reset',
  'requirements', 'proposal', 'export', 'publish', 'library', 'package', 'clone', 'fork', 'install', 'import', 'pull', 'push', 'debug', 'validate', 'template',
]);

const AGENTS_HELP_TEXT = [
  "Agent Room commands:",
  "- /room: 공유 가능한 AI Room / Room Package 보기",
  "- /agents: 이 채팅방의 Agent Room 보기",
  "- /agents suggest <목표>: 목표에 맞는 agent 구성 추천",
  "- /agents use planner,builder,reviewer: 기본 agent 역할 적용",
  "- /agents export: 현재 Agent Room을 portable package JSON으로 내보내기",
  "- /agents publish-candidate: 공유 전 검토용 package candidate 생성",
  "- /agents packages: 저장된 agent package 목록",
  "- /agents clone <package_id>: package를 이 채팅방에 설치",
  "- /agents reset: Agent Room 초기화",
  "- /team: legacy/advanced alias. 일반 사용은 /agents 권장",
].join("\n");


const ROOM_HELP_TEXT = [
  "AI Room commands:",
  "- /room: 현재 방의 specialization 보기",
  "- /room suggest <goal>: 반복 작업용 room profile / Room Package 제안",
  "- /room apply <goal>: 이 방을 해당 목적에 맞게 전문화",
  "- /room presets [query]: 내장 room/skill/memory preset 목록 보기",
  "- /room preset <id> 또는 /room use <id>: 내장 preset을 이 방에 적용",
  "- /room alternatives [goal]: base package + borrowed skill/protocol/memory 후보 보기",
  "- /room docs [full]: action/docs + MOC 문서 구조 보기",
  "- /room topology: agent communication topology와 learning dataset 계획 보기",
  "- /room agents: cost/outcome-aware agent activation policy 보기",
  "- /room agents specialize: 최근 trace 기반 agent pruning/downgrade proposal 생성",
  "- /room learning [export]: 사용자 approve/reject/correct/stop 선택을 room preference dataset으로 요약/내보내기",
  "- /room advisor [goal]: broad/specialized/hybrid tradeoff 추천",
  "- /room evolution: 반복 상호작용에서 emergent schema/agent/gateway 제안 보기",
  "- /room manual: 현재 ROOM.md 보기",
  "- /room export [title]: 공유 가능한 Room Package 생성",
  "- /room install <package_json>: 공유 Room Package 설치",
  "- /room reset: room specialization 초기화",
  "",
  "Room packages share how a room works; they never copy private memory, credentials, raw chat logs, or uploaded files.",
].join("\n");


function parseSimpleDotenv(text = '') {
  const parsed = {};
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) parsed[key] = value;
  }
  return parsed;
}

function loadRuntimeDoctorEnv() {
  const candidates = [];
  const explicit = String(process.env.DDALGGAK_ENV_FILE || '').trim();
  if (explicit) candidates.push(explicit);
  candidates.push(path.join(process.cwd(), '.env'));
  candidates.push(path.join(process.cwd(), 'ddalggak', '.env'));
  for (const candidate of candidates) {
    if (!candidate) continue;
    const resolved = path.resolve(candidate);
    if (!fs.existsSync(resolved)) continue;
    try {
      const parsed = parseSimpleDotenv(fs.readFileSync(resolved, 'utf8'));
      return {
        env: { ...process.env, ...parsed },
        configuredKeys: Object.keys(parsed),
        sourceLabel: resolved,
      };
    } catch (error) {
      return {
        env: process.env,
        configuredKeys: Object.keys(process.env),
        sourceLabel: `${resolved} (read failed: ${error?.message || error})`,
      };
    }
  }
  return {
    env: process.env,
    configuredKeys: Object.keys(process.env),
    sourceLabel: 'process.env (no .env file found)',
  };
}

const REVIEW_HELP_TEXT = [
  "Review commands:",
  "- /review: 승인/검토가 필요한 항목 보기",
  "- /review approve: 현재 approval 대기 상태 승인",
  "- /review reject <reason>: 현재 approval 대기 상태 거절/방향 수정",
  "- 상세 proposal 편집은 GoC Review Inbox에서 처리하세요.",
].join("\n");

const TEAM_DEBUG_HELP_TEXT = [
  "Team debug commands:",
  "- /team debug templates: benchmark template catalog 보기",
  "- /team debug template benchmark <id>: benchmark template을 pending team으로 불러오기",
  "- /team debug template current: 현재 pending/active team의 legacy JSON template 출력",
].join("\n");

export function createTelegramCommandHandler(deps = {}) {
  const telegramUi = deps.telegramUi || {};
  const runtimeOps = deps.runtimeOps || {};
  const jobOps = deps.jobOps || {};
  const sessionOps = deps.sessionOps || {};
  const fileOps = deps.fileOps || {};
  const teamOps = deps.teamOps || {};

  const bot = telegramUi.bot || deps.bot;
  const sendLong = telegramUi.sendLong || deps.sendLong || ((bot, chatId, text, options) => bot.sendMessage(chatId, text, options));
  const sendContextInfo = telegramUi.sendContextInfo || deps.sendContextInfo;
  const sendRouterAckMessage = telegramUi.sendRouterAckMessage || deps.sendRouterAckMessage;
  const clip = telegramUi.clip || deps.clip;

  const formatRunningJobs = jobOps.formatRunningJobs || deps.formatRunningJobs;
  const cancelJobExecution = jobOps.cancelJobExecution || deps.cancelJobExecution;
  const createJob = jobOps.createJob || deps.createJob;
  const resetJobAbortController = jobOps.resetJobAbortController || deps.resetJobAbortController;
  const tracking = jobOps.tracking || deps.tracking;
  const jobs = jobOps.jobs || deps.jobs;
  const approvals = jobOps.approvals || deps.approvals;
  const isCancelledError = jobOps.isCancelledError || deps.isCancelledError;
  const actionLabel = jobOps.actionLabel || deps.actionLabel;
  const getGoalFromResearch = jobOps.getGoalFromResearch || deps.getGoalFromResearch;
  const extractCodexInstruction = jobOps.extractCodexInstruction || deps.extractCodexInstruction;

  const getAwait = sessionOps.getAwait || deps.getAwait;
  const clearAwait = sessionOps.clearAwait || deps.clearAwait;
  const setAwait = sessionOps.setAwait || deps.setAwait;
  const rememberLastChatJob = sessionOps.rememberLastChatJob || deps.rememberLastChatJob;
  const resetChatSession = sessionOps.resetChatSession || deps.resetChatSession;
  const activeJobByChat = sessionOps.activeJobByChat || deps.activeJobByChat;
  const lastChatJobByChat = sessionOps.lastChatJobByChat || deps.lastChatJobByChat;
  const chatSessionStore = sessionOps.chatSessionStore || deps.chatSessionStore;
  const chatRunManager = sessionOps.chatRunManager || deps.chatRunManager;
  const jobAbortControllers = sessionOps.jobAbortControllers || deps.jobAbortControllers;

  const resolveLiveJobIdForChat = fileOps.resolveLiveJobIdForChat || deps.resolveLiveJobIdForChat || (() => null);
  const parseClampedInt = fileOps.parseClampedInt || deps.parseClampedInt;
  const collectWorkspaceFileEntries = fileOps.collectWorkspaceFileEntries || deps.collectWorkspaceFileEntries;
  const formatWorkspaceFileListText = fileOps.formatWorkspaceFileListText || deps.formatWorkspaceFileListText;
  const refreshArtifactIndex = fileOps.refreshArtifactIndex || deps.refreshArtifactIndex;
  const formatArtifactIndexText = fileOps.formatArtifactIndexText || deps.formatArtifactIndexText;
  const resolveArtifactDeliveryContract = fileOps.resolveArtifactDeliveryContract || deps.resolveArtifactDeliveryContract || (() => ({ enabled: false, warnings: [], bundle_allowed: true }));
  const formatArtifactDeliveryContractLines = fileOps.formatArtifactDeliveryContractLines || deps.formatArtifactDeliveryContractLines || (() => []);
  const sendArtifactBySelection = fileOps.sendArtifactBySelection || deps.sendArtifactBySelection;
  const sendArtifactBundle = fileOps.sendArtifactBundle || deps.sendArtifactBundle;
  const parseArtifactBundleSelection = fileOps.parseArtifactBundleSelection || deps.parseArtifactBundleSelection || (() => null);
  const formatByteSize = fileOps.formatByteSize || deps.formatByteSize;
  const runWorkspaceDir = fileOps.runWorkspaceDir || deps.runWorkspaceDir;

  const memory = runtimeOps.memory || deps.memory;
  const formatMemorySummary = runtimeOps.formatMemorySummary || deps.formatMemorySummary;
  const formatAgentMemorySummary = runtimeOps.formatAgentMemorySummary || deps.formatAgentMemorySummary;
  const parseChatMessageWithFlags = runtimeOps.parseChatMessageWithFlags || deps.parseChatMessageWithFlags;
  const runSupervisorChat = runtimeOps.runSupervisorChat || deps.runSupervisorChat;
  const loadSupervisorRuntime = runtimeOps.loadSupervisorRuntime || deps.loadSupervisorRuntime;
  const normalizeForceMode = runtimeOps.normalizeForceMode || deps.normalizeForceMode || ((value) => value || 'normal');
  const decideRunRoute = runtimeOps.decideRunRoute || deps.decideRunRoute;
  const executeRoutedPlan = runtimeOps.executeRoutedPlan || deps.executeRoutedPlan;
  const suggestNextPrompt = runtimeOps.suggestNextPrompt || deps.suggestNextPrompt;
  const sendChatGPTPrompt = runtimeOps.sendChatGPTPrompt || deps.sendChatGPTPrompt;
  const directAskExecutor = runtimeOps.directAskExecutor || deps.directAskExecutor || null;
  const searchAskExecutor = runtimeOps.searchAskExecutor || deps.searchAskExecutor || null;
  const explicitRoomConciergeModel = runtimeOps.roomConciergeModel || deps.roomConciergeModel || null;
  const memoryModeWithFallback = runtimeOps.memoryModeWithFallback || deps.memoryModeWithFallback;
  const requireGocClient = runtimeOps.requireGocClient || deps.requireGocClient;

  const sendChatStatus = teamOps.sendChatStatus || deps.sendChatStatus;
  const sendAgentOrToolListQuick = teamOps.sendAgentOrToolListQuick || deps.sendAgentOrToolListQuick;
  const createAgentRoomTeamConfiguration = teamOps.createAgentRoomTeamConfiguration
    || deps.createAgentRoomTeamConfiguration
    || createFreeformTeamConfigurationAdvanced;

  function parseApplyStateTokens(tokens = []) {
    for (const raw of tokens) {
      const value = String(raw || '').trim().toLowerCase();
      if (value === 'active' || value === '--active' || value === '--apply') return 'active';
      if (value === 'pending' || value === '--pending') return 'pending';
    }
    return 'pending';
  }

  function currentTeamForManifest(teamState = {}) {
    return teamState.pending_team || teamState.active_team || null;
  }

  function buildManifestWithSessionState(baseTeam, { runtime = null, applyState = 'pending', source = 'telegram', sessionInstallProposal = null } = {}) {
    return buildTeamBlueprint(baseTeam, { runtime, applyState, source, installProposalState: sessionInstallProposal });
  }

  function buildTeamStatusOverview(teamState = {}, { chatId = '', runtime = null } = {}) {
    const lines = [buildTeamListMessage(teamState, { runtime })];
    const session = chatSessionStore?.get?.(chatId) || {};
    const pendingTeam = teamState?.pending_team && typeof teamState.pending_team === 'object' ? teamState.pending_team : null;
    const activeTeam = teamState?.active_team && typeof teamState.active_team === 'object' ? teamState.active_team : null;
    const pendingInstallProposal = getPendingInstallProposal(chatSessionStore, chatId);
    const credentialBindingState = getCredentialBindingState(chatSessionStore, chatId);
    const patternConflict = session?.pattern_conflict && typeof session.pattern_conflict === 'object' ? session.pattern_conflict : null;
    const temporaryOverride = session?.temporary_execution_override && typeof session.temporary_execution_override === 'object' ? session.temporary_execution_override : null;
    const patternRecovery = session?.pattern_recovery && typeof session.pattern_recovery === 'object' ? session.pattern_recovery : null;
    const lastRecovery = session?.last_recovery_event && typeof session.last_recovery_event === 'object' ? session.last_recovery_event : null;
    const lastFork = session?.last_fork_event && typeof session.last_fork_event === 'object' ? session.last_fork_event : null;
    const lastRejoin = session?.last_rejoin_event && typeof session.last_rejoin_event === 'object' ? session.last_rejoin_event : null;

    const stateLines = [
      `active team: ${activeTeam ? String(activeTeam.team_name || 'configured').trim() : 'none'}`,
      `pending team: ${pendingTeam ? `${String(pendingTeam.team_name || 'pending_team').trim()}${pendingTeam?.planner_metadata?.auto_refine_from_pattern_conflict ? ' · auto_refine_draft' : ''}` : 'none'}`,
      `capability proposal: ${pendingInstallProposal ? `${String(pendingInstallProposal.status || 'awaiting_install_approval')} · gaps=${Number(pendingInstallProposal?.proposal?.gap_count || 0)}` : 'none'}`,
      `credential bindings: ${Number(credentialBindingState?.summary?.bound_count || 0)}`,
    ];
    if (patternConflict?.classification) {
      stateLines.push(`pattern conflict: ${String(patternConflict.classification)}${patternConflict?.reason ? ` · ${String(patternConflict.reason)}` : ''}`);
    }
    if (temporaryOverride?.effective_pattern || temporaryOverride?.mode) {
      stateLines.push(`temporary override: ${String(temporaryOverride.effective_pattern || temporaryOverride.mode || 'active')}`);
    }
    if (patternRecovery?.recovery_mode || patternRecovery?.status) {
      stateLines.push(`pattern recovery: ${String(patternRecovery.recovery_mode || patternRecovery.status || 'pending')}`);
    }
    if (lastRecovery?.category || lastRecovery?.status) {
      stateLines.push(`latest recovery: ${String(lastRecovery.status || 'classified')} · ${String(lastRecovery.category || 'unknown_failure')}${lastRecovery?.recovery_strategy ? ` · ${String(lastRecovery.recovery_strategy)}` : ''}`);
    }
    if (lastFork?.forked_agent_id || lastFork?.source_agent_id) {
      stateLines.push(`latest fork: ${String(lastFork.source_agent_id || 'source')} -> ${String(lastFork.forked_agent_id || 'forked')}${lastFork?.scope_mode ? ` · scope=${String(lastFork.scope_mode)}` : ''}`);
    }
    if (lastRejoin?.agent_id || lastRejoin?.source_agent_id) {
      stateLines.push(`latest rejoin: ${String(lastRejoin.agent_id || 'forked')} -> ${String(lastRejoin.source_agent_id || 'source')}${lastRejoin?.summary ? ` · ${String(lastRejoin.summary)}` : ''}`);
    }
    lines.push('', 'Runtime state', ...stateLines);
    const pendingApplyGuardrails = pendingTeam ? buildTeamTransitionGuardrails(activeTeam, pendingTeam) : null;
    const confirmationState = session?.pending_team_apply_confirmation && typeof session.pending_team_apply_confirmation === 'object'
      ? session.pending_team_apply_confirmation
      : null;
    if (pendingApplyGuardrails?.warning_count > 0) {
      lines.push('', 'Apply 전 확인', ...formatTeamTransitionGuardrailLines(pendingApplyGuardrails, { maxWarnings: 5 }));
      if (confirmationState?.expires_at) {
        stateLines.push(`apply confirmation: 재확인 필요 · ${String(confirmationState.expires_at)}`);
      }
    }

    const nextSteps = [];
    if (pendingTeam) {
      nextSteps.push(pendingApplyGuardrails?.destructive_changes_present
        ? '- /team apply (한 번 누르면 경고, 다시 누르면 적용)'
        : '- /team apply');
    }
    if (pendingInstallProposal) nextSteps.push('- /team proposal', '- /credential pending');
    if (patternConflict?.classification === 'structure_override_required') nextSteps.push('- /team refine <자연어 수정>');
    if (nextSteps.length > 0) lines.push('', '추천 명령', ...nextSteps);
    return lines.join('\n');
  }
  function countConfiguredAgents(team = null) {
    return Array.isArray(team?.agents) ? team.agents.length : 0;
  }

  function summarizeTeamSlot(label = '', team = null) {
    if (!team || typeof team !== 'object') return `${label}: none`;
    const name = String(team.team_name || `${label}_team`).trim() || `${label}_team`;
    const agentCount = countConfiguredAgents(team);
    const compositionMode = String(team.composition_mode || '').trim().toLowerCase() || 'structured';
    const pattern = String(team?.structure_v2?.topology?.pattern || '').trim();
    const extras = [];
    if (pattern) extras.push(pattern);
    if (team?.planner_metadata?.auto_refine_from_pattern_conflict) extras.push('auto-refine');
    const summaryParts = [`${label}: ${name}`, `${agentCount} agent${agentCount === 1 ? '' : 's'}`, compositionMode, ...extras];
    return summaryParts.join(' · ');
  }

  function buildCompactTeamStatusMessage(teamState = {}, { chatId = '', runtime = null } = {}) {
    const session = chatSessionStore?.get?.(chatId) || {};
    const pendingTeam = teamState?.pending_team && typeof teamState.pending_team === 'object' ? teamState.pending_team : null;
    const activeTeam = teamState?.active_team && typeof teamState.active_team === 'object' ? teamState.active_team : null;
    const pendingInstallProposal = getPendingInstallProposal(chatSessionStore, chatId);
    const patternConflict = session?.pattern_conflict && typeof session.pattern_conflict === 'object' ? session.pattern_conflict : null;
    const pendingApplyGuardrails = pendingTeam ? buildTeamTransitionGuardrails(activeTeam, pendingTeam) : null;
    const lines = [
      'Team',
      summarizeTeamSlot('active', activeTeam),
      summarizeTeamSlot('pending', pendingTeam),
    ];

    if (runtime?.conversationInfo?.executionLane) {
      lines.push(`lane: ${String(runtime.conversationInfo.executionLane)}`);
    }
    if (pendingInstallProposal) {
      lines.push(`install proposal: ${String(pendingInstallProposal.status || 'awaiting_install_approval')} · gaps=${Number(pendingInstallProposal?.proposal?.gap_count || 0)}`);
    }
    if (patternConflict?.classification) {
      lines.push(`pattern conflict: ${String(patternConflict.classification)}`);
    }
    if (pendingApplyGuardrails?.warning_count > 0) {
      lines.push(`apply check: warnings ${Number(pendingApplyGuardrails.warning_count || 0)}`);
    }

    const nextSteps = [];
    if (pendingTeam) {
      nextSteps.push(pendingApplyGuardrails?.destructive_changes_present ? '/team apply (confirm twice)' : '/team apply');
      nextSteps.push('/team refine <수정>');
    } else if (activeTeam) {
      nextSteps.push('/chat <요청>');
      nextSteps.push('/team suggest <목적>');
    } else {
      nextSteps.push('/team suggest <목적>');
      nextSteps.push('/team create <설명>');
    }
    if (pendingInstallProposal) nextSteps.push('/team proposal');

    lines.push('', 'Next', ...nextSteps.map((entry) => `- ${entry}`), '', 'More', '- /team details', '- /team more');
    return lines.join('\n');
  }



  async function resumeFromInstallProposal({ state = null, runtime = null, chatId = '', userId = '', currentTeam = null } = {}) {
    const resume = state?.resume_request && typeof state.resume_request === 'object' ? state.resume_request : null;
    if (!resume?.message || typeof runSupervisorChat !== 'function') return false;
    await runSupervisorChat(bot, chatId, userId, resume.message, {
      debug: false,
      chatInfo: resume.chat_info && typeof resume.chat_info === 'object' ? resume.chat_info : { chat_id: String(chatId || '') },
      inputKind: resume.input_kind || 'install_resume',
      telegramMessageId: resume.telegram_message_id || null,
      userReplyToMessageId: resume.user_reply_to_message_id || null,
      forceMode: normalizeForceMode(resume.force_mode || 'normal'),
      teamConfig: currentTeam && typeof currentTeam === 'object' ? currentTeam : null,
    });
    return true;
  }

  async function requireCurrentRuntime(chatId, userId) {
    const currentJobId = resolveLiveJobIdForChat(chatId);
    if (!currentJobId || typeof loadSupervisorRuntime !== 'function') return null;
    try {
      return await loadSupervisorRuntime(currentJobId, { telegramUserId: userId, includeContext: false, includeGlobal: false });
    } catch {
      return null;
    }
  }

  function getCurrentThreadId(runtime = null) {
    return String(runtime?.map?.threadId || runtime?.threadId || '').trim();
  }

  function formatImprovementJobStatus(jobResponse = {}) {
    const job = jobResponse?.job && typeof jobResponse.job === 'object' ? jobResponse.job : {};
    const payload = job.payload && typeof job.payload === 'object' ? job.payload : {};
    const latestReports = payload.latest_reports && typeof payload.latest_reports === 'object' ? payload.latest_reports : {};
    const lines = [
      'Improvement job',
      `- job_id: ${String(payload.job_id || payload.improvement_job_id || job.id || '-')}`,
      `- target: ${String(payload.improvement_target || '-')}`,
      `- runtime: ${String(payload.target_runtime || '-')}`,
      `- phase: ${String(payload.phase || '-')}`,
      `- status: ${String(payload.status || '-')}`,
      `- requested_by: ${String(payload.requested_by || '-')}`,
      `- workspace_root: ${String(payload.workspace_root || '-')}`,
      `- instruction: ${String(payload.instruction || job.text || '-').slice(0, 240)}`,
    ];
    const counts = payload.report_counts && typeof payload.report_counts === 'object' ? payload.report_counts : {};
    const countPairs = Object.entries(counts).map(([kind, count]) => `${kind}=${count}`);
    if (countPairs.length) lines.push(`- report_counts: ${countPairs.join(', ')}`);
    const latestPairs = Object.entries(latestReports).slice(0, 6).map(([kind, value]) => {
      const row = value && typeof value === 'object' ? value : {};
      return `- ${kind}: ${String(row.status || '-')}${row.phase ? ` @ ${String(row.phase)}` : ''}${row.summary ? ` · ${String(row.summary).slice(0, 120)}` : ''}`;
    });
    if (latestPairs.length) lines.push('', 'Latest reports', ...latestPairs);
    return lines.join('\n');
  }

  function formatAutomationSummary(result = {}) {
    const row = result && typeof result === 'object' ? result : {};
    const lines = [
      `- automation_status: ${String(row.status || '-')}`,
    ];
    if (row.patch) lines.push(`- patch: ${String(row.patch.status || '-')}`);
    if (row.tests) lines.push(`- tests: ${String(row.tests.status || '-')}`);
    if (row.canary) lines.push(`- canary: ${String(row.canary.status || '-')}`);
    if (row.promotion) lines.push(`- promotion: ${String(row.promotion.status || '-')}`);
    return lines.join('\n');
  }

  async function requireGocImprovementContext(chatId, userId) {
    const runtimeForGoc = await requireCurrentRuntime(chatId, userId);
    const threadId = getCurrentThreadId(runtimeForGoc);
    if (!threadId || memoryModeWithFallback?.() !== 'goc' || typeof requireGocClient !== 'function') {
      return null;
    }
    return {
      runtime: runtimeForGoc,
      threadId,
      client: requireGocClient(),
    };
  }


  async function trySyncApprovedRoomMemoryToGoc({ chatId = '', userId = '', memoryItem = null } = {}) {
    if (!memoryItem) return { ok: false, synced: false, reason: 'no_memory_item' };
    if (typeof requireGocClient !== 'function' || typeof memoryModeWithFallback !== 'function' || memoryModeWithFallback() !== 'goc') {
      return { ok: false, synced: false, reason: 'goc_memory_mode_not_active' };
    }
    const runtimeForGoc = await requireCurrentRuntime(chatId, userId);
    const threadId = getCurrentThreadId(runtimeForGoc);
    if (!threadId) return { ok: false, synced: false, reason: 'missing_goc_thread_id' };
    return await syncTelegramApprovedRoomMemoryToGoc({
      client: requireGocClient(),
      threadId,
      memoryItem,
      chatId,
      userId,
      runId: resolveLiveJobIdForChat(chatId) || '',
    });
  }

  function normalizeRuleSource(row = {}) {
    const source = String(row?.source || row?.origin || row?.scope || 'user').trim().toLowerCase();
    if (/learn|auto|runtime|system/.test(source)) return 'learned';
    return 'user';
  }

  function inferRuntimeRuleTopic(raw = '') {
    const text = String(raw || '').toLowerCase();
    if (!text.trim()) return 'general';
    if (/(산출물|결과물|artifact|deliverable|workspace|파일|문서|file|document|send|전송|보내|저장|생성|만들)/i.test(text)) return 'artifacts';
    if (/(메모리|기억|memory|remember|retain|summary|요약)/i.test(text)) return 'memory';
    if (/(답변|응답|말투|길이|간단|자세|tone|style|format|메시지)/i.test(text)) return 'answer_style';
    if (/(검색|web|웹|출처|citation|인용|최신|current)/i.test(text)) return 'search';
    if (/(모델|model|gemini|codex|router|routing|라우팅|agent|에이전트)/i.test(text)) return 'agent_behavior';
    return 'general';
  }

  function compactRuntimeRuleText(raw = '') {
    return String(raw || '')
      .replace(/^\s*(?:\/rule\s+|rule\s*:|rules\s*:|규칙\s*:|지침\s*:|운영\s*지침\s*:)/i, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 500);
  }

  function formatRuntimeRulesMessage(chatId) {
    const session = chatSessionStore.get(chatId);
    const rules = Array.isArray(session.runtime_rules)
      ? session.runtime_rules.filter((row) => row?.enabled !== false && String(row?.text || '').trim())
      : [];
    if (rules.length === 0) {
      return [
        '현재 적용 중인 운영 지침이 없습니다.',
        '',
        '사용법: /rule <자연어 지침>',
        '예: /rule 산출물은 내가 명시적으로 요청할 때만 만들어줘.',
        '',
        '세부 편집과 히스토리 관리는 GoC에서 다룹니다.',
      ].join('\n');
    }
    return [
      '현재 적용 중인 운영 지침:',
      ...rules.slice(0, 8).map((row, index) => `${index + 1}. ${String(row.text || '').trim()}`),
      '',
      '새 지침은 /rule <자연어 지침>으로 말하면 반영합니다. 세부 편집과 히스토리 관리는 GoC에서 다룹니다.',
    ].join('\n');
  }

  function addRuntimeRule(chatId, ruleText, opts = {}) {
    const text = compactRuntimeRuleText(ruleText);
    if (!text) return null;
    const source = String(opts.source || opts.origin || 'user').trim().toLowerCase() || 'user';
    const sourceGroup = /learn|auto|runtime|system/.test(source) ? 'learned' : 'user';
    const normalized = text.toLowerCase();
    const topic = String(opts.topic || inferRuntimeRuleTopic(text)).trim().toLowerCase() || 'general';
    const idPrefix = sourceGroup === 'learned' ? 'learned_rule' : 'rule';
    const now = new Date().toISOString();
    let inserted = null;
    chatSessionStore.upsert(chatId, (session) => {
      const existing = Array.isArray(session.runtime_rules) ? session.runtime_rules : [];
      const deduped = existing.filter((row) => String(row?.text || '').trim().toLowerCase() !== normalized);
      const replaced = topic === 'general'
        ? deduped
        : deduped.filter((row) => !(normalizeRuleSource(row) === sourceGroup && String(row?.topic || inferRuntimeRuleTopic(row?.text || '')).toLowerCase() === topic));
      const language = normalizeLanguageMetadata({ text, displayText: text, locale: resolveUserSurfaceLocale({ message: text, fallback: 'ko' }), source: 'telegram_rule_command' });
      const row = {
        id: `${idPrefix}_${Date.now().toString(36)}`,
        text,
        source_original_text: language.source_original_text,
        source_original_language: language.source_original_language,
        original_language: language.original_language,
        display_text: language.display_text,
        canonical_language: language.canonical_language,
        canonical_text_en: language.canonical_text_en,
        canonical_projection_status: language.canonical_projection_status,
        enabled: true,
        scope: 'chat',
        source,
        origin: String(opts.origin || source).trim().toLowerCase() || source,
        topic,
        confidence: Number.isFinite(Number(opts.confidence)) ? Math.max(0, Math.min(1, Number(opts.confidence))) : undefined,
        reason: String(opts.reason || '').trim() || undefined,
        created_at: now,
        updated_at: opts.replaces ? now : undefined,
      };
      inserted = row;
      const nextRows = [...replaced, row];
      const userRows = nextRows.filter((item) => normalizeRuleSource(item) !== 'learned').slice(-8);
      const learnedRows = nextRows.filter((item) => normalizeRuleSource(item) === 'learned').slice(-6);
      return { ...session, runtime_rules: [...userRows, ...learnedRows] };
    });
    return inserted;
  }

  function parseChatEmbeddedRule(raw = '') {
    const text = String(raw || '').trim();
    if (!text) return null;
    const match = text.match(/^(?:rule\s*:|rules\s*:|규칙\s*:|지침\s*:|agent\s+rule\s*:|runtime\s+rule\s*:|시스템\s*지침\s*:|에이전트\s*지침\s*:|운영\s*지침\s*:)([\s\S]+)/i);
    const ruleText = compactRuntimeRuleText(match?.[1] || '');
    return ruleText ? ruleText : null;
  }

  function inferAutoRuntimeRule(raw = '') {
    const text = String(raw || '').replace(/^\/chat\s+/i, '').trim();
    if (!text || text.length < 8 || text.length > 900) return null;
    if (parseChatEmbeddedRule(text)) return null;
    const behaviorSubject = /(답변|응답|메시지|산출물|파일|문서|workspace|artifact|deliverable|메모리|기억|검색|모델|agent|에이전트|routing|라우팅|prompt|프롬프트|rule|규칙|지침)/i.test(text);
    const correctionSignal = /(아니|그런식|그렇게|방금|이전|앞으로|다음부터|기본적으로|항상|절대|하지\s*마|하지\s*말|해야|말고|원하지|바꾸|수정|편집|관리해|가능하게|prefer|default|from\s+now|do\s+not|don't|never|always|instead)/i.test(text);
    if (!behaviorSubject || !correctionSignal) return null;
    return compactRuntimeRuleText(text);
  }

  function maybeLearnRuntimeRule(chatId, message = '') {
    const ruleText = inferAutoRuntimeRule(message);
    if (!ruleText) return null;
    addRuntimeRule(chatId, ruleText, {
      source: 'runtime_learned',
      origin: 'auto_correction',
      confidence: 0.62,
      reason: 'latest chat message looked like a correction/preference about agent behavior',
    });
    return ruleText;
  }

  function clearRuntimeRules(chatId) {
    return chatSessionStore.upsert(chatId, (session) => ({ ...session, runtime_rules: [] }));
  }

  function formatLocalSkillCatalogMessage({ rootDir = process.cwd() } = {}) {
    const skills = listLocalSkillPackages({ rootDir });
    if (skills.length === 0) {
      return [
        'Local skill catalog is empty.',
        '',
        'Import examples:',
        '- /skill import /path/to/skill_dir',
        '- /skill import {"skills":[...],"rules":[...]}',
      ].join('\n');
    }
    const lines = [
      'Local skill catalog',
      `- skills: ${skills.length}`,
      '',
    ];
    for (const skill of skills.slice(0, 20)) {
      const perf = skill.ranking_metadata?.reuse_score ? ` · reuse=${skill.ranking_metadata.reuse_score}` : '';
      lines.push(`- ${skill.skill_id || skill.id}: ${skill.name || skill.slug}${perf}`);
      if (skill.description) lines.push(`  ${String(skill.description).slice(0, 140)}`);
      const tags = Array.isArray(skill.capability_tags) ? skill.capability_tags.slice(0, 6).join(', ') : '';
      if (tags) lines.push(`  tags: ${tags}`);
    }
    if (skills.length > 20) lines.push(`... ${skills.length - 20} more`);
    return lines.join('\n');
  }

  function setSkillAutoActivation(chatId, enabled) {
    chatSessionStore.upsert(chatId, (session = {}) => ({
      ...session,
      skill_auto_activation: enabled !== false,
      updated_at: new Date().toISOString(),
    }));
    return enabled !== false;
  }

  function applyImportedRuntimeRules(chatId, rules = []) {
    const saved = [];
    for (const rule of Array.isArray(rules) ? rules : []) {
      const row = addRuntimeRule(chatId, rule.text || rule.rule || '', {
        source: rule.source || 'external_import',
        origin: rule.origin || 'external_import',
        topic: rule.topic,
        confidence: rule.confidence,
        reason: rule.reason || 'imported external rule package',
      });
      if (row) saved.push(row);
    }
    return saved;
  }

  function getCurrentJobDirForChat(chatId) {
    const jobId = resolveLiveJobIdForChat(chatId);
    if (!jobId || !jobs || typeof jobs.jobDir !== 'function') return { jobId: null, jobDir: null };
    try { return { jobId, jobDir: jobs.jobDir(jobId) }; } catch { return { jobId, jobDir: null }; }
  }


  function appendCompanionControlEvent(chatId, userId, event = {}) {
    const current = getCurrentJobDirForChat(chatId);
    return appendRoomCompanionEvent({
      jobDir: current.jobDir || '',
      chatSessionStore,
      chatId,
      userId,
      jobId: current.jobId || '',
      event,
    });
  }

  function getCurrentCompanionControlState(chatId) {
    const current = getCurrentJobDirForChat(chatId);
    const session = chatSessionStore?.get?.(chatId) || {};
    const events = readRoomCompanionEvents({ jobDir: current.jobDir || '', session, limit: 80 });
    return deriveRoomCompanionState({ events, session });
  }

  function runIdleMemoryStructuringForChat({ chatId = '', userId = '', force = false, source = 'idle_after_room_turn' } = {}) {
    const roomProfile = getAgentRoomProfile(chatSessionStore, chatId);
    const companionState = getCurrentCompanionControlState(chatId);
    return runRoomIdleMemoryStructuring({
      chatSessionStore,
      chatId,
      roomProfile,
      companionState,
      force,
      source,
      appendEvent: (event) => appendCompanionControlEvent(chatId, userId, event),
    });
  }

  function scheduleIdleMemoryStructuringForChat({ chatId = '', userId = '', source = 'idle_after_room_turn' } = {}) {
    const enabled = String(process.env.DDALGGAK_ROOM_IDLE_MEMORY_ENABLED || '1').trim().toLowerCase();
    if (['0', 'false', 'no', 'off'].includes(enabled)) return { scheduled: false, reason: 'disabled' };
    if (chatRunManager?.isRunning && chatRunManager.isRunning(chatId)) return { scheduled: false, reason: 'runtime_busy' };
    const runner = () => {
      try { runIdleMemoryStructuringForChat({ chatId, userId, force: false, source }); } catch {}
      try { maybeSendRoomGovernanceDigest({ chatId, userId }).catch(() => {}); } catch {}
    };
    if (typeof setTimeout === 'function') setTimeout(runner, 0);
    else runner();
    return { scheduled: true };
  }

  function formatCompanionSwitchMessage(state = {}) {
    const profile = state?.active_companion || getRoomCompanionProfile('research');
    const connections = (profile.memory_connections || []).map((conn) => `${conn.source}(${conn.mode}/${conn.strictness})`).join(', ') || '-';
    const excluded = (profile.excluded_by_default || []).join(', ') || '-';
    return [
      `✅ ${profile.label} 로 전환했습니다.`,
      `purpose: ${profile.purpose}`,
      `memory connections: ${connections}`,
      `excluded by default: ${excluded}`,
      `agent_mode: ${state.agent_mode || profile.agent_mode || 'balanced'}`,
      '',
      '확인: /companion profile',
    ].join('\n');
  }

  async function loadRuntimeForCurrentJob(chatId, userId, { includeContext = false } = {}) {
    const currentJobId = resolveLiveJobIdForChat(chatId);
    if (!currentJobId || typeof loadSupervisorRuntime !== 'function') return { currentJobId: currentJobId || null, runtime: null };
    try {
      return {
        currentJobId,
        runtime: await loadSupervisorRuntime(currentJobId, { telegramUserId: userId, includeContext, includeGlobal: false }),
      };
    } catch {
      return { currentJobId, runtime: null };
    }
  }


  function summarizeAgentRoomPlannerMetadata(team = null) {
    const metadata = team && typeof team === 'object' && team.planner_metadata && typeof team.planner_metadata === 'object'
      ? team.planner_metadata
      : {};
    const type = String(metadata.planner_type || '').trim() || 'unknown';
    const model = String(metadata.planner_model || '').trim();
    const source = String(metadata.planning_source || '').trim();
    const engine = [type, model].filter(Boolean).join(' · ') || 'unknown';
    const fallback = /heuristic|fallback|template|rule_based/i.test(`${type} ${source}`);
    return {
      engine,
      source,
      fallback,
      reasoning: Array.isArray(metadata.reasoning_summary)
        ? metadata.reasoning_summary.map((row) => String(row || '').trim()).filter(Boolean).slice(0, 3)
        : [],
    };
  }

  function formatAgentRoomPlannerDetails(team = null, { portfolio = null } = {}) {
    const row = team && typeof team === 'object' ? team : {};
    const metadata = summarizeAgentRoomPlannerMetadata(row);
    const agents = Array.isArray(row.agents) ? row.agents : [];
    const lines = [
      'LLM planner result',
      `- engine: ${metadata.engine}`,
      metadata.source ? `- source: ${metadata.source}` : null,
      metadata.fallback
        ? '- status: LLM planner를 사용할 수 없거나 실패해서 heuristic fallback이 적용되었습니다.'
        : '- status: LLM planner 기반 제안을 사용했습니다.',
    ].filter(Boolean);
    if (metadata.reasoning.length > 0) {
      lines.push('- reasoning:', ...metadata.reasoning.map((entry) => `  - ${entry}`));
    }
    if (agents.length > 0) {
      lines.push(
        '- planned agents:',
        ...agents.slice(0, 8).map((agent) => {
          const name = String(agent?.name || agent?.agent_id || agent?.id || agent?.role || 'agent').trim();
          const role = String(agent?.role || agent?.role_id || agent?.roleId || 'agent').trim();
          const model = String(agent?.model || '').trim();
          const provider = String(agent?.provider || '').trim();
          const runtime = [provider, model].filter(Boolean).join('/');
          return `  - ${name} (${role}${runtime ? ` · ${runtime}` : ''})`;
        }),
      );
    }
    const selectedCandidateId = portfolio && typeof portfolio === 'object' ? String(portfolio.selected_candidate_id || '').trim() : '';
    if (selectedCandidateId) lines.push(`- portfolio selection: ${selectedCandidateId}`);
    return lines.join('\n');
  }

  async function suggestAndApplyAgentRoomTeam({ chatId, userId, goal = '', runtimeForTeam = null, autoApply = false, preferPlannerProposal = false, workMode = 'team_task' } = {}) {
    let teamState = getSessionTeamState(chatSessionStore, chatId);
    const domainProfile = buildRoomProfileFromGoal({ chatId, goal, source: 'agent_room_team_suggest' });
    const packageForSelection = buildRoomPackage({ profile: domainProfile, goal, chatId, source: 'telegram_team_room_first' });
    let proposal = buildRoomFirstTeamConfiguration({
      taskText: goal,
      workMode,
      roomProfile: domainProfile,
      roomPackage: packageForSelection,
      chatId,
      runtime: runtimeForTeam,
      source: `telegram_${workMode}_room_first`,
    });
    let portfolio = {
      kind: 'team_selection_portfolio_v1',
      selected_candidate_id: 'ai_room_component_policy',
      selected_team: proposal,
      candidates: [{
        candidate_id: 'ai_room_component_policy',
        source: 'ai_room_component_policy',
        team: proposal,
        sufficient: true,
        utility: 1,
      }],
      notes: [
        'AI Room component policy is authoritative for /team and /loop runtime selection.',
        'Legacy implementation builder/reviewer fallback is suppressed unless room domain is code_review or user asks for workspace mutation.',
      ],
    };

    if (preferPlannerProposal) {
      try {
        const planned = await createAgentRoomTeamConfiguration({
          description: `Agent Room for this task: ${goal}`,
          runtime: runtimeForTeam,
          jobId: '',
        });
        if (planned && typeof planned === 'object' && Array.isArray(planned.agents) && planned.agents.length > 0) {
          proposal = {
            ...planned,
            composition_mode: planned.composition_mode || 'freeform',
            proposal_mode: planned.proposal_mode || 'suggest',
            task_brief: planned.task_brief || planned.taskBrief || `Agent Room for this task: ${goal}`,
          };
          portfolio = {
            kind: 'team_selection_portfolio_v1',
            selected_candidate_id: 'llm_planner_agent_room',
            selected_team: proposal,
            candidates: [{
              candidate_id: 'llm_planner_agent_room',
              source: proposal?.planner_metadata?.planning_source || 'llm_planner_agent_room',
              team: proposal,
              sufficient: true,
              utility: 1,
            }],
            notes: [
              'LLM-backed agent room planner proposal is preferred for /agents suggest.',
            ],
          };
        }
      } catch (error) {
        proposal = {
          ...proposal,
          planner_metadata: {
            ...(proposal?.planner_metadata && typeof proposal.planner_metadata === 'object' ? proposal.planner_metadata : {}),
            planner_type: proposal?.planner_metadata?.planner_type || 'heuristic_rule_based',
            planning_source: proposal?.planner_metadata?.planning_source || 'agent_room_planner_exception_fallback',
            reasoning_summary: [String(error?.message || error || 'planner unavailable').trim()].filter(Boolean),
          },
        };
      }
    }

    storePendingTeam(chatSessionStore, chatId, proposal, { portfolio });
    let activeTeam = proposal;
    if (autoApply) {
      try {
        activeTeam = await applyPendingTeam({ sessionStore: chatSessionStore, chatId, runtime: runtimeForTeam });
      } catch {
        activeTeam = proposal;
      }
    }
    const roomProfile = buildAgentRoomProfile({
      chatId,
      roomName: domainProfile.name || 'AI Work Room',
      goal,
      team: activeTeam,
      source: autoApply ? `${workMode}_auto_agent_room` : 'agents_suggest',
    });
    upsertAgentRoomProfile(chatSessionStore, chatId, {
      ...roomProfile,
      package_id: packageForSelection.package_id,
      room_runtime_selection: activeTeam?.room_runtime_selection || activeTeam?.ai_room_selection || null,
    });
    return { proposal, portfolio, activeTeam, roomProfile };
  }

  function setPendingTaskControl(chatId, payload = {}) {
    let saved = null;
    chatSessionStore.upsert(chatId, (session = {}) => {
      const now = new Date().toISOString();
      saved = {
        kind: 'agent_room_task_control_v1',
        status: 'active',
        created_at: session.pending_task_control?.created_at || now,
        updated_at: now,
        ...payload,
      };
      return { ...session, pending_task_control: saved };
    });
    return saved;
  }

  function getPendingTaskControl(chatId) {
    if (!chatSessionStore || typeof chatSessionStore.get !== 'function') return null;
    return chatSessionStore.get(chatId)?.pending_task_control || null;
  }


  function buildDdalggakHomeText(chatId) {
    const session = chatSessionStore?.get?.(chatId) || {};
    const chatKey = String(chatId || '');
    const current = getCurrentJobDirForChat(chatId);
    const activeJobFromMap = activeJobByChat && typeof activeJobByChat.get === 'function' ? activeJobByChat.get(chatKey) : '';
    const currentJobId = String(current.jobId || session.jobId || activeJobFromMap || '').trim();
    let watchSummary = null;
    try {
      watchSummary = current.jobDir ? summarizeWatchTaskState(current.jobDir) : null;
    } catch {
      watchSummary = null;
    }
    let companionState = null;
    try {
      companionState = getCurrentCompanionControlState(chatId);
    } catch {
      companionState = null;
    }
    const companionProfile = companionState?.active_companion || getRoomCompanionProfile('research');
    const agentMode = String(companionState?.agent_mode || companionProfile?.agent_mode || 'balanced').trim();
    let roomProfile = null;
    try {
      roomProfile = getAgentRoomProfile(chatSessionStore, chatId);
    } catch {
      roomProfile = null;
    }
    const roomName = String(roomProfile?.name || roomProfile?.room_name || '').trim();
    const roomGoal = String(roomProfile?.current_goal || roomProfile?.goal || roomProfile?.task_brief || '').trim();
    const pendingTask = getPendingTaskControl(chatId);
    const pendingApproval = session?.pending_approval && typeof session.pending_approval === 'object' ? session.pending_approval : null;
    const activeLabel = currentJobId ? `job=${currentJobId}` : 'active job 없음';
    const watchLabel = watchSummary
      ? `${watchSummary.status} · iteration ${watchSummary.current_iteration}/${watchSummary.max_iterations} · ${watchSummary.workflow_kind}`
      : '없음';
    const lines = [
      '🏠 DdalGgak Home · Room Doorway',
      '이 Telegram chat은 단순 bot UI가 아니라 evolving AI companion room으로 들어오는 front door입니다.',
      '',
      `- room: ${roomName || roomGoal || '아직 특화되지 않음'}`,
      `- status: ${activeLabel}`,
      `- loop/watch: ${watchLabel}`,
      `- active companion: ${companionProfile?.label || companionProfile?.id || 'Research Companion'} · mode=${agentMode}`,
      pendingTask?.goal ? `- pending goal: ${pendingTask.goal}` : '',
      pendingApproval ? `- needs review: ${String(pendingApproval.reason || pendingApproval.action || 'pending approval')}` : '',
      '',
      'Room entry actions / 바로 쓰는 5개 명령:',
      '1. /c <질문 또는 지시> — ask the room through the active companion',
      '2. /council ask <메시지> — companion들이 먼저 visible backchannel에서 조율',
      '3. /inbox — pending room decisions 확인',
      '4. /companions — companion roster와 memory boundary 보기',
      '5. /room apply <목표> — 이 Telegram chat의 room purpose 설정',
      '',
      currentJobId
        ? '현재 작업이 있으면: /status recent · /inbox · /artifacts 를 먼저 확인하세요.'
        : '처음이면: /room apply <하고 싶은 일> 후 /c 또는 /council ask 로 시작하는 것을 권장합니다.',
      '',
      '운영: /doctor · 전체 명령: /help · 고급 명령: /help more',
    ].filter(Boolean);

    return lines.join('\n');
  }

  function buildDdalggakInboxText(chatId) {
    const current = getCurrentJobDirForChat(chatId);
    const session = chatSessionStore?.get?.(chatId) || {};
    let watchSummary = null;
    try {
      watchSummary = current.jobDir ? summarizeWatchTaskState(current.jobDir) : null;
    } catch {
      watchSummary = null;
    }
    let reviewSummary = 'active job 없음';
    if (current.jobDir) {
      try {
        const queueSummary = buildRuntimeReviewQueue({ jobDir: current.jobDir, persist: false });
        const rows = Array.isArray(queueSummary?.items)
          ? queueSummary.items
          : (Array.isArray(queueSummary?.queue) ? queueSummary.queue : []);
        reviewSummary = rows.length > 0 ? `${rows.length}개 review item` : '대기 item 없음';
      } catch {
        reviewSummary = '조회 실패 · /review 로 확인';
      }
    }
    const pendingApproval = session?.pending_approval && typeof session.pending_approval === 'object' ? session.pending_approval : null;
    let companionState = null;
    try {
      companionState = getCurrentCompanionControlState(chatId);
    } catch {
      companionState = null;
    }
    const proposals = Array.isArray(companionState?.merge_proposals) ? companionState.merge_proposals : [];
    const pendingProposals = proposals.filter((proposal) => String(proposal?.status || 'pending').trim().toLowerCase() === 'pending').length;
    const acceptedProposals = proposals.filter((proposal) => String(proposal?.status || '').trim().toLowerCase() === 'accepted').length;
    const candidates = Array.isArray(companionState?.materialization_candidates) ? companionState.materialization_candidates.length : 0;
    const exchanges = Array.isArray(companionState?.memory_exchange_proposals) ? companionState.memory_exchange_proposals : [];
    const pendingExchanges = exchanges.filter((proposal) => String(proposal?.status || 'pending').trim().toLowerCase() === 'pending').length;
    const idleCandidates = Array.isArray(companionState?.idle_memory_observations) ? companionState.idle_memory_observations : [];
    const pendingIdleCandidates = idleCandidates.filter((candidate) => String(candidate?.status || 'pending').trim().toLowerCase() === 'pending').length;
    let governance = null;
    try { governance = buildRoomGovernanceMetricsForChat(chatId); } catch { governance = null; }
    const governanceLine = governance && governance.status !== 'no_governance_items'
      ? `- governance: ${governance.status} · pending=${governance.totals.pending} · 7d 결정 ${governance.throughput_7d.decided}건 (/inbox digest)`
      : '- governance: 측정할 proposal 없음';
    const lines = [
      '📥 DdalGgak Inbox · Room Decisions',
      '사용자가 승인해야 하는 room-level decisions를 모읍니다.',
      `- job review: ${reviewSummary}`,
      watchSummary ? `- loop/watch: ${watchSummary.status} · iteration ${watchSummary.current_iteration}/${watchSummary.max_iterations}` : '- loop/watch: 없음',
      pendingApproval ? `- pending approval: ${String(pendingApproval.reason || pendingApproval.action || 'yes')}` : '- pending approval: 없음',
      `- correction proposals: pending=${pendingProposals}, accepted=${acceptedProposals}`,
      `- companion memory exchange: pending=${pendingExchanges}`,
      `- idle memory structuring: pending=${pendingIdleCandidates}`,
      `- materialization previews: ${candidates}`,
      governanceLine,
      '',
      '바로 처리:',
      '- /review — active job review queue 보기',
      '- /correct proposals — correction merge proposal 보기',
      '- /correct approve latest 또는 /correct reject latest <reason>',
      '- /correct materialize-preview — accepted proposal preview 보기',
      '- /council proposals — companion memory exchange proposal 보기',
      '- /council approve latest 또는 /council reject latest <reason>',
      '- /memory idle — idle-time room memory structuring 후보 생성/점검',
      '- /inbox digest — proposal 백로그/리뷰율/결정 지연 다이제스트',
      '- /status — 현재 실행 상태 보기',
    ];
    return lines.join('\n');
  }

  function buildRoomGovernanceMetricsForChat(chatId) {
    const session = chatSessionStore?.get?.(chatId) || {};
    const current = getCurrentJobDirForChat(chatId);
    const companionEvents = readRoomCompanionEvents({ jobDir: current.jobDir || '', session, limit: 400 });
    const companionState = deriveRoomCompanionState({ events: companionEvents, session });
    const memoryView = deriveRoomMemoryView({ session, companionState, includeRejected: true });
    const usageEvents = readRoomUsageEvents(chatId, { limit: 500 });
    return buildRoomGovernanceMetrics({
      companionEvents,
      memoryView,
      usageEvents,
      pendingAgentSpecialization: session.pending_agent_specialization || null,
    });
  }

  async function maybeSendRoomGovernanceDigest({ chatId = '', userId = '' } = {}) {
    const session = chatSessionStore?.get?.(chatId) || {};
    const metrics = buildRoomGovernanceMetricsForChat(chatId);
    const gate = shouldSendRoomGovernanceDigest({ session, metrics });
    if (!gate.send) return { sent: false, reason: gate.reason };
    try {
      chatSessionStore.upsert(chatId, (current = {}) => ({
        ...current,
        last_governance_digest_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }));
    } catch {}
    await sendLong(bot, chatId, formatRoomGovernanceDigestForTelegram(metrics));
    try {
      appendRoomUsageEvent(buildRoomUsageEvent({
        chatId,
        userId,
        eventType: 'room_governance_digest_sent',
        command: '/inbox digest',
        extra: { status: metrics.status, pending: metrics.totals.pending, review_rate: metrics.totals.review_rate },
      }));
    } catch {}
    return { sent: true, status: metrics.status };
  }

  function telegramReplyToMessageId(msg = {}) {
    const n = Number(msg?.reply_to_message?.message_id);
    return Number.isFinite(n) ? n : null;
  }

  function telegramChatInfo(msg = {}, chatId = '') {
    return {
      chat_id: String(chatId || ''),
      title: String(msg?.chat?.title || msg?.chat?.username || '').trim(),
      type: String(msg?.chat?.type || '').trim(),
    };
  }

  function rememberCommandAck(chatId, sent = null) {
    const messageId = Number(sent?.message_id || 0);
    if (Number.isFinite(messageId) && messageId > 0) {
      chatSessionStore.upsert(chatId, {
        current_turn_ack_message_id: messageId,
        current_turn_plan_message_id: null,
      });
    }
    return messageId > 0 ? messageId : null;
  }

  async function safeRouterAck(chatId, msg = {}) {
    if (typeof sendRouterAckMessage !== 'function') return null;
    return sendRouterAckMessage(bot, chatId, { replyToMessageId: msg?.message_id });
  }

  function parseLoopDepthArgs(raw = '') {
    let text = String(raw || '').trim();
    let maxLoops = null;
    let explicitMaxLoops = false;
    let staged = false;
    // Telegram/mobile keyboards often turn --loops into —loops or –loops.
    // Normalize option dashes without touching the user's natural-language goal.
    text = text.replace(/[—–−]/g, '-');
    const takeLoops = (_m, _prefix, n) => {
      maxLoops = Math.max(1, Math.min(24, Number(n) || 1));
      explicitMaxLoops = true;
      return ' ';
    };
    text = text.replace(/(^|\s)(?:--?loops|loops)(?:=|\s+)(\d{1,2})(?=\s|$)/i, takeLoops);
    text = text.replace(/(^|\s)(\d{1,2})(?:\s*(?:회|번|loops?))?(?=\s+\S)/i, (_m, _prefix, n) => {
      if (maxLoops !== null) return _m;
      maxLoops = Math.max(1, Math.min(24, Number(n) || 1));
      explicitMaxLoops = true;
      return ' ';
    });
    text = text.replace(/(?:^|\s)--?staged(?=\s|$)/i, () => { staged = true; return ' '; });
    return { goal: text.replace(/\s+/g, ' ').trim(), maxLoops, explicitMaxLoops, staged };
  }

  function forceBoundedLoopContract(contract = {}, { goal = '', maxLoops = null, explicitMaxLoops = false, staged = false, defaultMaxLoops = null } = {}) {
    const fallbackPasses = staged
      ? ['plan', 'research_or_build', 'review', 'revise', 'stop_condition_evaluation']
      : ['plan', 'implement_or_diagnose', 'verify', 'review', 'stop_condition_evaluation'];
    const defaultIterations = Math.max(1, Math.min(24, Number(defaultMaxLoops || (staged ? 5 : 3)) || (staged ? 5 : 3)));
    const contractIterations = Math.max(0, Math.min(24, Number(contract.max_iterations || contract.maxIterations || 0) || 0));
    const rawIterations = explicitMaxLoops ? maxLoops : Math.max(defaultIterations, contractIterations);
    const maxIterations = Math.max(1, Math.min(24, Number(rawIterations) || defaultIterations));
    const minIterations = Math.min(maxIterations, Math.max(1, Math.min(2, Number(contract.min_iterations || contract.minIterations || 2) || 2)));
    return {
      ...contract,
      workflow_kind: 'bounded_continuous_loop',
      goal_excerpt: String(contract.goal_excerpt || goal || '').slice(0, 300),
      required_passes: Array.isArray(contract.required_passes) && contract.required_passes.length ? contract.required_passes : fallbackPasses,
      min_iterations: minIterations,
      max_iterations: maxIterations,
      review_each_iteration: contract.review_each_iteration !== false,
      stop_conditions: Array.isArray(contract.stop_conditions) && contract.stop_conditions.length
        ? contract.stop_conditions
        : ['user_stop', 'iteration_budget_exceeded', 'three_consecutive_failures', 'quality_threshold_met'],
      source_reasons: [
        ...new Set([
          ...(Array.isArray(contract.source_reasons) ? contract.source_reasons : []),
          'telegram_loop_command',
          maxLoops ? `telegram_max_loops_${maxLoops}` : '',
          staged ? 'telegram_staged_loop' : '',
        ].filter(Boolean)),
      ],
    };
  }

  function isTeamControlSubcommand(sub = '') {
    return USER_TEAM_GOAL_RESERVED_SUBCOMMANDS.has(String(sub || '').trim().toLowerCase());
  }

  function getRoomConciergeModel() {
    if (explicitRoomConciergeModel) return explicitRoomConciergeModel;
    return loadRoomConciergeModelFromEnv(process.env);
  }

  function directAskModelPolicy(decision = null) {
    return resolveRoomConciergeModelPolicy({ decision: decision || { route: 'concierge_direct_answer' }, env: process.env });
  }

  function directAskProviderPreference(decision = null) {
    return String(directAskModelPolicy(decision).provider || '').trim().toLowerCase();
  }

  function isDirectAskFastPathEnabled() {
    const raw = String(process.env.DDALGGAK_DIRECT_ASK_FAST_PATH_ENABLED || process.env.ROOM_CONCIERGE_DIRECT_ASK_ENABLED || 'auto').trim().toLowerCase();
    if (['0', 'false', 'no', 'off'].includes(raw)) return false;
    if (typeof directAskExecutor === 'function') return true;
    const providerPreference = directAskProviderPreference({ route: 'concierge_direct_answer' });
    if (['codex', 'openai', 'openai_compatible', 'antigravity'].includes(providerPreference)) return true;
    if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
    return directAskOpenAIConfigured();
  }

  function directAskOpenAIConfigured() {
    return !!String(process.env.DDALGGAK_DIRECT_ASK_BASE_URL || process.env.OPENAI_COMPATIBLE_BASE_URL || process.env.LOCAL_MODEL_BASE_URL || process.env.OLLAMA_BASE_URL || '').trim()
      && !!String(process.env.DDALGGAK_DIRECT_ASK_MODEL || process.env.OPENAI_COMPATIBLE_MODEL || process.env.LOCAL_MODEL || process.env.OLLAMA_MODEL || '').trim();
  }

  function searchAskModelPolicy(decision = null) {
    return resolveRoomConciergeModelPolicy({ decision: decision || { route: 'concierge_search_answer' }, env: process.env });
  }

  function searchAskProviderPreference(decision = null) {
    return String(searchAskModelPolicy(decision).provider || '').trim().toLowerCase();
  }

  function searchAskOpenAIConfigured() {
    return !!String(process.env.DDALGGAK_SEARCH_ASK_BASE_URL || process.env.DDALGGAK_DIRECT_ASK_BASE_URL || process.env.OPENAI_COMPATIBLE_BASE_URL || process.env.LOCAL_MODEL_BASE_URL || process.env.OLLAMA_BASE_URL || '').trim()
      && !!String(process.env.DDALGGAK_SEARCH_ASK_MODEL || process.env.DDALGGAK_DIRECT_ASK_MODEL || process.env.OPENAI_COMPATIBLE_MODEL || process.env.LOCAL_MODEL || process.env.OLLAMA_MODEL || '').trim();
  }

  function isSearchAskFastPathEnabled() {
    const raw = String(process.env.DDALGGAK_SEARCH_ASK_FAST_PATH_ENABLED || process.env.ROOM_CONCIERGE_SEARCH_ASK_ENABLED || 'auto').trim().toLowerCase();
    if (['0', 'false', 'no', 'off'].includes(raw)) return false;
    if (typeof searchAskExecutor === 'function') return true;
    const providerPreference = searchAskProviderPreference({ route: 'concierge_search_answer' });
    if (['codex', 'openai', 'openai_compatible', 'antigravity'].includes(providerPreference)) return true;
    if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
    return searchAskOpenAIConfigured();
  }

  async function executeDirectAskFastPath({ chatId, userId, msg = {}, message = '', decision = null, sourceCommand = '/chat' } = {}) {
    const roomProfile = getAgentRoomProfile(chatSessionStore, chatId) || {};
    const context = buildRoomContextProjectionForRoute({
      chatId,
      message,
      command: sourceCommand,
      decision,
      tier: 'micro',
      maxChars: resolveDdalggakRouteRuntimeConfig('direct', { env: process.env }).context_max_chars,
      turnLimit: resolveDdalggakRouteRuntimeConfig('direct', { env: process.env }).context_turns,
    });
    const session = chatSessionStore.get(chatId) || {};
    const surfaceLocale = resolveUserSurfaceLocale({ message, session, fallback: 'ko' });
    const prompt = buildDirectAskPrompt({
      question: message,
      roomName: roomProfile?.name || roomProfile?.room_name || '',
      locale: surfaceLocale,
      context,
    });
    const jobId = `direct_ask_${Date.now().toString(36)}`;
    if (typeof directAskExecutor === 'function') {
      return await directAskExecutor({ chatId, userId, msg, message, prompt, decision, roomProfile, jobId });
    }

    const modelPolicy = directAskModelPolicy(decision);
    const providerPreference = String(modelPolicy.provider || '').trim().toLowerCase();
    if (providerPreference === 'antigravity') {
      const { runAntigravityPrompt } = await import('../../antigravity.js');
      const result = await runAntigravityPrompt({
        workspaceRoot: process.cwd(),
        cwd: process.cwd(),
        prompt,
        jobId,
        model: modelPolicy.model || process.env.ANTIGRAVITY_MODEL || process.env.GOOGLE_AI_MODEL || '',
        surface: 'telegram_direct_ask_fast_path',
        agentId: 'room_concierge',
        roleId: 'room_concierge',
        timeoutMs: resolveDdalggakRouteRuntimeConfig('direct', { env: process.env }).timeout_ms,
        traceMetadata: { concierge_decision: decision || null, model_policy: modelPolicy, bypassed_workbench: true },
      });
      if (!result.ok) throw new Error(result.stderr || 'direct Antigravity ask failed');
      return { text: String(result.stdout || '').trim(), provider: 'antigravity', result };
    }

    if ((providerPreference === 'openai_compatible' || providerPreference === 'openai' || (!providerPreference && directAskOpenAIConfigured()))) {
      const result = await runOpenAICompatiblePrompt({
        nodeId: process.env.DDALGGAK_DIRECT_ASK_NODE || '',
        model: modelPolicy.model || resolveDdalggakRouteRuntimeConfig('direct', { env: process.env }).model || '',
        baseUrl: resolveDdalggakRouteRuntimeConfig('direct', { env: process.env }).openai_compatible?.base_url || '',
        runtime: resolveDdalggakRouteRuntimeConfig('direct', { env: process.env }).openai_compatible?.runtime || '',
        apiKey: process.env.DDALGGAK_DIRECT_ASK_API_KEY || process.env.DDALGGAK_LOCAL_API_KEY || process.env.OPENAI_COMPATIBLE_API_KEY || process.env.LOCAL_MODEL_API_KEY || process.env.OLLAMA_API_KEY || '',
        prompt,
        system: `${userSurfaceLanguageDirective(surfaceLocale)} Keep the reply concise and useful.`,
        temperature: Number(process.env.DDALGGAK_DIRECT_ASK_TEMPERATURE || 0.2),
        maxTokens: Number(process.env.DDALGGAK_DIRECT_ASK_MAX_TOKENS || 512),
        timeoutMs: resolveDdalggakRouteRuntimeConfig('direct', { env: process.env }).timeout_ms,
        jobId,
        surface: 'telegram_direct_ask_fast_path',
        agentId: 'room_concierge',
        roleId: 'room_concierge',
        cwd: process.cwd(),
        traceMetadata: { concierge_decision: decision || null, model_policy: modelPolicy, bypassed_workbench: true },
      });
      if (!result.ok) throw new Error(result.stderr || 'direct OpenAI-compatible ask failed');
      return { text: String(result.stdout || '').trim(), provider: 'openai_compatible', result };
    }

    const codexResult = await runCodexExec({
      workspaceRoot: process.cwd(),
      cwd: process.cwd(),
      prompt,
      jobId,
      model: modelPolicy.model || process.env.DDALGGAK_DIRECT_ASK_CODEX_MODEL || process.env.CODEX_MODEL || process.env.CODEX_ASSIST_MODEL || '',
      surface: 'telegram_direct_ask_fast_path',
      agentId: 'room_concierge',
      roleId: 'room_concierge',
      sandboxMode: process.env.DDALGGAK_DIRECT_ASK_SANDBOX_MODE || 'read-only',
      approvalPolicy: process.env.DDALGGAK_DIRECT_ASK_APPROVAL_POLICY || 'never',
      profile: process.env.DDALGGAK_DIRECT_ASK_CODEX_PROFILE || process.env.CODEX_ASSIST_PROFILE || process.env.CODEX_PROFILE || '',
      timeoutMs: resolveDdalggakRouteRuntimeConfig('direct', { env: process.env }).timeout_ms,
      traceMetadata: { concierge_decision: decision || null, model_policy: modelPolicy, bypassed_workbench: true },
    });
    if (!codexResult.ok) throw new Error(codexResult.stderr || 'direct Codex ask failed');
    return { text: String(codexResult.stdout || '').trim(), provider: 'codex', result: codexResult };
  }


  function resolveJobDirForRoute(chatId = '') {
    try {
      const jobId = resolveLiveJobIdForChat(chatId);
      if (!jobId) return { jobId: '', jobDir: '' };
      if (jobs && typeof jobs.jobDir === 'function') return { jobId, jobDir: jobs.jobDir(jobId) };
      if (typeof runWorkspaceDir === 'function') {
        const workspace = runWorkspaceDir(jobId);
        if (workspace) return { jobId, jobDir: String(workspace).replace(/\/workspace\/?$/, '') };
      }
      return { jobId, jobDir: '' };
    } catch {
      return { jobId: '', jobDir: '' };
    }
  }

  function buildRoomContextProjectionForRoute({ chatId = '', message = '', command = '/chat', decision = null, tier = 'micro', roomSelection = null, teamSelection = null, maxChars = null, turnLimit = null } = {}) {
    try {
      const { jobDir } = resolveJobDirForRoute(chatId);
      const session = chatSessionStore.get(chatId) || {};
      const snapshot = createRoomContextSnapshot({
        jobDir,
        session,
        latestUserText: message,
        command,
        route: decision?.route || '',
        roomSelection: roomSelection || session.last_room_selection || session.lastRoomSelection || null,
        teamSelection: teamSelection || session.last_team_selection || session.lastTeamSelection || null,
        roomProfile: getAgentRoomProfile(chatSessionStore, chatId),
      });
      return formatRoomContextProjectionBlock({ snapshot, tier, maxChars, turnLimit });
    } catch {
      return '';
    }
  }

  function recordIncomingRoomTurn({ chatId = '', userId = '', message = '', command = '/chat', decision = null } = {}) {
    try {
      const { jobId, jobDir } = resolveJobDirForRoute(chatId);
      return appendRoomConversationTurn({
        jobDir,
        chatSessionStore,
        chatId,
        userId,
        role: 'user',
        text: message,
        command,
        source: 'room_context_substrate_input',
        route: decision?.route || 'room_concierge_planned',
        jobId,
        writeConversation: false,
        updatePacket: false,
      });
    } catch {
      return null;
    }
  }

  function resolveActiveRoomLoopForChat(chatId = '') {
    try {
      const { jobDir } = resolveJobDirForRoute(chatId);
      const session = chatSessionStore.get(chatId) || {};
      const events = readRoomLoopEvents({ jobDir, session, limit: 80 });
      return deriveActiveRoomLoop({ events, session });
    } catch {
      return null;
    }
  }

  function recordRoomLoopInterruptionForIncoming({ chatId = '', userId = '', message = '', command = '/chat' } = {}) {
    try {
      const activeLoop = resolveActiveRoomLoopForChat(chatId);
      const event = classifyRoomLoopInterruption({ text: message, command, activeLoop });
      if (!event) return null;
      const { jobId, jobDir } = resolveJobDirForRoute(chatId);
      return appendRoomLoopEvent({
        jobDir,
        chatSessionStore,
        chatId,
        userId,
        jobId,
        event: {
          ...event,
          chat_id: chatId,
          user_id: userId,
          job_id: jobId,
          command,
        },
      });
    } catch {
      return null;
    }
  }

  function startRoomLoopControlPlane({ chatId = '', userId = '', goal = '', command = '/loop', workflowContract = null, teamConfig = null, source = 'telegram_loop' } = {}) {
    try {
      const { jobId, jobDir } = resolveJobDirForRoute(chatId);
      const loopId = createRoomLoopId({ chatId, objective: goal, source });
      const loop = normalizeRoomLoop({
        loop_id: loopId,
        room_id: chatId,
        chat_id: chatId,
        objective: goal,
        status: 'running',
        controller: 'user',
        command,
        source,
        model_policy: teamConfig?.room_runtime_selection || teamConfig?.ai_room_selection || {},
        budget_policy: { max_iterations: workflowContract?.max_iterations || workflowContract?.maxIterations || undefined },
        current_plan: Array.isArray(workflowContract?.required_passes) ? workflowContract.required_passes : [],
        active_constraints: Array.isArray(workflowContract?.stop_conditions) ? workflowContract.stop_conditions.map((item) => `stop_condition: ${item}`) : [],
      });
      const event = buildRoomLoopStartEvent({ loop, chatId, userId, jobId, command, source });
      appendRoomLoopEvent({ jobDir, chatSessionStore, chatId, userId, jobId, event });
      return loop;
    } catch {
      return null;
    }
  }

  function recordRoomLoopStatusCommand({ chatId = '', userId = '', command = '', status = '', text = '' } = {}) {
    try {
      const activeLoop = resolveActiveRoomLoopForChat(chatId);
      if (!activeLoop?.loop_id) return null;
      const interruptType = command === '/pause' ? 'pause' : command === '/resume' ? 'resume' : command === '/approve' ? 'approve' : 'status_update';
      const { jobId, jobDir } = resolveJobDirForRoute(chatId);
      return appendRoomLoopEvent({
        jobDir,
        chatSessionStore,
        chatId,
        userId,
        jobId,
        event: {
          event_type: 'user_interrupt',
          interrupt_type: interruptType,
          loop_id: activeLoop.loop_id,
          chat_id: chatId,
          user_id: userId,
          job_id: jobId,
          command,
          source: 'telegram_loop_status_command',
          payload: { text: text || command, target_status: status },
        },
      });
    } catch {
      return null;
    }
  }

  function appendAskRouteOutcome({ chatId = '', userId = '', message = '', command = '/chat', decision = null, modelPolicy = null, executor = '', outcome = '', extra = {} } = {}) {
    try {
      const { jobDir } = resolveJobDirForRoute(chatId);
      if (!jobDir) return null;
      return appendKnowledgeRouteEvent({
        jobDir,
        chatId,
        userId,
        command,
        message,
        decision: decision || {},
        modelPolicy: modelPolicy || (shouldUseSearchAskPath(decision || {}) ? searchAskModelPolicy(decision || {}) : directAskModelPolicy(decision || {})),
        executor,
        outcome: outcome || 'unknown',
        extra,
      });
    } catch {
      return null;
    }
  }

  async function tryRoomConciergeConversationalPath({ chatId, userId, msg = {}, message = '', sourceCommand = '/chat' } = {}) {
    const roomProfile = getAgentRoomProfile(chatSessionStore, chatId);
    const sessionSnapshot = chatSessionStore.get(chatId) || {};
    const conciergeDecision = classifyRoomConciergeRoute({
      text: message,
      command: sourceCommand,
      hasAttachment: !!(msg?.document || msg?.photo || msg?.video || msg?.audio || msg?.voice),
      pendingApproval: !!sessionSnapshot.pending_approval,
      busy: chatRunManager?.isRunning ? chatRunManager.isRunning(chatId) : false,
      policy: {
        enabled: isDirectAskFastPathEnabled() || isSearchAskFastPathEnabled(),
        max_chars: resolveDdalggakRouteRuntimeConfig('direct', { env: process.env }).max_chars,
        max_tokenish_units: resolveDdalggakRouteRuntimeConfig('direct', { env: process.env }).max_tokenish_units,
      },
      learnedModel: getRoomConciergeModel(),
      roomFootprint: sessionSnapshot.room_memory_footprint || sessionSnapshot.roomMemoryFootprint || {},
      recentRouteStats: sessionSnapshot.room_concierge_route_stats || sessionSnapshot.roomConciergeRouteStats || {},
    });
    const roomSelection = buildRoomSelectionDecision({
      text: message,
      command: sourceCommand,
      chatId,
      roomProfile,
      session: sessionSnapshot,
      candidateRooms: sessionSnapshot.candidate_rooms || sessionSnapshot.candidateRooms || [],
    });
    const teamSelection = buildTeamSelectionDecision({
      text: message,
      command: sourceCommand,
      conciergeDecision,
      teamState: getSessionTeamState(chatSessionStore, chatId),
      roomSelection,
    });
    recordRoomEvent({
      chatId,
      userId,
      eventType: 'work_depth_used',
      command: sourceCommand,
      goal: message,
      profile: roomProfile,
      extra: { depth: conciergeDecision.depth || 'chat', room_concierge: conciergeDecision, room_selection: roomSelection, team_selection: teamSelection },
    });
    const conciergeModelPolicy = shouldUseSearchAskPath(conciergeDecision) ? searchAskModelPolicy(conciergeDecision) : directAskModelPolicy(conciergeDecision);
    try {
      const { jobDir } = resolveJobDirForRoute(chatId);
      if (jobDir) {
        appendKnowledgeRouteEvent({
          jobDir,
          chatId,
          userId,
          command: sourceCommand,
          message,
          decision: conciergeDecision,
          modelPolicy: conciergeModelPolicy,
          outcome: 'planned',
          extra: { room_selection: roomSelection, team_selection: teamSelection },
        });
        appendRoomSelectionRouteEvent({ jobDir, chatId, userId, roomSelection, teamSelection, conciergeDecision, source: sourceCommand });
      }
    } catch {}
    const ackText = shouldUseDirectAskFastPath(conciergeDecision)
      ? `⚡ ${sourceCommand} accepted: direct Room Concierge path.`
      : shouldUseSearchAskPath(conciergeDecision)
        ? `⚡ ${sourceCommand} accepted: bounded Room Concierge search path.`
        : `⚡ ${sourceCommand} accepted: running standard AI Room conversation.`;
    const ack = await bot.sendMessage(chatId, ackText);
    rememberCommandAck(chatId, ack);
    try {
      chatSessionStore.upsert(chatId, (session = {}) => ({
        ...session,
        last_room_concierge_route: { ...conciergeDecision, model_policy: conciergeModelPolicy, source_command: sourceCommand, updated_at: new Date().toISOString() },
        last_room_selection: roomSelection,
        last_team_selection: teamSelection,
      }));
    } catch {}
    recordIncomingRoomTurn({ chatId, userId, message, command: sourceCommand, decision: conciergeDecision });
    recordRoomLoopInterruptionForIncoming({ chatId, userId, message, command: sourceCommand });
    if (shouldUseDirectAskFastPath(conciergeDecision) && (typeof directAskExecutor === 'function' || shouldEnableConciergeFastPathForPolicy(conciergeModelPolicy))) {
      const directResult = await runDirectAskOrFallback({ chatId, userId, msg, message, decision: conciergeDecision, ackAlreadySent: true, sourceCommand });
      if (directResult?.status !== 'disabled') return { handled: true, ackAlreadySent: true, decision: conciergeDecision, modelPolicy: conciergeModelPolicy, roomSelection, teamSelection };
    }
    if (shouldUseSearchAskPath(conciergeDecision) && (typeof searchAskExecutor === 'function' || shouldEnableConciergeFastPathForPolicy(conciergeModelPolicy))) {
      const searchResult = await runSearchAskOrFallback({ chatId, userId, msg, message, decision: conciergeDecision, ackAlreadySent: true, sourceCommand });
      if (searchResult?.status !== 'disabled') return { handled: true, ackAlreadySent: true, decision: conciergeDecision, modelPolicy: conciergeModelPolicy, roomSelection, teamSelection };
    }
    return { handled: false, ackAlreadySent: true, decision: conciergeDecision, modelPolicy: conciergeModelPolicy, roomProfile, roomSelection, teamSelection };
  }

  async function executeSearchAskFastPath({ chatId, userId, msg = {}, message = '', decision = null, sourceCommand = '/chat' } = {}) {
    const roomProfile = getAgentRoomProfile(chatSessionStore, chatId) || {};
    const searchRuntime = resolveDdalggakRouteRuntimeConfig('search', { env: process.env });
    const maxSeconds = Math.max(3, Number(searchRuntime.max_seconds || 20));
    const context = buildRoomContextProjectionForRoute({
      chatId,
      message,
      command: sourceCommand,
      decision,
      tier: 'search',
      maxChars: searchRuntime.context_max_chars,
      turnLimit: searchRuntime.context_turns,
    });
    const session = chatSessionStore.get(chatId) || {};
    const surfaceLocale = resolveUserSurfaceLocale({ message, session, fallback: 'ko' });
    const prompt = buildSearchAskFallbackPrompt({
      question: message,
      locale: surfaceLocale,
      maxSeconds,
      context,
    });
    const jobId = `search_ask_${Date.now().toString(36)}`;
    if (typeof searchAskExecutor === 'function') {
      return await searchAskExecutor({ chatId, userId, msg, message, prompt, decision, roomProfile, jobId, maxSeconds });
    }

    const modelPolicy = searchAskModelPolicy(decision);
    const providerPreference = String(modelPolicy.provider || '').trim().toLowerCase();
    if (providerPreference === 'antigravity') {
      const { runAntigravityPrompt } = await import('../../antigravity.js');
      const result = await runAntigravityPrompt({
        workspaceRoot: process.cwd(),
        cwd: process.cwd(),
        prompt,
        jobId,
        model: modelPolicy.model || process.env.ANTIGRAVITY_MODEL || process.env.GOOGLE_AI_MODEL || '',
        surface: 'telegram_search_ask_fast_path',
        agentId: 'room_concierge_search',
        roleId: 'room_concierge',
        timeoutMs: searchRuntime.timeout_ms,
        traceMetadata: { concierge_decision: decision || null, model_policy: modelPolicy, bypassed_workbench: true, bounded_search: true },
      });
      if (!result.ok) throw new Error(result.stderr || 'search Antigravity ask failed');
      return { text: String(result.stdout || '').trim(), provider: 'antigravity', result };
    }

    if ((providerPreference === 'openai_compatible' || providerPreference === 'openai' || (!providerPreference && searchAskOpenAIConfigured()))) {
      const result = await runOpenAICompatiblePrompt({
        nodeId: process.env.DDALGGAK_SEARCH_ASK_NODE || process.env.DDALGGAK_DIRECT_ASK_NODE || '',
        model: modelPolicy.model || searchRuntime.model || '',
        baseUrl: searchRuntime.openai_compatible?.base_url || '',
        runtime: searchRuntime.openai_compatible?.runtime || '',
        apiKey: process.env.DDALGGAK_SEARCH_ASK_API_KEY || process.env.DDALGGAK_DIRECT_ASK_API_KEY || process.env.DDALGGAK_LOCAL_API_KEY || process.env.OPENAI_COMPATIBLE_API_KEY || process.env.LOCAL_MODEL_API_KEY || process.env.OLLAMA_API_KEY || '',
        prompt,
        system: `${userSurfaceLanguageDirective(surfaceLocale)} For search-intent requests, do not fabricate unavailable current facts; ask for a link/photo/source when needed.`,
        temperature: Number(process.env.DDALGGAK_SEARCH_ASK_TEMPERATURE || process.env.DDALGGAK_DIRECT_ASK_TEMPERATURE || 0.1),
        maxTokens: Number(process.env.DDALGGAK_SEARCH_ASK_MAX_TOKENS || process.env.DDALGGAK_DIRECT_ASK_MAX_TOKENS || 512),
        timeoutMs: searchRuntime.timeout_ms,
        jobId,
        surface: 'telegram_search_ask_fast_path',
        agentId: 'room_concierge_search',
        roleId: 'room_concierge',
        cwd: process.cwd(),
        traceMetadata: { concierge_decision: decision || null, model_policy: modelPolicy, bypassed_workbench: true, bounded_search: true },
      });
      if (!result.ok) throw new Error(result.stderr || 'search OpenAI-compatible ask failed');
      return { text: String(result.stdout || '').trim(), provider: 'openai_compatible', result };
    }

    const codexResult = await runCodexExec({
      workspaceRoot: process.cwd(),
      cwd: process.cwd(),
      prompt,
      jobId,
      model: modelPolicy.model || process.env.DDALGGAK_SEARCH_ASK_CODEX_MODEL || process.env.DDALGGAK_DIRECT_ASK_CODEX_MODEL || process.env.CODEX_MODEL || process.env.CODEX_ASSIST_MODEL || '',
      surface: 'telegram_search_ask_fast_path',
      agentId: 'room_concierge_search',
      roleId: 'room_concierge',
      sandboxMode: process.env.DDALGGAK_SEARCH_ASK_SANDBOX_MODE || process.env.DDALGGAK_DIRECT_ASK_SANDBOX_MODE || 'read-only',
      approvalPolicy: process.env.DDALGGAK_SEARCH_ASK_APPROVAL_POLICY || process.env.DDALGGAK_DIRECT_ASK_APPROVAL_POLICY || 'never',
      profile: process.env.DDALGGAK_SEARCH_ASK_CODEX_PROFILE || process.env.DDALGGAK_DIRECT_ASK_CODEX_PROFILE || process.env.CODEX_ASSIST_PROFILE || process.env.CODEX_PROFILE || '',
      timeoutMs: searchRuntime.timeout_ms,
      traceMetadata: { concierge_decision: decision || null, model_policy: modelPolicy, bypassed_workbench: true, bounded_search: true },
    });
    if (!codexResult.ok) throw new Error(codexResult.stderr || 'search Codex ask failed');
    return { text: String(codexResult.stdout || '').trim(), provider: 'codex', result: codexResult };
  }

  async function runSearchAskOrFallback({ chatId, userId, msg = {}, message = '', decision = null, ackAlreadySent = false, sourceCommand = '/chat' } = {}) {
    if (!isSearchAskFastPathEnabled()) return { status: 'disabled' };
    try {
      const started = Date.now();
      const result = await executeSearchAskFastPath({ chatId, userId, msg, message, decision, sourceCommand });
      const answer = String(result?.text || '').trim();
      if (!answer) throw new Error('empty search ask answer');
      const answerWithModel = appendRuntimeModelFooter(answer, {
        provider: result?.provider || 'unknown',
        model: result?.result?.used_model || result?.result?.model || result?.model || '',
        route: decision?.route || 'concierge_search_answer',
      });
      await bot.sendMessage(chatId, answerWithModel);
      try {
        const { jobId, jobDir } = resolveJobDirForRoute(chatId);
        appendRoomConversationExchange({
          jobDir,
          chatSessionStore,
          chatId,
          userId,
          userText: message,
          assistantText: answer,
          command: sourceCommand,
          source: 'room_concierge_search_fast_path',
          provider: result?.provider || 'unknown',
          model: result?.result?.used_model || result?.result?.model || '',
          route: decision?.route || 'concierge_search_answer',
          jobId,
          skipUserTurn: true,
        });
      } catch {}
      scheduleIdleMemoryStructuringForChat({ chatId, userId, source: 'idle_after_search_fast_path' });
      appendAskRouteOutcome({ chatId, userId, message, command: sourceCommand, decision, executor: 'search_ask_fast_path', outcome: 'answered_search_fast_path', extra: { latency_ms: Date.now() - started } });
      try {
        chatSessionStore.upsert(chatId, (session = {}) => ({
          ...session,
          last_room_concierge_route: decision || null,
          last_search_ask: {
            ts: new Date().toISOString(),
            provider: result?.provider || 'unknown',
            model: result?.result?.used_model || result?.result?.model || result?.model || '',
            duration_ms: Date.now() - started,
            message_chars: Array.from(String(message || '')).length,
          },
        }));
      } catch {}
      return { status: 'answered_search_fast_path', duration_ms: Date.now() - started, provider: result?.provider || 'unknown' };
    } catch (error) {
      try {
        chatSessionStore.upsert(chatId, (session = {}) => ({
          ...session,
          last_room_concierge_route: decision || null,
          last_search_ask_error: {
            ts: new Date().toISOString(),
            message: String(error?.message || error || 'unknown'),
          },
        }));
      } catch {}
      const shouldNoticeFallback = resolveDdalggakRouteRuntimeConfig('search', { env: process.env }).fallback_notice;
      if (shouldNoticeFallback) {
        await bot.sendMessage(chatId, [
          '🔎 빠른 검색 경로가 제한 시간 안에 끝나지 않아 표준 AI Room 실행으로 전환합니다.',
          '지금 하는 일: 최근 대화 맥락을 붙이고, 검색/외부정보 요청으로 처리할 agent를 준비하는 중입니다.',
          '조금 걸릴 수 있어요. /status 로 현재 단계를 볼 수 있습니다.',
        ].join('\n'));
      }
      if (!resolveDdalggakRouteRuntimeConfig('search', { env: process.env }).fallback_to_workbench) {
        throw error;
      }
      appendAskRouteOutcome({ chatId, userId, message, command: sourceCommand, decision, executor: 'search_ask_fast_path', outcome: 'fast_path_failed_fallback_to_workbench', extra: { error: String(error?.message || error || 'unknown') } });
      await enqueueWorkbenchInput({ chatId, userId, msg, text: message, kind: 'chat_message', teamConfig: buildRoomFirstTeamConfiguration({ taskText: message, workMode: 'ask', roomProfile: getAgentRoomProfile(chatSessionStore, chatId), chatId, source: 'telegram_ask_search_fallback' }), ackAlreadySent });
      return { status: 'fallback_to_workbench', error: String(error?.message || error || 'unknown') };
    }
  }

  async function runDirectAskOrFallback({ chatId, userId, msg = {}, message = '', decision = null, ackAlreadySent = false, sourceCommand = '/chat' } = {}) {
    if (!isDirectAskFastPathEnabled()) return { status: 'disabled' };
    try {
      const started = Date.now();
      const result = await executeDirectAskFastPath({ chatId, userId, msg, message, decision, sourceCommand });
      const answer = String(result?.text || '').trim();
      if (!answer) throw new Error('empty direct ask answer');
      const answerWithModel = appendRuntimeModelFooter(answer, {
        provider: result?.provider || 'unknown',
        model: result?.result?.used_model || result?.result?.model || result?.model || '',
        route: decision?.route || 'concierge_direct_answer',
      });
      await bot.sendMessage(chatId, answerWithModel);
      try {
        const { jobId, jobDir } = resolveJobDirForRoute(chatId);
        appendRoomConversationExchange({
          jobDir,
          chatSessionStore,
          chatId,
          userId,
          userText: message,
          assistantText: answer,
          command: sourceCommand,
          source: 'room_concierge_direct_fast_path',
          provider: result?.provider || 'unknown',
          model: result?.result?.used_model || result?.result?.model || '',
          route: decision?.route || 'concierge_direct_answer',
          jobId,
          skipUserTurn: true,
        });
      } catch {}
      scheduleIdleMemoryStructuringForChat({ chatId, userId, source: 'idle_after_direct_fast_path' });
      appendAskRouteOutcome({ chatId, userId, message, command: sourceCommand, decision, executor: 'direct_ask_fast_path', outcome: 'answered_direct_fast_path', extra: { latency_ms: Date.now() - started } });
      try {
        chatSessionStore.upsert(chatId, (session = {}) => ({
          ...session,
          last_room_concierge_route: decision || null,
          last_direct_ask: {
            ts: new Date().toISOString(),
            provider: result?.provider || 'unknown',
            model: result?.result?.used_model || result?.result?.model || result?.model || '',
            duration_ms: Date.now() - started,
            message_chars: Array.from(String(message || '')).length,
          },
        }));
      } catch {}
      return { status: 'answered_directly', duration_ms: Date.now() - started, provider: result?.provider || 'unknown' };
    } catch (error) {
      try {
        chatSessionStore.upsert(chatId, (session = {}) => ({
          ...session,
          last_room_concierge_route: decision || null,
          last_direct_ask_error: {
            ts: new Date().toISOString(),
            message: String(error?.message || error || 'unknown'),
          },
        }));
      } catch {}
      if (String(process.env.DDALGGAK_DIRECT_ASK_FALLBACK_NOTICE || '').trim().toLowerCase() === 'true') {
        await bot.sendMessage(chatId, '빠른 답변 경로가 실패해서 표준 AI Room 실행으로 전환합니다.');
      }
      appendAskRouteOutcome({ chatId, userId, message, command: sourceCommand, decision, executor: 'direct_ask_fast_path', outcome: 'fast_path_failed_fallback_to_workbench', extra: { error: String(error?.message || error || 'unknown') } });
      await enqueueWorkbenchInput({ chatId, userId, msg, text: message, kind: 'ask', teamConfig: buildRoomFirstTeamConfiguration({ taskText: message, workMode: 'ask', roomProfile: getAgentRoomProfile(chatSessionStore, chatId), chatId, source: 'telegram_ask_direct_fallback' }), ackAlreadySent });
      return { status: 'fallback_to_workbench', error: String(error?.message || error || 'unknown') };
    }
  }

  async function enqueueWorkbenchInput({ chatId, userId, msg = {}, text = '', kind = 'normal', teamConfig = null, ackAlreadySent = false } = {}) {
    if (!ackAlreadySent) await safeRouterAck(chatId, msg);
    await chatRunManager.handleIncoming({
      chatId,
      userId,
      text,
      kind,
      telegramMessageId: msg?.message_id,
      userReplyToMessageId: telegramReplyToMessageId(msg),
      teamConfig,
      chatInfo: telegramChatInfo(msg, chatId),
    });
  }

  async function startBoundedLoopFromTelegram({ chatId, userId, msg = {}, raw = '', sourceCommand = '/loop' } = {}) {
    const parsedLoop = parseLoopDepthArgs(raw);
    const goal = parsedLoop.goal;
    if (!goal) {
      await bot.sendMessage(chatId, `Usage: ${sourceCommand} [--loops n] <goal>`);
      return true;
    }
    const { runtime: runtimeForTeam } = await loadRuntimeForCurrentJob(chatId, userId, { includeContext: false });
    const existingRoomProfile = getAgentRoomProfile(chatSessionStore, chatId);
    const defaultMaxLoops = Number(existingRoomProfile?.loop_policy?.default_iterations || existingRoomProfile?.loopPolicy?.default_iterations || 0) || null;
    const signals = extractTeamCreationSignals({ request: goal, goal, runtime: runtimeForTeam });
    const workflowContract = forceBoundedLoopContract(buildTeamWorkflowContract({ signals, goal }), { goal, ...parsedLoop, defaultMaxLoops });
    const { activeTeam, roomProfile } = await suggestAndApplyAgentRoomTeam({ chatId, userId, goal, runtimeForTeam, autoApply: true, workMode: 'team_loop_task' });
    const taskLoopRuntimeExecution = buildWorkflowRuntimeExecutionPatch(workflowContract, activeTeam?.runtime_execution || activeTeam?.runtimeExecution || runtimeForTeam?.runtime_execution || runtimeForTeam?.runtimeExecution || {});
    const taskLoopTeamConfig = activeTeam && typeof activeTeam === 'object'
      ? {
        ...activeTeam,
        runtime_execution: taskLoopRuntimeExecution || activeTeam.runtime_execution || activeTeam.runtimeExecution,
        runtimeExecution: taskLoopRuntimeExecution || activeTeam.runtimeExecution || activeTeam.runtime_execution,
        task_loop_execution_mode: 'task_loop',
      }
      : activeTeam;
    setPendingTaskControl(chatId, {
      goal,
      command: sourceCommand,
      workflow_contract: workflowContract,
      team_roles: roomProfile.default_agents,
      source: sourceCommand === '/loop' ? 'telegram_loop' : 'telegram_task_loop',
    });
    const roomLoop = startRoomLoopControlPlane({
      chatId,
      userId,
      goal,
      command: sourceCommand,
      workflowContract,
      teamConfig: taskLoopTeamConfig,
      source: sourceCommand === '/loop' ? 'telegram_loop' : 'telegram_task_loop',
    });
    await sendLong(bot, chatId, [
      '🔁 Bounded loop를 시작합니다.',
      '',
      `workflow: ${summarizeTeamWorkflowContract(workflowContract)}`,
      `agents: ${(roomProfile.default_agents || []).join(', ') || '-'}`,
      roomLoop?.loop_id ? `loop id: ${roomLoop.loop_id}` : '',
      `max loops: ${workflowContract.max_iterations}`,
      'policy: small safe changes auto · risky/large changes approval-required',
    ].join('\n'));
    const taskMessage = [
      'CONTROL PLANE TASK: Start a bounded agent-room loop for the following goal.',
      `Work depth: loop`,
      roomLoop?.loop_id ? `Loop ID: ${roomLoop.loop_id}` : '',
      `Workflow contract: ${JSON.stringify(workflowContract)}`,
      `Agent room roles: ${(roomProfile.default_agents || []).join(', ')}`,
      '',
      goal,
    ].join('\n');
    recordRoomEvent({ chatId, userId, eventType: 'work_depth_used', command: sourceCommand || '/loop', goal, profile: getAgentRoomProfile(chatSessionStore, chatId), extra: { depth: 'loop', max_iterations: workflowContract.max_iterations } });
    await enqueueWorkbenchInput({ chatId, userId, msg, text: taskMessage, kind: 'team_loop_task', teamConfig: taskLoopTeamConfig || null });
    return true;
  }


  function getCurrentRoomPackage(chatId, { title = '' } = {}) {
    const profile = getAgentRoomProfile(chatSessionStore, chatId);
    return buildRoomPackage({ profile, chatId, title: title || profile?.name || '', source: 'telegram_room_command' });
  }



  function buildRoomPreferenceScorerCandidates({ profile = null, roomPackage = null, goal = '' } = {}) {
    const pkg = roomPackage || {};
    const packageCandidates = listDefaultRoomPackages({ limit: 24 }).map((row) => ({
      candidate_id: row.package_id,
      title: row.title || row.package_id,
      learning_target: 'room_package',
      proposal_kind: 'room_package_trial',
      summary: row.description || row.domain_label || '',
      tags: [...(Array.isArray(row.tags) ? row.tags : []), row.domain_label, row.default_depth, ...(Array.isArray(row.skills) ? row.skills.slice(0, 8) : []), ...(Array.isArray(row.agents) ? row.agents.slice(0, 8) : [])],
      risk: row.default_depth === 'loop' ? 'medium' : 'low',
    }));
    const recipeCandidates = ['ask', 'team', 'loop'].map((depth) => ({
      candidate_id: `recipe_${depth}`,
      title: `Recipe: ${depth}`,
      learning_target: 'room_recipe',
      proposal_kind: 'room_recipe_trial',
      summary: `Route recurring ${depth} work through a ${depth} room recipe; durable change remains approval-gated.`,
      tags: [depth, profile?.domain_label, pkg.domain_label, goal],
      risk: depth === 'loop' ? 'medium' : 'low',
    }));
    const agentPolicy = buildDefaultAgentActivationPolicy(pkg, { profile });
    const agentCandidates = (agentPolicy.roster || []).slice(0, 12).map((row) => ({
      candidate_id: `agent_${row.agent}_${row.state}`,
      title: `Agent policy: ${row.agent} stays ${row.state}`,
      learning_target: 'agent_policy',
      proposal_kind: 'agent_policy_trial',
      summary: `${row.agent} uses activation=${row.state}; token cost alone cannot disable required/safety/verifier agents.`,
      tags: [row.agent, row.state, row.model_role_hint, row.rationale],
      risk: row.state === 'required' ? 'medium' : 'low',
    }));
    const modelAssignments = Array.isArray(pkg.model_policy?.default_assignment) ? pkg.model_policy.default_assignment : [];
    const modelCandidates = modelAssignments.slice(0, 12).map((row) => ({
      candidate_id: `model_role_${row.role}`,
      title: `Model role: ${row.role}`,
      learning_target: 'model_policy',
      proposal_kind: 'model_policy_trial',
      summary: `${row.role}: ${row.purpose || 'room-scoped model role'}; provider secrets are never exported.`,
      tags: [row.role, row.preferred_tier, row.fallback_tier, row.purpose],
      risk: /verifier|source|code/.test(String(row.role || '')) ? 'medium' : 'low',
    }));
    return [...packageCandidates, ...recipeCandidates, ...agentCandidates, ...modelCandidates];
  }

  function recordRoomEvent({ chatId, userId, eventType, command, goal = '', profile = null, recommendation = null, extra = {} }) {
    try {
      const event = buildRoomUsageEvent({ chatId, userId, eventType, command, goal, profile, recommendation, extra });
      appendRoomUsageEvent(event);
      try {
        appendRoomActionNoteFromEvent({ chatId, event });
      } catch (docErr) {
        console.warn('[room-docs] failed to append action note:', docErr?.message || docErr);
      }
    } catch (err) {
      console.warn('[room-events] failed to record event:', err?.message || err);
    }
  }

  async function handleRoomCommand({ chatId, userId, msg, sub = '', rawArgs = '' }) {
    const command = String(sub || '').trim().toLowerCase();
    const argsAfterSub = String(rawArgs || '').replace(/^\S+\s*/i, '').trim();
    if (!command || ['status', 'show', 'profile'].includes(command)) {
      const profile = getAgentRoomProfile(chatSessionStore, chatId);
      if (!profile || !profile.kind) {
        await sendLong(bot, chatId, [
          'AI Room이 아직 전문화되지 않았어요.',
          '',
          ROOM_HELP_TEXT,
        ].join('\n'));
        return true;
      }
      const pkg = getCurrentRoomPackage(chatId);
      await sendLong(bot, chatId, [
        formatAgentRoomProfile(profile, { includeHelp: false }),
        '',
        formatRoomPackageSummary(pkg, { includeExamples: false }),
        '',
        ROOM_HELP_TEXT,
      ].join('\n'));
      return true;
    }
    if (['help', 'more'].includes(command)) {
      await sendLong(bot, chatId, ROOM_HELP_TEXT);
      return true;
    }
    if (['presets', 'preset-list', 'library', 'catalog'].includes(command)) {
      const query = argsAfterSub;
      const rows = query ? recommendDefaultRoomPackages(query, { limit: 12, minScore: 1 }) : listDefaultRoomPackages({ limit: 40 });
      recordRoomEvent({ chatId, userId, eventType: 'default_room_presets_view', command: '/room presets', goal: query, profile: getAgentRoomProfile(chatSessionStore, chatId), extra: { count: rows.length } });
      await sendLong(bot, chatId, [
        formatDefaultRoomPackageList(rows, { includeScores: Boolean(query) }),
        '',
        '적용:',
        '/room preset <id>',
        '',
        '원칙: 이 preset들은 fixed prompt가 아니라 agent roster, skill cards, memory hierarchy, loop policy의 starting point입니다. 실제 방은 사용 기록과 승인된 memory proposal로 점점 조정됩니다.',
      ].join('\n'));
      return true;
    }
    if (['docs', 'doc', 'moc', 'index'].includes(command)) {
      const profile = getAgentRoomProfile(chatSessionStore, chatId);
      const events = readRoomUsageEvents(chatId, { limit: 240 });
      const pkg = getCurrentRoomPackage(chatId);
      const pack = buildRoomDocumentMocPack({ roomPackage: pkg, profile, events });
      const docMode = String(argsAfterSub || '').trim().toLowerCase();
      const invalidation = buildMaterializedRoomDocsInvalidation({ chatId, pack, events });
      if (/\b(sync|materialize|write)\b/i.test(docMode)) {
        const result = materializeRoomDocumentMocPack({ chatId, pack, events });
        recordRoomEvent({ chatId, userId, eventType: 'room_document_moc_synced', command: '/room docs sync', profile, extra: { file_count: result.files_written, root: result.root } });
        await sendLong(bot, chatId, formatRoomDocsSyncResultForTelegram(result));
        return true;
      }
      if (/\b(status|stale|invalidat|freshness)\b/i.test(docMode)) {
        recordRoomEvent({ chatId, userId, eventType: 'room_document_moc_status_view', command: '/room docs status', profile, extra: { status: invalidation.status, changed_event_count: invalidation.changed_event_count } });
        await sendLong(bot, chatId, formatRoomDocumentInvalidationForTelegram(invalidation));
        return true;
      }
      const includeFull = /\b(full|export|files|all)\b/i.test(docMode);
      recordRoomEvent({ chatId, userId, eventType: 'room_document_moc_view', command: '/room docs', profile, extra: { action_count: (pack.actions || []).length, doc_count: (pack.docs || []).length, include_full: includeFull, materialized_status: invalidation.status } });
      await sendLong(bot, chatId, formatRoomDocumentMocPackForTelegram(pack, { includeFull, invalidation }));
      return true;
    }
    if (['agents', 'agent-roster', 'roster', 'activation'].includes(command)) {
      const profile = getAgentRoomProfile(chatSessionStore, chatId);
      const events = readRoomUsageEvents(chatId, { limit: 240 });
      const pkg = getCurrentRoomPackage(chatId);
      const subMode = String(argsAfterSub || '').trim().toLowerCase();
      const currentPolicy = buildDefaultAgentActivationPolicy(pkg, { profile });
      const telemetry = deriveAgentTelemetry({ events, policy: currentPolicy, roomPackage: pkg, profile });
      if (/\b(specialize|optimise|optimize|prune|proposal|trial)\b/i.test(subMode)) {
        const proposal = proposeAgentRosterSpecialization({ events, policy: currentPolicy, roomPackage: pkg, profile });
        try {
          chatSessionStore.upsert(chatId, (session = {}) => ({
            ...session,
            pending_agent_specialization: proposal,
            updated_at: new Date().toISOString(),
          }));
        } catch {}
        recordRoomEvent({ chatId, userId, eventType: 'room_agent_specialization_proposed', command: '/room agents specialize', profile, extra: { status: proposal.status, action_count: (proposal.actions || []).length } });
        await sendLong(bot, chatId, formatAgentSpecializationProposalForTelegram(proposal));
        return true;
      }
      if (/\b(approve|accept)\b/i.test(subMode)) {
        const session = chatSessionStore.get(chatId) || {};
        const proposal = session.pending_agent_specialization || null;
        if (!proposal || proposal.status !== 'proposal_ready') {
          await sendLong(bot, chatId, '승인할 pending agent specialization proposal이 없습니다. 먼저 /room agents specialize 를 실행하세요.');
          return true;
        }
        const updatedProfile = upsertAgentRoomProfile(chatSessionStore, chatId, {
          ...(profile || {}),
          agent_activation_policy: proposal.proposed_policy,
          updated_at: new Date().toISOString(),
          reasons: [...new Set([...(profile?.reasons || []), 'approved_agent_activation_specialization'])],
        });
        try {
          chatSessionStore.upsert(chatId, (session = {}) => ({ ...session, pending_agent_specialization: null, updated_at: new Date().toISOString() }));
        } catch {}
        recordRoomEvent({ chatId, userId, eventType: 'room_agent_specialization_approved', command: '/room agents approve', profile: updatedProfile, extra: { action_count: (proposal.actions || []).length } });
        await sendLong(bot, chatId, [
          '✅ Agent activation policy를 이 room에 적용했습니다.',
          '',
          formatAgentActivationPolicyForTelegram(proposal.proposed_policy),
          '',
          '주의: required agent는 자동으로 비활성화하지 않으며, rollback/재특화가 필요하면 /room agents specialize 로 다시 proposal을 만드세요.',
        ].join('\n'));
        return true;
      }
      if (/\b(reject|deny)\b/i.test(subMode)) {
        try { chatSessionStore.upsert(chatId, (session = {}) => ({ ...session, pending_agent_specialization: null, updated_at: new Date().toISOString() })); } catch {}
        recordRoomEvent({ chatId, userId, eventType: 'room_agent_specialization_rejected', command: '/room agents reject', profile, extra: {} });
        await sendLong(bot, chatId, '✅ pending agent specialization proposal을 거절했습니다. 현재 agent activation policy는 유지됩니다.');
        return true;
      }
      recordRoomEvent({ chatId, userId, eventType: 'room_agent_activation_policy_view', command: '/room agents', profile, extra: { agent_count: (currentPolicy.roster || []).length } });
      await sendLong(bot, chatId, formatAgentActivationPolicyForTelegram(currentPolicy, { telemetry }));
      return true;
    }
    if (['model', 'models', 'model-policy', 'model-router', 'router'].includes(command)) {
      const profile = getAgentRoomProfile(chatSessionStore, chatId);
      const pkg = getCurrentRoomPackage(chatId);
      const plan = resolveRoomModelRolePlan({ roomPackage: pkg, profile });
      recordRoomEvent({ chatId, userId, eventType: 'room_model_role_router_view', command: '/room model-router', profile, extra: { role_count: plan.role_count || 0, roles: (plan.rows || []).map((row) => row.role).slice(0, 12) } });
      await sendLong(bot, chatId, formatRoomModelRolePlanForTelegram(plan));
      return true;
    }
    if (['topology', 'communication', 'comm', 'graph'].includes(command)) {
      const profile = getAgentRoomProfile(chatSessionStore, chatId);
      const events = readRoomUsageEvents(chatId, { limit: 240 });
      const pkg = getCurrentRoomPackage(chatId);
      if (/\b(export|dataset|jsonl|train|training)\b/i.test(argsAfterSub || '')) {
        const result = exportRoomTopologyTrainingDataset({ chatId, events, profile, roomPackage: pkg, format: /\bjson\b/i.test(argsAfterSub || '') && !/jsonl/i.test(argsAfterSub || '') ? 'json' : 'jsonl' });
        recordRoomEvent({ chatId, userId, eventType: 'room_topology_dataset_exported', command: '/room topology export', profile, extra: { row_count: result.dataset?.row_count || 0, root: result.root } });
        await sendLong(bot, chatId, formatRoomTopologyDatasetExportForTelegram(result));
        return true;
      }
      if (/\b(replay|evaluate|eval|rank|score)\b/i.test(argsAfterSub || '')) {
        const report = evaluateTopologyReplay({ events, profile, roomPackage: pkg });
        recordRoomEvent({ chatId, userId, eventType: 'room_topology_replay_evaluated', command: '/room topology replay', profile, extra: { status: report.status, trace_count: report.trace_count || 0, top_candidate: report.top_candidate?.topology_id || '' } });
        await sendLong(bot, chatId, formatTopologyReplayEvaluationForTelegram(report));
        return true;
      }
      const card = buildRoomTopologyLearningCard({ roomPackage: pkg, profile, events });
      recordRoomEvent({ chatId, userId, eventType: 'room_topology_learning_view', command: '/room topology', profile, extra: { primary_topology: card.primary_topology, candidate_count: (card.candidates || []).length } });
      await sendLong(bot, chatId, formatRoomTopologyLearningCardForTelegram(card));
      return true;
    }
    if (['alternatives', 'alt', 'compose', 'composition'].includes(command)) {
      const profile = getAgentRoomProfile(chatSessionStore, chatId);
      const goal = argsAfterSub || profile?.current_goal || '';
      if (!goal) {
        await sendLong(bot, chatId, [
          '아직 비교할 room goal이 없습니다.',
          '',
          '먼저 /room apply <goal> 또는 /room suggest <goal>를 사용하세요.',
        ].join('\n'));
        return true;
      }
      const composition = buildDefaultRoomPackageComposition(goal, { limit: 8, currentProfile: profile });
      recordRoomEvent({ chatId, userId, eventType: 'room_package_composition_view', command: '/room alternatives', goal, profile, extra: { mode: composition.mode, base_package: composition.base_package?.package_id || '', borrowed_count: (composition.borrowed_packages || []).length } });
      await sendLong(bot, chatId, [
        formatDefaultRoomPackageComposition(composition),
        '',
        '적용:',
        `/room apply ${goal}`,
        composition.base_package?.package_id ? `/room preset ${composition.base_package.package_id}` : '',
        '',
        '원칙: 이것은 분류기가 아니라 retrieval + composition 후보입니다. durable room 변경은 사용자/GoC 승인 경로를 거칩니다.',
      ].filter(Boolean).join('\n'));
      return true;
    }
    if (['preset', 'use', 'template'].includes(command)) {
      const presetId = String(argsAfterSub || '').trim();
      if (!presetId) {
        await sendLong(bot, chatId, [
          'Usage: /room preset <id>',
          '',
          formatDefaultRoomPackageList(listDefaultRoomPackages({ limit: 20 })),
        ].join('\n'));
        return true;
      }
      const preset = getDefaultRoomPackage(presetId);
      if (!preset) {
        await sendLong(bot, chatId, [
          `Default room preset을 찾지 못했습니다: ${presetId}`,
          '',
          formatDefaultRoomPackageList(recommendDefaultRoomPackages(presetId, { limit: 8, minScore: 1 }), { includeScores: true }),
        ].join('\n'));
        return true;
      }
      const profile = buildRoomProfileFromGoal({ chatId, goal: preset.description || preset.title, roomName: preset.title, source: 'telegram_room_preset', presetId: preset.package_id });
      upsertAgentRoomProfile(chatSessionStore, chatId, profile);
      recordRoomEvent({ chatId, userId, eventType: 'default_room_preset_applied', command: '/room preset', goal: preset.package_id, profile, extra: { package_id: preset.package_id } });
      await sendLong(bot, chatId, [
        '✅ Default room preset을 이 Telegram room에 적용했습니다.',
        '',
        formatDefaultRoomPackageDetail(preset),
        '',
        formatAgentRoomProfile(profile, { includeHelp: false }),
        '',
        '다음:',
        '- /c <요청>: preset 기반으로 바로 요청',
        '- /loop 3 <목표>: preset loop policy를 사용해 bounded loop 시작',
        '- /memory idle: idle 시간에 memory candidate 정리',
      ].join('\n'));
      return true;
    }
    if (command === 'suggest') {
      const goal = argsAfterSub;
      if (!goal) {
        await bot.sendMessage(chatId, 'Usage: /room suggest <goal>');
        return true;
      }
      const profile = buildRoomProfileFromGoal({ chatId, goal, source: 'telegram_room_suggest' });
      const pkg = buildRoomPackage({ profile, chatId, goal, title: profile.name, source: 'telegram_room_suggest' });
      recordRoomEvent({ chatId, userId, eventType: 'room_suggested', command: '/room suggest', goal, profile });
      const presets = recommendDefaultRoomPackages(goal, { limit: 5, minScore: 1 });
      await sendLong(bot, chatId, [
        '추천 AI Room specialization입니다. 아직 적용하지 않았습니다.',
        '',
        formatAgentRoomProfile(profile, { includeHelp: false }),
        '',
        formatRoomPackageSummary(pkg),
        '',
        formatDefaultRoomPackageComposition(buildDefaultRoomPackageComposition(goal, { limit: 6, currentProfile: getAgentRoomProfile(chatSessionStore, chatId) })),
        '',
        presets.length ? formatDefaultRoomPackageList(presets, { includeScores: true }) : '',
        '',
        '적용하려면:',
        `/room apply ${goal}`,
        presets[0]?.package_id ? `또는: /room preset ${presets[0].package_id}` : '',
      ].filter(Boolean).join('\n'));
      return true;
    }
    if (command === 'apply' || command === 'specialize' || command === 'set') {
      const goal = argsAfterSub;
      if (!goal) {
        await bot.sendMessage(chatId, 'Usage: /room apply <goal>');
        return true;
      }
      const profile = buildRoomProfileFromGoal({ chatId, goal, source: 'telegram_room_apply' });
      upsertAgentRoomProfile(chatSessionStore, chatId, profile);
      recordRoomEvent({ chatId, userId, eventType: 'room_applied', command: '/room apply', goal, profile });
      const preset = profile?.preset_id ? getDefaultRoomPackage(profile.preset_id) : null;
      await sendLong(bot, chatId, [
        '✅ 이 채팅방을 specialized AI Room으로 설정했습니다.',
        profile?.preset_id ? `- default preset: ${profile.preset_id}` : '',
        '',
        formatAgentRoomProfile(profile, { includeHelp: false }),
        '',
        formatDefaultRoomPackageComposition(profile.room_package_composition),
        preset ? '' : '',
        preset ? formatDefaultRoomPackageDetail(preset) : '',
        '',
        '공유/포크 가능한 설명서를 보려면 /room manual 또는 /room export 를 사용하세요.',
        '대안/구성 근거를 다시 보려면 /room alternatives 를 사용하세요.',
      ].filter((line) => line !== '').join('\n'));
      return true;
    }
    if (['advisor', 'advise', 'tradeoff', 'granularity', 'recommend'].includes(command)) {
      const goal = argsAfterSub;
      const profile = getAgentRoomProfile(chatSessionStore, chatId);
      const recommendation = recommendRoomGranularity({ goal, profile });
      recordRoomEvent({ chatId, userId, eventType: 'room_granularity_advice', command: '/room advisor', goal, profile, recommendation });
      await sendLong(bot, chatId, [
        formatRoomGranularityRecommendation(recommendation),
        '',
        'User remains in control: use this as an advisory signal, not an automatic room router.',
        'Apply specialization with /room apply <goal>, or keep using the current room if the tradeoff is not worth it.',
      ].join('\n'));
      return true;
    }
    if (['components', 'component', 'cards', 'compose'].includes(command)) {
      const pkg = getCurrentRoomPackage(chatId);
      recordRoomEvent({ chatId, userId, eventType: 'room_components_view', command: '/room components', profile: getAgentRoomProfile(chatSessionStore, chatId), extra: { package_id: pkg.package_id } });
      await sendLong(bot, chatId, [
        formatRoomComponentLibrary(pkg),
        '',
        'Component reuse:',
        '- borrow: use an agent card for one attempt with projected context only',
        '- install: add a reusable agent card as a resident room member',
        '- fork: adapt an agent/policy/schema card for this room',
        '',
        'Private memory is never copied by a Room Package or borrowed agent.',
      ].join('\n'));
      return true;
    }
    if (['learning', 'learn', 'preference', 'preferences', 'feedback', 'rlhf'].includes(command)) {
      const profile = getAgentRoomProfile(chatSessionStore, chatId);
      const events = readRoomUsageEvents(chatId, { limit: 500 });
      const pkg = getCurrentRoomPackage(chatId);
      const mode = String(argsAfterSub || '').trim().toLowerCase();
      if (/\b(export|dataset|jsonl|train|training)\b/i.test(mode)) {
        const result = exportRoomPreferenceDataset({ chatId, events, profile, roomPackage: pkg, format: /\bjson\b/i.test(mode) && !/jsonl/i.test(mode) ? 'json' : 'jsonl' });
        recordRoomEvent({ chatId, userId, eventType: 'room_preference_dataset_exported', command: '/room learning export', profile, extra: { row_count: result.dataset?.row_count || 0, dpo_ready_rows: result.dataset?.summary?.dpo_ready_rows || 0, root: result.root } });
        await sendLong(bot, chatId, formatRoomPreferenceDatasetExportForTelegram(result));
        return true;
      }
      if (/\b(score|rank|scorer|recommend|router)\b/i.test(mode)) {
        const dataset = buildRoomPreferenceDataset({ events, profile, roomPackage: pkg, limit: 500 });
        const report = scoreRoomPreferenceCandidates({ dataset, profile, roomPackage: pkg, candidates: buildRoomPreferenceScorerCandidates({ profile, roomPackage: pkg, goal: mode }) });
        recordRoomEvent({ chatId, userId, eventType: 'room_preference_scorer_view', command: '/room learning score', profile, extra: { candidate_count: report.candidate_count || 0, top_candidate: report.top_recommendation?.candidate_id || '', top_target: report.top_recommendation?.learning_target || '' } });
        await sendLong(bot, chatId, formatRoomPreferenceScorerReportForTelegram(report));
        return true;
      }
      const dataset = buildRoomPreferenceDataset({ events, profile, roomPackage: pkg, limit: 500 });
      recordRoomEvent({ chatId, userId, eventType: 'room_preference_learning_view', command: '/room learning', profile, extra: { row_count: dataset.row_count || 0, dpo_ready_rows: dataset.summary?.dpo_ready_rows || 0 } });
      await sendLong(bot, chatId, formatRoomPreferenceLearningSummaryForTelegram(dataset));
      return true;
    }
    if (['evolution', 'grow', 'growth'].includes(command)) {
      const profile = getAgentRoomProfile(chatSessionStore, chatId);
      const events = readRoomUsageEvents(chatId, { limit: 200 });
      const snapshot = proposeRoomEvolution({ events, roomPackage: getCurrentRoomPackage(chatId) });
      recordRoomEvent({ chatId, userId, eventType: 'room_evolution_view', command: '/room evolution', profile, extra: { maturity: snapshot.maturity, proposal_count: (snapshot.proposals || []).length } });
      await sendLong(bot, chatId, [
        '🌱 AI Room evolution',
        '',
        formatRoomEvolutionSnapshot(snapshot),
        '',
        '이 제안들은 자동 적용되지 않습니다. AI는 설계자/제안자이고, GoC 또는 사용자가 승인해야 schema/agent/tool/gateway가 실제 room state에 반영됩니다.',
      ].join('\n'));
      return true;
    }
    if (command === 'manual' || command === 'md' || command === 'room.md') {
      const pkg = getCurrentRoomPackage(chatId);
      recordRoomEvent({ chatId, userId, eventType: 'room_manual_view', command: '/room manual', profile: getAgentRoomProfile(chatSessionStore, chatId) });
      await sendLong(bot, chatId, ['ROOM.md', '```md', renderRoomMarkdown(pkg), '```'].join('\n'));
      return true;
    }
    if (command === 'export' || command === 'package') {
      const title = argsAfterSub;
      const pkg = getCurrentRoomPackage(chatId, { title });
      recordRoomEvent({ chatId, userId, eventType: 'room_package_exported', command: '/room export', goal: title, profile: getAgentRoomProfile(chatSessionStore, chatId), extra: { package_id: pkg.package_id } });
      await sendLong(bot, chatId, [
        '📦 공유 가능한 AI Room Package를 생성했습니다.',
        '',
        formatRoomPackageSummary(pkg),
        '',
        'ROOM.md',
        '```md',
        renderRoomMarkdown(pkg),
        '```',
        '',
        'JSON',
        '```json',
        JSON.stringify(pkg, null, 2),
        '```',
      ].join('\n'));
      return true;
    }
    if (command === 'install' || command === 'import' || command === 'clone') {
      const raw = String(argsAfterSub || '').trim();
      if (!raw) {
        await bot.sendMessage(chatId, 'Usage: /room install <package_json>');
        return true;
      }
      const pkg = parseRoomPackageInput(raw);
      if (!pkg) {
        await bot.sendMessage(chatId, 'ROOM package JSON 파싱에 실패했습니다. /room export 의 JSON 블록을 사용하세요.');
        return true;
      }
      const profilePatch = roomPackageToProfilePatch(pkg, { chatId, source: 'telegram_room_install' });
      const profile = upsertAgentRoomProfile(chatSessionStore, chatId, profilePatch);
      recordRoomEvent({ chatId, userId, eventType: 'room_package_installed', command: '/room install', profile, extra: { package_id: pkg.package_id } });
      await sendLong(bot, chatId, [
        '✅ 공유 AI Room package를 설치했습니다.',
        'private memory, credentials, raw chat history, uploaded files는 복사하지 않았고 이 방의 fresh local memory로 시작합니다.',
        '',
        formatAgentRoomProfile(profile, { includeHelp: false }),
      ].join('\n'));
      return true;
    }
    if (command === 'reset') {
      recordRoomEvent({ chatId, userId, eventType: 'room_reset', command: '/room reset', profile: getAgentRoomProfile(chatSessionStore, chatId) });
      upsertAgentRoomProfile(chatSessionStore, chatId, {
        status: 'reset',
        default_agents: [],
        default_workflow: 'task_adaptive',
        default_depth: 'ask',
        current_goal: '',
        memory_schema: { object_types: [] },
        reasons: [],
        source: 'telegram_room_reset',
      });
      await bot.sendMessage(chatId, '✅ AI Room specialization을 초기화했습니다. /room suggest <goal>로 다시 시작하세요.');
      return true;
    }
    await bot.sendMessage(chatId, `알 수 없는 /room 명령입니다.\n\n${ROOM_HELP_TEXT}`);
    return true;
  }

  return async function handleTelegramCommand({ msg, text, chatId, userId }) {
    if (!String(text || "").startsWith("/")) return false;

    const rawText = String(text || "");
    const firstSpaceIndex = rawText.indexOf(" ");
    const rawArgs = firstSpaceIndex >= 0 ? rawText.slice(firstSpaceIndex + 1).trim() : "";
    let [cmd, ...rest] = rawText.split(/\s+/);
    const originalCmd = String(cmd || '').trim().toLowerCase();
    cmd = normalizeTelegramCommandAlias(cmd);
    const args = rawArgs || rest.join(" ").trim();

    if (cmd === "/start" || cmd === "/home" || cmd === "/quickstart") {
      await sendLong(bot, chatId, buildDdalggakHomeText(chatId));
      return true;
    }

    if (cmd === "/inbox") {
      const sub = String(args || '').trim().toLowerCase();
      if (['digest', 'metrics', 'governance'].includes(sub)) {
        const metrics = buildRoomGovernanceMetricsForChat(chatId);
        recordRoomEvent({
          chatId,
          userId,
          eventType: 'room_governance_digest_view',
          command: '/inbox digest',
          profile: getAgentRoomProfile(chatSessionStore, chatId),
          extra: { status: metrics.status, pending: metrics.totals.pending, review_rate: metrics.totals.review_rate },
        });
        await sendLong(bot, chatId, formatRoomGovernanceDigestForTelegram(metrics));
        return true;
      }
      await sendLong(bot, chatId, buildDdalggakInboxText(chatId));
      return true;
    }

    if (cmd === "/help" || cmd === "/commands" || originalCmd === "/h") {
      const sub = String(args || "").trim().toLowerCase();
      if (sub === "advanced" || sub === "more") {
        await bot.sendMessage(chatId, ADVANCED_HELP_TEXT);
        return true;
      }
      await bot.sendMessage(chatId, HELP_TEXT);
      return true;
    }

    if (cmd === "/doctor") {
      const source = loadRuntimeDoctorEnv();
      const report = auditDdalggakRuntimeEnv(source);
      await sendLong(bot, chatId, formatRuntimeConfigDoctorForTelegram(report));
      return true;
    }

    if (cmd === "/config") {
      const sub = String(args || '').trim().toLowerCase();
      if (sub === 'doctor' || sub === 'audit') {
        const source = loadRuntimeDoctorEnv();
        const report = auditDdalggakRuntimeEnv(source);
        await sendLong(bot, chatId, formatRuntimeConfigDoctorForTelegram(report));
        return true;
      }
      await bot.sendMessage(chatId, formatRuntimeConfigForTelegram(resolveDdalggakRuntimeConfig({ env: process.env })));
      return true;
    }

    if (cmd === "/room") {
      const sub = String(rest[0] || "").trim().toLowerCase();
      return handleRoomCommand({ chatId, userId, msg, sub, rawArgs });
    }

    if (cmd === "/council") {
      const raw = String(args || '').trim();
      const [subRaw, ...subRest] = raw.split(/\s+/);
      const sub = String(subRaw || '').trim().toLowerCase();
      const restText = subRest.join(' ').trim();
      const state = getCurrentCompanionControlState(chatId);
      if (!raw || sub === 'help') {
        await sendLong(bot, chatId, [
          '🧭 Companion Council',
          '이 Telegram room 안의 companion들이 사용자가 볼 수 있는 backchannel에서 짧게 조율합니다.',
          '',
          'Usage:',
          '- /council ask <message>',
          '- /council log',
          '- /council proposals',
          '- /council approve latest|<number>',
          '- /council reject latest|<number> [reason]',
        ].join('\n'));
        return true;
      }
      if (sub === 'ask') {
        if (!restText) {
          await bot.sendMessage(chatId, 'Usage: /council ask <message>');
          return true;
        }
        let roomProfile = null;
        try { roomProfile = getAgentRoomProfile(chatSessionStore, chatId); } catch { roomProfile = null; }
        const session = buildCompanionCouncilSession({ question: restText, state, roomProfile, chatId, userId });
        for (const event of session.events) {
          appendCompanionControlEvent(chatId, userId, event);
        }
        await sendLong(bot, chatId, session.text);
        scheduleIdleMemoryStructuringForChat({ chatId, userId, source: 'idle_after_council' });
        return true;
      }
      if (sub === 'log') {
        await sendLong(bot, chatId, formatRoomCompanionCouncilLogForTelegram(state));
        return true;
      }
      if (sub === 'proposals' || sub === 'exchange' || sub === 'exchanges') {
        await sendLong(bot, chatId, formatRoomCompanionMemoryExchangeProposalsForTelegram(state));
        return true;
      }
      if (sub === 'approve' || sub === 'reject') {
        const target = subRest[0] || 'latest';
        const reason = subRest.slice(1).join(' ').trim();
        const selected = selectRoomCompanionMemoryExchangeProposal({ state, target });
        if (!selected?.proposal) {
          await bot.sendMessage(chatId, 'pending companion memory exchange proposal이 없습니다. /council proposals 로 확인하세요.');
          return true;
        }
        const event = buildRoomCompanionMemoryExchangeDecisionEvent({ proposal: selected.proposal, decision: sub, reason, userId });
        appendCompanionControlEvent(chatId, userId, event);
        const updatedState = getCurrentCompanionControlState(chatId);
        await sendLong(bot, chatId, [
          `✅ companion memory exchange ${sub === 'approve' ? 'accepted' : 'rejected'}`,
          '',
          formatRoomCompanionMemoryExchangeProposalsForTelegram(updatedState),
        ].join('\n'));
        return true;
      }
      await bot.sendMessage(chatId, '알 수 없는 /council 명령입니다. /council help 를 확인하세요.');
      return true;
    }

    if (cmd === "/companions") {
      await sendLong(bot, chatId, formatRoomCompanionListForTelegram());
      return true;
    }

    if (cmd === "/companion") {
      const raw = String(args || '').trim();
      const [subRaw, ...subRest] = raw.split(/\s+/);
      const sub = String(subRaw || '').trim().toLowerCase();
      if (!raw || sub === 'list' || sub === 'help') {
        await sendLong(bot, chatId, formatRoomCompanionListForTelegram());
        return true;
      }
      if (sub === 'profile' || sub === 'status') {
        await sendLong(bot, chatId, formatRoomCompanionProfileForTelegram(getCurrentCompanionControlState(chatId)));
        return true;
      }
      if (sub === 'switch' || sub === 'use' || sub === 'select') {
        const target = normalizeCompanionId(subRest.join(' ') || subRest[0] || '');
        if (!target) {
          await bot.sendMessage(chatId, 'Usage: /companion switch <research|implementation|product|critic|personal|concierge>');
          return true;
        }
        const profile = getRoomCompanionProfile(target);
        appendCompanionControlEvent(chatId, userId, {
          event_type: 'companion_selected',
          companion_id: profile.id,
          command: '/companion switch',
          source: 'telegram_companion_command',
          payload: { requested_companion_id: target },
        });
        await sendLong(bot, chatId, formatCompanionSwitchMessage(getCurrentCompanionControlState(chatId)));
        return true;
      }
      await bot.sendMessage(chatId, ['Usage:', '/companion profile', '/companion switch <research|implementation|product|critic|personal|concierge>', '/companions'].join('\n'));
      return true;
    }

    if (cmd === "/agent") {
      const raw = String(args || '').trim();
      const [subRaw, ...subRest] = raw.split(/\s+/);
      const sub = String(subRaw || '').trim().toLowerCase();
      if (sub === 'mode') {
        const mode = normalizeAgentMode(subRest[0] || '');
        appendCompanionControlEvent(chatId, userId, {
          event_type: 'agent_mode_changed',
          agent_mode: mode,
          command: '/agent mode',
          source: 'telegram_companion_command',
        });
        await bot.sendMessage(chatId, `✅ agent mode를 ${mode} 로 설정했습니다.
확인: /companion profile`);
        return true;
      }
      await bot.sendMessage(chatId, 'Usage: /agent mode <fast|balanced|strict>');
      return true;
    }

    if (cmd === "/correct") {
      const correctionText = String(args || '').trim();
      const [subRaw, ...subRest] = correctionText.split(/\s+/);
      const sub = String(subRaw || '').trim().toLowerCase();
      if (!correctionText || sub === 'help') {
        await bot.sendMessage(chatId, [
          'Usage:',
          '/correct <반복 오류 방지용 정정>',
          '/correct proposals',
          '/correct approve latest|<number>',
          '/correct reject latest|<number> [reason]',
          '/correct materialize-preview',
          '/correct promote latest',
          '',
          '일시적 정정은 room-local로만 기록하고, 앞으로도 적용될 가능성이 큰 정정은 reviewable merge proposal까지 생성합니다. pending proposal은 /correct approve 또는 /correct reject 로 명시 처리하며, accepted proposal은 branchable materialization candidate로만 연결됩니다. 별도 review 없이 canonical project write는 하지 않습니다.',
        ].join('\n'));
        return true;
      }
      if (['proposals', 'proposal', 'status'].includes(sub)) {
        await sendLong(bot, chatId, formatRoomCompanionMergeProposalsForTelegram(getCurrentCompanionControlState(chatId)));
        return true;
      }
      if (['materialize-preview', 'materialization-preview', 'materialization', 'materialize', 'candidates'].includes(sub)) {
        await sendLong(bot, chatId, formatRoomCompanionMaterializationCandidatesForTelegram(getCurrentCompanionControlState(chatId)));
        return true;
      }
      if (['approve', 'approved', 'accept', 'accepted', 'reject', 'rejected', 'deny', 'denied'].includes(sub)) {
        const state = getCurrentCompanionControlState(chatId);
        const firstArg = String(subRest[0] || 'latest').trim().toLowerCase();
        const hasExplicitTarget = firstArg === 'latest' || /^\d+$/.test(firstArg);
        const target = hasExplicitTarget ? firstArg : 'latest';
        const reason = subRest.slice(hasExplicitTarget ? 1 : 0).join(' ').trim();
        const decisionEvent = buildRoomCompanionMergeProposalDecisionEvent({
          state,
          target,
          decision: sub,
          reason,
          userId,
        });
        if (!decisionEvent) {
          await bot.sendMessage(chatId, '처리할 pending companion merge proposal이 없습니다. 먼저 /correct proposals 로 상태를 확인해 주세요.');
          return true;
        }
        appendCompanionControlEvent(chatId, userId, {
          ...decisionEvent,
          command: `/correct ${decisionEvent.decision}`,
          source: 'telegram_companion_command',
        });
        let materializationEvent = null;
        if (decisionEvent.status === 'accepted') {
          const nextState = getCurrentCompanionControlState(chatId);
          materializationEvent = buildRoomCompanionMaterializationCandidateEvent({
            state: nextState,
            proposalEventId: decisionEvent.proposal_event_id,
            userId,
          });
          if (materializationEvent) {
            appendCompanionControlEvent(chatId, userId, {
              ...materializationEvent,
              command: '/correct approve materialization-candidate',
              source: 'telegram_companion_command',
            });
          }
        }
        await bot.sendMessage(chatId, [
          decisionEvent.status === 'accepted'
            ? '✅ companion merge proposal을 accepted로 표시했습니다.'
            : '✅ companion merge proposal을 rejected로 표시했습니다.',
          decisionEvent.summary,
          '',
          `status: ${decisionEvent.status}`,
          `target_scope: ${decisionEvent.target_scope || 'project_candidate'}`,
          reason ? `reason: ${reason}` : '',
          materializationEvent ? `materialization_candidate: ${materializationEvent.materialization_id || 'created'} (branch overlay preview only)` : '',
          '',
          decisionEvent.status === 'accepted'
            ? '결정은 companion event log에 남겼고, branchable materialization candidate를 만들었습니다. canonical project write는 아직 비활성입니다.'
            : '결정은 companion event log에 남겼습니다. rejected proposal은 project memory materialization 후보가 되지 않습니다.',
          '확인: /correct proposals 또는 /correct materialize-preview',
        ].filter(Boolean).join('\n'));
        return true;
      }

      if (sub === 'promote') {
        const state = getCurrentCompanionControlState(chatId);
        const corrections = Array.isArray(state.recent_corrections) ? state.recent_corrections : [];
        const target = String(subRest[0] || 'latest').trim().toLowerCase();
        const index = target === 'latest' ? corrections.length - 1 : Math.max(0, Number(target) - 1);
        const correction = corrections[index];
        if (!correction) {
          await bot.sendMessage(chatId, 'promote할 correction이 없습니다. 먼저 /correct <정정> 으로 기록해 주세요.');
          return true;
        }
        const proposalEvent = buildCorrectionMergeProposalEvent({ correction, state, force: true });
        if (!proposalEvent) {
          await bot.sendMessage(chatId, 'merge proposal을 만들 수 없습니다.');
          return true;
        }
        appendCompanionControlEvent(chatId, userId, {
          ...proposalEvent,
          command: '/correct promote',
          source: 'telegram_companion_command',
        });
        await bot.sendMessage(chatId, [
          '✅ reviewable merge proposal을 만들었습니다.',
          proposalEvent.summary,
          '',
          '아직 project-shared memory로 승격하지는 않았습니다.',
          '확인: /correct proposals',
        ].join('\n'));
        return true;
      }

      const intent = classifyRoomCorrectionIntent(correctionText);
      const correctionEvent = appendCompanionControlEvent(chatId, userId, {
        event_type: 'user_correction',
        correction_text: correctionText,
        scope: intent.correction_scope,
        promotion_status: intent.promotion_status,
        command: '/correct',
        source: 'telegram_companion_command',
        payload: {
          durability: intent.durability,
          risk_level: intent.risk_level,
          rationale: intent.rationale,
        },
      });
      let proposalEvent = null;
      if (correctionEvent) {
        const state = getCurrentCompanionControlState(chatId);
        proposalEvent = buildCorrectionMergeProposalEvent({
          correction: { ...correctionEvent, text: correctionText },
          state,
        });
        if (proposalEvent) {
          appendCompanionControlEvent(chatId, userId, {
            ...proposalEvent,
            command: '/correct',
            source: 'telegram_companion_command',
          });
        }
      }
      await bot.sendMessage(chatId, [
        intent.should_create_merge_proposal
          ? '✅ correction을 기록했고, durable해 보이는 정정이라 reviewable merge proposal도 만들었습니다.'
          : '✅ room-local correction으로 기록했습니다.',
        `“${correctionText}”`,
        '',
        `scope: ${intent.correction_scope}`,
        `durability: ${intent.durability}`,
        proposalEvent ? 'merge proposal: pending review' : 'merge proposal: not created automatically',
        '',
        '다음 projection에 correction을 포함합니다. 실제 project-shared memory 승격은 자동으로 하지 않습니다.',
        proposalEvent ? '확인: /correct proposals' : '필요하면 /correct promote latest 로 proposal을 만들 수 있습니다.',
      ].join('\n'));
      return true;
    }

    if (cmd === "/ask") {
      const raw = String(args || '').trim();
      if (!raw) {
        await bot.sendMessage(chatId, 'Usage: /ask <question>');
        return true;
      }
      const parsed = parseChatMessageWithFlags(raw);
      const message = String(parsed.message || '').trim();
      if (!message) {
        await bot.sendMessage(chatId, 'Usage: /ask <question>');
        return true;
      }
      const route = await tryRoomConciergeConversationalPath({ chatId, userId, msg, message, sourceCommand: '/ask' });
      if (route.handled) return true;
      const askTeamConfig = buildRoomFirstTeamConfiguration({
        taskText: message,
        workMode: 'ask',
        roomProfile: route.roomProfile || getAgentRoomProfile(chatSessionStore, chatId),
        chatId,
        source: `telegram_ask_${route.decision?.route || 'room_first'}`,
      });
      appendAskRouteOutcome({ chatId, userId, message, command: '/ask', decision: route.decision, modelPolicy: route.modelPolicy, executor: 'workbench', outcome: 'queued_workbench' });
      await enqueueWorkbenchInput({ chatId, userId, msg, text: message, kind: 'ask', teamConfig: askTeamConfig, ackAlreadySent: true });
      return true;
    }

    if (cmd === "/loop") {
      return startBoundedLoopFromTelegram({ chatId, userId, msg, raw: args, sourceCommand: '/loop' });
    }

    if (["/pause", "/resume", "/approve"].includes(cmd)) {
      const { jobDir } = getCurrentJobDirForChat(chatId);
      if (!jobDir) {
        await bot.sendMessage(chatId, '현재 active loop job이 없어 상태를 변경할 수 없습니다. /loop <goal>로 작업을 먼저 시작하세요.');
        return true;
      }
      const statusMap = { '/pause': 'paused', '/resume': 'active', '/approve': 'active' };
      const result = setWatchTaskStatus({
        jobDir,
        status: statusMap[cmd],
        reason: cmd === '/approve' ? 'telegram_top_level_approve' : `telegram_top_level_${cmd.slice(1)}`,
        actor: String(userId || chatId || 'telegram_user'),
      });
      recordRoomLoopStatusCommand({ chatId, userId, command: cmd, status: statusMap[cmd], text: args || cmd });
      await bot.sendMessage(chatId, result.ok
        ? `✅ loop 상태를 ${statusMap[cmd]} 로 변경했습니다.`
        : `loop 상태 변경 실패: ${result.reason || 'unknown'}`);
      return true;
    }

    if (cmd === "/rule" || cmd === "/rules") {
      const raw = String(args || '').trim();
      const lower = raw.toLowerCase();
      if (!raw || lower === 'help' || lower === 'status' || lower === 'list' || lower === 'show') {
        await bot.sendMessage(chatId, formatRuntimeRulesMessage(chatId));
        return true;
      }
      if (['reset', 'clear', 'delete', 'remove', '초기화', '삭제', '정리'].includes(lower)) {
        clearRuntimeRules(chatId);
        await bot.sendMessage(chatId, '✅ 운영 지침을 초기화했어요. 세부 편집과 히스토리 관리는 GoC에서 다룹니다.');
        return true;
      }
      if (lower.startsWith('import ')) {
        const source = raw.replace(/^import\s+/i, '').trim();
        try {
          const result = importExternalSkillRuleSource(source, { rootDir: process.cwd() });
          const savedRules = applyImportedRuntimeRules(chatId, result.imported_rules || []);
          const currentJobId = resolveLiveJobIdForChat(chatId);
          const boardMirror = mirrorSkillRuleImportToSemanticBoard(result, { rootDir: process.cwd(), jobId: currentJobId || '' });
          await sendLong(bot, chatId, [
            formatExternalSkillRuleImportResult(result),
            '',
            `Applied runtime rules to this chat: ${savedRules.length}`,
            `Semantic Board cards mirrored: ${boardMirror.mirrored}`,
          ].join('\n'));
        } catch (error) {
          await bot.sendMessage(chatId, `Rule import failed: ${error?.message || error}`);
        }
        return true;
      }
      const naturalRule = raw.replace(/^(?:add|set|edit|update|추가|수정|변경)\s+/i, '').trim() || raw;
      const saved = addRuntimeRule(chatId, naturalRule, { source: 'user', origin: 'telegram_rule_command' });
      const currentJobId = resolveLiveJobIdForChat(chatId);
      upsertSemanticBoardCards([runtimeRuleToSemanticCard(saved || { text: naturalRule }, { source: 'telegram_rule_command' })], { rootDir: process.cwd(), jobId: currentJobId || '' });
      await bot.sendMessage(chatId, [
        '✅ 운영 지침에 반영했어요.',
        saved?.topic && saved.topic !== 'general' ? `분류: ${saved.topic}` : '',
        '',
        '자세한 편집/비활성화/히스토리는 GoC에서 다룹니다.',
      ].filter(Boolean).join('\n'));
      return true;
    }

    if (cmd === "/whoami") {
      await bot.sendMessage(chatId, `chat_id=${chatId}\nuser_id=${userId}`);
      return true;
    }

    if (cmd === "/running") {
      await sendLong(bot, chatId, formatRunningJobs(chatId));
      return true;
    }

    if (cmd === "/stop") {
      const chatKey = String(chatId);
      const fromAwait = getAwait(chatId)?.jobId;
      const targetJobId = args || activeJobByChat.get(chatKey) || fromAwait;
      if (!targetJobId) {
        if (lastChatJobByChat.has(chatKey)) {
          resetChatSession(chatId);
          await bot.sendMessage(chatId, "✅ 현재 /chat 세션을 초기화했어요.");
          return true;
        }
        await bot.sendMessage(chatId, `중단할 jobId를 찾지 못했어요. Usage: /stop <jobId>\n\n${formatRunningJobs(chatId)}`);
        return true;
      }

      const { aborted, dropped } = cancelJobExecution(targetJobId);
      if (activeJobByChat.get(chatKey) === String(targetJobId)) activeJobByChat.delete(chatKey);
      if (fromAwait && String(fromAwait) === String(targetJobId)) clearAwait(chatId);
      if (lastChatJobByChat.get(chatKey) === String(targetJobId)) lastChatJobByChat.delete(chatKey);
      chatSessionStore.upsert(chatId, (session) => {
        if (String(session.jobId || "").trim() && String(session.jobId || "").trim() !== String(targetJobId).trim()) {
          return session;
        }
        return {
          ...session,
          interrupt: {
            requested: true,
            mode: "cancel",
            reason: "/stop",
            ts: new Date().toISOString(),
          },
          pending_user_messages: [],
          pending_approval: null,
          state: "idle",
        };
      });

      if (!aborted && dropped === 0) {
        await bot.sendMessage(chatId, `중단할 실행이 없어요. (jobId=${targetJobId})\n이미 종료되었거나 큐에 없습니다.\n\n${formatRunningJobs(chatId)}`);
        return true;
      }
      await bot.sendMessage(chatId, `⏹️ 중단 요청 완료\njobId=${targetJobId}\n실행중 중단=${aborted}\n큐 제거=${dropped}`);
      return true;
    }

    if (cmd === "/memory" || cmd === "/settings") {
      const firstMemoryArg = String(rest[0] || "show").trim().toLowerCase();
      const debugMode = firstMemoryArg === "debug" || firstMemoryArg === "--debug";
      const memoryRest = debugMode ? rest.slice(1) : rest;
      const sub = String(memoryRest[0] || "show").trim().toLowerCase();
      const publicMemorySubcommands = new Set(["", "show", "status", "list", "ls", "proposals", "proposal", "candidates", "approve", "accept", "reject", "explain", "detail", "idle", "structure", "structuring"]);

      if (!debugMode && !publicMemorySubcommands.has(sub)) {
        const session = chatSessionStore?.get?.(chatId) || {};
        const companionState = getCurrentCompanionControlState(chatId);
        await sendLong(bot, chatId, [
          formatRoomMemoryListForTelegram(deriveRoomMemoryView({ session, companionState })),
          '',
          '개발/진단용 topology/pressure/materialization은 /memory debug <subcommand>를 사용하세요.',
        ].join('\n'));
        return true;
      }

      if (!debugMode && (sub === "show" || sub === "status" || sub === "list" || sub === "ls" || sub === "")) {
        const session = chatSessionStore?.get?.(chatId) || {};
        const companionState = getCurrentCompanionControlState(chatId);
        await sendLong(bot, chatId, formatRoomMemoryListForTelegram(deriveRoomMemoryView({ session, companionState })));
        return true;
      }

      if (!debugMode && (sub === "proposals" || sub === "proposal" || sub === "candidates")) {
        const session = chatSessionStore?.get?.(chatId) || {};
        const companionState = getCurrentCompanionControlState(chatId);
        await sendLong(bot, chatId, formatRoomMemoryProposalsForTelegram(deriveRoomMemoryView({ session, companionState, includeRejected: true })));
        return true;
      }

      if (!debugMode && (sub === "approve" || sub === "accept" || sub === "reject")) {
        const target = String(memoryRest[1] || 'latest').trim() || 'latest';
        const reason = memoryRest.slice(2).join(' ').trim();
        const result = updateRoomMemoryCandidateDecision({ chatSessionStore, chatId, target, decision: sub === 'reject' ? 'reject' : 'approve', userId, reason });
        if (result?.ok && result.memory_item && sub !== 'reject') {
          result.goc_sync = await trySyncApprovedRoomMemoryToGoc({ chatId, userId, memoryItem: result.memory_item });
          try {
            chatSessionStore.upsert(chatId, (session = {}) => ({
              ...session,
              room_memory_goc_sync_events: [...(Array.isArray(session.room_memory_goc_sync_events) ? session.room_memory_goc_sync_events : []), { ts: new Date().toISOString(), memory_id: result.memory_item.memory_id, ...result.goc_sync }].slice(-80),
              updated_at: new Date().toISOString(),
            }));
          } catch {}
        }
        recordRoomEvent({ chatId, userId, eventType: sub === 'reject' ? 'room_memory_candidate_rejected' : 'room_memory_candidate_approved', command: `/memory ${sub}`, profile: getAgentRoomProfile(chatSessionStore, chatId), extra: { candidate_id: result?.candidate?.candidate_id || '', memory_id: result?.memory_item?.memory_id || '', goc_synced: result?.goc_sync?.synced === true, goc_sync_reason: result?.goc_sync?.reason || '' } });
        await sendLong(bot, chatId, formatRoomMemoryDecisionForTelegram(result));
        return true;
      }

      if (!debugMode && (sub === "explain" || sub === "detail")) {
        const session = chatSessionStore?.get?.(chatId) || {};
        const id = memoryRest.slice(1).join(' ').trim();
        await sendLong(bot, chatId, formatRoomMemoryExplainForTelegram({ session, id }));
        return true;
      }

      if (sub === "idle" || sub === "structure" || sub === "structuring") {
        try {
          const result = runIdleMemoryStructuringForChat({ chatId, userId, force: true, source: 'telegram_memory_idle' });
          await sendLong(bot, chatId, formatRoomIdleMemoryStructuringResultForTelegram(result));
        } catch (e) {
          await bot.sendMessage(chatId, `❌ idle memory structuring 실패: ${String(e?.message ?? e)}`);
        }
        return true;
      }

      if (debugMode && (sub === "show" || sub === "status")) {
        await sendLong(bot, chatId, formatMemorySummary());
        return true;
      }

      if (sub === "md") {
        await sendLong(bot, chatId, memory.readMarkdown());
        return true;
      }

      if (sub === "kb") {
        const currentJobId = resolveLiveJobIdForChat(chatId);
        if (!currentJobId) {
          await bot.sendMessage(chatId, "현재 job이 없어 knowledge base profile을 표시할 수 없습니다. /chat 또는 /run 으로 job을 먼저 시작하세요.");
          return true;
        }
        await sendLong(bot, chatId, tracking.renderProfileMarkdown(currentJobId));
        return true;
      }

      if (sub === "compact" || sub === "compaction") {
        const currentJobId = resolveLiveJobIdForChat(chatId);
        if (!currentJobId) {
          await bot.sendMessage(chatId, "현재 job이 없어 compaction candidate를 생성할 수 없습니다. /chat 또는 /run 으로 job을 먼저 시작하세요.");
          return true;
        }
        try {
          const candidate = writeIdleCompactionCandidate({ jobDir: jobs.jobDir(currentJobId) });
          await sendLong(bot, chatId, formatIdleCompactionCandidateForTelegram(candidate));
        } catch (e) {
          await bot.sendMessage(chatId, `❌ compaction candidate 생성 실패: ${String(e?.message ?? e)}`);
        }
        return true;
      }

      if (sub === "topology" || sub === "topo" || sub === "map") {
        const currentJobId = resolveLiveJobIdForChat(chatId);
        if (!currentJobId) {
          await bot.sendMessage(chatId, "현재 job이 없어 memory topology를 표시할 수 없습니다. /chat 또는 /run 으로 job을 먼저 시작하세요.");
          return true;
        }
        try {
          const topology = planMemoryTopology({ jobDir: jobs.jobDir(currentJobId), persist: true, eventReason: 'telegram_memory_topology' });
          await sendLong(bot, chatId, formatMemoryTopologyForTelegram(topology));
        } catch (e) {
          await bot.sendMessage(chatId, `❌ memory topology 생성 실패: ${String(e?.message ?? e)}`);
        }
        return true;
      }

      if (sub === "pressure" || sub === "evidence" || sub === "claims" || sub === "proposals" || sub === "review") {
        const currentJobId = resolveLiveJobIdForChat(chatId);
        if (!currentJobId) {
          await bot.sendMessage(chatId, "현재 job이 없어 review/pressure를 표시할 수 없습니다. /chat 또는 /run 으로 job을 먼저 시작하세요.");
          return true;
        }
        const jobDir = jobs.jobDir(currentJobId);
        try {
          if (sub === "pressure") {
            await sendLong(bot, chatId, formatPressureOverviewForTelegram(buildPressureOverview({ jobDir, persist: true })));
            return true;
          }
          if (sub === "evidence" || sub === "claims") {
            await sendLong(bot, chatId, formatClaimEvidenceForTelegram(buildClaimEvidenceLedger({ jobDir, persist: true })));
            return true;
          }
          await sendLong(bot, chatId, formatReviewQueueForTelegram(buildRuntimeReviewQueue({ jobDir, persist: true })));
        } catch (e) {
          await bot.sendMessage(chatId, `❌ memory review 생성 실패: ${String(e?.message ?? e)}`);
        }
        return true;
      }

      if (sub === "materialize-preview" || sub === "materialization" || sub === "materialize" || sub === "modules") {
        const currentJobId = resolveLiveJobIdForChat(chatId);
        if (!currentJobId) {
          await bot.sendMessage(chatId, "현재 job이 없어 memory materialization을 표시할 수 없습니다. /chat 또는 /run 으로 job을 먼저 시작하세요.");
          return true;
        }
        const jobDir = jobs.jobDir(currentJobId);
        const materializeTokens = memoryRest.slice(1).filter((x) => !/^--/.test(String(x || '')));
        const action = materializeTokens[0] || (sub === 'modules' ? 'list' : 'preview');
        if (sub === 'modules' || action === 'modules' || action === 'list') {
          await sendLong(bot, chatId, formatShadowMemoryModuleListForTelegram(listShadowMemoryModules({ jobDir })));
          return true;
        }
        if (sub === 'materialize' && ['shadow', 'create', 'module'].includes(String(action || '').toLowerCase())) {
          try {
            const selector = materializeTokens[1] || '';
            const latest = loadLatestMemoryMaterializationPlan({ jobDir }) || planMemoryMaterialization({ jobDir, persist: true, reason: 'telegram_shadow_module_candidate_refresh' });
            const candidate = findMaterializationCandidate(latest, selector);
            if (!candidate) {
              await bot.sendMessage(chatId, `shadow module로 만들 candidate를 찾지 못했습니다. 먼저 GoC에서 candidate를 검토하거나 /memory debug materialize-preview를 실행하세요.${selector ? ` selector=${selector}` : ''}`);
              return true;
            }
            const result = createShadowMemoryModule({ jobDir, candidate, reason: 'telegram_memory_materialize_shadow' });
            await sendLong(bot, chatId, formatShadowMemoryModuleResultForTelegram(result));
          } catch (e) {
            await bot.sendMessage(chatId, `❌ shadow memory module 생성 실패: ${String(e?.message ?? e)}`);
          }
          return true;
        }
        const useServer = /--server\b/i.test(memoryRest.slice(1).join(' '));
        const session = chatSessionStore?.get?.(chatId) || {};
        const threadId = session?.runtime?.threadId || session?.runtime?.map?.threadId || session?.map?.threadId || '';
        if (useServer && threadId && memoryModeWithFallback?.() === 'goc' && typeof requireGocClient === 'function') {
          try {
            const serverPlan = await requireGocClient().previewMemoryMaterialization(threadId, { include_backfill_preview: true });
            await sendLong(bot, chatId, formatMemoryMaterializationPlanForTelegram(serverPlan));
            return true;
          } catch (e) {
            await bot.sendMessage(chatId, `⚠️ GoC materialization preview 실패, local preview로 대체합니다: ${String(e?.message ?? e)}`);
          }
        }
        try {
          const plan = planMemoryMaterialization({ jobDir, persist: true, reason: 'telegram_memory_materialization_preview' });
          await sendLong(bot, chatId, formatMemoryMaterializationPlanForTelegram(plan));
        } catch (e) {
          await bot.sendMessage(chatId, `❌ memory materialization preview 생성 실패: ${String(e?.message ?? e)}`);
        }
        return true;
      }

      if (sub === "reset") {
        memory.reset();
        await sendLong(bot, chatId, `✅ 메모리를 기본값으로 되돌렸습니다.\n\n${formatMemorySummary()}`);
        return true;
      }

      if (sub === "policy") {
        const value = memoryRest.slice(1).join(" ").trim();
        if (!value) {
          await bot.sendMessage(chatId, "Usage: /memory debug policy <자연어 프롬프트>");
          return true;
        }
        try {
          memory.setPolicyPrompt(value);
          await sendLong(bot, chatId, `✅ reflection prompt 업데이트 완료.\n\n${formatMemorySummary()}`);
        } catch (e) {
          await bot.sendMessage(chatId, `❌ 업데이트 실패: ${String(e?.message ?? e)}`);
        }
        return true;
      }

      if (sub === "routing") {
        const value = memoryRest.slice(1).join(" ").trim();
        if (!value) {
          await bot.sendMessage(chatId, "Usage: /memory debug routing <자연어 프롬프트>");
          return true;
        }
        try {
          memory.setRouterPrompt(value);
          await sendLong(bot, chatId, `✅ router prompt 업데이트 완료.\n\n${formatMemorySummary()}`);
        } catch (e) {
          await bot.sendMessage(chatId, `❌ 업데이트 실패: ${String(e?.message ?? e)}`);
        }
        return true;
      }

      if (sub === "role") {
        const agent = String(memoryRest[1] || "").trim().toLowerCase();
        const value = memoryRest.slice(2).join(" ").trim();
        if (!agent || !value) {
          await bot.sendMessage(chatId, "Usage: /memory debug role <gemini|codex|chatgpt> <자연어 역할>");
          return true;
        }
        try {
          memory.setAgentRole(agent, value);
          await sendLong(bot, chatId, `✅ ${agent} role 업데이트 완료.\n\n${formatAgentMemorySummary()}`);
        } catch (e) {
          await bot.sendMessage(chatId, `❌ role 업데이트 실패: ${String(e?.message ?? e)}`);
        }
        return true;
      }

      if (sub === "agents") {
        await sendLong(bot, chatId, formatAgentMemorySummary());
        return true;
      }

      if (sub === "note") {
        const value = memoryRest.slice(1).join(" ").trim();
        if (!value) {
          await bot.sendMessage(chatId, "Usage: /memory debug note <메모>");
          return true;
        }
        try {
          memory.addOperatorNote(value);
          await sendLong(bot, chatId, `✅ operator note 추가 완료.\n\n${formatMemorySummary()}`);
        } catch (e) {
          await bot.sendMessage(chatId, `❌ 메모 추가 실패: ${String(e?.message ?? e)}`);
        }
        return true;
      }

      if (sub === "lesson") {
        const value = memoryRest.slice(1).join(" ").trim();
        if (!value) {
          await bot.sendMessage(chatId, "Usage: /memory debug lesson <교훈>");
          return true;
        }
        try {
          memory.addRecentLesson(value);
          await sendLong(bot, chatId, `✅ recent lesson 추가 완료.\n\n${formatMemorySummary()}`);
        } catch (e) {
          await bot.sendMessage(chatId, `❌ 교훈 추가 실패: ${String(e?.message ?? e)}`);
        }
        return true;
      }

      await bot.sendMessage(chatId, ['Usage:', '/memory', '/memory debug show', '/memory debug md', '/memory debug kb', '/memory debug topology', '/memory debug pressure', '/memory debug evidence', '/memory debug review', '/memory debug materialize-preview', '/memory debug modules', '', '수정/승인/삭제/편집은 GoC에서 처리하세요.'].join('\n'));
      return true;
    }

    if (cmd === "/gptdone") {
      if (!isChatGptManualFallbackEnabled()) {
        await bot.sendMessage(chatId, "legacy ChatGPT paste 모드는 비활성화되어 있어요. 직접 실행은 CHATGPT_PROVIDER_BRIDGE=codex를 사용하세요.");
        return true;
      }
      clearAwait(chatId);
      await bot.sendMessage(chatId, "✅ gpt paste 모드를 종료했어요.");
      return true;
    }

    if (cmd === "/models" || cmd === "/modelnodes") {
      const sub = String(rest[0] || '').trim().toLowerCase();
      if (sub === 'route' || sub === 'pick' || sub === 'select') {
        const knownRoles = new Set(['planner', 'researcher', 'builder', 'reviewer', 'verifier', 'synthesizer', 'operator', 'risk_reviewer']);
        const maybeRole = String(rest[1] || '').trim().toLowerCase();
        const roleId = knownRoles.has(maybeRole) ? maybeRole : 'researcher';
        const goal = knownRoles.has(maybeRole) ? rest.slice(2).join(' ').trim() : rest.slice(1).join(' ').trim();
        if (!goal) {
          await bot.sendMessage(chatId, 'Usage: /models route [role] <목표>');
          return true;
        }
        const nodes = listModelNodes({ includeDisabled: false });
        if (!nodes.length) {
          await bot.sendMessage(chatId, '등록된 model node가 없습니다. config/model_nodes.json 또는 OLLAMA_BASE_URL + OLLAMA_MODEL 환경변수로 추가하세요.');
          return true;
        }
        const selection = selectModelNodeForTask({ nodes, roleId, taskText: goal, policy: 'cheapest_sufficient' });
        const lines = [`Model routing preview · role=${roleId}`];
        if (selection.selected) {
          lines.push(`selected: ${selection.selected.label || selection.selected.id} · ${selection.selected.provider}/${selection.selected.model}`);
          lines.push(`score=${selection.fit?.score ?? '-'} reasons=${(selection.fit?.reasons || []).join(', ') || '-'}`);
        }
        lines.push('', 'ranked:');
        selection.ranked.slice(0, 8).forEach((fit, index) => {
          lines.push(`${index + 1}. ${fit.node_id || fit.model} · score=${fit.score} · ${fit.executable ? 'executable' : 'limited'} · ${(fit.reasons || []).join(', ') || '-'}`);
        });
        await sendLong(bot, chatId, lines.join('\n'));
        return true;
      }
      if (sub === 'refresh') {
        try {
          const result = await refreshModelCatalog({ force: true, reason: 'telegram_models_refresh', logger: console });
          if (result.skipped) {
            await bot.sendMessage(chatId, `Model catalog refresh skipped: ${result.reason || 'unknown'}`);
            return true;
          }
          const payload = result.payload || {};
          const lines = [`Model catalog refreshed · nodes=${payload.nodes?.length || 0}`, `output=${result.outputPath || '-'}`, ''];
          for (const entry of payload.discovery_results || []) {
            lines.push(`- ${entry.label}: ${entry.ok ? 'ok' : 'failed'} · count=${entry.count || 0}${entry.error ? ` · ${entry.error}` : ''}`);
          }
          await sendLong(bot, chatId, lines.join('\n'));
        } catch (error) {
          await bot.sendMessage(chatId, `Model catalog refresh 실패: ${String(error?.message || error).slice(0, 400)}`);
        }
        return true;
      }
      if (sub === 'discover') {
        const kind = String(rest[1] || 'ollama').trim().toLowerCase();
        const url = String(rest[2] || process.env.OLLAMA_BASE_URL || '').trim();
        const trustArg = String(rest[3] || 'trusted').trim().toLowerCase();
        const trustedContext = !['untrusted', 'public', 'external', 'false', '0', 'no'].includes(trustArg);
        try {
          const common = { timeoutMs: Number(process.env.MODEL_NODE_DISCOVERY_TIMEOUT_MS || process.env.CLI_MODEL_DISCOVERY_TIMEOUT_MS || 12000) || 12000, maxModels: Number(process.env.MODEL_NODE_DISCOVERY_MAX_MODELS || 20) || 20 };
          const result = kind === 'ollama'
            ? await discoverOllamaModelNodes({ baseUrl: url, trustedContext, timeoutMs: common.timeoutMs, maxModels: common.maxModels })
            : kind === 'codex'
              ? await discoverCodexCliModelNodes(common)
              : kind === 'gemini'
                ? await discoverGeminiCliModelNodes(common)
                : null;
          if (!result) {
            await bot.sendMessage(chatId, 'Usage: /models discover <ollama|codex|gemini> [url-for-ollama] [trusted|untrusted]');
            return true;
          }
          if (!result.ok) {
            await bot.sendMessage(chatId, `Model discovery 실패: ${result.error || result.status || 'unknown error'}`);
            return true;
          }
          const title = kind === 'ollama' ? `Ollama model discovery · ${url}` : `${kind} CLI model discovery`;
          const lines = [title, kind === 'ollama' ? `trusted_context=${trustedContext}` : 'source=/model best-effort parser', `models=${result.nodes.length}`, '', 'discovered node preview:'];
          result.nodes.slice(0, 12).forEach((node, index) => {
            lines.push(`${index + 1}. ${node.id} · ${node.provider}/${node.model}`);
            lines.push(`   - ${summarizeModelCatalogEntry(node)} · privacy=${node.privacy_profile?.tier || '-'} · boundary=${node.privacy_profile?.data_boundary || '-'}`);
          });
          lines.push('', '저장하려면 /models refresh 를 사용하거나 scripts/discover_model_nodes.js --kind <kind> 를 실행하세요.');
          await sendLong(bot, chatId, lines.join('\n'));
        } catch (error) {
          await bot.sendMessage(chatId, `Model discovery 실패: ${String(error?.message || error).slice(0, 400)}`);
        }
        return true;
      }
      if (sub === 'health') {
        const nodes = await listModelNodesWithHealth({ includeDisabled: true, timeoutMs: Number(process.env.MODEL_NODE_HEALTH_TIMEOUT_MS || 4000) || 4000 });
        if (!nodes.length) {
          await bot.sendMessage(chatId, "등록된 model node가 없습니다. config/model_nodes.json 또는 LOCAL_MODEL_BASE_URL + LOCAL_MODEL 환경변수로 추가할 수 있습니다.");
          return true;
        }
        const lines = ["Model node health:"];
        nodes.slice(0, 20).forEach((node, index) => {
          const h = node.health || {};
          lines.push(`${index + 1}. ${node.label || node.id} · ${node.provider}/${node.model} · ${h.ok ? "ok" : "not ready"} (${h.status || "-"})`);
          if (h.http_status) lines.push(`   - http=${h.http_status}`);
          if (h.error) lines.push(`   - error=${String(h.error).slice(0, 180)}`);
        });
        await sendLong(bot, chatId, lines.join("\n"));
        return true;
      }
      if (sub === 'usage') {
        const rows = readRecentModelNodeUsage({ limit: Number(rest[1] || 10) || 10 });
        if (!rows.length) {
          await bot.sendMessage(chatId, "최근 model node usage 기록이 없습니다.");
          return true;
        }
        const lines = ["Recent model node usage:"];
        rows.forEach((row, index) => {
          const node = row.model_node || {};
          lines.push(`${index + 1}. ${row.timestamp || "-"} · ${node.label || node.id || row.model || "-"} · ${row.ok ? "ok" : "fail"} · ${row.duration_ms || 0}ms`);
          const tokens = row.token_usage || {};
          const tokenSummary = tokens.total_tokens ? ` tokens=${tokens.total_tokens} (in=${tokens.prompt_tokens || '-'} out=${tokens.completion_tokens || '-'})` : '';
          lines.push(`   - agent=${row.agent_id || "-"} model=${row.model || "-"} prompt=${row.prompt_chars || 0} output=${row.output_chars || 0}${tokenSummary} trace=${row.trace_id || "-"}`);
          const access = row.context_access || {};
          if (access.projection_id || access.snapshot_id || access.memory_mode) {
            lines.push(`   - context projection=${access.projection_id || "-"} snapshot=${access.snapshot_id || "-"} memory=${access.memory_mode || "-"}`);
          }
        });
        await sendLong(bot, chatId, lines.join("\n"));
        return true;
      }
      const nodes = listModelNodes({ includeDisabled: true });
      if (!nodes.length) {
        await bot.sendMessage(chatId, "등록된 model node가 없습니다. config/model_nodes.json 또는 LOCAL_MODEL_BASE_URL + LOCAL_MODEL 환경변수로 추가할 수 있습니다.");
        return true;
      }
      const lines = ["Model nodes:", "Usage: /models refresh · /models health · /models usage [limit] · /models route [role] <goal> · /models discover <ollama|codex|gemini>"];
      nodes.slice(0, 20).forEach((node, index) => {
        const caps = Object.entries(node.capabilities || {}).filter(([, enabled]) => enabled === true).map(([key]) => key).slice(0, 6).join(", ") || "chat";
        const perms = [node.permissions?.memory_read ? "memory_read=" + node.permissions.memory_read : "", node.permissions?.memory_write ? "memory_write=" + node.permissions.memory_write : "", node.permissions?.workspace_read ? "workspace_read" : "", node.permissions?.workspace_write ? "workspace_write" : ""].filter(Boolean).join(", ") || "scoped_context";
        lines.push(`${index + 1}. ${node.label || node.id} · ${node.provider}/${node.model} · ${node.enabled === false ? "disabled" : "enabled"}`);
        lines.push(`   - node_id=${node.id} runtime=${node.runtime || "-"} location=${node.location || "-"}`);
        lines.push(`   - capabilities=${caps}`);
        lines.push(`   - permissions=${perms}`);
        const profiles = [node.cost_profile?.tier ? `cost=${node.cost_profile.tier}` : '', node.latency_profile?.tier ? `latency=${node.latency_profile.tier}` : '', node.quality_profile?.tier ? `quality=${node.quality_profile.tier}` : '', node.privacy_profile?.tier ? `privacy=${node.privacy_profile.tier}` : '', node.limits?.context_tokens ? `context=${node.limits.context_tokens}` : ''].filter(Boolean).join(', ');
        if (profiles) lines.push(`   - profiles=${profiles}`);
        if (node.model_catalog?.parameter_size || node.model_catalog?.quantization_level) lines.push(`   - catalog=${summarizeModelCatalogEntry(node)}`);
      });
      await sendLong(bot, chatId, lines.join("\n"));
      return true;
    }

    if (cmd === "/task") {
      const sub = String(rest[0] || '').trim().toLowerCase();
      const taskArgs = String(rawArgs || '').replace(/^\S+\s*/i, '').trim();
      const { jobId: currentJobId, jobDir } = getCurrentJobDirForChat(chatId);

      if (!sub || ['status', 'show', 'list'].includes(sub)) {
        const watchSummary = jobDir ? summarizeWatchTaskState(jobDir) : null;
        const roomProfile = getAgentRoomProfile(chatSessionStore, chatId);
        const pendingTask = getPendingTaskControl(chatId);
        const lines = ['Task / Loop status'];
        if (watchSummary) {
          lines.push(`- watch: ${watchSummary.status} · iteration ${watchSummary.current_iteration}/${watchSummary.max_iterations} · ${watchSummary.workflow_kind}`);
          if (watchSummary.required_passes?.length) lines.push(`- passes: ${watchSummary.required_passes.join(' → ')}`);
          if (watchSummary.approval_boundary) lines.push('- approval: risky/large changes require approval');
        } else {
          lines.push('- watch: no active persisted loop task');
        }
        if (pendingTask?.goal) lines.push(`- pending task goal: ${pendingTask.goal}`);
        lines.push('', formatAgentRoomProfile(roomProfile, { includeHelp: false }), '', TASK_HELP_TEXT);
        await sendLong(bot, chatId, lines.join('\n'));
        return true;
      }

      if (['help', 'more'].includes(sub)) {
        await sendLong(bot, chatId, TASK_HELP_TEXT);
        return true;
      }

      if (['pause', 'resume', 'stop', 'approve'].includes(sub)) {
        if (!jobDir) {
          await bot.sendMessage(chatId, '현재 active job이 없어 task 상태를 변경할 수 없습니다. /task loop <목표>로 작업을 먼저 시작하세요.');
          return true;
        }
        const statusMap = { pause: 'paused', resume: 'active', stop: 'stopped', approve: 'active' };
        const result = setWatchTaskStatus({
          jobDir,
          status: statusMap[sub],
          reason: sub === 'approve' ? 'telegram_task_approve' : `telegram_task_${sub}`,
          actor: String(userId || chatId || 'telegram_user'),
        });
        if (!result.ok) {
          await bot.sendMessage(chatId, `task 상태 변경 실패: ${result.reason || 'unknown'}`);
          return true;
        }
        await bot.sendMessage(chatId, `✅ task 상태를 ${statusMap[sub]} 로 변경했습니다.`);
        return true;
      }

      if (sub === 'loop' || sub === 'start' || sub === 'watch') {
        const rawLoopArgs = taskArgs || String(rawArgs || '').replace(/^(loop|start|watch)\s*/i, '').trim();
        return startBoundedLoopFromTelegram({ chatId, userId, msg, raw: rawLoopArgs, sourceCommand: '/task loop' });
      }


      await bot.sendMessage(chatId, `알 수 없는 /task 명령입니다.\n\n${TASK_HELP_TEXT}`);
      return true;
    }

    if (cmd === "/review") {
      const sub = String(rest[0] || '').trim().toLowerCase();
      const { jobDir } = getCurrentJobDirForChat(chatId);
      if (['help', 'more'].includes(sub)) {
        await bot.sendMessage(chatId, REVIEW_HELP_TEXT);
        return true;
      }
      if (sub === 'approve' || sub === 'reject') {
        if (!jobDir) {
          await bot.sendMessage(chatId, '현재 active job이 없어 승인/거절할 task를 찾지 못했습니다. GoC Review Inbox도 확인해 주세요.');
          return true;
        }
        const result = setWatchTaskStatus({
          jobDir,
          status: sub === 'approve' ? 'active' : 'paused',
          reason: sub === 'approve' ? 'telegram_review_approve' : `telegram_review_reject:${String(rawArgs || '').slice(0, 160)}`,
          actor: String(userId || chatId || 'telegram_user'),
        });
        await bot.sendMessage(chatId, result.ok
          ? `✅ review ${sub} 처리했습니다. 상태=${sub === 'approve' ? 'active' : 'paused'}`
          : `review 처리 실패: ${result.reason || 'unknown'}`);
        return true;
      }
      if (!jobDir) {
        await bot.sendMessage(chatId, `현재 active job이 없습니다.\n\n${REVIEW_HELP_TEXT}`);
        return true;
      }
      try {
        const reviewQueue = buildRuntimeReviewQueue({ jobDir, persist: true });
        const watch = readWatchTaskState(jobDir);
        const approvalLine = watch?.state?.status === 'awaiting_approval' || watch?.contract?.status === 'awaiting_approval'
          ? 'approval: 대기 중 · /review approve 또는 /review reject <reason>'
          : 'approval: 현재 대기 항목 없음';
        await sendLong(bot, chatId, [approvalLine, '', formatReviewQueueForTelegram(reviewQueue), '', REVIEW_HELP_TEXT].join('\n'));
      } catch (e) {
        await bot.sendMessage(chatId, `review 상태 조회 실패: ${String(e?.message ?? e)}`);
      }
      return true;
    }

    if (cmd === "/status") {
      const detailArg = String(rest[0] || '').trim().toLowerCase();
      const detail = ['full', 'detail', 'details', 'verbose'].includes(detailArg)
        ? 'full'
        : (['recent', 'activity', 'progress'].includes(detailArg)
          ? 'recent'
          : (['prompt', 'tokens', 'telemetry'].includes(detailArg) ? 'prompt' : 'compact'));
      await sendChatStatus(bot, chatId, { telegramUserId: userId, detail });
      return true;
    }

    if (cmd === "/agents") {
      const sub = String(rest[0] || '').trim().toLowerCase();
      const argsAfterSub = String(rawArgs || '').replace(/^\S+\s*/i, '').trim();
      const { runtime: runtimeForTeam } = await loadRuntimeForCurrentJob(chatId, userId, { includeContext: false });
      if (!sub || ['status', 'show', 'list'].includes(sub)) {
        await sendLong(bot, chatId, `${formatAgentRoomProfile(getAgentRoomProfile(chatSessionStore, chatId))}\n\n${AGENTS_HELP_TEXT}`);
        return true;
      }
      if (['help', 'more'].includes(sub)) {
        await sendLong(bot, chatId, AGENTS_HELP_TEXT);
        return true;
      }
      if (sub === 'suggest') {
        const goal = argsAfterSub;
        if (!goal) {
          await bot.sendMessage(chatId, 'Usage: /agents suggest <목표>');
          return true;
        }
        const { proposal, portfolio, roomProfile } = await suggestAndApplyAgentRoomTeam({
          chatId,
          userId,
          goal,
          runtimeForTeam,
          autoApply: false,
          preferPlannerProposal: true,
          workMode: 'team_task',
        });
        await sendLong(bot, chatId, [
          buildAgentRoomSuggestionMessage({ goal, profile: roomProfile }),
          '',
          formatAgentRoomPlannerDetails(proposal, { portfolio }),
        ].join('\n'));
        return true;
      }
      if (sub === 'use' || sub === 'set') {
        const roleText = argsAfterSub;
        const roles = normalizeRoomAgentRoles(roleText);
        if (!roles.length) {
          await bot.sendMessage(chatId, 'Usage: /agents use planner,builder,reviewer');
          return true;
        }
        const profile = buildAgentRoomProfile({ chatId, goal: `Use agent roles: ${roles.join(', ')}`, roles, source: 'telegram_agents_use' });
        upsertAgentRoomProfile(chatSessionStore, chatId, profile);
        let proposal = null;
        try {
          proposal = await createFreeformTeamConfigurationAdvanced({
            description: `Use this Agent Room roster for future tasks: ${roles.join(', ')}. Keep responsibilities distinct and route review/verification separately from implementation.`,
            runtime: runtimeForTeam,
            jobId: resolveLiveJobIdForChat(chatId),
          });
        } catch {
          proposal = suggestTeamConfiguration({ taskText: `Use agent roles: ${roles.join(', ')}`, runtime: runtimeForTeam });
        }
        storePendingTeam(chatSessionStore, chatId, proposal);
        let applied = null;
        try { applied = await applyPendingTeam({ sessionStore: chatSessionStore, chatId, runtime: runtimeForTeam }); } catch {}
        await sendLong(bot, chatId, [
          '✅ Agent Room 기본 역할을 적용했습니다.',
          '',
          formatAgentRoomProfile(profile, { includeHelp: false }),
          '',
          applied ? 'team: active team에도 적용됨' : 'team: pending team으로 저장됨. 필요하면 /team apply 를 사용하세요.',
        ].join('\n'));
        return true;
      }

      if (sub === 'export' || sub === 'package-export') {
        const pkg = buildAgentPackageFromSession({ sessionStore: chatSessionStore, chatId, title: argsAfterSub });
        const saved = saveAgentPackageToRegistry(pkg);
        await sendLong(bot, chatId, [
          '✅ Agent package를 생성하고 local registry에 저장했습니다.',
          '',
          formatAgentPackage(saved.package, { detail: true }),
          '',
          'JSON:',
          '```json',
          JSON.stringify(saved.package, null, 2),
          '```',
        ].join('\n'));
        return true;
      }
      if (sub === 'publish-candidate' || sub === 'publish' || sub === 'share') {
        const pkg = buildAgentPackageFromSession({
          sessionStore: chatSessionStore,
          chatId,
          title: argsAfterSub || '',
          visibility: 'private_review',
        });
        const candidate = sanitizeAgentPackage({
          ...pkg,
          visibility: 'private_review',
          publish_state: 'candidate',
          review_notes: [
            'Private memory is not copied; clones start with fresh private memory.',
            'Credential bindings and provider state are never copied.',
            'Knowledge packs must be attached separately if public reusable content is needed.',
          ],
        });
        const saved = saveAgentPackageToRegistry(candidate);
        await sendLong(bot, chatId, [
          '📦 Agent package publish candidate를 만들었습니다.',
          '',
          formatAgentPackage(saved.package, { detail: true }),
          '',
          '다른 채팅방에서 사용:',
          `/agents clone ${saved.package.package_id}`,
        ].join('\n'));
        return true;
      }
      if (['packages', 'registry', 'list-packages'].includes(sub)) {
        const registry = readAgentPackageRegistry();
        await sendLong(bot, chatId, formatAgentPackageRegistry(registry));
        return true;
      }
      if (sub === 'package' || sub === 'show-package') {
        const packageId = String(argsAfterSub || '').trim();
        if (!packageId) {
          await bot.sendMessage(chatId, 'Usage: /agents package <package_id>');
          return true;
        }
        const pkg = findAgentPackage(packageId);
        if (!pkg) {
          await bot.sendMessage(chatId, `agent package를 찾지 못했습니다: ${packageId}`);
          return true;
        }
        await sendLong(bot, chatId, formatAgentPackage(pkg, { detail: true }));
        return true;
      }
      if (sub === 'clone' || sub === 'install' || sub === 'import') {
        const rawInput = String(argsAfterSub || '').trim();
        if (!rawInput) {
          await bot.sendMessage(chatId, 'Usage: /agents clone <package_id|package_json>');
          return true;
        }
        let pkg = null;
        if (rawInput.startsWith('{')) {
          try { pkg = sanitizeAgentPackage(JSON.parse(rawInput)); } catch (error) {
            await bot.sendMessage(chatId, `package JSON 파싱 실패: ${String(error?.message || error).slice(0, 200)}`);
            return true;
          }
        } else {
          pkg = findAgentPackage(rawInput);
        }
        if (!pkg) {
          await bot.sendMessage(chatId, `agent package를 찾지 못했습니다: ${rawInput}`);
          return true;
        }
        const installed = await installAgentPackageToSession({
          sessionStore: chatSessionStore,
          chatId,
          agentPackage: pkg,
          runtime: runtimeForTeam,
          applyState: 'pending',
          source: 'telegram_agents_clone',
        });
        await sendLong(bot, chatId, [
          '✅ Agent package를 이 채팅방에 설치했습니다. source private memory는 복사하지 않았고, 새 room memory로 시작합니다.',
          '',
          formatAgentPackage(installed.package, { detail: false }),
          '',
          '적용 상태: pending team으로 저장됨. 바로 활성화하려면 /team apply 또는 /agents use <roles>를 사용하세요.',
        ].join('\n'));
        return true;
      }
      if (sub === 'reset') {
        upsertAgentRoomProfile(chatSessionStore, chatId, { status: 'reset', default_agents: [], default_workflow: 'task_adaptive', current_goal: '', reasons: [], source: 'telegram_agents_reset' });
        await resetTeamConfiguration(chatSessionStore, chatId, { runtime: runtimeForTeam }).catch(() => null);
        await bot.sendMessage(chatId, '✅ Agent Room 설정을 초기화했습니다. /agents suggest <목표> 또는 /task loop <목표>로 다시 시작하세요.');
        return true;
      }
      await bot.sendMessage(chatId, `알 수 없는 /agents 명령입니다.\n\n${AGENTS_HELP_TEXT}`);
      return true;
    }

    if (cmd === "/team") {
      const sub = String(rest[0] || "").trim().toLowerCase();
      let teamState = getSessionTeamState(chatSessionStore, chatId);
      const currentJobId = resolveLiveJobIdForChat(chatId);
      let runtimeForTeam = null;
      if (currentJobId && typeof loadSupervisorRuntime === 'function') {
        try {
          runtimeForTeam = await loadSupervisorRuntime(currentJobId, { telegramUserId: userId, includeContext: false, includeGlobal: false });
        } catch {}
      }
      if (runtimeForTeam) {
        await hydrateSessionTeamStateFromConversationStore({ sessionStore: chatSessionStore, chatId, runtime: runtimeForTeam }).catch(() => null);
        teamState = getSessionTeamState(chatSessionStore, chatId);
      }
      if (!sub) {
        await bot.sendMessage(chatId, ['Advanced team topology (/agents 권장)', '', buildCompactTeamStatusMessage(teamState, { chatId, runtime: runtimeForTeam })].join('\n'));
        return true;
      }
      if (!isTeamControlSubcommand(sub)) {
        const goal = String(rawArgs || '').trim();
        if (!goal) {
          await bot.sendMessage(chatId, 'Usage: /team <goal>');
          return true;
        }
        const { activeTeam, roomProfile } = await suggestAndApplyAgentRoomTeam({
          chatId,
          userId,
          goal,
          runtimeForTeam,
          autoApply: true,
          preferPlannerProposal: true,
          workMode: 'team_task',
        });
        setPendingTaskControl(chatId, {
          goal,
          command: '/team',
          team_roles: roomProfile.default_agents,
          source: 'telegram_team_review',
        });
        if (roomProfile.setup_only) {
          await sendLong(bot, chatId, [
            '👥 /team accepted: specialized room prepared.',
            `room: ${roomProfile.name || 'AI Work Room'}`,
            `domain: ${roomProfile.domain_label || 'general'}`,
            `agents: ${(roomProfile.default_agents || []).join(', ') || '-'}`,
            '',
            'setup-only request로 판단했기 때문에 아직 실행하지 않습니다.',
            '다음 메시지에 실제 줄거리/사진/티커/연구 아이디어/작업 입력을 주면 이 room 설정으로 진행합니다.',
            '',
            'ROOM.md를 보려면 /room manual 을 사용하세요.',
          ].join('\n'));
          return true;
        }
        await sendLong(bot, chatId, [
          '👥 /team accepted: running a team-review attempt.',
          `room: ${roomProfile.name || 'AI Work Room'}`,
          `agents: ${(roomProfile.default_agents || []).join(', ') || '-'}`,
          'policy: one team pass with review/synthesis; user remains in control.',
        ].join('\n'));
        const teamMessage = [
          'CONTROL PLANE TASK: Run a team-review attempt for the following goal.',
          'Work depth: team_task',
          `Agent room roles: ${(roomProfile.default_agents || []).join(', ')}`,
          '',
          goal,
        ].join('\n');
        await enqueueWorkbenchInput({ chatId, userId, msg, text: teamMessage, kind: 'team_task', teamConfig: activeTeam || null, ackAlreadySent: true });
        return true;
      }
      if (sub === 'help') {
        await bot.sendMessage(chatId, TEAM_CORE_HELP_TEXT);
        return true;
      }
      if (sub === 'details' || sub === 'status') {
        await sendLong(bot, chatId, `${buildTeamStatusOverview(teamState, { chatId, runtime: runtimeForTeam })}

${TEAM_CORE_HELP_TEXT}`);
        return true;
      }
      if (sub === 'more') {
        await sendLong(bot, chatId, TEAM_ADVANCED_HELP_TEXT);
        return true;
      }
      if (sub === 'suggest') {
        const goal = String(rawArgs.replace(/^suggest\s+/i, '') || '').trim();
        if (!goal) {
          await bot.sendMessage(chatId, 'Usage: /team suggest [--fast|--template|--mode freeform] <목적>');
          return true;
        }
        const freeformMatch = goal.match(/^--mode\s+freeform\s+([\s\S]+)$/i);
        const fastMatch = goal.match(/^--(?:fast|template|heuristic)\s+([\s\S]+)$/i);
        const effectiveGoal = String(freeformMatch?.[1] || fastMatch?.[1] || goal).trim();
        const useHeuristicTemplate = Boolean(fastMatch);
        if (!useHeuristicTemplate) {
          await bot.sendMessage(chatId, 'LLM planner를 우선 시도하고, 사용할 수 없으면 heuristic fallback으로 team 초안을 구성합니다. 빠른 템플릿 모드는 /team suggest --fast <목적> 을 사용하세요.');
        }
        let proposal;
        try {
          proposal = useHeuristicTemplate
            ? suggestTeamConfiguration({ taskText: effectiveGoal, runtime: runtimeForTeam })
            : {
                ...(await createFreeformTeamConfigurationAdvanced({ description: effectiveGoal, runtime: runtimeForTeam, jobId: currentJobId })),
                proposal_mode: 'suggest',
              };
        } catch (error) {
          proposal = {
            ...suggestTeamConfiguration({ taskText: effectiveGoal, runtime: runtimeForTeam }),
            planner_metadata: {
              planner_type: 'heuristic_rule_based',
              planning_source: 'telegram_suggest_exception_fallback',
              reasoning_summary: [String(error?.message || error || 'LLM planner failed').slice(0, 180)],
            },
          };
        }
        const fallbackProposal = suggestTeamConfiguration({ taskText: effectiveGoal, runtime: runtimeForTeam });
        const portfolio = buildTeamSelectionPortfolio({ taskText: effectiveGoal, runtime: runtimeForTeam, primaryTeam: proposal, fallbackTeam: fallbackProposal, activeTeam: teamState.active_team });
        proposal = portfolio.selected_team || proposal;
        storePendingTeam(chatSessionStore, chatId, proposal, { portfolio });
        await sendLong(bot, chatId, `${formatTeamProposalMessage(proposal, { runtime: runtimeForTeam })}

${formatTeamCandidatePortfolioMessage(portfolio)}`);
        return true;
      }
      if (sub === 'create') {
        const description = String(rawArgs.replace(/^create\s+/i, '') || '').trim();
        if (!description) {
          await bot.sendMessage(chatId, 'Usage: /team create <자연어 팀 설명>\n\n더 많은 옵션: /team more');
          return true;
        }
        await bot.sendMessage(chatId, '해당 요청에 맞는 팀 구성을 진행합니다. LLM planner를 사용할 수 없으면 fallback 경로를 사용합니다.');
        let proposal;
        try {
          proposal = await createFreeformTeamConfigurationAdvanced({ description, runtime: runtimeForTeam, jobId: currentJobId });
        } catch (error) {
          proposal = {
            ...createFreeformTeamConfiguration({ description, runtime: runtimeForTeam }),
            planner_metadata: {
              planner_type: 'heuristic_rule_based',
              planning_source: 'telegram_create_exception_fallback',
              reasoning_summary: [String(error?.message || error || 'LLM planner failed').slice(0, 180)],
            },
          };
        }
        const fallbackProposal = createFreeformTeamConfiguration({ description, runtime: runtimeForTeam });
        const portfolio = buildTeamSelectionPortfolio({ taskText: description, runtime: runtimeForTeam, primaryTeam: proposal, fallbackTeam: fallbackProposal, activeTeam: teamState.active_team });
        proposal = portfolio.selected_team || proposal;
        storePendingTeam(chatSessionStore, chatId, proposal, { portfolio });
        await sendLong(bot, chatId, `${formatTeamProposalMessage(proposal, { runtime: runtimeForTeam })}

${formatTeamCandidatePortfolioMessage(portfolio)}`);
        return true;
      }
      if (sub === 'refine') {
        const instruction = String(rawArgs.replace(/^refine\s+/i, '') || '').trim();
        const baseTeam = teamState.pending_team || teamState.active_team;
        if (!baseTeam) {
          await bot.sendMessage(chatId, '수정할 팀이 없습니다. 먼저 /team suggest <목적> 또는 /team create <자연어 팀 설명> 을 실행해 주세요.');
          return true;
        }
        if (!instruction) {
          await bot.sendMessage(chatId, 'Usage: /team refine <자연어 수정>\n\n더 많은 옵션: /team more');
          return true;
        }
        await bot.sendMessage(chatId, '기존 팀 구성을 바탕으로 수정안을 다시 설계합니다. LLM planner를 사용할 수 없으면 fallback 경로를 사용합니다.');
        let next;
        try {
          next = await refineTeamConfigurationAdvanced({ team: baseTeam, instruction, runtime: runtimeForTeam, jobId: currentJobId });
        } catch (error) {
          next = {
            ...refineTeamConfiguration(baseTeam, instruction, { runtime: runtimeForTeam }),
            planner_metadata: {
              planner_type: 'heuristic_rule_based',
              planning_source: 'telegram_refine_exception_fallback',
              reasoning_summary: [String(error?.message || error || 'LLM planner failed').slice(0, 180)],
            },
          };
        }
        const fallbackNext = refineTeamConfiguration(baseTeam, instruction, { runtime: runtimeForTeam });
        const portfolio = buildTeamSelectionPortfolio({ taskText: `${baseTeam.task_brief || baseTeam.design_prompt || ''}
Refine: ${instruction}`, runtime: runtimeForTeam, primaryTeam: next, fallbackTeam: fallbackNext, activeTeam: teamState.active_team });
        next = portfolio.selected_team || next;
        storePendingTeam(chatSessionStore, chatId, next, { portfolio });
        await sendLong(bot, chatId, `${formatTeamProposalMessage(next, { runtime: runtimeForTeam })}

${formatTeamCandidatePortfolioMessage(portfolio)}`);
        return true;
      }

      const handledTeamManifestSubcommand = await handleTelegramTeamBlueprintSubcommand({
        sub,
        rest,
        rawArgs,
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
      });
      if (handledTeamManifestSubcommand) return true;
      // legacy team blueprint subcommand handlers were removed.
      // /team proposal|install-plan|requirements|export|publish|library|clone|fork|install|import|pull|push are handled only by handleTelegramTeamBlueprintSubcommand.
      if (sub === 'template') {
        await bot.sendMessage(chatId, TEAM_TEMPLATE_DEPRECATED_TEXT);
        return true;
      }
      if (sub === 'debug') {
        const debugArg = String(rawArgs.replace(/^debug\s*/i, '') || '').trim();
        if (!debugArg) {
          await bot.sendMessage(chatId, TEAM_DEBUG_HELP_TEXT);
          return true;
        }
        if (/^(templates?|template\s+(?:catalog|benchmarks?))$/i.test(debugArg)) {
          await sendLong(bot, chatId, buildBenchmarkTemplateCatalogText());
          return true;
        }
        if (/^template\s+current$/i.test(debugArg)) {
          const baseTeam = teamState.pending_team || teamState.active_team;
          if (!baseTeam) {
            await bot.sendMessage(chatId, '출력할 team이 없습니다. 먼저 /team suggest <목적> 또는 /team create <설명> 으로 pending team을 만든 뒤 다시 시도하세요.');
            return true;
          }
          await sendLong(bot, chatId, buildTeamConfigurationTemplate(baseTeam));
          return true;
        }
        const match = debugArg.match(/^template\s+(?:benchmark|bench)\s+([a-z0-9_.-]+)$/i);
        if (match) {
          const bench = buildBenchmarkTeamTemplate(match[1], {});
          if (!bench) {
            await bot.sendMessage(chatId, `알 수 없는 benchmark template: ${String(match[1] || '')}. /team debug templates 로 목록을 확인하세요.`);
            return true;
          }
          const validated = validateTeamConfiguration({ ...bench, proposal_mode: 'suggest' }, { runtime: runtimeForTeam });
          storePendingTeam(chatSessionStore, chatId, validated);
          await sendLong(bot, chatId, `✅ debug benchmark template을 pending team으로 불러왔습니다.

${formatTeamProposalMessage(validated, { runtime: runtimeForTeam })}`);
          return true;
        }
        await bot.sendMessage(chatId, TEAM_DEBUG_HELP_TEXT);
        return true;
      }
      if (sub === 'validate') {
        const payload = String(rawArgs.replace(/^validate\s+/i, '') || '').trim();
        if (!payload) {
          await bot.sendMessage(chatId, 'Usage: /team validate <JSON template>');
          return true;
        }
        try {
          const parsed = parseTeamTemplate(payload);
          const validated = validateTeamConfiguration(parsed, { runtime: runtimeForTeam });
          storePendingTeam(chatSessionStore, chatId, validated);
          await sendLong(bot, chatId, `✅ 팀 템플릿 검증 완료

${formatTeamProposalMessage(validated, { runtime: runtimeForTeam })}`);
        } catch (e) {
          await bot.sendMessage(chatId, `❌ 팀 템플릿 검증 실패: ${String(e?.message ?? e)}`);
        }
        return true;
      }
      if (sub === 'apply') {
        try {
          const applyArgs = String(rawArgs || '').replace(/^apply\b/i, '').trim();
          const confirmApply = /(?:^|\s)confirm(?:\s|$)/i.test(applyArgs);
          const applySelector = applyArgs.replace(/\bconfirm\b/i, '').trim();
          if (applySelector) {
            const selected = selectPendingTeamCandidate(chatSessionStore, chatId, applySelector, { runtime: runtimeForTeam });
            teamState = getSessionTeamState(chatSessionStore, chatId);
            await sendLong(bot, chatId, `✅ team candidate ${applySelector}를 pending team으로 선택했습니다.

${formatTeamCandidatePortfolioMessage(selected.portfolio)}`);
          }
          const activeTeam = teamState?.active_team || null;
          const pendingTeam = teamState?.pending_team || null;
          const requiresApproval = teamConfigChangeRequiresApproval(activeTeam, pendingTeam);
          if (requiresApproval && !confirmApply) {
            const guardrails = buildTeamTransitionGuardrails(activeTeam, pendingTeam);
            await sendLong(bot, chatId, [
              '⚠️ team 변경 적용 전 승인 확인이 필요합니다.',
              '현재 active team과 다른 pending team이 준비되어 있습니다.',
              ...(guardrails?.warning_count > 0 ? formatTeamTransitionGuardrailLines(guardrails, { maxWarnings: 5 }) : []),
              '',
              '승인하려면 /team apply confirm',
              '검토하려면 /team details',
            ].filter(Boolean).join('\n'));
            return true;
          }
          const applied = await applyPendingTeam({ sessionStore: chatSessionStore, chatId, runtime: runtimeForTeam });
          await sendLong(bot, chatId, `✅ 활성 팀 적용 완료

${buildTeamListMessage({ active_team: applied }, { runtime: runtimeForTeam })}`);
        } catch (e) {
          await bot.sendMessage(chatId, `❌ 팀 적용 실패: ${String(e?.message ?? e)}`);
        }
        return true;
      }
      if (sub === 'options') {
        const portfolio = teamState?.pending_team_portfolio;
        if (portfolio) {
          await sendLong(bot, chatId, formatTeamCandidatePortfolioMessage(portfolio, { verbose: true }));
        } else {
          await sendLong(bot, chatId, buildTeamSchemaOptionsText());
        }
        return true;
      }
      if (sub === 'roles' || sub === 'patterns' || sub === 'schema') {
        await sendLong(bot, chatId, buildTeamSchemaOptionsText());
        return true;
      }
      if (sub === 'modes') {
        await sendLong(bot, chatId, [
          'Team composition modes:',
          '- LLM planner: /team suggest <목적>',
          '  canonical role/skill/model 후보를 안전하게 조합합니다.',
          '- freeform: /team create <자연어 팀 설명>',
          '  더 자유로운 agent 이름/책임/상호작용을 제안한 뒤 structured contract로 정규화합니다.',
          '- fast template: /team suggest --fast <목적>',
        ].join('\n'));
        return true;
      }

      if (sub === 'reset') {
        await resetTeamConfiguration(chatSessionStore, chatId, { runtime: runtimeForTeam });
        await bot.sendMessage(chatId, '✅ 팀 구성을 초기화했습니다. 다시 /team suggest <목적> 또는 /team create <자연어 팀 설명> 으로 시작해 주세요.');
        return true;
      }
      await bot.sendMessage(chatId, `알 수 없는 /team 명령입니다.\n\n${TEAM_CORE_HELP_TEXT}`);
      return true;
    }

    if (cmd === "/credential") {
      return handleTelegramCredentialCommand({
        bot,
        chatId,
        rawArgs,
        chatSessionStore,
        resolveLiveJobIdForChat,
        jobs,
        loadSupervisorRuntime,
        userId,
        runSupervisorChat,
        normalizeForceMode,
        chatType: msg?.chat?.type || '',
        telegramMessageId: msg?.message_id ?? null,
      });
    }


    if (cmd === "/context") {
      const raw = String(args || '').trim();
      const [subRaw, ...subRest] = raw.split(/\s+/);
      const sub = String(subRaw || '').trim().toLowerCase();
      const companionContextMode = normalizeContextMode(sub);
      if (companionContextMode) {
        if (companionContextMode === 'exclude') {
          const label = subRest.join(' ').trim();
          if (!label) {
            await bot.sendMessage(chatId, 'Usage: /context exclude <source-or-assumption>');
            return true;
          }
          appendCompanionControlEvent(chatId, userId, {
            event_type: 'context_override',
            context_mode: 'exclude',
            excluded_sources: [label],
            command: '/context exclude',
            source: 'telegram_companion_command',
          });
          await bot.sendMessage(chatId, `✅ context에서 제외했습니다: ${label}
확인: /companion profile`);
          return true;
        }
        appendCompanionControlEvent(chatId, userId, {
          event_type: 'context_override',
          context_mode: companionContextMode,
          command: `/context ${companionContextMode}`,
          source: 'telegram_companion_command',
        });
        const label = companionContextMode === 'project-only'
          ? 'project-only: project-scoped sources 중심으로 사용하고 unrelated/global memory는 피합니다.'
          : companionContextMode === 'clean-slate'
            ? 'clean-slate: 기존 memory/context를 배제하고 이번 요청 중심으로 답합니다.'
            : 'reset: companion context override를 초기화했습니다.';
        await bot.sendMessage(chatId, `✅ context mode 설정: ${label}
확인: /companion profile`);
        return true;
      }
      const payload = raw.slice(subRaw ? subRaw.length : 0).trim();
      const currentJobId = resolveLiveJobIdForChat(chatId);
      const contextOptions = { rootDir: process.cwd(), jobId: currentJobId || '' };
      try {
        if (!raw || ['summary', 'status', 'help'].includes(sub)) {
          await sendLong(bot, chatId, formatContextSubstrateSummary(summarizeContextSubstrate(contextOptions)));
          return true;
        }
        if (sub === 'ops' || sub === 'operations') {
          const limit = Number(subRest[0]) || 20;
          await sendLong(bot, chatId, JSON.stringify({ kind: 'context_operations_tail_v1', operations: listContextOperations(contextOptions, { limit }) }, null, 2));
          return true;
        }
        if (sub === 'proposals' || sub === 'pending') {
          const limit = Number(subRest[0]) || 20;
          await sendLong(bot, chatId, JSON.stringify({ kind: 'context_proposals_tail_v1', proposals: listContextOperations(contextOptions, { limit, proposals: true }) }, null, 2));
          return true;
        }
        if (sub === 'projection' || sub === 'prompt') {
          const role = subRest[0] || '';
          const taskType = subRest[1] || '';
          const goal = subRest.slice(2).join(' ');
          const projection = getContextProjection(contextOptions, { role, task_type: taskType, goal, limit: 24 });
          await sendLong(bot, chatId, JSON.stringify(projection, null, 2));
          return true;
        }
        if (sub === 'commit' || sub === 'write') {
          const result = commitContextWriteIntent(JSON.parse(payload), contextOptions);
          await sendLong(bot, chatId, JSON.stringify(result, null, 2));
          return true;
        }
        if (sub === 'mirror-board') {
          const result = mirrorSemanticBoardToContextSubstrate(contextOptions);
          await sendLong(bot, chatId, `Context substrate mirror complete. committed=${result.committed}; proposals=${result.proposals}; board cards=${result.board_card_count}; board links=${result.board_link_count}`);
          return true;
        }
        if (sub === 'mirror-to-board') {
          const result = mirrorContextSubstrateToSemanticBoard(contextOptions);
          await sendLong(bot, chatId, `Semantic Board mirror from context complete. cards=${result.cards}; links=${result.links}`);
          return true;
        }
        if (sub === 'compact' || sub === 'snapshot') {
          const result = compactContextSubstrate(contextOptions);
          await sendLong(bot, chatId, `Context substrate snapshot created: ${result.snapshot_id} · version=${result.version} · atoms=${result.atom_count} · links=${result.link_count}`);
          return true;
        }
        await sendLong(bot, chatId, [
          'Context commands:',
          '- /context',
          '- /context ops [limit]',
          '- /context proposals [limit]',
          '- /context projection [role] [task_type] [goal]',
          '- /context commit <json-intent>',
          '- /context mirror-board',
          '- /context mirror-to-board',
          '- /context compact',
        ].join('\n'));
        return true;
      } catch (error) {
        await bot.sendMessage(chatId, `Context Substrate error: ${error?.message || error}`);
        return true;
      }
    }

    if (cmd === "/board") {
      const raw = String(args || '').trim();
      const [subRaw, ...subRest] = raw.split(/\s+/);
      const sub = String(subRaw || '').trim().toLowerCase();
      const payload = raw.slice(subRaw ? subRaw.length : 0).trim();
      const currentJobId = resolveLiveJobIdForChat(chatId);
      const boardOptions = { rootDir: process.cwd(), jobId: currentJobId || '' };
      try {
        if (!raw || ['summary', 'status', 'help'].includes(sub)) {
          mirrorLocalSkillCatalogToSemanticBoard(boardOptions);
          await sendLong(bot, chatId, formatSemanticBoardSummary(readSemanticBoard(boardOptions)));
          return true;
        }
        if (['cards', 'list'].includes(sub)) {
          const maybeLimit = Number(subRest[0]);
          const type = Number.isFinite(maybeLimit) ? subRest[1] : subRest[0];
          const limit = Number.isFinite(maybeLimit) ? maybeLimit : 20;
          mirrorLocalSkillCatalogToSemanticBoard(boardOptions);
          await sendLong(bot, chatId, formatSemanticBoardCards(readSemanticBoard(boardOptions), { limit, type }));
          return true;
        }
        if (sub === 'validate' || sub === 'check') {
          mirrorLocalSkillCatalogToSemanticBoard(boardOptions);
          const { validation } = validateSemanticBoardStore(boardOptions);
          await sendLong(bot, chatId, formatSemanticBoardValidation(validation));
          return true;
        }
        if (sub === 'repair') {
          mirrorLocalSkillCatalogToSemanticBoard(boardOptions);
          const result = repairSemanticBoardStore(boardOptions);
          await sendLong(bot, chatId, formatSemanticBoardRepair(result));
          return true;
        }
        if (sub === 'consistency') {
          const board = readSemanticBoard(boardOptions);
          const store = readSkillRulePerformanceStore({ rootDir: process.cwd() });
          const report = buildSemanticBoardConsistencyReport({ board, performanceStore: store });
          await sendLong(bot, chatId, JSON.stringify(report, null, 2));
          return true;
        }
        if (sub === 'export') {
          const board = readSemanticBoard(boardOptions);
          await sendLong(bot, chatId, JSON.stringify({ kind: 'semantic_board_export_v1', cards: board.cards, links: board.links }, null, 2));
          return true;
        }
        if (sub === 'projection' || sub === 'prompt') {
          const board = readSemanticBoard(boardOptions);
          const types = subRest.join(' ').split(',').map((v) => v.trim()).filter(Boolean);
          await sendLong(bot, chatId, JSON.stringify(buildPromptProjectionFromBoard(board, { cardTypes: types }), null, 2));
          return true;
        }
        if (sub === 'import') {
          const result = importSemanticBoardSource(payload, boardOptions);
          await sendLong(bot, chatId, [
            'Semantic Board import complete.',
            `- cards imported: ${result.cards_imported}`,
            `- links imported: ${result.links_imported}`,
            `- total cards: ${result.board?.card_count ?? 0}`,
          ].join('\n'));
          return true;
        }
        if (sub === 'mirror') {
          const store = readSkillRulePerformanceStore({ rootDir: process.cwd() });
          const skillResult = mirrorLocalSkillCatalogToSemanticBoard(boardOptions);
          const result = mirrorSkillPerformanceToSemanticBoard(store, boardOptions);
          await sendLong(bot, chatId, `Semantic Board mirror complete. skill cards=${skillResult.upserted}; performance cards=${result.upserted}`);
          return true;
        }
        await sendLong(bot, chatId, [
          'Board commands:',
          '- /board',
          '- /board cards [limit] [type]',
          '- /board export',
          '- /board import <path|json>',
          '- /board projection [card_type,...]',
          '- /board mirror',
          '- /board validate',
          '- /board repair',
          '- /board consistency',
        ].join('\n'));
        return true;
      } catch (error) {
        await bot.sendMessage(chatId, `Semantic Board error: ${error?.message || error}`);
        return true;
      }
    }

    if (cmd === "/skill" || cmd === "/skills") {
      const raw = String(args || '').trim();
      const [subRaw, ...subRest] = raw.split(/\s+/);
      const sub = String(subRaw || '').trim().toLowerCase();
      const payload = raw.slice(subRaw ? subRaw.length : 0).trim();
      if (!raw || ['help', 'status'].includes(sub)) {
        await sendLong(bot, chatId, [
          'Skill commands:',
          '- /skill list: local skill catalog 보기',
          '- /skill score: skill/rule performance score 보기',
          '- /skill import <path|json>: 외부 skill/rule package import',
          '- /skill auto on|off: score 기반 자동 skill 선택 on/off',
          '',
          '기존 roster/agent skill 요약은 /skills roster 를 사용하세요.',
        ].join('\n'));
        return true;
      }
      if (['list', 'catalog', 'installed'].includes(sub)) {
        await sendLong(bot, chatId, formatLocalSkillCatalogMessage({ rootDir: process.cwd() }));
        return true;
      }
      if (['score', 'scores', 'performance', 'perf'].includes(sub)) {
        const store = readSkillRulePerformanceStore({ rootDir: process.cwd() });
        await sendLong(bot, chatId, formatSkillRulePerformanceSummary(store));
        return true;
      }
      if (sub === 'auto') {
        const value = String(subRest[0] || '').trim().toLowerCase();
        const enabled = !['off', 'false', '0', 'disable', 'disabled'].includes(value);
        setSkillAutoActivation(chatId, enabled);
        await bot.sendMessage(chatId, `Skill auto activation: ${enabled ? 'on' : 'off'}`);
        return true;
      }
      if (sub === 'import') {
        const source = payload;
        try {
          const result = importExternalSkillRuleSource(source, { rootDir: process.cwd() });
          const savedRules = applyImportedRuntimeRules(chatId, result.imported_rules || []);
          const currentJobId = resolveLiveJobIdForChat(chatId);
          const boardMirror = mirrorSkillRuleImportToSemanticBoard(result, { rootDir: process.cwd(), jobId: currentJobId || '' });
          await sendLong(bot, chatId, [
            formatExternalSkillRuleImportResult(result),
            '',
            `Applied runtime rules to this chat: ${savedRules.length}`,
            `Semantic Board cards mirrored: ${boardMirror.mirrored}`,
            'Imported skills are available to the resolver after the next registry refresh/run.',
          ].join('\n'));
        } catch (error) {
          await bot.sendMessage(chatId, `Skill import failed: ${error?.message || error}`);
        }
        return true;
      }
      if (sub === 'roster' || sub === 'agents') {
        const skillsArgs = ["skills", ...subRest].join(" ").trim();
        await sendAgentOrToolListQuick(bot, chatId, "agent", skillsArgs, { telegramUserId: userId });
        return true;
      }
      const skillsArgs = ["skills", ...rest].join(" ").trim();
      await sendAgentOrToolListQuick(bot, chatId, "agent", skillsArgs, { telegramUserId: userId });
      return true;
    }

    if (cmd === "/tools") {
      await sendAgentOrToolListQuick(bot, chatId, "tool", "", { telegramUserId: userId });
      return true;
    }

    if (cmd === "/files") {
      const currentJobId = resolveLiveJobIdForChat(chatId);
      if (!currentJobId) {
        await bot.sendMessage(chatId, "현재 chat에 연결된 job이 없어요. 먼저 /chat 또는 /run으로 job을 시작해 주세요.");
        return true;
      }
      const first = String(rest[0] || "").trim().toLowerCase();
      const hasScope = ["uploads", "workspace", "artifacts", "outputs", "all"].includes(first);
      const scope = hasScope ? first : "all";
      const limit = parseClampedInt(hasScope ? rest[1] : rest[0], 20, { min: 1, max: 100 });
      const entries = collectWorkspaceFileEntries(currentJobId, { scope }).slice(0, limit);
      await sendLong(
        bot,
        chatId,
        `📂 workspace files
${formatWorkspaceFileListText(currentJobId, entries, { scope, limit })}`
      );
      return true;
    }

    if (cmd === "/outputs") {
      await bot.sendMessage(chatId, '이제 /outputs 는 제거되었습니다. 결과물은 /artifacts 를 사용해 주세요.');
      return true;
    }

    if (cmd === "/artifacts") {
      const currentJobId = resolveLiveJobIdForChat(chatId);
      if (!currentJobId) {
        await bot.sendMessage(chatId, "현재 chat에 연결된 job이 없어요. 먼저 /chat 또는 /run으로 job을 시작해 주세요.");
        return true;
      }
      const limit = parseClampedInt(rest[0], 12, { min: 1, max: 24 });
      const artifactIndex = refreshArtifactIndex(currentJobId, { maxFiles: limit });
      let runtime = null;
      if (typeof loadSupervisorRuntime === 'function') {
        try {
          runtime = await loadSupervisorRuntime(currentJobId, { telegramUserId: userId, includeContext: false, includeGlobal: false });
        } catch {}
      }
      const contract = resolveArtifactDeliveryContract(currentJobId, runtime);
      const sections = [`📎 artifacts
${formatArtifactIndexText(currentJobId, artifactIndex, { limit })}`];
      const contractLines = formatArtifactDeliveryContractLines(contract);
      if (contractLines.length > 0) sections.push(`publish contract
${contractLines.join('\n')}`);
      await sendLong(bot, chatId, sections.join('\n\n'));
      return true;
    }

    if (cmd === "/sendfile") {
      await bot.sendMessage(chatId, '이제 /sendfile 은 제거되었습니다. /send <번호|path> 를 사용해 주세요.');
      return true;
    }

    if (cmd === "/send") {
      const currentJobId = resolveLiveJobIdForChat(chatId);
      if (!currentJobId) {
        await bot.sendMessage(chatId, "현재 chat에 연결된 job이 없어요. 먼저 /chat 또는 /run으로 job을 시작해 주세요.");
        return true;
      }
      const selection = String(args || '').trim();
      if (!selection) {
        await bot.sendMessage(chatId, 'Usage: /send <번호|path>\n또는 /send bundle <번호,번호|path,...>');
        return true;
      }
      try {
        const artifactIndex = refreshArtifactIndex(currentJobId, { maxFiles: 12 });
        let runtime = null;
        if (typeof loadSupervisorRuntime === 'function') {
          try {
            runtime = await loadSupervisorRuntime(currentJobId, { telegramUserId: userId, includeContext: false, includeGlobal: false });
          } catch {}
        }
        const contract = resolveArtifactDeliveryContract(currentJobId, runtime);
        const bundle = parseArtifactBundleSelection(selection);
        if (bundle) {
          if (!sendArtifactBundle) throw new Error('bundle send is not available');
          const sentBundle = await sendArtifactBundle(bot, chatId, currentJobId, bundle.items, {
            replyToMessageId: msg.message_id,
            artifactIndex,
            runtime,
          });
          await bot.sendMessage(
            chatId,
            `✅ 번들 전송 완료
job_id=${currentJobId}
files=${sentBundle.entries.length}
name=${sentBundle.fileName}
size=${formatByteSize(sentBundle.size)}`
          );
          return true;
        }
        const sent = await sendArtifactBySelection(bot, chatId, currentJobId, selection, {
          replyToMessageId: msg.message_id,
          artifactIndex,
        });
        const messageLines = [
          '✅ 파일 전송 완료',
          `job_id=${currentJobId}`,
          `path=${sent.rel}`,
          `size=${formatByteSize(sent.size)}`,
        ];
        if (Array.isArray(contract?.warnings) && contract.warnings.length > 0) {
          messageLines.push('publish_contract_warnings:');
          for (const warning of contract.warnings.slice(0, 2)) messageLines.push(`- ${warning}`);
        }
        await bot.sendMessage(chatId, messageLines.join('\n'));
      } catch (e) {
        await bot.sendMessage(chatId, `❌ /send 실패: ${clip(String(e?.message ?? e), 260)}`);
      }
      return true;
    }

    if (cmd === "/improve") {
      const sub = String(rest[0] || '').trim().toLowerCase();
      const context = await requireGocImprovementContext(chatId, userId);
      if (!context) {
        await bot.sendMessage(chatId, '현재 GoC thread에 연결된 runtime이 없어 improvement job을 만들 수 없습니다.');
        return true;
      }
      const { runtime: runtimeForGoc, threadId, client } = context;
      if (sub === 'status') {
        const jobId = String(rest[1] || '').trim();
        if (!jobId) {
          await bot.sendMessage(chatId, 'Usage:\n/improve status <jobId>');
          return true;
        }
        try {
          const payload = await client.getImprovementJob(threadId, jobId);
          await sendLong(bot, chatId, formatImprovementJobStatus(payload));
        } catch (e) {
          await bot.sendMessage(chatId, `❌ /improve status 실패: ${String(e?.message ?? e)}`);
        }
        return true;
      }
      if (sub === 'test' || sub === 'canary' || sub === 'review' || sub === 'gate' || sub === 'promote' || sub === 'rollback') {
        const jobId = String(rest[1] || '').trim();
        if (!jobId) {
          await bot.sendMessage(chatId, `Usage:\n/improve ${sub} <jobId>`);
          return true;
        }
        try {
          const loaded = await loadImprovementExecutionContext({ client, threadId, jobId });
          let stageResult = null;
          if (sub === 'test') stageResult = await runImprovementTests({ client, threadId, jobId, targetConfig: loaded.targetConfig });
          if (sub === 'canary') stageResult = await runImprovementCanary({ client, threadId, jobId, targetConfig: loaded.targetConfig });
          if (sub === 'review') stageResult = await runImprovementReview({ client, threadId, jobId, targetConfig: loaded.targetConfig });
          if (sub === 'gate') stageResult = await runImprovementEvalGate({ client, threadId, jobId, targetConfig: loaded.targetConfig });
          if (sub === 'promote') stageResult = await markImprovementPromotion({ client, threadId, jobId, targetConfig: loaded.targetConfig });
          if (sub === 'rollback') stageResult = await runImprovementRollback({ client, threadId, jobId, targetConfig: loaded.targetConfig });
          const refreshed = await client.getImprovementJob(threadId, jobId);
          await sendLong(bot, chatId, [
            `✅ /improve ${sub} 완료`,
            `- job_id: ${jobId}`,
            `- status: ${String(stageResult?.status || '-')}`,
            `- duration_ms: ${String(stageResult?.duration_ms || '-')}`,
            '',
            formatImprovementJobStatus(refreshed),
          ].join('\n'));
        } catch (e) {
          await bot.sendMessage(chatId, `❌ /improve ${sub} 실패: ${String(e?.message ?? e)}`);
        }
        return true;
      }
      if (sub === 'execute' || sub === 'run') {
        const jobId = String(rest[1] || '').trim();
        const mode = String(rest[2] || '').trim().toLowerCase();
        if (!jobId) {
          await bot.sendMessage(chatId, 'Usage:\n/improve execute <jobId> [full]');
          return true;
        }
        try {
          const teamState = getSessionTeamState(chatSessionStore, chatId);
          await syncRawHistoryToGoC({ client, threadId, chatId, chatSessionStore, runtime: runtimeForGoc, teamState }).catch(() => null);
          const board = await client.getThreadBoard(threadId).catch(() => ({ lanes: [], counts: {} }));
          const loaded = await loadImprovementExecutionContext({ client, threadId, jobId });
          const automation = await runImprovementAutomation({
            client,
            threadId,
            jobId,
            targetConfig: loaded.targetConfig,
            autoPromote: mode === 'full',
            board,
          });
          const refreshed = await client.getImprovementJob(threadId, jobId);
          await sendLong(bot, chatId, [
            `✅ /improve execute 완료`,
            `- job_id: ${jobId}`,
            formatAutomationSummary(automation),
            '',
            formatImprovementJobStatus(refreshed),
          ].join('\n'));
        } catch (e) {
          await bot.sendMessage(chatId, `❌ /improve execute 실패: ${String(e?.message ?? e)}`);
        }
        return true;
      }
      if (sub === 'auto' || sub === 'full') {
        const targetRepo = String(rest[1] || '').trim().toLowerCase();
        const instruction = rawArgs.split(/\s+/).slice(2).join(' ').trim();
        if (targetRepo !== 'ddalggak' && targetRepo !== 'goc') {
          await bot.sendMessage(chatId, `Usage:\n/improve ${sub} <ddalggak|goc> <instruction>`);
          return true;
        }
        if (!instruction) {
          await bot.sendMessage(chatId, `Usage:\n/improve ${sub} <ddalggak|goc> <instruction>`);
          return true;
        }
        try {
          const teamState = getSessionTeamState(chatSessionStore, chatId);
          await syncRawHistoryToGoC({ client, threadId, chatId, chatSessionStore, runtime: runtimeForGoc, teamState }).catch(() => null);
          const board = await client.getThreadBoard(threadId).catch(() => ({ lanes: [], counts: {} }));
          const prepared = await inspectAndPrepareImprovementJob({
            client,
            threadId,
            targetRepo,
            instruction,
            requestedBy: `telegram:${userId}` ,
            board,
            autoMode: true,
            autoPromote: sub === 'full',
          });
          const automation = await runImprovementAutomation({
            client,
            threadId,
            jobId: prepared.jobId,
            targetConfig: prepared.targetConfig,
            autoPromote: sub === 'full',
            board,
          });
          const refreshed = await client.getImprovementJob(threadId, prepared.jobId);
          await sendLong(bot, chatId, [
            `✅ /improve ${sub} 완료`,
            `- job_id: ${prepared.jobId}`,
            `- target: ${targetRepo}`,
            `- workspace_root: ${String(prepared.targetConfig.workspace_root || '-')}`,
            `- target_runtime: ${String(prepared.targetConfig.target_runtime || '-')}`,
            formatAutomationSummary(automation),
            '',
            formatImprovementJobStatus(refreshed),
          ].join('\n'));
        } catch (e) {
          await bot.sendMessage(chatId, `❌ /improve ${sub} 실패: ${String(e?.message ?? e)}`);
        }
        return true;
      }
      if (sub !== 'ddalggak' && sub !== 'goc') {
        await bot.sendMessage(chatId, 'Usage:\n/improve <ddalggak|goc> <instruction>\n/improve auto <ddalggak|goc> <instruction>\n/improve full <ddalggak|goc> <instruction>\n/improve execute <jobId> [full]\n/improve status <jobId>\n/improve test <jobId>\n/improve canary <jobId>\n/improve review <jobId>\n/improve gate <jobId>\n/improve promote <jobId>\n/improve rollback <jobId>');
        return true;
      }
      const instruction = rawArgs.slice(sub.length).trim();
      if (!instruction) {
        await bot.sendMessage(chatId, `Usage:\n/improve ${sub} <instruction>`);
        return true;
      }
      try {
        const teamState = getSessionTeamState(chatSessionStore, chatId);
        await syncRawHistoryToGoC({ client, threadId, chatId, chatSessionStore, runtime: runtimeForGoc, teamState }).catch(() => null);
        const board = await client.getThreadBoard(threadId).catch(() => ({ lanes: [], counts: {} }));
        const prepared = await inspectAndPrepareImprovementJob({
          client,
          threadId,
          targetRepo: sub,
          instruction,
          requestedBy: `telegram:${userId}`,
          board,
        });
        const testResult = await runImprovementTests({ client, threadId, jobId: prepared.jobId, targetConfig: prepared.targetConfig });
        const canaryResult = await runImprovementCanary({ client, threadId, jobId: prepared.jobId, targetConfig: prepared.targetConfig });
        const refreshed = await client.getImprovementJob(threadId, prepared.jobId);
        await sendLong(bot, chatId, [
          `✅ improvement job 생성: ${prepared.jobId}`,
          `- target: ${sub}`,
          `- workspace_root: ${String(prepared.targetConfig.workspace_root || '-')}`,
          `- target_runtime: ${String(prepared.targetConfig.target_runtime || '-')}`,
          `- tests: ${String(testResult?.status || '-')}`,
          `- canary: ${String(canaryResult?.status || '-')}`,
          '',
          formatImprovementJobStatus(refreshed),
        ].join('\n'));
      } catch (e) {
        await bot.sendMessage(chatId, `❌ /improve 실패: ${String(e?.message ?? e)}`);
      }
      return true;
    }

    if (cmd === "/goc") {
      const sub = String(rest[0] || '').trim().toLowerCase();
      const action = String(rest[1] || '').trim().toLowerCase();
      if (sub === 'status' || sub === 'circuit' || sub === 'circuits') {
        const rows = getGocRouteCircuitSnapshot();
        const now = Date.now();
        const openRows = rows.filter((row) => Number(row.openUntil || 0) > now);
        const lines = [
          'GoC route circuit breaker',
          `- open routes: ${openRows.length}`,
          `- tracked routes: ${rows.length}`,
        ];
        for (const row of rows.slice(-8)) {
          const cooldownMs = Math.max(0, Number(row.openUntil || 0) - now);
          lines.push(`- ${row.key}: failures=${Number(row.failures || 0)} status=${Number(row.lastStatus || 0) || '-'} cooldown_ms=${cooldownMs}`);
        }
        if (!rows.length) lines.push('- no recent route failures');
        await bot.sendMessage(chatId, lines.join('\n'));
        return true;
      }
      if (sub === 'history' && (!action || action === 'push' || action === 'sync')) {
        const runtimeForGoc = await requireCurrentRuntime(chatId, userId);
        const threadId = getCurrentThreadId(runtimeForGoc);
        if (!threadId || memoryModeWithFallback?.() !== 'goc' || typeof requireGocClient !== 'function') {
          await bot.sendMessage(chatId, '현재 GoC thread에 연결된 runtime이 없어 raw history를 push 할 수 없습니다.');
          return true;
        }
        try {
          const client = requireGocClient();
          const teamState = getSessionTeamState(chatSessionStore, chatId);
          const synced = await syncRawHistoryToGoC({ client, threadId, chatId, chatSessionStore, runtime: runtimeForGoc, teamState });
          const derivedCount = Number(synced?.saved?.derived_candidates?.count || 0);
          await sendLong(bot, chatId, [
            '✅ raw history snapshot을 GoC Board로 동기화했습니다.',
            `- thread_id: ${threadId}`,
            `- stream_key: ${String(synced?.snapshot?.stream_key || '-')}`,
            `- summary: ${String(synced?.snapshot?.summary || '-')}`,
            `- derived_candidates: ${derivedCount}`,
            '- policy: visible in board / raw history excluded from learning',
            '- structured candidates stay in review lane until promoted',
          ].join('\n'));
        } catch (e) {
          await bot.sendMessage(chatId, `❌ /goc history push 실패: ${String(e?.message ?? e)}`);
        }
        return true;
      }
      if (sub === 'candidate' && action === 'approve') {
        const runtimeForGoc = await requireCurrentRuntime(chatId, userId);
        const threadId = getCurrentThreadId(runtimeForGoc);
        const candidateNodeId = String(rest[2] || '').trim();
        const publishToLibrary = String(rest[3] || '').trim().toLowerCase() === 'publish';
        if (!threadId || memoryModeWithFallback?.() !== 'goc' || typeof requireGocClient !== 'function') {
          await bot.sendMessage(chatId, '현재 GoC thread에 연결된 runtime이 없어 candidate를 승격할 수 없습니다.');
          return true;
        }
        if (!candidateNodeId) {
          await bot.sendMessage(chatId, 'Usage:\n/goc candidate approve <nodeId> [publish]');
          return true;
        }
        try {
          const client = requireGocClient();
          const result = await client.approveBoardCandidate(threadId, candidateNodeId, { publishToLibrary });
          await sendLong(bot, chatId, [
            publishToLibrary ? '✅ Board candidate를 승인하고 library로 publish했습니다.' : '✅ Board candidate를 승인하고 현재 thread 자산으로 승격했습니다.',
            `- thread_id: ${threadId}`,
            `- candidate_node_id: ${candidateNodeId}`,
            `- promoted_resource_kind: ${String(result?.promoted_resource_kind || '-')}`,
            `- promoted_node_id: ${String(result?.promoted_node?.id || '-')}`,
            `- target_thread_id: ${String(result?.target_thread_id || '-')}`,
          ].join('\n'));
        } catch (e) {
          await bot.sendMessage(chatId, `❌ /goc candidate approve 실패: ${String(e?.message ?? e)}`);
        }
        return true;
      }
      await bot.sendMessage(chatId, `Usage:\n/goc history push\n/goc candidate approve <nodeId> [publish]`);
      return true;
    }

    if (cmd === "/context") {
      try {
        const arg = String(rest[0] || "").trim();
        await sendContextInfo(bot, chatId, arg, {
          userId,
          createIfMissing: true,
        });
      } catch (e) {
        await bot.sendMessage(chatId, `❌ /context 실패: ${String(e?.message ?? e)}`);
      }
      return true;
    }

    if (cmd === "/attach") {
      await bot.sendMessage(chatId, '이제 /attach 는 제거되었습니다. 파일 업로드는 /upload 를 사용해 주세요.');
      return true;
    }

    if (cmd === "/chat") {
      const raw = String(args || "").trim();
      if (!raw) {
        await bot.sendMessage(chatId, "Usage: /chat [--debug] <message>\n세션 초기화: /chat reset");
        return true;
      }
      if (raw.toLowerCase() === "reset") {
        resetChatSession(chatId);
        await bot.sendMessage(chatId, "✅ /chat 세션을 초기화했습니다.");
        return true;
      }

      const parsed = parseChatMessageWithFlags(raw);
      const message = parsed.message;
      if (!message) {
        await bot.sendMessage(chatId, "Usage: /chat [--debug] <message>\n세션 초기화: /chat reset");
        return true;
      }
      const embeddedRule = parseChatEmbeddedRule(message);
      if (embeddedRule) {
        addRuntimeRule(chatId, embeddedRule, { source: 'user', origin: 'chat_inline_rule' });
        await bot.sendMessage(chatId, '✅ 운영 지침에 반영했어요. 자세한 편집/비활성화/히스토리는 GoC에서 다룹니다.');
        return true;
      }
      if (isOperationalControlText(message)) {
        await sendLong(bot, chatId, buildOperationalControlRedirectMessage(message));
        return true;
      }
      maybeLearnRuntimeRule(chatId, message);

      try {
        let teamState = getSessionTeamState(chatSessionStore, chatId);
        const currentJobId = resolveLiveJobIdForChat(chatId);
        if (!teamState.active_team && currentJobId && typeof loadSupervisorRuntime === 'function') {
          try {
            const runtimeForChat = await loadSupervisorRuntime(currentJobId, { telegramUserId: userId, includeContext: false, includeGlobal: false });
            await hydrateSessionTeamStateFromConversationStore({ sessionStore: chatSessionStore, chatId, runtime: runtimeForChat }).catch(() => null);
            teamState = getSessionTeamState(chatSessionStore, chatId);
          } catch {}
        }
        if (!parsed.debug) {
          const route = await tryRoomConciergeConversationalPath({
            chatId,
            userId,
            msg,
            message,
            sourceCommand: originalCmd === '/c' ? '/c' : '/chat',
          });
          if (route.handled) return true;
          appendAskRouteOutcome({ chatId, userId, message, command: originalCmd === '/c' ? '/c' : '/chat', decision: route.decision, modelPolicy: route.modelPolicy, executor: 'workbench', outcome: 'queued_workbench' });
          await chatRunManager.handleIncoming({
            chatId,
            userId,
            text: message,
            kind: "normal",
            telegramMessageId: msg.message_id,
            userReplyToMessageId: Number.isFinite(Number(msg?.reply_to_message?.message_id)) ? Number(msg.reply_to_message.message_id) : null,
            teamConfig: teamState.active_team || null,
            chatInfo: {
              chat_id: String(chatId || ""),
              title: String(msg.chat?.title || msg.chat?.username || "").trim(),
              type: String(msg.chat?.type || "").trim(),
            },
          });
          return true;
        }
        await sendRouterAckMessage(bot, chatId, { replyToMessageId: msg.message_id });
        await runSupervisorChat(bot, chatId, userId, message, {
          debug: parsed.debug,
          teamConfig: teamState.active_team || null,
          chatInfo: {
            chat_id: String(chatId || ""),
            title: String(msg.chat?.title || msg.chat?.username || "").trim(),
            type: String(msg.chat?.type || "").trim(),
          },
          inputKind: "command_chat",
          telegramMessageId: msg.message_id,
          userReplyToMessageId: Number.isFinite(Number(msg?.reply_to_message?.message_id)) ? Number(msg.reply_to_message.message_id) : null,
        });
      } catch (e) {
        await bot.sendMessage(chatId, `❌ /chat 실패: ${String(e?.message ?? e)}`);
      }
      return true;
    }

    if (cmd === "/run") {
      if (!args) {
        await bot.sendMessage(chatId, "Usage: /run <goal>");
        return true;
      }
      await executeRunCommand({
        bot,
        chatId,
        userId,
        goal: args,
        createJob,
        resetJobAbortController,
        activeJobByChat,
        jobAbortControllers,
        runWorkspaceDir,
        loadSupervisorRuntime,
        decideRunRoute,
        tracking,
        actionLabel,
        executeRoutedPlan,
        suggestNextPrompt,
        isCancelledError,
      });
      return true;
    }

    if (cmd === "/continue") {
      if (!args) {
        await bot.sendMessage(chatId, "Usage: /continue <jobId>");
        return true;
      }
      await executeContinueCommand({
        bot,
        chatId,
        userId,
        jobId: args,
        resetJobAbortController,
        activeJobByChat,
        jobAbortControllers,
        runWorkspaceDir,
        tracking,
        extractCodexInstruction,
        loadSupervisorRuntime,
        getGoalFromResearch,
        decideRunRoute,
        actionLabel,
        executeRoutedPlan,
        suggestNextPrompt,
        isCancelledError,
      });
      return true;
    }

    if (cmd === "/gptprompt") {
      if (!isChatGptManualFallbackEnabled()) {
        await bot.sendMessage(chatId, "legacy ChatGPT 수동 프롬프트 생성은 비활성화되어 있어요. chatgpt 역할은 Codex bridge/model node로 직접 실행하세요.");
        return true;
      }
      const parts = rest;
      const jobId = parts[0];
      const question = parts.slice(1).join(" ").trim();
      if (!jobId || !question) {
        await bot.sendMessage(chatId, "Usage: /gptprompt <jobId> <question>");
        return true;
      }

      jobs.appendConversation(jobId, "user", `/gptprompt ${question}`, { kind: "gptprompt" });
      await sendChatGPTPrompt(bot, chatId, jobId, question);
      return true;
    }

    if (cmd === "/gptapply") {
      if (!isChatGptManualFallbackEnabled()) {
        await bot.sendMessage(chatId, "legacy ChatGPT 붙여넣기 모드는 기본 비활성화되어 있어요. 직접 실행은 CHATGPT_PROVIDER_BRIDGE=codex를 사용하고, 수동 복붙을 꼭 쓰려면 CHATGPT_MANUAL_FALLBACK_ENABLED=true를 설정하세요.");
        return true;
      }
      const targetJobId = String(args || resolveLiveJobIdForChat(chatId) || "").trim();
      if (!targetJobId) {
        await bot.sendMessage(chatId, "Usage: /gptapply [jobId]");
        return true;
      }
      setAwait(chatId, targetJobId, userId);
      rememberLastChatJob(chatId, targetJobId);
      await bot.sendMessage(chatId, "🟣 이제 ChatGPT 답변을 그대로 붙여넣어 주세요. (20분 내)\nJSON 액션 플랜이 있으면 자동 실행됩니다.\n종료: /gptdone");
      return true;
    }

    if (cmd === "/commit") {
      const parts = rest;
      const jobId = parts[0];
      const message = parts.slice(1).join(" ").trim();
      if (!jobId || !message) {
        await bot.sendMessage(chatId, "Usage: /commit <jobId> <message>");
        return true;
      }
      const rec = approvals.request(jobId, {
        purpose: "git commit",
        summary: `Commit changes with message: ${message}`,
        payload: { action: "git_commit", message },
      });

      await bot.sendMessage(
        chatId,
        `🟡 커밋 승인 필요\njobId=${jobId}\nmessage=${message}\ntoken=${rec.token}`,
        {
          reply_markup: {
            inline_keyboard: [[
              { text: "✅ Approve", callback_data: `approve:${jobId}:${rec.token}` },
              { text: "❌ Deny", callback_data: `deny:${jobId}:${rec.token}` },
            ]],
          },
        }
      );
      return true;
    }

    if (cmd.startsWith("/")) {
      await bot.sendMessage(chatId, "알 수 없는 명령입니다. /help 를 참고하세요.");
      return true;
    }

    return false;
  };
}
