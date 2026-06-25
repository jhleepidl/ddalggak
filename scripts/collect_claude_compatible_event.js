#!/usr/bin/env node
import fs from 'node:fs';
import { buildClaudeCompatibleRoomEvent, buildClaudeCompatibleImportPreview, claudeEventToRoomUsageEvent } from '../src/application/claude_compatible_event_adapter.js';

function arg(name, fallback = '') {
  const prefix = `--${name}=`;
  const found = process.argv.find((x) => x.startsWith(prefix));
  if (found) return found.slice(prefix.length);
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

const root = arg('root', process.cwd());
const mode = arg('mode', 'event');
let out;
if (mode === 'preview') {
  out = buildClaudeCompatibleImportPreview({ projectRoot: root });
} else {
  const event = buildClaudeCompatibleRoomEvent({
    source: arg('source', 'claude_code'),
    projectRoot: root,
    roomId: arg('room-id', ''),
    userId: arg('user-id', ''),
    sessionId: arg('session-id', ''),
    eventType: arg('event-type', 'claude_compatible_usage'),
    action: arg('action', ''),
    toolName: arg('tool', ''),
    manifestType: arg('manifest-type', ''),
    manifestFilename: arg('manifest-file', ''),
    subagentName: arg('subagent', ''),
    skillName: arg('skill', ''),
    outcome: { signal: arg('outcome', '') },
  });
  out = process.argv.includes('--room-usage') ? claudeEventToRoomUsageEvent(event) : event;
}
const outputPath = arg('out', '');
const text = `${JSON.stringify(out, null, 2)}\n`;
if (outputPath) fs.writeFileSync(outputPath, text, 'utf8');
else process.stdout.write(text);
