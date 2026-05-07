import { getKnowledgeDocEntry, normalizeKnowledgeBaseProfile } from "./knowledge_base/profile.js";
import { internalLanguagePolicyBlock, resolveUserSurfaceLocale, userSurfaceLanguageDirective } from "./application/language_policy.js";

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
  userLocale = "",
}) {
  const roleBlock = agentRolesText
    ? `
## Agent role memory
${agentRolesText}
`
    : "";
  const routerBlock = routerPrompt
    ? `
## Agent routing criteria
${routerPrompt}
`
    : "";
  const surfaceLocale = resolveUserSurfaceLocale({ message: question, fallback: userLocale || process.env.DEFAULT_USER_LOCALE || 'ko' });
  const languagePolicy = internalLanguagePolicyBlock({ surfaceLocale });
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
        '- Semantic slots(plan/research/progress/decisions/artifacts) are stable, but actions must use the concrete file names below.',
        `- plan -> ${planDoc}`,
        `- research -> ${researchDoc}`,
        `- progress -> ${progressDoc}`,
        `- decisions -> ${decisionsDoc}`,
        '- knowledge_base_contract.md is a read-only reference.',
        `- artifacts -> ${artifactsDoc}`,
        profile?.memory_policy ? `- stable semantic slots: ${(profile.memory_policy.stable_semantic_slots || []).join(', ') || '(none)'}` : '',
        '- In JSON actions, prefer concrete file names for track_append.doc.',
        '',
      ].join('\n')
    : '';

  return `# Request: decide the next executable step as the central controller

You are the central control AI for ddalggak. Review the context below and decide the next step.
Your response must include a JSON action plan that can be pasted into Telegram and executed automatically.

${languagePolicy}

## Goal(jobId=${jobId})
${goal}

## User request
${question}${routerBlock}${roleBlock}${kbBlock ? `
${kbBlock}` : ''}
## Shared docs
${contextDocsText}

## Recent conversation
${convoText}

## Required JSON (single object)
Output the following JSON shape. After the JSON, include at most 5 short user-facing lines. ${userSurfaceLanguageDirective(surfaceLocale)}

\`\`\`json
{
  "jobId": "${jobId}",
  "actions": [
    {"type":"track_append","doc":"${planDoc}","markdown":"(needed plan/checklist)"},
    {"type":"agent_run","agent":"researcher","prompt":"(research instruction if needed)","inputs":{}},
    {"type":"agent_run","agent":"coder","prompt":"(short implementation instruction)","inputs":{}},
    {"type":"git_summary"}
  ]
}
\`\`\`

Additional rules:
- Avoid overlapping agent roles; include only necessary actions.
- Add commit_request only when truly needed; actual commits require approval.
- Keep agent_run prompts short and explicit.
- If you add a "Codex task instructions" section to ${planDoc}, later /continue will prioritize it.
`;
}
