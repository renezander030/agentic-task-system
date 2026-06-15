#!/usr/bin/env node
import fs from 'node:fs';

const statePath = process.env.ATS_BEADS_PROOF_STATE;
if (!statePath) throw new Error('ATS_BEADS_PROOF_STATE is required.');
const read = () => JSON.parse(fs.readFileSync(statePath, 'utf8'));
const write = (issues) => fs.writeFileSync(statePath, `${JSON.stringify(issues, null, 2)}\n`);
const args = process.argv.slice(2).filter((arg) => arg !== '--json');
const command = args[0];
const flag = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const output = (value) => process.stdout.write(JSON.stringify(value));

if (command === '--version') {
  process.stdout.write('bd version synthetic-proof');
  process.exit(0);
}

const issues = read();
if (command === 'list') output(issues);
else if (command === 'show') output(issues.filter((issue) => issue.id === args[1]));
else if (command === 'create') {
  const issue = {
    id: `bd-demo-new${issues.length + 1}`,
    title: args[1],
    description: flag('--description') || '',
    status: 'open',
    priority: Number(flag('--priority') || 2),
    issue_type: 'task',
    labels: (flag('--labels') || '').split(',').filter(Boolean),
    created_at: '2026-06-15T00:00:00Z',
    updated_at: '2026-06-15T00:00:00Z',
    dependencies: [],
  };
  issues.push(issue);
  write(issues);
  output(issue);
} else if (command === 'update') {
  const issue = issues.find((item) => item.id === args[1]);
  if (!issue) process.exit(2);
  if (flag('--title') !== undefined) issue.title = flag('--title');
  if (flag('--description') !== undefined) issue.description = flag('--description');
  if (flag('--priority') !== undefined) issue.priority = Number(flag('--priority'));
  if (flag('--set-labels') !== undefined) issue.labels = flag('--set-labels').split(',').filter(Boolean);
  if (flag('--due') !== undefined) {
    if (flag('--due')) issue.due_at = flag('--due');
    else delete issue.due_at;
  }
  issue.updated_at = '2026-06-16T00:00:00Z';
  write(issues);
  output([issue]);
} else if (command === 'close') {
  const issue = issues.find((item) => item.id === args[1]);
  issue.status = 'closed';
  write(issues);
  output([issue]);
} else if (command === 'delete') {
  write(issues.filter((item) => item.id !== args[1]));
  output({ deleted: [args[1]] });
} else {
  process.stderr.write(`Unsupported synthetic bd command: ${args.join(' ')}`);
  process.exit(2);
}
