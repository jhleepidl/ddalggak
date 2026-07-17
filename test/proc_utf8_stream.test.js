import test from 'node:test';
import assert from 'node:assert/strict';
import { makeUtf8StreamDecoder, runCommand } from '../src/proc.js';

function decodeWithCollector(chunks) {
  const decoder = makeUtf8StreamDecoder();
  let out = '';
  for (const chunk of chunks) out += decoder.write(chunk);
  out += decoder.end();
  return out;
}

test('makeUtf8StreamDecoder preserves Korean across every byte split', () => {
  const original = '가보실 만한 메뉴와 맛집을 추천해 드립니다';
  const bytes = Buffer.from(original, 'utf8');
  for (let i = 1; i < bytes.length; i += 1) {
    const decoded = decodeWithCollector([bytes.subarray(0, i), bytes.subarray(i)]);
    assert.equal(decoded, original, `split at byte ${i}`);
    assert.equal(decoded.includes('�'), false, `replacement char at byte ${i}`);
  }
});

test('runCommand decodes stdout and stderr safely when a Korean character is split across writes', async () => {
  const source = `
    const out = Buffer.from('stdout: 가보실 만한 메뉴와 맛집을 추천해 드립니다\\n', 'utf8');
    const err = Buffer.from('stderr: 가보실 만한 메뉴와 맛집을 추천해 드립니다\\n', 'utf8');
    process.stdout.write(out.subarray(0, 13));
    setTimeout(() => {
      process.stdout.write(out.subarray(13));
      process.stderr.write(err.subarray(0, 13));
      setTimeout(() => {
        process.stderr.write(err.subarray(13));
      }, 5);
    }, 5);
  `;
  const result = await runCommand(process.execPath, ['-e', source], { timeoutMs: 5000 });
  assert.equal(result.ok, true);
  assert.equal(result.stdout, 'stdout: 가보실 만한 메뉴와 맛집을 추천해 드립니다\n');
  assert.equal(result.stderr, 'stderr: 가보실 만한 메뉴와 맛집을 추천해 드립니다\n');
  assert.equal(result.stdout.includes('�'), false);
  assert.equal(result.stderr.includes('�'), false);
});

test('runCommand emits ordered intermediate output events before resolving', async () => {
  const source = [
    "process.stdout.write('first\\n')",
    "setTimeout(() => process.stderr.write('second\\n'), 10)",
    "setTimeout(() => process.stdout.write('third\\n'), 20)",
  ].join(';');
  const events = [];
  const result = await runCommand(process.execPath, ['-e', source], {
    timeoutMs: 5000,
    onOutput: async (event) => {
      await new Promise((resolve) => setTimeout(resolve, 2));
      events.push({ stream: event.stream, chunk: event.chunk.trim(), sequence: event.sequence });
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(events.map((row) => row.chunk), ['first', 'second', 'third']);
  assert.deepEqual(events.map((row) => row.sequence), [1, 2, 3]);
  assert.equal(result.outputEventCount, 3);
});
