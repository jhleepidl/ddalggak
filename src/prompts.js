export function orchestratorNotes({ goal }) {
  return `# Orchestrator Notes\n\n## Goal\n${goal}\n\n## Tracking files\n- research.md: 조사/근거/링크\n- plan.md: 구현 단계/체크리스트/리스크\n- progress.md: 실행 로그/결과\n- decisions.md: 최종 결론/트레이드오프\n`;
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
}) {
  const roleBlock = agentRolesText
    ? `\n## 에이전트 역할 메모리\n${agentRolesText}\n`
    : "";
  const routerBlock = routerPrompt
    ? `\n## 에이전트 라우팅 기준\n${routerPrompt}\n`
    : "";

  return `# 요청: 중앙 통제 AI(=ChatGPT)로 다음 단계 결정\n\n너는 중앙 통제 AI다. 아래 컨텍스트를 보고 다음 단계를 결정해라.\n너의 답변은 **사람이 Telegram에 붙여넣어도 자동 실행될 수 있게** JSON 액션 플랜을 포함해야 한다.\n\n## 목표(jobId=${jobId})\n${goal}\n\n## 질문/요청\n${question}${routerBlock}${roleBlock}\n## 기록: shared docs\n${contextDocsText}\n\n## 기록: 최근 대화\n${convoText}\n\n## 반드시 포함할 JSON (단일 JSON 객체)\n아래 형식으로만 출력해줘. (설명은 JSON 아래에 짧게 5줄 이내)\n\n\`\`\`json\n{\n  \"jobId\": \"${jobId}\",\n  \"actions\": [\n    {\"type\":\"track_append\",\"doc\":\"plan.md\",\"markdown\":\"(필요한 계획/체크리스트)\"},\n    {\"type\":\"agent_run\",\"agent\":\"researcher\",\"prompt\":\"(조사가 더 필요하면)\",\"inputs\":{}},\n    {\"type\":\"agent_run\",\"agent\":\"coder\",\"prompt\":\"(짧고 명확한 구현 지시)\",\"inputs\":{}},\n    {\"type\":\"git_summary\"}\n  ]\n}\n\`\`\`\n\n추가 규칙:\n- 에이전트 역할이 겹치지 않게, 필요한 액션만 최소로 구성하라.\n- commit_request는 정말 필요할 때만 추가하라(실제 커밋은 승인 필요).\n- agent_run 프롬프트는 짧고 명확하게.\n- plan.md에 \"Codex에게 줄 작업 지시문\" 섹션을 만들어주면 이후 /continue가 그 부분을 우선 사용한다.\n`;
}
