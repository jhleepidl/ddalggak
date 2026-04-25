import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const sourcePath = path.join(process.cwd(), 'src/application/telegram_chat_execution.js');
const source = fs.readFileSync(sourcePath, 'utf8');

test('execution callbacks resolve route plan via injected getter', () => {
  assert.match(source, /getRoutePlan = null/);
  assert.match(source, /resolveCurrentRoutePlan/);
  assert.match(source, /getRoutePlan: \(\) => routePlan/);
});

test('callback helper blocks do not reference free routePlan directly', () => {
  assert.doesNotMatch(source, /buildTelegramAgentIndex\(\{ runtime, routePlan, actions: routePlan\?\.actions/);
  assert.match(source, /routePlan: currentRoutePlan, actions: currentRoutePlan\?\.actions/);
});
