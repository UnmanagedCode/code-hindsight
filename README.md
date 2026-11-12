# code-hindsight

A code-conductor (cc) plugin that runs [Hindsight](https://hindsight.vectorize.io), an agent memory server, in Docker, shows its control-plane UI inside cc, and gives cc sessions scoped memory.

**Status: not implemented.** This repository holds only the scaffold. There is no plugin manifest and no backend yet.

## Functional description

Planned behavior:

- Run Hindsight in Docker from either a full image or a slim image.
- Import the Hindsight image from an offline tarball, for machines without registry access.
- Embed the Hindsight control-plane UI in cc.
- Give each cc session memory scoped to that session's work.

## Technical description

- Stack: undecided. No code exists.
- Components: none yet. The planned pieces are a cc plugin manifest, a backend that manages the Docker container, and the embedded UI.
- Run, test, extend: no commands exist yet.
- Known limitations: everything above is planned, not built.

## Layout

```
README.md                          this file
CLAUDE.md, CONVENTIONS.md          workspace conventions loaded into agent sessions
.code-conductor/post-worktree-create.sh   links the project wiki into new worktrees
```
