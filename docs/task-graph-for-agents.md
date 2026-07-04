# Task Graphs For Agents

Most task systems are designed for humans: titles, notes, due dates, and
checkboxes. That is useful, but it is not enough when agents execute work across
projects, repositories, websites, and publishing surfaces.

For an agent, the task system is closer to a program graph. The important
question is not only:

> What task should I do?

It is:

> What state may I change, what proof do I need, and which downstream system
> depends on the result?

Graph-first systems such as Zerolang make this distinction explicit for code:
the readable projection is useful for humans, but the checked structure is what
the agent should query and patch. ATS applies the same idea to task execution.

## Task text is not enough

An agent should not treat the title and body as the whole source of truth. It
needs structured handles:

- project
- trunk
- owner
- route
- adapter
- due date
- source task
- target writeback
- proof command
- review requirement
- completion policy
- public-facing risk

If these fields exist only as prose, every agent has to infer them on every run.
That creates drift and collisions: two agents can grab the same work, publish
without review, or mark a task complete when the real finish line was approval.

## The graph model

In ATS, a task can be treated as a node with edges:

- this task belongs to this trunk
- this task updates this repo
- this task depends on this blocker
- this task writes back to this target
- this task has this proof command
- this task needs this human review
- this task supersedes this earlier decision

Once the structure is explicit, agents can do less guessing. They can query
current state, update the narrow field they own, leave review artifacts, and
produce readback proof after a write.

## Production-shaped agent work

The common failure mode is not that the model cannot write code or text. The
failure mode is that the workflow around the model stays informal:

- no deterministic definition of done
- no durable approval step
- no business-specific regression tests
- no audit trail
- no separation between "agent finished work" and "human approved release"

ATS helps keep that workflow attached to the task spine:

- `ats intent` records outcome, why, and done-when.
- `ats link` records typed relationships such as `depends-on`, `decision`, and
  `output`.
- `ats lifecycle` prevents stale context from steering current work.
- `ats ledger` records what an agent did and whether the task advanced.
- `ats context` retrieves the graph around the work instead of relying on a
  chat transcript.

## Practical rule

Do not let the agent own the finish line. The agent may propose the change, but
the task graph should say what proof is required, where the result is written,
and whether a human review is still blocking completion.
