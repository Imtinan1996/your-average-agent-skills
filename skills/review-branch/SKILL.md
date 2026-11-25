---
name: review-branch
description: Production-readiness review of a whole feature branch, across every repo the feature touches. Reviews everything from the merge-base with main (or a base the user names) up to the working tree, so all of the branch's commits plus any uncommitted work on top. Run only when the user asks for it by name.
disable-model-invocation: true
---

# Review a feature branch

Review the **whole branch**: every commit since it left the base, plus any uncommitted or untracked work on top. The goal is to decide whether the feature is ready for production and to hand back a PR description.

For a review of uncommitted work only, the user has a separate skill (`review-uncommitted`). Do not narrow this review to uncommitted changes.

## 1. Find the changes

### Repos

The feature may span several repos (for example a frontend and a backend). Start with the current repo, then check the session's other working directories and any repos the user names. For each one:

```bash
git -C <repo> branch --show-current
```

- A repo on `main` (or the base) carries no feature changes. Do not review it as part of the feature, but do check that the changed repos still integrate with it.
- If only one repo has changes, the feature lives there; still verify it against the others.
- If several repos have changes, review them as one feature.
- If a repo has the feature on a branch that is not checked out, do not switch branches. Tell the user and ask.

### Base

Use `main` unless the user names another base. Compare against whichever of `main` and `origin/main` is closer to HEAD, so a stale local `main` does not pull other people's merged work into the review. Do not fetch.

```bash
mb_local=$(git -C <repo> merge-base main HEAD 2>/dev/null)
mb_origin=$(git -C <repo> merge-base origin/main HEAD 2>/dev/null)
# Take origin's merge-base when it exists and is the newer of the two.
MB=$mb_local
if [ -n "$mb_origin" ] && { [ -z "$mb_local" ] || git -C <repo> merge-base --is-ancestor "$mb_local" "$mb_origin"; }; then
  MB=$mb_origin
fi
```

### The diff

```bash
git -C <repo> log --oneline "$MB"..HEAD                  # the branch's commits
git -C <repo> diff "$MB"                                 # merge-base -> working tree, staged and unstaged
git -C <repo> diff --stat HEAD                           # what is still uncommitted
git -C <repo> ls-files --others --exclude-standard       # untracked files: read them whole
```

Review the accumulated change, not only the latest commit. Note in the report which parts are still uncommitted.

## 2. Understand the feature

Before judging individual files:

- Work out what the feature is for and the user flow it supports.
- Work out how the frontend and backend talk to each other for it.
- Read the surrounding code where needed to understand the architecture and existing patterns.

Do not review the diff in isolation. Understand how the feature works end to end.

## 3. Review

### Backend

Evaluate correctness, business logic, validation, error handling, security, database access, query efficiency, scalability, maintainability, API design, backward compatibility, and consistency with existing patterns.

Look for missing validation, wrong assumptions, data-integrity problems, N+1 or otherwise inefficient queries, missing indexes, migration risks, race conditions, and missing logging or monitoring.

### Frontend

Evaluate user experience, state management, data flow, error handling, loading and empty states, accessibility, performance, maintainability, and consistency with existing patterns.

Look for wrong assumptions about backend behaviour, missed edge cases, poor state handling, unhandled errors, needless complexity, and rendering problems.

### Frontend ↔ backend integration

Check the whole round trip: endpoints, request payloads, response shapes, field names, data types, enum values, validation rules, error handling, and authentication/authorization. The frontend's expectations must match what the backend does, and nothing should rest on an unstated assumption between repos.

### Tests

Review the tests that cover the feature. Name the missing unit, integration, API, frontend and end-to-end tests and the uncovered edge cases. For each, say what scenario to test and why it matters.

### Risk

Look for regressions, breaking changes, hidden assumptions, production-only failures, race conditions, performance problems, deployment and migration risks, and backward-compatibility concerns.

## 4. Report

### Feature summary

What was implemented, how the frontend and backend work together, and the overall flow.

### Repository changes

Per repo: current branch, base and merge-base, commit count, files changed, a summary of the changes, and what is still uncommitted.

### Positive findings

Implementation decisions that are well made.

### Issues found

For each issue:

- **Severity:** Critical, High, Medium or Low
- **Location:** repo, file(s), line numbers where possible
- **Description:** what is wrong
- **Impact:** what could happen
- **Recommended fix:** how to address it

### Missing test coverage

The tests to add, and why.

### End-to-end validation

Assess the backend, the frontend and their integration, and state plainly whether the feature appears functionally correct.

### Production readiness

One of: **Ready to Merge**, **Ready with Minor Fixes**, **Requires Changes Before Merge**. Give a confidence level (High, Medium or Low) and the main reasons.

### PR description

A GitHub PR description ready to paste, with these sections:

- **Summary:** a short overview of the feature
- **Changes:** the key changes as bullet points
- **Testing:** what was tested and the coverage added
- **Notes:** caveats, assumptions, deployment steps

---

Be thorough. Prefer real issues over generic advice. Review as a senior engineer doing the last check before production.
