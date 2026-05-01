import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  isCodexPlannerEnabled,
  isLlmTeamPlannerEnabled,
  resetFreeformPlannerAvailabilityCache,
} from '../src/application/freeform_team_planner.js';

test('isCodexPlannerEnabled detects codex binary from PATH without spawning a probe', () => {
  const prevPath = process.env.PATH;
  const prevMode = process.env.TEAM_CREATE_PLANNER_MODE;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddalggak-codex-path-'));
  const bin = path.join(dir, 'codex');
  fs.writeFileSync(bin, '#!/bin/sh\necho codex\n', 'utf8');
  fs.chmodSync(bin, 0o755);
  process.env.PATH = dir;
  process.env.TEAM_CREATE_PLANNER_MODE = 'auto';
  resetFreeformPlannerAvailabilityCache();
  try {
    assert.equal(isCodexPlannerEnabled(), true);
  } finally {
    process.env.PATH = prevPath;
    if (prevMode === undefined) delete process.env.TEAM_CREATE_PLANNER_MODE;
    else process.env.TEAM_CREATE_PLANNER_MODE = prevMode;
    resetFreeformPlannerAvailabilityCache();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('isCodexPlannerEnabled returns false in auto mode when PATH has no codex binary', () => {
  const prevPath = process.env.PATH;
  const prevMode = process.env.TEAM_CREATE_PLANNER_MODE;
  process.env.PATH = '';
  process.env.TEAM_CREATE_PLANNER_MODE = 'auto';
  resetFreeformPlannerAvailabilityCache();
  try {
    assert.equal(isCodexPlannerEnabled(), false);
  } finally {
    process.env.PATH = prevPath;
    if (prevMode === undefined) delete process.env.TEAM_CREATE_PLANNER_MODE;
    else process.env.TEAM_CREATE_PLANNER_MODE = prevMode;
    resetFreeformPlannerAvailabilityCache();
  }
});


test('isLlmTeamPlannerEnabled detects Gemini planner binary in auto mode', () => {
  const prevPath = process.env.PATH;
  const prevMode = process.env.TEAM_CREATE_PLANNER_MODE;
  const prevProvider = process.env.TEAM_PLANNER_PROVIDER;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddalggak-gemini-path-'));
  const bin = path.join(dir, 'gemini');
  fs.writeFileSync(bin, '#!/bin/sh\necho gemini\n', 'utf8');
  fs.chmodSync(bin, 0o755);
  process.env.PATH = dir;
  process.env.TEAM_CREATE_PLANNER_MODE = 'auto';
  delete process.env.TEAM_PLANNER_PROVIDER;
  resetFreeformPlannerAvailabilityCache();
  try {
    assert.equal(isLlmTeamPlannerEnabled('create'), true);
  } finally {
    process.env.PATH = prevPath;
    if (prevMode === undefined) delete process.env.TEAM_CREATE_PLANNER_MODE;
    else process.env.TEAM_CREATE_PLANNER_MODE = prevMode;
    if (prevProvider === undefined) delete process.env.TEAM_PLANNER_PROVIDER;
    else process.env.TEAM_PLANNER_PROVIDER = prevProvider;
    resetFreeformPlannerAvailabilityCache();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
