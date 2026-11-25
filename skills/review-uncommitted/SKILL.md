---
name: review-uncommitted
description: Production-readiness review of uncommitted work only (staged, unstaged and untracked files) across every repo in the workspace. The branch's existing commits are not reviewed. Run only when the user asks for it by name.
disable-model-invocation: true
---

# Review uncommitted changes

Review **only the work that is not yet committed**: staged changes, unstaged changes and new untracked files. The goal is to decide whether this increment is ready to commit and merge, and to hand back a PR description.

**Do not review the branch's existing commits.** Read committed code only as context for understanding the uncommitted changes. For a review of the whole branch, the user has a separate skill (`review-branch`).

## 1. Find the changes

Start with the current repo, then check the session's other working directories and any repos the user names. For each repo:

```bash
git -C <repo> branch --show-current
git -C <repo> status --short
git -C <repo> diff HEAD                               # staged and unstaged changes to tracked files
git -C <repo> ls-files --others --exclude-standard    # untracked files: read them whole
```

Use `git diff HEAD`, not plain `git diff`: plain `git diff` leaves out everything already staged. A repo with a clean working tree has nothing to review; say so and move on. If no repo has uncommitted changes, tell the user and stop.

Read the surrounding committed code where needed to understand the architecture, existing patterns and what the changes build on.

## 2. Review

### Backend

Evaluate correctness, business logic, validation, error handling, security, database access, query efficiency, scalability, maintainability, and consistency with existing patterns.

Look for missing validation, wrong assumptions, data-integrity problems, inefficient queries, migration risks and race conditions.

### Frontend

Evaluate user experience, state management, data flow, error handling, loading and empty states, accessibility, performance, maintainability, and consistency with existing patterns.

Look for wrong assumptions about backend behaviour, missed edge cases, poor state handling, unhandled errors and needless complexity.

### Frontend ↔ backend integration

Check endpoints, payloads, response handling, field names, data types, enum values, validation rules and error handling. Name any integration risk, including mismatches between the uncommitted changes and committed code they depend on.

### Tests

Name the missing unit, integration and end-to-end tests and the uncovered edge cases. For each, say what scenario to test and why it matters.

### Risk

Look for regressions, breaking changes, hidden assumptions, production-only failures, race conditions and performance problems.

## 3. Report

### Feature summary

A short summary of what the uncommitted changes implement.

### Files reviewed

Grouped by repo, then backend and frontend, with each file marked staged, unstaged or untracked.

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

Assess the backend, the frontend and their integration, and state plainly whether the changes appear functionally correct.

### Production readiness

One of: **Ready to Merge**, **Ready with Minor Fixes**, **Requires Changes Before Merge**. Give a confidence level (High, Medium or Low) and the main reasons.

### PR description

If the changes are acceptable, a GitHub PR description ready to paste, with these sections:

- **Summary:** a short overview of the change
- **Changes:** the key changes as bullet points
- **Testing:** what was tested and the coverage added
- **Notes:** caveats, assumptions, deployment steps

---

Be thorough. Prefer real issues over generic advice. Review as a senior engineer doing the last check before production.
