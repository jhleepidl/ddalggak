import { buildWorkModeConfig, summarizeWorkModeConfig } from './work_mode.js';

function clean(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function cleanId(value = '') {
  return clean(value).toLowerCase().replace(/[^a-z0-9가-힣_:\-]+/g, '_').replace(/^_+|_+$/g, '');
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function uniq(values = [], max = 16) {
  const out = [];
  const seen = new Set();
  for (const raw of asArray(values)) {
    const value = cleanId(raw);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
    if (out.length >= max) break;
  }
  return out;
}

function summarizeRoom(roomPackage = {}) {
  const row = asObject(roomPackage);
  return {
    package_id: clean(row.package_id || row.id || ''),
    title: clean(row.title || row.name || 'AI Room'),
    domain_label: cleanId(row.domain_label || row.domain || 'general_workbench') || 'general_workbench',
  };
}

function inferSignals(taskText = '') {
  const text = clean(taskText);
  const lower = text.toLowerCase();
  const signals = {
    asksQuestion: /\?|뭐|무엇|어떻게|why|what|how|can you|could you|추천|설명|요약|정리/.test(text),
    requiresImage: /image|photo|사진|이미지|그림|첨부/.test(lower),
    requiresSearch: /search|find|look up|검색|찾아|근처|지도|restaurant|가게|업장/.test(lower),
    requiresMutation: /patch|edit|modify|build|implement|fix|write file|코드 수정|패치|구현|빌드|파일 작성/.test(lower),
    requiresReview: /review|검토|리뷰|critic|double check|cross-check|모순|검증/.test(lower),
    requiresLoop: /plan|roadmap|반복|loop|step by step|여러 단계|캠페인|프로젝트|장기/.test(lower),
    asksForTracking: /기록|track|history|log|저장|누적|pattern|분석|trend|통계/.test(lower),
  };
  signals.simpleAsk = signals.asksQuestion
    && !signals.requiresImage
    && !signals.requiresSearch
    && !signals.requiresMutation
    && !signals.requiresReview
    && !signals.requiresLoop;
  return signals;
}

function policyFromDepth(depth = 'ask', signals = {}) {
  if (depth === 'ask') {
    return {
      memory_policy: {
        read: 'light_projection',
        write: signals.asksForTracking ? 'proposal_only' : 'none',
      },
      tool_policy: {
        allow_external_tools: false,
        requires_confirmation: false,
      },
    };
  }
  if (depth === 'team_task') {
    return {
      memory_policy: {
        read: 'structured_projection',
        write: 'proposal_only',
      },
      tool_policy: {
        allow_external_tools: signals.requiresSearch || signals.requiresImage,
        requires_confirmation: signals.requiresImage || signals.asksForTracking,
      },
    };
  }
  return {
    memory_policy: {
      read: 'room_projection_plus_history',
      write: 'proposal_then_confirm',
    },
    tool_policy: {
      allow_external_tools: true,
      requires_confirmation: true,
    },
  };
}

export function buildRoomTurnRoute({
  taskText = '',
  explicitMode = '',
  inputKind = '',
  roomPackage = null,
  chatId = '',
  source = 'room_turn_router',
  runtime = null,
  userOrchestrationIntent = null,
  memoryImportIntent = null,
  stress = null,
} = {}) {
  const mode = summarizeWorkModeConfig(buildWorkModeConfig({
    request: taskText,
    explicitMode: explicitMode || inputKind || '',
    runtime,
    userOrchestrationIntent,
    memoryImportIntent,
    stress,
  }));
  const room = summarizeRoom(roomPackage || {});
  const signals = inferSignals(taskText);
  const reasonCodes = uniq([
    ...(mode.reason_codes || []),
    signals.simpleAsk ? 'simple_question' : '',
    signals.requiresImage ? 'image_or_upload_input' : '',
    signals.requiresSearch ? 'external_lookup_needed' : '',
    signals.requiresMutation ? 'workspace_mutation_or_build' : '',
    signals.requiresReview ? 'review_or_cross_check_requested' : '',
    signals.requiresLoop ? 'multi_step_or_loop_intent' : '',
    signals.asksForTracking ? 'tracking_or_logging_signal' : '',
    room.domain_label !== 'general_workbench' ? `room_domain_${room.domain_label}` : '',
  ]);

  let depth = mode.work_mode;
  if (!mode.explicit && depth === 'ask' && (signals.requiresSearch || signals.asksForTracking || signals.requiresImage || signals.requiresReview)) {
    depth = signals.requiresLoop ? 'team_loop_task' : 'team_task';
  }
  if (!mode.explicit && depth === 'team_task' && (signals.requiresLoop || signals.requiresMutation)) {
    depth = 'team_loop_task';
  }

  const executionShape = depth === 'ask'
    ? 'single_agent'
    : (depth === 'team_task' ? 'bounded_team' : 'bounded_loop_team');
  const conciergeLabel = mode.work_mode === 'ask'
    ? 'Room Concierge (Router)'
    : 'Room Router / Concierge';
  const policies = policyFromDepth(depth, signals);

  return {
    kind: 'room_turn_route_v1',
    source,
    chat_id: String(chatId || ''),
    room,
    room_router: {
      title: conciergeLabel,
      role: 'turn_router',
      concept: 'A room-level routing policy that decides whether a turn should stay lightweight or invoke a larger team.',
    },
    depth,
    execution_shape: executionShape,
    explicit: mode.explicit === true,
    reason_codes: reasonCodes,
    signals,
    memory_policy: policies.memory_policy,
    tool_policy: policies.tool_policy,
    summary_lines: [
      `${conciergeLabel} selected ${depth} for this turn`,
      depth === 'ask'
        ? 'Simple turns stay lightweight even when the room becomes highly specialized.'
        : 'The room can invoke richer components only when the turn justifies it.',
      'Routing is room-level policy, not an individual agent decision.',
    ],
  };
}
