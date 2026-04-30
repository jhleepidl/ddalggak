import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { materializeArtifactsFromLlmOutput } from '../src/application/llm_output_artifact_materializer.js';
import { WORKSPACE_ARTIFACT_PUBLISH_MANIFEST } from '../src/application/cli_workspace_contract.js';

test('materializes notebook JSON blocks from LLM output into workspace artifacts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddalggak-llm-materialize-'));
  try {
    const output = `Here is CE2026S_Assignment_5.ipynb\n\n\`\`\`json\n{"cells":[{"cell_type":"markdown","metadata":{},"source":["# Assignment 5"]}],"metadata":{},"nbformat":4,"nbformat_minor":5}\n\`\`\``;
    const result = materializeArtifactsFromLlmOutput({ output, workspaceRoot: dir, userRequest: 'CE2026S_Assignment_5.ipynb 파일로 만들어줘' });
    assert.deepEqual(result.materialized.map((row) => row.path), ['CE2026S_Assignment_5.ipynb']);
    const notebook = JSON.parse(fs.readFileSync(path.join(dir, 'CE2026S_Assignment_5.ipynb'), 'utf8'));
    assert.equal(notebook.nbformat, 4);
    assert.equal(notebook.cells[0].cell_type, 'markdown');
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, WORKSPACE_ARTIFACT_PUBLISH_MANIFEST), 'utf8'));
    assert.ok(manifest.artifacts.some((row) => row.path === 'CE2026S_Assignment_5.ipynb' && row.final === true));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('materializes explicit artifact contract blocks for arbitrary file types', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddalggak-llm-materialize-general-'));
  try {
    const output = `[ARTIFACT]\npath: reports/summary.md\n\`\`\`markdown\n# Summary\nGenerated report.\n\`\`\`\n[/ARTIFACT]`;
    const result = materializeArtifactsFromLlmOutput({ output, workspaceRoot: dir, userRequest: '리포트 파일을 만들어줘' });
    assert.deepEqual(result.materialized.map((row) => row.path), ['reports/summary.md']);
    assert.match(fs.readFileSync(path.join(dir, 'reports/summary.md'), 'utf8'), /Generated report/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('does not materialize ordinary unscoped code blocks', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddalggak-llm-materialize-ordinary-'));
  try {
    const output = `\`\`\`python\nprint('hello')\n\`\`\``;
    const result = materializeArtifactsFromLlmOutput({ output, workspaceRoot: dir, userRequest: '파이썬 예시를 보여줘' });
    assert.deepEqual(result.materialized, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
