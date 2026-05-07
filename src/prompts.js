import { getKnowledgeDocEntry, normalizeKnowledgeBaseProfile } from "./knowledge_base/profile.js";

function uniqueTrackingDocs(docs = []) {
  const out = [];
  const byName = new Map();
  for (const doc of Array.isArray(docs) ? docs : []) {
    const fileName = String(doc?.file_name || '').trim();
    if (!fileName) continue;
    const key = fileName.toLowerCase();
    const existing = byName.get(key);
    const slot = String(doc?.doc_id || '').trim();
    if (existing) {
      if (slot && !existing.slots.includes(slot)) existing.slots.push(slot);
      continue;
    }
    const row = {
      file_name: fileName,
      purpose: String(doc?.purpose || 'tracking document').trim(),
      slots: slot ? [slot] : [],
    };
    byName.set(key, row);
    out.push(row);
  }
  return out;
}

export function orchestratorNotes({ goal, knowledgeBaseProfile = null }) {
  const profile = knowledgeBaseProfile ? normalizeKnowledgeBaseProfile(knowledgeBaseProfile) : null;
  const docs = Array.isArray(profile?.docs) && profile.docs.length > 0
    ? profile.docs
    : [
      {
        file_name: 'core_memory.md',
        purpose: 'Compact memory surface. Semantic slots: plan, research, progress, decisions, artifacts.',
        doc_id: 'core',
      },
    ];
  const trackingDocs = uniqueTrackingDocs(docs);
  const docLines = trackingDocs.map((doc) => {
    const slotSuffix = doc.slots.length > 1 ? ` (semantic slots: ${doc.slots.join(', ')})` : '';
    return `- ${doc.file_name}: ${doc.purpose || 'tracking document'}${slotSuffix}`;
  }).join('\n');
  const kbLines = profile
    ? [
        `## Knowledge Base Profile`,
        `- profile_id: ${profile.profile_id || 'unknown'}`,
        `- display_name: ${profile.display_name || 'Knowledge Base'}`,
        profile.selection_reason ? `- selection_reason: ${profile.selection_reason}` : '',
        '',
        '## Stable KB memory',
        '- knowledge_base_contract.md: read-only file contract + semantic slot mapping',
        '- knowledge_base_profile.json: machine-readable manifest (system-owned)',
        '',
      ].filter(Boolean).join('\n')
    : '';
  return `# Orchestrator Notes\n\n## Goal\n${goal}\n\n${kbLines ? `${kbLines}\n` : ''}## Tracking files\n${docLines}\n`;
}

// Prompt to ask ChatGPT for next steps + machine-executable plan
export function buildChatGPTNextStepPrompt({
  jobId,
  goal,
  question,
  contextDocsText,
  convoText,
  routerPrompt = "",
  agentRolesText = "",
  knowledgeBaseProfile = null,
}) {
  const roleBlock = agentRolesText
    ? `\n## 에이전트 역할 메모리\n${agentRolesText}\n`
    : "";
  const routerBlock = routerPrompt
    ? `\n## 에이전트 라우팅 기준\n${routerPrompt}\n`
    : "";
  const profile = knowledgeBaseProfile ? normalizeKnowledgeBaseProfile(knowledgeBaseProfile) : null;
  const defaultMemoryDoc = 'core_memory.md';
  const planDoc = profile ? (getKnowledgeDocEntry(profile, 'plan')?.file_name || defaultMemoryDoc) : defaultMemoryDoc;
  const researchDoc = profile ? (getKnowledgeDocEntry(profile, 'research')?.file_name || defaultMemoryDoc) : defaultMemoryDoc;
  const progressDoc = profile ? (getKnowledgeDocEntry(profile, 'progress')?.file_name || defaultMemoryDoc) : defaultMemoryDoc;
  const decisionsDoc = profile ? (getKnowledgeDocEntry(profile, 'decisions')?.file_name || defaultMemoryDoc) : defaultMemoryDoc;
  const artifactsDoc = profile ? (getKnowledgeDocEntry(profile, 'artifacts')?.file_name || defaultMemoryDoc) : defaultMemoryDoc;
  const kbBlock = profile
    ? [
        '## Knowledge Base contract',
        `- profile_id: ${profile.profile_id}`,
        '- semantic slots(plan/research/progress/decisions/artifacts)은 안정적이지만, 파일명은 아래 concrete name을 사용한다.',
        `- plan -> ${planDoc}`,
        `- research -> ${researchDoc}`,
        `- progress -> ${progressDoc}`,
        `- decisions -> ${decisionsDoc}`,
        '- knowledge_base_contract.md 는 read-only reference다.',
        `- artifacts -> ${artifactsDoc}`,
        profile?.memory_policy ? `- stable semantic slots: ${(profile.memory_policy.stable_semantic_slots || []).join(', ') || '(none)'}` : '',
        '- JSON action의 track_append.doc 는 가능하면 concrete file name을 사용한다.',
        '',
      ].join('\n')
    : '';

  return `# 요청: 중앙 통제 AI(=ChatGPT)로 다음 단계 결정\n\n너는 중앙 통제 AI다. 아래 컨텍스트를 보고 다음 단계를 결정해라.\n너의 답변은 **사람이 Telegram에 붙여넣어도 자동 실행될 수 있게** JSON 액션 플랜을 포함해야 한다.\n\n## 목표(jobId=${jobId})\n${goal}\n\n## 질문/요청\n${question}${routerBlock}${roleBlock}${kbBlock ? `\n${kbBlock}` : ''}\n## 기록: shared docs\n${contextDocsText}\n\n## 기록: 최근 대화\n${convoText}\n\n## 반드시 포함할 JSON (단일 JSON 객체)\n아래 형식으로만 출력해줘. (설명은 JSON 아래에 짧게 5줄 이내)\n\n\`\`\`json\n{\n  \"jobId\": \"${jobId}\",\n  \"actions\": [\n    {\"type\":\"track_append\",\"doc\":\"${planDoc}\",\"markdown\":\"(필요한 계획/체크리스트)\"},\n    {\"type\":\"agent_run\",\"agent\":\"researcher\",\"prompt\":\"(조사가 더 필요하면)\",\"inputs\":{}},\n    {\"type\":\"agent_run\",\"agent\":\"coder\",\"prompt\":\"(짧고 명확한 구현 지시)\",\"inputs\":{}},\n    {\"type\":\"git_summary\"}\n  ]\n}\n\`\`\`\n\n추가 규칙:\n- 에이전트 역할이 겹치지 않게, 필요한 액션만 최소로 구성하라.\n- commit_request는 정말 필요할 때만 추가하라(실제 커밋은 승인 필요).\n- agent_run 프롬프트는 짧고 명확하게.\n- ${planDoc}에 \"Codex에게 줄 작업 지시문\" 섹션을 만들어주면 이후 /continue가 그 부분을 우선 사용한다.\n`;
}
