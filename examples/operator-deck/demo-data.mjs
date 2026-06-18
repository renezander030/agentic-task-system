// Curated demo deck for the always-on public surface (and the README GIF /
// LinkedIn carousel). Same card shape the live engine emits, but hand-written
// so the public deck never exposes real tasks and approve never mutates anything
// (demo mode forces dry-run). Swap DECK_DEMO off to run against the real corpus.
export const DEMO_SUGGESTIONS = [
  {
    id: 'demo-relate-oauth',
    kind: 'relate',
    score: 0.9,
    front: { badge: 'Relate', title: 'Add OAuth login (Google + GitHub)', subtitle: '↔ Provision OAuth client credentials' },
    back: { heading: 'Why', body: 'Both are the same OAuth rollout but nothing links them. Approving files a Related link so the prerequisite surfaces alongside the feature — and the agent stops proposing them separately.' },
  },
  {
    id: 'demo-relate-launch',
    kind: 'relate',
    score: 0.84,
    front: { badge: 'Relate', title: 'Write the Q3 launch post', subtitle: '↔ Q3 launch — landing page copy' },
    back: { heading: 'Why', body: 'Same launch, drafted in parallel by different people. Linking keeps the post and the landing copy consistent as both change.' },
  },
  {
    id: 'demo-archive-kafka',
    kind: 'archive',
    score: 0.7,
    front: { badge: 'Archive', title: 'Spike: Kafka vs RabbitMQ', subtitle: 'Overdue 47 days' },
    back: { heading: 'Why', body: 'No movement for 47 days and the queue decision already shipped. Approving sets lifecycle: archived (reversible) so dead context stops steering planning.' },
  },
  {
    id: 'demo-relate-churn',
    kind: 'relate',
    score: 0.66,
    front: { badge: 'Relate', title: 'Customer churn analysis', subtitle: '↔ Design the re-engagement email' },
    back: { heading: 'Why', body: 'The analysis feeds the email flow. Linking makes the handoff explicit for whoever picks up the re-engagement work.' },
  },
  {
    id: 'demo-relate-fde',
    kind: 'relate',
    score: 0.61,
    front: { badge: 'Relate', title: 'FDE-044: AI Engineer (Python + React + MCP)', subtitle: '↔ FDE-055: FullStack AI Developer' },
    back: { heading: 'Why', body: 'Near-duplicate role specs sitting apart. Linking flags them as the same search so they do not drift out of sync.' },
  },
  {
    id: 'demo-archive-ci',
    kind: 'archive',
    score: 0.55,
    front: { badge: 'Archive', title: 'Migrate CI to CircleCI', subtitle: 'Overdue 90 days' },
    back: { heading: 'Why', body: 'Superseded by the GitHub Actions migration that already landed. Archive to clear it off the live board without losing the record.' },
  },
];
