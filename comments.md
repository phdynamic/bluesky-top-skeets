# Documenting and Tracking App Development

**What this is:** instructions for an AI agent working in this
repository. Read this file first. Set up the documentation structure
below — create a `docs/` folder and the files inside it, as needed —
before or alongside the first real work on the project. This file
itself stays at the repo root; everything it describes goes in
`docs/`.

## When to use the full structure

Use everything below for a project that will run across multiple
sessions and matters enough that continuity between sessions is worth
the overhead of maintaining docs. For a quick script or one-off, skip
this — a short README is enough.

## Layout

All files below live under `<project-root>/docs/`, including the
index files. App code stays at the project root, outside `docs/`.

## File map

| File | Purpose | Expected churn |
|---|---|---|
| `docs/CLAUDE.md` | Entry point. Reading order, routing table to everything else, core principles/concept, architecture notes that rarely change. | Low |
| `docs/STATUS.md` | Build-status snapshot — what's built, what's tested, what's not. | High (most sessions) |
| `docs/DECISIONS.md` | Index of the themed decision files below it. No per-decision table — search the themed files directly. | Low |
| `docs/decisions/<theme>.md` | The *why* behind non-obvious choices, one file per theme (chosen per project, see below). Status-flagged (`active` / `superseded` / `partly superseded`) with a blockquoted pointer when superseded. | Medium |
| `docs/BUILD-LOG.md` | Index of build-log eras. | Low |
| `docs/build-log/<era>.md` | The *when* — dated, bullet-only entries. Append only, never rewritten. Start a new era file at a phase boundary or ~40KB, whichever comes first. | High |
| `docs/standing-rules.md` | Recurring technical lessons, each line a pointer to its source entry. | Medium |
| `docs/NEXT-SESSION.txt` | Where development was left off. Points at `TESTING-OWED.md` when relevant — never restates its contents. | High |
| `docs/TESTING-OWED.md` | Running backlog of live checks owed on the developer's machine, each with how to test and what should happen. Kept separate from `NEXT-SESSION.txt` — it's the testing backlog, not necessarily the current task. | Medium |

## Setting up a new project

1. Ask the developer: project name, one-line concept (or point to an
   existing scope/spec doc), repo location, and anything about how
   they want sessions and handoffs to work — that's theirs to set, not
   assumed here.
2. Create `docs/CLAUDE.md` first — index and routing table, even
   before the routed-to files exist. Link placeholders are fine.
3. Create `docs/decisions/` and `docs/build-log/` with one themed/era
   file each — don't over-split before there's content to split.
4. Create `docs/STATUS.md`, `docs/NEXT-SESSION.txt`,
   `docs/TESTING-OWED.md` as empty skeletons with their headers.
5. Confirm the skeleton with the developer before populating it with
   real content — structure gets reviewed before content does.

## Maintaining it (every session)

- **Build-log entries:** bullets only, no narrative connective
  sentences. What changed, why, build version if any, what's
  unverified — as fixed short tags, not rewritten prose ("live-tested:
  no" beats a sentence saying so). If a past entry turns out wrong, add
  a new entry plus a one-line blockquoted pointer under the old one —
  never edit or delete history.
- **Decisions:** one entry per non-obvious choice, in the matching
  themed file, in date order. Use the status flag + blockquoted pointer
  pattern for anything superseded. No master table to update.
- **Spec/CLAUDE.md:** when behavior changes, update the routed-to file
  in the same session. Don't leave it describing something that no
  longer exists.
- **Tighten before filing, not after:** before writing any log or
  decision entry, cut it to the minimum that would still make sense to
  a future session with no other context. This is a standing
  instruction, not a one-time cleanup pass.
- **Deviating from a documented decision:** write a new entry proposing
  the change and ask the developer before implementing. Never silently
  override.
- **When in doubt, write it down** — a short note is cheap, a missing
  one is expensive. But keep it short.

## Decision themes (choose per project)

Pick 3-6 themes that match the actual domains of this project — don't
reuse a theme list written for a different kind of app. For example, a
web app might split into architecture-and-process, data-model,
ui-and-interaction, integrations-and-external-services; a CLI tool or
backend service would split differently again. Ask the developer if
it's unclear, rather than guessing.
