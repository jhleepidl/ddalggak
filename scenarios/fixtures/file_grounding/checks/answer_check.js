import fs from 'node:fs';
import assert from 'node:assert/strict';

const rows = fs.readFileSync('data/inventory.csv', 'utf8').trim().split(/\r?\n/).slice(1).map((line) => {
  const [id, name, available, alreadyOwned, score] = line.split(',');
  return { id, name, available: available === 'true', already_owned: alreadyOwned === 'true', score: Number(score) };
});
const answer = JSON.parse(fs.readFileSync('output/answer.json', 'utf8'));
assert.equal(answer.source_of_truth, 'data/inventory.csv');
assert.ok(Array.isArray(answer.selected_ids) && answer.selected_ids.length >= 1);
const byId = new Map(rows.map((row) => [row.id, row]));
for (const id of answer.selected_ids) {
  const row = byId.get(id);
  assert.ok(row, `unknown selected id: ${id}`);
  assert.equal(row.available, true, `unavailable selection: ${id}`);
  assert.equal(row.already_owned, false, `already-owned selection: ${id}`);
}
assert.ok(Array.isArray(answer.evidence) && answer.evidence.length >= answer.selected_ids.length);
assert.ok(answer.evidence.every((entry) => entry && typeof entry.id === 'string' && typeof entry.reason === 'string'));
console.log('file-grounded answer validated');
