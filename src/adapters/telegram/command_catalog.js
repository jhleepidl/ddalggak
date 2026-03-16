const PRIMARY_GROUPS = [
  {
    title: 'Talk & run',
    items: [
      ['plain text', 'Default path: interpret the request, build a team, and execute it.'],
      ['/chat <message>', 'Run the supervisor/chat path explicitly.'],
      ['/run <goal>', 'Start a new execution run immediately.'],
      ['/continue <jobId>', 'Continue a previous run.'],
      ['/stop [jobId]', 'Cancel the current run or a specific job.'],
      ['/status', 'Show the current run, team, and checkpoint status.'],
      ['/running', 'List active and queued jobs.'],
    ],
  },
  {
    title: 'Team & presets',
    items: [
      ['/team', 'Show the current conversation team and preference state.'],
      ['/team add <preset_or_role>', 'Pin a preset or enable a role preference.'],
      ['/team remove <preset_or_role>', 'Ban a preset or suppress a role preference.'],
      ['/team enable|disable <preset_or_role>', 'Toggle a preference without removing it.'],
      ['/catalog [query]', 'Browse the local or GoC preset catalog.'],
      ['/agents …', 'Legacy alias for /team.'],
    ],
  },
  {
    title: 'Context & files',
    items: [
      ['/context [jobId|global]', 'Open the current context set or a specific job context.'],
      ['/files [uploads|outputs|all] [limit]', 'Inspect workspace files for the current job.'],
      ['/outputs [send]', 'List or send output files.'],
      ['/sendfile <relative_path>', 'Send one file from the current workspace.'],
      ['/tools', 'Show enabled tools for the current run.'],
    ],
  },
]

const ADVANCED_GROUPS = [
  {
    title: 'Memory & policy',
    items: [
      ['/memory show|md|reset', 'Inspect or reset memory-backed prompts.'],
      ['/memory policy <text>', 'Update the reflection / policy prompt.'],
      ['/memory routing <text>', 'Update the routing prompt.'],
      ['/memory role <gemini|codex|chatgpt> <text>', 'Override agent role memory.'],
      ['/memory note <text>', 'Add an operator note.'],
      ['/memory lesson <text>', 'Add a recent lesson.'],
      ['/settings …', 'Legacy alias for /memory.'],
    ],
  },
  {
    title: 'Manual GPT / commit flow',
    items: [
      ['/gptprompt <jobId> <question>', 'Send a manual GPT prompt for a run.'],
      ['/gptapply [jobId]', 'Enter paste/apply mode for GPT output.'],
      ['/gptdone', 'Exit GPT paste/apply mode.'],
      ['/commit <jobId> <message>', 'Request a git commit approval.'],
    ],
  },
  {
    title: 'Identity',
    items: [
      ['/whoami', 'Show Telegram chat/user identifiers.'],
      ['/help team|files|advanced', 'Show focused help sections.'],
    ],
  },
]

function sectionToText(section) {
  return [section.title, ...section.items.map(([cmd, desc]) => `- ${cmd}: ${desc}`)].join('\n')
}

export function buildTelegramHelpText(topic = '') {
  const clean = String(topic || '').trim().toLowerCase()
  if (clean === 'advanced') {
    return ['Advanced commands', ...ADVANCED_GROUPS.map(sectionToText)].join('\n\n')
  }
  if (clean === 'team') {
    return ['Team & preset commands', sectionToText(PRIMARY_GROUPS[1]), '', sectionToText(ADVANCED_GROUPS[0])].join('\n\n')
  }
  if (clean === 'files') {
    return ['Context & file commands', sectionToText(PRIMARY_GROUPS[2])].join('\n\n')
  }
  return [
    'Core commands',
    ...PRIMARY_GROUPS.map(sectionToText),
    '',
    'More: /help team | /help files | /help advanced',
  ].join('\n\n')
}

export function normalizeTelegramCommand(rawCmd = '', rawArgs = '') {
  const cmd = String(rawCmd || '').trim().toLowerCase()
  const args = String(rawArgs || '').trim()
  const tokens = args.split(/\s+/).filter(Boolean)
  const sub = String(tokens[0] || '').trim().toLowerCase()

  if (cmd === '/commands') {
    return { cmd: '/help', args }
  }
  if (cmd === '/catalog' || cmd === '/presets') {
    return { cmd: '/agents', args: ['registry', ...tokens].join(' ').trim() }
  }
  if (cmd === '/team') {
    if (!sub || sub === 'show' || sub === 'list' || sub === 'status') {
      return { cmd: '/agents', args: '' }
    }
    if (sub === 'catalog') {
      return { cmd: '/agents', args: ['registry', ...tokens.slice(1)].join(' ').trim() }
    }
    if (sub === 'public') {
      return { cmd: '/agents', args: ['public', ...tokens.slice(1)].join(' ').trim() }
    }
    return { cmd: '/agents', args }
  }
  return { cmd, args }
}
