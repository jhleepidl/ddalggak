import path from 'node:path';

function clean(value = '') {
  return String(value || '').trim();
}

function uniq(values = []) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const item = clean(value);
    if (!item) continue;
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function has(text = '', re) {
  return re.test(String(text || ''));
}

export function extractExecutionRequirements(text = '') {
  const raw = clean(text);
  const mentionsDirectness = has(raw, /(네가|니가|너가|직접|직접적으로|직접 해|직접 실행|yourself|you should run|run it yourself)/i);
  const mentionsShell = has(raw, /(npm\s+(install|run|ci)|pnpm\s|yarn\s|pip\s+install|cargo\s+build|gradle\s|dotnet\s+build|make\s|cmake\s|electron-builder|pkg\s)/i);
  const mentionsBuild = has(raw, /(빌드|패키징|패키지|패키징해서|dist\b|installer|설치 파일|설치파일|exe\b|\.exe\b|패키지 파일|산출물.*(파일|줘)|generate.*installer|build.*installer)/i);
  const wantsArtifactDelivery = has(raw, /(산출물.*줘|파일.*줘|첨부|전달해|보내줘|bundle|deliver|artifact|설치 파일까지 생성해서|exe 파일까지 생성해서)/i);

  const expectedArtifactKinds = [];
  if (has(raw, /(\.exe\b|\bexe\b|windows installer|nsis|설치 파일|설치파일)/i)) expectedArtifactKinds.push('exe');
  if (has(raw, /(zip\b|압축)/i)) expectedArtifactKinds.push('zip');

  return {
    direct_execution_requested: mentionsDirectness && (mentionsShell || mentionsBuild || wantsArtifactDelivery),
    shell_execution_requested: mentionsShell,
    artifact_build_requested: mentionsBuild,
    artifact_delivery_requested: wantsArtifactDelivery || mentionsBuild,
    expected_artifact_kinds: uniq(expectedArtifactKinds),
    raw_text: raw,
    summary: [
      mentionsDirectness && (mentionsShell || mentionsBuild || wantsArtifactDelivery) ? '사용자가 직접 실행을 요청함' : '',
      mentionsShell ? 'shell command 실행 필요' : '',
      mentionsBuild ? '빌드/설치 산출 필요' : '',
      wantsArtifactDelivery ? '파일 전달 기대' : '',
    ].filter(Boolean).join(' · '),
  };
}

export function mergeExecutionRequirements(...rows) {
  const merged = {
    direct_execution_requested: false,
    shell_execution_requested: false,
    artifact_build_requested: false,
    artifact_delivery_requested: false,
    expected_artifact_kinds: [],
    raw_text: '',
    summary: '',
  };
  const texts = [];
  for (const row of rows) {
    const item = row && typeof row === 'object' ? row : extractExecutionRequirements(String(row || ''));
    if (!item || typeof item !== 'object') continue;
    merged.direct_execution_requested = merged.direct_execution_requested || item.direct_execution_requested === true;
    merged.shell_execution_requested = merged.shell_execution_requested || item.shell_execution_requested === true;
    merged.artifact_build_requested = merged.artifact_build_requested || item.artifact_build_requested === true;
    merged.artifact_delivery_requested = merged.artifact_delivery_requested || item.artifact_delivery_requested === true;
    merged.expected_artifact_kinds = uniq([...merged.expected_artifact_kinds, ...(Array.isArray(item.expected_artifact_kinds) ? item.expected_artifact_kinds : [])]);
    if (clean(item.raw_text)) texts.push(clean(item.raw_text));
  }
  merged.raw_text = uniq(texts).join('\n');
  merged.summary = [
    merged.direct_execution_requested ? '직접 실행 요청' : '',
    merged.shell_execution_requested ? 'shell 실행 필요' : '',
    merged.artifact_build_requested ? '빌드 산출 필요' : '',
    merged.artifact_delivery_requested ? '파일 전달 필요' : '',
    merged.expected_artifact_kinds.length > 0 ? `기대 산출물=${merged.expected_artifact_kinds.join(',')}` : '',
  ].filter(Boolean).join(' · ');
  return merged;
}

