// A small board in the standalone page's data layout (made up: a demo app's releases).
export const DEMO = {
  meta: { updated: '2026-10-30 12:00', updated_by: 'Demo orchestrator', timeline_start: '2026-10-24', timeline_end: '2026-11-13' },
  now: { headline: 'R2 goes out Monday', summary: 'R1 is **closed**; R2 waits for `the migration`.' },
  actions: [
    { text: 'Merge `feature/login` into dev', when: 'now', release: 'R2', item: 'mvaaaaaa-0123456789abcdef', command: 'c-merge', detail: 'Expected tree `abc123`.' },
    { text: 'Run the migration', when: 'Mon 11-02', release: 'R2' },
  ],
  releases: [
    {
      id: 'R1', title: 'Sign-in', status: 'closed', short_status: 'Closed', ship_label: 'Live Sun 10-25', summary: 'Sign-in for everyone.',
      dates: { opened: '2026-10-24', deployed: '2026-10-25', closed: '2026-10-26' },
      phases: [{ label: 'build', from: '2026-10-24', to: '2026-10-25', state: 'done' }],
      milestones: [{ date: '2026-10-25', label: 'live', short: 'live', state: 'done' }],
      steps: [{ label: 'Merge', done: true, date: '2026-10-24' }, { label: 'Deploy', done: true, date: '2026-10-25' }],
      features: ['f-login', 'f-reset'], tests: ['t-login'], decisions: ['d-1'],
      merges: [{ repo: 'web', branch: 'feature/login', commit: 'abc123', status: 'merged', mr: null, date: '2026-10-24' }],
      commands: [{ id: 'c-old', label: 'Deploy R1', status: 'done', code: 'deploy r1' }], recommendations: [], risks: [], links: [],
    },
    {
      id: 'R2', title: 'Reports', status: 'deploying', short_status: 'Deploying', ship_label: 'Mon 11-02',
      milestones: [{ date: '2026-11-02 16:00', label: 'go live', state: 'planned' }],
      steps: [{ label: 'Cut', done: true }, { label: 'Merge', done: false }, { label: 'Deploy', done: false }],
      features: ['f-reports', 'f-export'], tests: ['t-reports'], decisions: ['d-2'], merges: [],
      commands: [{ id: 'c-merge', label: 'Merge into dev', when: 'this weekend', status: 'pending', code: 'git switch dev\ngit merge feature/reports  # the branch', expect: 'clean', if_not: 'abort' }],
      recommendations: ['Merge before Monday.'], risks: ['The migration is slow.'], links: [{ label: 'Plan', item: 'mvbbbbbb-0123456789abcdef' }],
    },
  ],
  features: [
    { id: 'f-login', name: 'Login', what: 'Sign in with a password.', release: 'R1', status: 'live', repos: ['web'], items: [], headline: true, session: null },
    { id: 'f-reset', name: 'Password reset', what: 'Reset by email.', release: 'R1', status: 'live', repos: ['web'], items: [], session: null },
    { id: 'f-reports', name: 'Reports', what: 'Monthly reports.', release: 'R2', status: 'merged', repos: ['web', 'api'], items: ['mvaaaaaa-0123456789abcdef'], session: 'Reports' },
    { id: 'f-export', name: 'Export', what: 'CSV export.', release: 'R2', status: 'planned', repos: ['api'], items: [], blockers: 'waits for reports', session: null },
  ],
  tests: [
    { id: 't-login', title: 'Login test', item: 'mvcccccc-0123456789abcdef', release: 'R1', status: 'passed', date: '2026-10-25', owner: 'QA' },
    { id: 't-reports', title: 'Reports test', item: 'mvcccccc-0123456789abcdef', release: 'R2', status: 'scheduled', date: '2026-11-03', owner: 'QA', note: null },
  ],
  decisions: [
    { id: 'd-1', code: null, date: '2026-10-24', title: 'Use email links', choice: 'Links, not codes.', status: 'decided', item: 'mvdddddd-0123456789abcdef', release: 'R1' },
    { id: 'd-2', code: 'D2', date: '2026-10-29', title: 'Report format', choice: 'PDF or CSV?', status: 'open', item: 'mvdddddd-0123456789abcdef', release: 'R2' },
  ],
  events: [
    { id: 'e-swap', date: '2026-11-01 16:00', title: 'Server swap', kind: 'infra', status: 'planned', item: 'mveeeeee-0123456789abcdef', detail: 'Swap the servers.', steps: ['stop', 'swap', 'start'] },
    { id: 'e-old', date: '2026-10-20', title: 'Old event', kind: 'infra', status: 'done', item: 'mveeeeee-0123456789abcdef', detail: 'Done before.' },
  ],
  sessions: [
    { name: 'Reports', state: 'working', status: 'in_progress', now: 'Writing the export', item: 'mvffffff-0123456789abcdef' },
    { name: 'Release', state: 'waiting', status: 'waiting', now: 'Waiting for the merge', item: 'mvffffff-0123456789abcdef' },
  ],
  repos: [{ repo: 'web', live: 'abc123', master: 'abc123', dev: 'def456', note: 'clean' }],
  log: [
    { time: '2026-10-30 11:00', text: 'R2 cut', item: 'mvaaaaaa-0123456789abcdef', release: 'R2' },
    { time: '2026-10-25 10:00', text: 'R1 live', item: 'mvaaaaaa-0123456789abcdef', release: 'R1' },
  ],
  briefs: [{ code: 'B1', title: 'Reports brief', status: 'in_progress', detail: 'Build reports.', release: 'R2', owner: 'Reports', item: 'mvaaaaaa-0123456789abcdef', items: [] }],
};

