// Curated demo deck for the always-on public surface (and the README GIF /
// LinkedIn carousel). Each card carries the referenced items with the adapter
// they came from (the agent cycles adapters on its cadence wakeups and links
// across systems with semantic search) plus one verb-led GTD action.
// Dry-run only — no real tasks.
export const DEMO_SUGGESTIONS = [
  {
    id: 'demo-link-mail-cal', kind: 'relate', score: 0.92,
    items: [
      { adapter: 'gmail', title: 'Re: Q3 contract — legal review' },
      { adapter: 'gcal', title: 'Hold: contract review' },
    ],
    action: 'Link the email thread to its calendar hold',
    back: { heading: 'Why', body: 'The thread and the calendar hold are the same review. Linking keeps the agenda anchored to the discussion that drives it.' },
  },
  {
    id: 'demo-link-oauth', kind: 'relate', score: 0.9,
    items: [
      { adapter: 'notion', title: 'OAuth integration spec' },
      { adapter: 'ticktick', title: 'Add OAuth login (Google + GitHub)' },
    ],
    action: 'Link the spec to its build task',
    back: { heading: 'Why', body: 'The Notion spec and the TickTick task are the same OAuth work in two systems. Linking them keeps the build pointing back to the spec.' },
  },
  {
    id: 'demo-link-adr', kind: 'relate', score: 0.86,
    items: [
      { adapter: 'obsidian', title: 'ADR: event-driven data layer' },
      { adapter: 'ticktick', title: 'Implement the new data layer' },
    ],
    action: 'Link the decision note to its task',
    back: { heading: 'Why', body: 'The Obsidian decision record and the TickTick task are the same work. Linking keeps the rationale next to the build.' },
  },
  {
    id: 'demo-link-churn', kind: 'relate', score: 0.7,
    items: [
      { adapter: 'confluence', title: 'Churn analysis — Q2' },
      { adapter: 'ticktick', title: 'Design the re-engagement email' },
    ],
    action: 'Link the analysis to the email task',
    back: { heading: 'Why', body: 'The Confluence analysis feeds the email flow. Linking makes the handoff explicit for whoever picks up the work.' },
  },
  {
    id: 'demo-archive-kafka', kind: 'archive', score: 0.66,
    items: [{ adapter: 'ticktick', title: 'Spike: Kafka vs RabbitMQ' }],
    action: 'Archive this stale spike',
    back: { heading: 'Why', body: 'No movement for 47 days and the queue decision already shipped. Archiving (reversible) stops dead context steering planning.' },
  },
  {
    id: 'demo-merge-fde', kind: 'relate', score: 0.61,
    items: [
      { adapter: 'ticktick', title: 'FDE-044: AI Engineer (Python + React)' },
      { adapter: 'ticktick', title: 'FDE-055: FullStack AI Developer' },
    ],
    action: 'Merge these duplicate role specs',
    back: { heading: 'Why', body: 'Near-duplicate role specs sitting apart. Linking them as the same search keeps them from drifting out of sync.' },
  },
  {
    id: 'demo-drop-ci', kind: 'archive', score: 0.55,
    items: [{ adapter: 'ticktick', title: 'Migrate CI to CircleCI' }],
    action: 'Drop this superseded migration',
    back: { heading: 'Why', body: 'Superseded by the GitHub Actions migration that already landed. Archive to clear it off the live board without losing the record.' },
  },
];
