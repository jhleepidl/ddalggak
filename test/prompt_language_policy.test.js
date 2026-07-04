import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { detectTextLanguage, internalLanguagePolicyBlock, normalizeLanguageMetadata, resolveUserSurfaceLocale, userSurfaceLanguageDirective } from '../src/application/language_policy.js';
import { normalizeProposal } from '../src/application/proposal_log.js';
import { addSemanticIndexItems, searchSemanticIndex } from '../src/application/semantic_index.js';
import { loadAgents } from '../src/agents.js';

test('detects Korean and English surface locale from user text', () => {
  assert.equal(resolveUserSurfaceLocale({ message: '이 작업을 계속 점검하고 개선해줘.' }), 'ko');
  assert.equal(resolveUserSurfaceLocale({ message: 'Please keep reviewing and improving this workflow.' }), 'en');
  assert.equal(resolveUserSurfaceLocale({ message: '영어로 답해줘. 이 설계를 설명해줘.' }), 'en');
  assert.equal(detectTextLanguage('Please answer this in English.'), 'en');
  assert.match(userSurfaceLanguageDirective('en'), /English/);
  assert.match(userSurfaceLanguageDirective('ko'), /Korean/);
});



test('runtime-authored control prompts do not force English surface locale', () => {
  const synthetic = [
    '[LANGUAGE POLICY]',
    '- User-facing surface language for this turn: English (en).',
    '[KNOWLEDGE BASE CONTRACT] profile=experiment_lab agent=reviewer role=reviewer provider=codex',
    'CONTROL PLANE TASK: Run a team-review attempt for the following goal.',
    '여러 뉴스들도 종합하고 분석해서 투자 종목을 추천해봐.',
  ].join('\\n');
  assert.equal(resolveUserSurfaceLocale({ message: synthetic, fallback: 'ko' }), 'ko');
});
test('internal language policy is English while preserving user-facing locale', () => {
  const block = internalLanguagePolicyBlock({ surfaceLocale: 'ko' });
  assert.match(block, /Internal operating language: English/);
  assert.match(block, /User-facing surface language.*Korean/);
  assert.match(block, /Preserve raw user-provided memory\/rules\/quotes/);
});

test('proposal and semantic index preserve original text with English canonical hook', () => {
  const p = normalizeProposal({ kind: 'learned_rule_candidate', summary: '한국어로 간결하게 답해' });
  assert.equal(p.source_original_language, 'ko');
  assert.equal(p.source_original_text, '한국어로 간결하게 답해');
  assert.equal(p.canonical_language, 'en');
  assert.equal(p.canonical_projection_status, 'ready');
  assert.match(p.canonical_text_en, /Respond concisely in Korean/);

  const en = normalizeLanguageMetadata({ text: 'Respond concisely in English.' });
  assert.equal(en.original_language, 'en');
  assert.equal(en.canonical_text_en, 'Respond concisely in English.');
});

test('semantic index searches original and canonical projection text', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-language-'));
  addSemanticIndexItems({ jobDir: dir, items: [{ itemType: 'skill', sourceId: 'skill_news_impact', title: '뉴스 영향 분석', text: '최신 뉴스가 국내 주식에 미치는 영향을 분석한다.', canonicalTextEn: 'Analyze the impact of recent news on Korean stocks.' }] });
  const ko = searchSemanticIndex({ jobDir: dir, query: '국내 주식 뉴스', itemTypes: ['skill'] });
  const en = searchSemanticIndex({ jobDir: dir, query: 'recent news Korean stocks', itemTypes: ['skill'] });
  assert.equal(ko.item_count, 1);
  assert.equal(en.item_count, 1);
  assert.equal(en.items[0].canonical_projection_status, 'ready');
});

test('default agent prompts use English canonical instructions with localized metadata', () => {
  const original = process.env.AGENTS_REGISTRY_PATH;
  process.env.AGENTS_REGISTRY_PATH = path.join(os.tmpdir(), `missing-agents-${Date.now()}.json`);
  try {
    const reg = loadAgents();
    const builder = reg.byId.get('builder');
    assert.ok(builder);
    assert.match(builder.prompt, /Role: Builder Agent/);
    assert.equal(builder.meta?.canonical_language, 'en');
    assert.equal(builder.meta?.localized?.ko?.description, '코드 구현/수정 담당');
  } finally {
    if (original === undefined) delete process.env.AGENTS_REGISTRY_PATH;
    else process.env.AGENTS_REGISTRY_PATH = original;
  }
});