export function formatExecutionRequirementsBlock(requirements = {}) {
  const row = requirements && typeof requirements === 'object' ? requirements : {};
  const lines = [];
  if (row.direct_execution_requested) lines.push('- 사용자가 직접 로컬 실행/빌드를 명시적으로 요청했다.');
  if (row.shell_execution_requested) lines.push('- 필요한 bounded shell command를 직접 실행할 수 있으면 실행하라.');
  if (row.artifact_build_requested) lines.push('- 코드 수정만이 아니라 실제 빌드/패키징 산출까지 확인해야 한다.');
  if (row.artifact_delivery_requested) lines.push('- 생성된 파일 경로/이름을 artifact index와 최종 응답에 명시하라.');
  if (Array.isArray(row.expected_artifact_kinds) && row.expected_artifact_kinds.length > 0) {
    lines.push(`- 기대 산출물: ${row.expected_artifact_kinds.join(', ')}`);
  }
  lines.push('- 실행/산출을 수행하지 못했으면 성공처럼 쓰지 말고 blocker와 미생성 산출물을 명시하라.');
  return lines.join('\n');
}

function normalizeArtifactPaths(artifactPaths = []) {
  return uniq((Array.isArray(artifactPaths) ? artifactPaths : []).map((entry) => clean(entry).replace(/\\/g, '/')));
}

function hasArtifactKind(paths = [], kind = '') {
  const key = clean(kind).toLowerCase();
  if (!key) return false;
  const rows = normalizeArtifactPaths(paths);
  if (key === 'exe') return rows.some((entry) => /\.exe$/i.test(path.basename(entry)));
  if (key === 'zip') return rows.some((entry) => /\.zip$/i.test(path.basename(entry)));
  return rows.some((entry) => entry.toLowerCase().includes(`.${key}`));
}

export function detectUnmetExecutionRequirements({ requirements = {}, output = '', artifactPaths = [] } = {}) {
  const req = requirements && typeof requirements === 'object' ? requirements : {};
  const text = clean(output);
  const unmet = [];
  const add = (code = '', detail = '') => {
    const cleanCode = clean(code);
    if (!cleanCode || unmet.some((row) => row.code === cleanCode)) return;
    unmet.push({ code: cleanCode, detail: clean(detail) || cleanCode });
  };

  const skippedExecution = has(text, /(cannot execute shell commands|can't execute shell commands|i cannot execute shell commands|실행하지 않았습니다|수행하지 않았습니다|실제 .*생성 확인하지 않았습니다|아직 생성되지 않았습니다|electron 패키지가 아직 설치되지 않아 실제 .*빌드는 .*수행하지 않았습니다|별도의 tool_proxy step|tool_proxy step unless explicitly asked otherwise)/i);
  const deferredToUser = has(text, /(npm install|npm run dist|pkg\s+\.|run the following|다음 단계|직접 실행하세요|터미널에서 .* 실행)/i) && has(text, /(설치 파일|\.exe|installer|dist\/|release-manifest)/i);

  if ((req.direct_execution_requested || req.shell_execution_requested) && skippedExecution) {
    add('direct_execution_not_performed', '직접 실행 요청이 있었지만 shell/build 실행이 수행되지 않았다.');
  }
  if (req.artifact_build_requested && (skippedExecution || deferredToUser)) {
    add('artifact_build_not_verified', '빌드/패키징 요청이 있었지만 실제 산출 확인 없이 사용자에게 실행을 넘겼다.');
  }
  if (Array.isArray(req.expected_artifact_kinds) && req.expected_artifact_kinds.length > 0) {
    for (const kind of req.expected_artifact_kinds) {
      if (!hasArtifactKind(artifactPaths, kind)) {
        add(`missing_${clean(kind).toLowerCase()}_artifact`, `${kind} 산출물이 artifact index/workspace에서 확인되지 않았다.`);
      }
    }
  }
  return unmet;
}
