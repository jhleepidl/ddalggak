import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OrchestratorMemory } from '../src/settings.js';

test('orchestrator memory auto-migrates legacy multi-agent template', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-migrate-'));
  fs.writeFileSync(path.join(dir, 'settings.md'), [
    '# Orchestrator Memory', '', '## Auto-Suggest Reflection Prompt', 'legacy policy', '',
    '## Multi-Agent Router Prompt',
    '아래 목표/상황을 보고 필요한 에이전트만 최소로 호출하는 실행 순서를 결정한다.\n- Gemini는 리서치/리스크/검증 전략 중심으로만 사용한다.\n- Codex는 실제 코드 변경이 필요할 때만 사용한다.',
    '', '## Agent Roles', '### Gemini', '역할: 기술 리서처/검토자\n- 코드 작성/수정 대신, 구현 전략·리스크·검증 체크리스트를 제시한다.',
    '', '### Codex', '역할: 구현 담당\n- 테스트는 직접 실행하지 말고 필요한 테스트를 제안한다.', '', '### ChatGPT', '역할: 상위 플래너/조정자', '',
  ].join('\n'), 'utf8');
  const memory = new OrchestratorMemory({ baseDir: dir });
  assert.match(memory.getRouterPrompt(), /single-agent fast path/);
  assert.doesNotMatch(memory.getAgentRole('gemini'), /기술 리서처\/검토자/);
  const raw = fs.readFileSync(path.join(dir, 'settings.md'), 'utf8');
  assert.match(raw, /Auto-migrated legacy memory template/);
});
