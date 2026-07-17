import test from 'node:test';
import assert from 'node:assert/strict';
import { buildExecutionGraph } from '../src/room_runtime/room_execution_graph.js';
import { buildRoomStagePrompt } from '../src/room_runtime/room_prompt_builder.js';

const workingMemory = {
  decisions: ['proposal A secret decision'],
  open_blockers: ['proposal A secret blocker'],
};
const prior = [
  {
    stage_id: 'propose_a',
    structured: { summary: 'A summary', decisions: ['A decision'], blocking_issues: [], next_actions: [] },
    visible_output: 'A full proposal body with architecture details',
  },
  {
    stage_id: 'propose_b',
    structured: { summary: 'B summary', decisions: ['B decision'], blocking_issues: [], next_actions: [] },
    visible_output: 'B full proposal body with alternative details',
  },
  {
    stage_id: 'implement',
    structured: { summary: 'implementation claim' },
    visible_output: 'implementation agent says everything is correct',
  },
];

test('deliberate proposal B is isolated from proposal A and global working memory', () => {
  const graph = buildExecutionGraph({ objective: 'compare two architectures', topology: 'deliberate' });
  const stage = graph.stages.find((row) => row.stage_id === 'propose_b');
  const prompt = buildRoomStagePrompt({ spec: { objective: 'compare' }, stage, workingMemory, priorStageResults: prior });
  assert.doesNotMatch(prompt, /A summary|A full proposal|proposal A secret/);
  assert.match(prompt, /intentionally isolated/);
});

test('adjudicator receives full independent proposals but not unrelated implementation claims', () => {
  const graph = buildExecutionGraph({ objective: 'compare two architectures', topology: 'deliberate' });
  const stage = graph.stages.find((row) => row.stage_id === 'adjudicate');
  const prompt = buildRoomStagePrompt({ spec: { objective: 'compare' }, stage, workingMemory, priorStageResults: prior });
  assert.match(prompt, /A full proposal body with architecture details/);
  assert.match(prompt, /B full proposal body with alternative details/);
  assert.doesNotMatch(prompt, /implementation agent says everything is correct|proposal A secret/);
});

test('review stage is independent from builder claims', () => {
  const graph = buildExecutionGraph({ objective: 'implement and review', topology: 'review_loop' });
  const stage = graph.stages.find((row) => row.stage_id === 'review_1');
  const prompt = buildRoomStagePrompt({ spec: { objective: 'review' }, stage, workingMemory, priorStageResults: prior });
  assert.doesNotMatch(prompt, /implementation claim|everything is correct|proposal A secret/);
});
