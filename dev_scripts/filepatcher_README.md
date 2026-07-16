# Safe Repository Patcher — LLM Bootstrap Guide

> **Purpose**
>
> This document is intended to bootstrap an LLM before it generates repository patches.
>
> It describes how the patch system works, what guarantees it provides, and how patches should be authored.
>
> The goal is not merely to edit files.
>
> The goal is to preserve repository integrity while implementing requested changes.

—

# Repository Philosophy

This repository should **never** be modified through arbitrary code edits.

Instead, modifications are expressed as **structured JSON change contracts**.

The patch engine is responsible for safely applying those contracts.

The patch engine exists because successful text replacement **does not imply repository correctness.**

Repository integrity always takes precedence over implementing new functionality.

If a requested feature would violate repository integrity, the patch should refuse to apply.

—

# Primary Workflow

Always think in this order.

```
User Request
      │
      ▼
Understand Intent
      │
      ▼
Reason About Repository
      │
      ▼
Determine Required Changes
      │
      ▼
Determine Repository Risks
      │
      ▼
Generate JSON Patch
      │
      ▼
Stop
```

Do **not** rewrite source files directly unless explicitly requested.

The primary artifact is the JSON patch.

—

# Repository Mental Model

Treat the repository as a graph.

```
Files
 │
 ├── exports
 │
 ├── imports
 │
 ├── dependencies
 │
 ├── consumers
 │
 └── references
```

Every edit potentially changes the graph.

Always consider:

- imports
- exports
- dependency edges
- reverse dependency edges
- symbol ownership
- file ownership
- API contracts

before proposing modifications.

—

# Fundamental Principle

Never think:

> “How do I edit this file?”

Instead think:

> “How does this repository evolve safely?”

—

# Patch Philosophy

A patch is **not** a text replacement script.

It is a repository change contract.

It should describe:

- assumptions
- intended edits
- repository risks
- dependency implications
- validation requirements
- expected end state

The patch engine validates those assumptions before any file is modified.

—

# Always Prefer Small Patches

Small isolated patches are preferred.

Instead of:

```
Huge rewrite
```

Prefer:

```
Patch A

↓

Validation

↓

Patch B

↓

Validation

↓

Patch C
```

Smaller patches:

- fail less often
- are easier to review
- isolate regressions
- simplify rollback

—

# Think About Dependencies

Whenever removing or replacing something ask:

```
Who imports this?

Who references this?

Who depends on this?

Who exports this?

Who owns this responsibility?
```

Never assume something is unused.

—

# Deletion Policy

Deleting code is considered dangerous.

Always ask:

Should this instead be:

- wrapped?
- redirected?
- replaced?
- moved?
- deprecated?

Delete only when intentional.

—

# Replacement Policy

Whenever functionality changes, identify:

Old symbol

↓

Replacement symbol

↓

Old file

↓

Replacement file

↓

Consumers

↓

Imports

↓

Exports

A replacement should preserve behavior unless the feature intentionally changes it.

—

# File Operations

The patch engine understands operations such as:

```
replace
append
prepend
delete
write
create
overwrite
remove_file
move_file
```

Choose the operation that best communicates intent.

Never use overwrite when create expresses intent better.

Never emulate deletion by emptying a file.

Use remove_file.

—

# Preconditions

Every patch should declare assumptions whenever possible.

Examples:

- file exists
- file does not exist
- file contains text
- file does not contain text
- expected SHA256
- valid JSON
- valid Python

These protect against stale patches.

—

# Postconditions

Always describe the expected repository state.

Examples:

- file exists
- symbol exists
- replacement completed
- deleted reference removed
- expected text exists

Postconditions are repository assertions.

—

# Hash Validation

Whenever replacing an entire file, prefer SHA256 validation.

This prevents applying a patch against an unexpected repository revision.

—

# Repository Risks

The patch engine requires explicit acknowledgement of dangerous operations.

Risks include:

```
overwrite_files

delete_files

move_files

change_dependencies

modify_package_manifest
```

Only acknowledge risks actually performed.

If a risk is declared but never occurs, validation should fail.

—

# Dependency Changes

Whenever replacing functionality declare:

- symbol removed
- symbol added
- replacement mapping
- replacement file

Do not silently change repository wiring.

—

# Protected Paths

Some locations are intentionally protected.

Examples include:

```
.git

node_modules

.env

package-lock.json
```

Never modify protected paths unless explicitly requested.

—

# Transactional Behavior

The patch engine applies patches transactionally.

Workflow:

```
Read repository

↓

Validate assumptions

↓

Stage all edits

↓

Validate staged repository

↓

Run structural validation

↓

Run dependency validation

↓

Run build/test commands

↓

Commit atomically
```

If anything fails:

```
Rollback
```

No partial repository state should remain.

—

# Structural Validation

The patch engine validates supported file types.

Examples include:

- JSON
- Python

Future versions may validate:

- TypeScript
- JavaScript
- CSS
- YAML

Do not generate malformed files.

—

# Dependency Validation

The patch engine checks for:

- deleted files still imported
- moved files still referenced
- deleted symbols still referenced
- replacement files missing
- replacement symbols missing

Always think about dependency graphs before proposing edits.

—

# Validation Commands

The patch may request repository validation commands such as:

```
npm run lint

npm test

npm run typecheck
```

Only request validation relevant to the change.

—

# Dry Run

Recommend:

```bash
npm run patch — —dry-run
```

before applying a real patch.

Dry runs validate the entire repository without modifying files.

—

# Patch History

Each patch should have a unique ID.

Applied patches are recorded.

Avoid generating duplicate IDs.

—

# Backup Philosophy

Backups are automatic.

Every patch should remain individually reversible.

Never rely solely on Git for recovery.

—

# Think Like an Architect

You are not editing text.

You are evolving a software system.

Always preserve:

- readability
- architecture
- dependency integrity
- repository consistency
- explicit intent

—

# Expected Workflow

When asked to implement a feature:

1. Understand the request.
2. Identify affected files.
3. Identify affected symbols.
4. Identify dependency changes.
5. Identify repository risks.
6. Determine required file operations.
7. Define preconditions.
8. Define postconditions.
9. Define validation commands.
10. Generate the JSON patch.
11. Stop.

Do **not** continue by generating modified source files unless explicitly requested.

The JSON patch is the primary artifact.

—

# Guiding Principle

> **The repository is more valuable than the feature being added.**

If implementing a feature would leave the repository in an inconsistent or unverifiable state, refuse the patch and explain why.

Correctness is measured by the integrity of the entire repository, not by whether a single file compiles or a single replacement succeeds.