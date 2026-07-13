import fs from 'node:fs';
import assert from 'node:assert/strict';
const ideas = JSON.parse(fs.readFileSync('output/ideas.json', 'utf8'));
const synthesis = JSON.parse(fs.readFileSync('output/synthesis.json', 'utf8'));
assert.ok(Array.isArray(ideas) && ideas.length >= 3);
const assumptions = new Set();
for (const idea of ideas) {
  for (const key of ['id', 'proposal', 'core_assumption', 'validation', 'risk']) assert.equal(typeof idea[key], 'string', `${key} required`);
  const normalized = idea.core_assumption.trim().toLowerCase();
  assert.ok(normalized.length >= 8);
  assert.ok(!assumptions.has(normalized), 'core assumptions must be distinct');
  assumptions.add(normalized);
}
assert.ok(Array.isArray(synthesis.top_choices) && synthesis.top_choices.length >= 1 && synthesis.top_choices.length <= 3);
const ids = new Set(ideas.map((idea) => idea.id));
assert.ok(synthesis.top_choices.every((id) => ids.has(id)));
assert.equal(typeof synthesis.comparison, 'string');
assert.ok(synthesis.comparison.length >= 40);
console.log('parallel idea diversity contract validated');
