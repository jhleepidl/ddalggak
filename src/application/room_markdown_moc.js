function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function cleanText(value = '', { maxLen = 1000, lower = false } = {}) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  const clipped = text.length > maxLen ? text.slice(0, maxLen) : text;
  return lower ? clipped.toLowerCase() : clipped;
}

function uniqueStrings(values = [], { max = 64, lower = false } = {}) {
  const out = [];
  const seen = new Set();
  for (const raw of asArray(values)) {
    const text = cleanText(raw, { maxLen: 200, lower });
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

function slugify(value = '', fallback = 'note') {
  const slug = cleanText(value || fallback, { lower: true, maxLen: 120 })
    .replace(/[^a-z0-9가-힣._:-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || fallback;
}

function dateOf(value = '') {
  const raw = String(value || '');
  const m = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  const d = raw ? new Date(raw) : new Date();
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return new Date().toISOString().slice(0, 10);
}

function classifyEventCategory(event = {}) {
  const row = asObject(event);
  const type = cleanText(row.event_type || row.eventType || row.type || '', { lower: true, maxLen: 160 });
  const command = cleanText(row.command || '', { lower: true, maxLen: 80 });
  const goal = cleanText(row.goal || row.text || asObject(row.extra).goal || '', { lower: true, maxLen: 300 });
  const hay = `${type} ${command} ${goal}`;
  if (/room|preset|package|profile|evolution|composition/.test(hay)) return 'room-setting';
  if (/memory|remember|correction|correct/.test(hay)) return 'memory-governance';
  if (/skill|tool|artifact|file|test|build|patch|code|구현|패치|테스트/.test(hay)) return 'execution-skill';
  if (/loop|team|agent|council|handoff|topology/.test(hay)) return 'agent-topology';
  if (/research|paper|논문|실험|evaluation|benchmark/.test(hay)) return 'research-work';
  return 'operations';
}

function eventTitle(event = {}) {
  const row = asObject(event);
  const type = cleanText(row.event_type || row.eventType || row.type || 'room_event', { maxLen: 80 });
  const command = cleanText(row.command || '', { maxLen: 80 });
  const goal = cleanText(row.goal || asObject(row.extra).goal || row.text || '', { maxLen: 100 });
  return [command || type, goal].filter(Boolean).join(' · ') || type;
}

function buildActionEntries(events = [], { max = 12 } = {}) {
  return asArray(events).slice(-max).reverse().map((event, idx) => {
    const row = asObject(event);
    const date = dateOf(row.ts || row.created_at || row.updated_at);
    const category = classifyEventCategory(row);
    const title = eventTitle(row);
    const name = `${date}-${slugify(category)}-${String(idx + 1).padStart(2, '0')}.md`;
    return {
      kind: 'room_doc_action_entry_v1',
      path: `action/${name}`,
      date,
      category,
      title,
      event_type: cleanText(row.event_type || row.eventType || row.type || '', { maxLen: 120 }),
      command: cleanText(row.command || '', { maxLen: 80 }),
      summary: cleanText(row.goal || asObject(row.extra).summary || title, { maxLen: 240 }),
      provenance: {
        event_ts: row.ts || row.created_at || '',
        event_type: row.event_type || row.eventType || row.type || '',
        copies_raw_transcript: false,
      },
    };
  });
}

function buildLivingDocs({ roomPackage = null, profile = null } = {}) {
  const pkg = asObject(roomPackage);
  const prof = asObject(profile);
  const packageId = cleanText(pkg.package_id || prof.package_id || prof.preset_id || 'room_package', { maxLen: 120 });
  const title = cleanText(pkg.title || prof.name || 'AI Room', { maxLen: 160 });
  const purpose = cleanText(pkg.description || prof.room_purpose || prof.current_goal || '', { maxLen: 500 });
  const agents = uniqueStrings(pkg.agents || prof.default_agents || [], { max: 16, lower: true });
  const skills = uniqueStrings(pkg.skills || prof.installed_skills || [], { max: 24, lower: true });
  const memory = uniqueStrings(asObject(pkg.memory_schema).object_types || asObject(prof.memory_schema).object_types || [], { max: 24, lower: true });
  const hierarchy = uniqueStrings(pkg.memory_hierarchy || prof.memory_hierarchy || asObject(prof.memory_schema).hierarchy || [], { max: 24, lower: true });
  const loopPolicy = asObject(pkg.loop_policy || prof.loop_policy);
  return [
    {
      kind: 'room_living_doc_v1',
      path: 'docs/room-setting.md',
      category: 'room-setting',
      title: 'Room setting and package lineage',
      summary: `Base package ${packageId} for ${title}.`,
      sections: [
        ['Room', [`title: ${title}`, `package: ${packageId}`, purpose ? `purpose: ${purpose}` : 'purpose: (unset)']],
        ['Companions', agents.length ? agents : ['(none)']],
        ['Loop policy', Object.keys(loopPolicy).length ? Object.entries(loopPolicy).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}`) : ['default loop policy not set']],
      ],
    },
    {
      kind: 'room_living_doc_v1',
      path: 'docs/memory-hierarchy.md',
      category: 'memory-governance',
      title: 'Memory hierarchy and governance',
      summary: 'Stable room memory layers, candidate/approval boundary, and prompt projection inputs.',
      sections: [
        ['Object types', memory.length ? memory : ['(none)']],
        ['Hierarchy', hierarchy.length ? hierarchy : ['room_profile', 'working_context', 'active_memory', 'protocols', 'skills']],
        ['Write policy', ['raw events are evidence, not prompt memory', 'idle structuring creates candidates', 'durable/high-risk memory changes require review', 'projection should cite active memory provenance']],
      ],
    },
    {
      kind: 'room_living_doc_v1',
      path: 'docs/skills-and-protocols.md',
      category: 'execution-skill',
      title: 'Skills and room protocols',
      summary: 'Reusable procedural knowledge for this room; skills are executable methods, protocols are recurring room procedures.',
      sections: [
        ['Skills', skills.length ? skills : ['(none)']],
        ['Protocol policy', ['borrow first', 'trial before install', 'install durable protocols only after outcome evidence or user approval']],
      ],
    },
    {
      kind: 'room_living_doc_v1',
      path: 'docs/topology-learning.md',
      category: 'agent-topology',
      title: 'Agent communication topology and learning signals',
      summary: 'How this room decides between sequential, council, reviewer-gated, or bounded-loop communication patterns.',
      sections: [
        ['Candidate topologies', ['sequential handoff', 'orchestrator star', 'reviewer-gated pipeline', 'visible companion council', 'bounded parallel group with WCCU-style witness checks']],
        ['Outcome signals', ['task completion', 'artifact/test success', 'user correction or stop', 'review-required rate', 'stale dependency or authority warning', 'latency and token cost']],
      ],
    },
  ];
}

function groupBy(entries = [], keyFn = (x) => x) {
  const map = new Map();
  for (const entry of asArray(entries)) {
    const key = keyFn(entry);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(entry);
  }
  return [...map.entries()].map(([key, rows]) => ({ key, rows }));
}

function renderBullets(values = [], indent = '') {
  return asArray(values).map((v) => `${indent}- ${String(v)}`).join('\n');
}

function renderLivingDoc(doc = {}) {
  const row = asObject(doc);
  const lines = [`# ${row.title || row.path}`, '', row.summary || '', ''].filter((line) => line !== '');
  for (const [heading, items] of asArray(row.sections)) {
    lines.push(`## ${heading}`, '', renderBullets(items), '');
  }
  return lines.join('\n').trim() + '\n';
}

export function buildRoomDocumentMocPack({ roomPackage = null, profile = null, events = [], now = new Date().toISOString() } = {}) {
  const actions = buildActionEntries(events, { max: 16 });
  const docs = buildLivingDocs({ roomPackage, profile });
  const categories = uniqueStrings([...actions.map((x) => x.category), ...docs.map((x) => x.category)], { max: 32, lower: true });
  return {
    kind: 'room_document_moc_pack_v1',
    generated_at: now,
    policy: {
      action_dir: 'execution and operation records; append-only, chronological, evidence-oriented',
      docs_dir: 'living architecture/design/planning/operations documents; curated and revised over time',
      raw_transcript_policy: 'do not copy raw private transcript into public/shared docs by default',
      navigation_flow: ['AGENTS.md', 'moc-structure.md', 'moc-by-date.md', 'moc-by-category.md', 'action/', 'docs/'],
    },
    files: {
      agents: 'AGENTS.md',
      structure: 'moc-structure.md',
      by_date: 'moc-by-date.md',
      by_category: 'moc-by-category.md',
    },
    actions,
    docs,
    categories,
  };
}

export function renderRoomDocumentMocFiles(pack = {}) {
  const row = asObject(pack);
  const actions = asArray(row.actions);
  const docs = asArray(row.docs);
  const dateGroups = groupBy(actions, (x) => x.date).sort((a, b) => String(b.key).localeCompare(String(a.key)));
  const categoryGroups = groupBy([...actions, ...docs], (x) => x.category).sort((a, b) => String(a.key).localeCompare(String(b.key)));
  const files = [];
  files.push({
    path: 'AGENTS.md',
    content: [
      '# AGENTS.md',
      '',
      'This room uses Markdown as navigable runtime context, not as an unbounded prompt dump.',
      '',
      '## Service structure',
      '- `action/`: chronological execution, verification, deployment, bug-fix, and operation records.',
      '- `docs/`: living architecture, design, planning, operation guides, and delivery explanations.',
      '- `moc-structure.md`: where to start reading and how the indexes relate.',
      '- `moc-by-date.md`: time-oriented index for recent work.',
      '- `moc-by-category.md`: category-oriented index for memory, skills, topology, room settings, and operations.',
      '',
      '## Runtime rules',
      '- Prefer indexed docs over raw chat history.',
      '- Treat action notes as evidence records and docs as curated living views.',
      '- Do not silently promote memories, skills, or topology changes into durable room state.',
      '- For high-risk or durable changes, create a proposal and route it through `/inbox` or GoC review.',
      '',
      '## Authoring guide',
      '- Every non-trivial loop should append an action note.',
      '- Every durable design decision should update a docs note and both MOCs.',
      '- Keep entries short, linked, and provenance-aware.',
    ].join('\n'),
  });
  files.push({
    path: 'moc-structure.md',
    content: [
      '# MOC Structure',
      '',
      'Recommended read order:',
      '1. `AGENTS.md` for room rules and document policy.',
      '2. `moc-by-date.md` for recent execution/action records.',
      '3. `moc-by-category.md` for topic-based navigation.',
      '4. `docs/*` for living design state.',
      '5. `action/*` for chronological evidence and verification records.',
      '',
      'The MOC files are materialized views over room state. When memory, skills, protocols, or topology change, regenerate or mark them stale.',
    ].join('\n'),
  });
  files.push({
    path: 'moc-by-date.md',
    content: ['# MOC by Date', '', ...dateGroups.flatMap((group) => [`## ${group.key}`, '', ...group.rows.map((entry) => `- [${entry.title}](${entry.path}) · ${entry.category}`), ''])].join('\n'),
  });
  files.push({
    path: 'moc-by-category.md',
    content: ['# MOC by Category', '', ...categoryGroups.flatMap((group) => [`## ${group.key}`, '', ...group.rows.map((entry) => `- [${entry.title || entry.summary}](${entry.path})`), ''])].join('\n'),
  });
  for (const doc of docs) files.push({ path: doc.path, content: renderLivingDoc(doc) });
  for (const action of actions) {
    files.push({
      path: action.path,
      content: [
        `# ${action.title}`,
        '',
        `- date: ${action.date}`,
        `- category: ${action.category}`,
        `- event_type: ${action.event_type || '(unknown)'}`,
        action.command ? `- command: ${action.command}` : '',
        '- raw transcript copied: false',
        '',
        '## Summary',
        action.summary || '(empty)',
        '',
        '## Follow-up indexing',
        `- Update \`moc-by-date.md\` under ${action.date}.`,
        `- Update \`moc-by-category.md\` under ${action.category}.`,
      ].filter(Boolean).join('\n'),
    });
  }
  return files;
}

export function renderRoomDocumentMocPack(pack = {}) {
  return renderRoomDocumentMocFiles(pack).map((file) => `--- ${file.path} ---\n${file.content}`).join('\n\n');
}

export function buildRoomDocumentViewInvalidation(pack = {}, { materializedAt = null, events = [] } = {}) {
  const row = asObject(pack);
  const docs = asArray(row.docs);
  const actions = asArray(row.actions);
  const materializedTime = materializedAt ? new Date(materializedAt).getTime() : 0;
  const changed = [];
  for (const event of asArray(events)) {
    const ts = asObject(event).ts || asObject(event).created_at || asObject(event).updated_at || '';
    const time = ts ? new Date(ts).getTime() : 0;
    if (materializedTime && time && time <= materializedTime) continue;
    changed.push({
      ts,
      event_type: cleanText(asObject(event).event_type || asObject(event).eventType || asObject(event).type || '', { maxLen: 120 }),
      category: classifyEventCategory(event),
      title: eventTitle(event),
    });
  }
  const categories = uniqueStrings(changed.map((x) => x.category), { max: 32, lower: true });
  const staleDocs = docs.filter((doc) => categories.includes(doc.category)).map((doc) => doc.path);
  const staleMocs = changed.length ? ['moc-by-date.md', 'moc-by-category.md'] : [];
  return {
    kind: 'room_document_view_invalidation_v1',
    generated_at: row.generated_at || new Date().toISOString(),
    materialized_at: materializedAt || null,
    status: changed.length ? 'stale' : 'fresh',
    changed_event_count: changed.length,
    changed_categories: categories,
    stale_views: uniqueStrings([...staleMocs, ...staleDocs], { max: 64 }),
    changed_events: changed.slice(-20).reverse(),
    dependency_policy: {
      docs_are_materialized_views: true,
      source_layers: ['room_profile', 'room_usage_events', 'memory_candidates', 'skills', 'protocols', 'topology'],
      refresh_command: '/room docs sync',
    },
    counts: { action_count: actions.length, doc_count: docs.length },
  };
}

export function formatRoomDocumentInvalidationForTelegram(invalidation = {}) {
  const row = asObject(invalidation);
  const staleViews = asArray(row.stale_views);
  const changed = asArray(row.changed_events);
  return [
    '🗂️ Room docs materialized-view status',
    '',
    `status: ${row.status || 'unknown'}`,
    row.materialized_at ? `last materialized: ${row.materialized_at}` : 'last materialized: never',
    `changed events since sync: ${Number(row.changed_event_count || 0)}`,
    staleViews.length ? `stale views: ${staleViews.join(', ')}` : 'stale views: none',
    '',
    'Recent invalidating events:',
    ...(changed.length ? changed.slice(0, 8).map((evt) => `- ${evt.ts || '(no ts)'} · ${evt.category} · ${evt.title}`) : ['- none']),
    '',
    'Refresh:',
    '- /room docs sync',
  ].join('\n');
}

export function formatRoomDocumentMocPackForTelegram(pack = {}, { includeFull = false, invalidation = null } = {}) {
  const row = asObject(pack);
  const actions = asArray(row.actions);
  const docs = asArray(row.docs);
  const categories = asArray(row.categories);
  const lines = [
    '🗂️ Room Markdown MOC',
    '',
    '문서 구조:',
    '- action/: 실행/시행/검증 기록. 시간순 append-only evidence.',
    '- docs/: 설계/기획/운영 가이드. 계속 갱신되는 living documents.',
    '- AGENTS.md → moc-structure → moc-by-date / moc-by-category 순서로 탐색.',
    '',
    `living docs: ${docs.length}`,
    `recent action entries: ${actions.length}`,
    categories.length ? `categories: ${categories.join(', ')}` : 'categories: (none)',
    invalidation && asObject(invalidation).status ? `materialized view: ${asObject(invalidation).status}` : '',
    invalidation && asArray(asObject(invalidation).stale_views).length ? `stale views: ${asArray(asObject(invalidation).stale_views).join(', ')}` : '',
    '',
    '주요 docs:',
    ...docs.slice(0, 8).map((doc) => `- ${doc.path}: ${doc.title}`),
    '',
    '최근 action:',
    ...(actions.length ? actions.slice(0, 8).map((action) => `- ${action.date} · ${action.category} · ${action.title}`) : ['- 아직 action 후보가 없습니다.']),
    '',
    '사용:',
    '- /room docs full: virtual Markdown 파일 전체 보기',
    '- /room docs sync: 현재 MOC/docs/action materialized view를 runs/room_docs에 저장',
    '- /room docs status: stale/invalidation 상태 보기',
    '- GoC: Room Docs Browser에서 MOC/Docs/Action을 탐색',
  ];
  if (includeFull) {
    lines.push('', '```md', renderRoomDocumentMocPack(row).slice(0, 15000), '```');
  }
  return lines.join('\n');
}
