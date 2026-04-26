import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const commandsSource = readFileSync(new URL('../src/adapters/telegram/commands.js', import.meta.url), 'utf8');
const benchmarkSource = readFileSync(new URL('../src/application/benchmark_team_templates.js', import.meta.url), 'utf8');

test('/team template is a deprecation shim, not a large dump command', () => {
  assert.match(commandsSource, /const TEAM_TEMPLATE_DEPRECATED_TEXT = \[/);
  assert.match(commandsSource, /\/team template은 더 이상 일반 사용 흐름에서 권장되지 않습니다/);
  const templateBlock = commandsSource.match(/if \(sub === 'template'\) \{[\s\S]*?return true;\s*\}/)?.[0] || '';
  assert.match(templateBlock, /await bot\.sendMessage\(chatId, TEAM_TEMPLATE_DEPRECATED_TEXT\)/);
  assert.doesNotMatch(templateBlock, /buildTeamConfigurationTemplate\(baseTeam\)/);
  assert.doesNotMatch(templateBlock, /buildBenchmarkTemplateCatalogText\(\)/);
});

test('/team more hides the legacy template command and exposes debug templates', () => {
  const advancedHelpMatch = commandsSource.match(/const TEAM_ADVANCED_HELP_TEXT = \[([\s\S]*?)\]\.join\("\\n"\);/);
  assert.ok(advancedHelpMatch, 'TEAM_ADVANCED_HELP_TEXT should exist');
  assert.doesNotMatch(advancedHelpMatch[1], /"- \/team template"/);
  assert.match(advancedHelpMatch[1], /\/team debug templates/);
});

test('developer template catalog moved to /team debug templates', () => {
  assert.match(commandsSource, /if \(sub === 'debug'\)/);
  assert.match(commandsSource, /\/team debug template benchmark <id>/);
  assert.match(benchmarkSource, /\/team debug template benchmark <id>/);
  assert.doesNotMatch(benchmarkSource, /\/team template benchmark <id>/);
});
