---
name: feature-workflow
description: Standard workflow for developing features. Follow this process for all non-trivial changes - from planning through PR merge. Ensures proper testing, review, and CI verification.
metadata:
  author: opencode-reflection-plugin
  version: "1.0"
---

# Feature Development Workflow

A structured 11-step process for developing features that ensures quality, traceability, and proper review.

## Prerequisites

- Git repository initialized
- GitHub CLI (`gh`) authenticated
- Access to run tests (unit and E2E)
- Todo tool available for tracking progress

---

## The 11-Step Process

### Step 1: Create a Plan

Before writing any code, plan the work:

```markdown
## Feature: [Name]

### Goal
[One sentence describing what we're building]

### Why
[Problem this solves or value it provides]

### Scope
- [ ] What's included
- [ ] What's NOT included (explicit boundaries)

### Technical Approach
1. [High-level step 1]
2. [High-level step 2]
3. [etc.]

### Risks / Open Questions
- [Any unknowns or concerns]
```

**Use the Todo tool** to capture each major task from the plan.

---

### Step 2: Create GitHub Issue (if not exists)

Check for existing issue or create one:

```bash
# Search for existing issue
gh issue list --repo OWNER/REPO --search "feature keywords"

# Create new issue if needed
gh issue create --repo OWNER/REPO \
  --title "feat: [Feature Name]" \
  --body "$(cat <<'EOF'
## Summary
[Brief description]

## Motivation
[Why this is needed]

## Proposed Solution
[High-level approach]

## Acceptance Criteria
- [ ] Criterion 1
- [ ] Criterion 2
- [ ] Tests pass
- [ ] Documentation updated
EOF
)"
```

**Record the issue number** for linking in commits and PR.

---

### Step 3: Define Task Scope in Issue

Update the issue with detailed scope:

```bash
gh issue comment ISSUE_NUMBER --body "$(cat <<'EOF'
## Implementation Plan

### Design
[Architecture decisions, data flow, etc.]

### Files to Modify
- `path/to/file1.ts` - [what changes]
- `path/to/file2.ts` - [what changes]

### New Files
- `path/to/new.ts` - [purpose]

### Testing Strategy
- Unit tests for [X]
- E2E tests for [Y]
- Manual verification of [Z]

### Out of Scope
- [Explicitly list what this PR won't do]
EOF
)"
```

---

### Step 4: Fetch Latest Changes

Always start from up-to-date main:

```bash
git fetch origin
git status  # Check for uncommitted changes
```

**If you have uncommitted changes**, either:
- Commit them to current branch
- Stash them: `git stash`
- Discard them: `git checkout -- .`

---

### Step 5: Create Feature Branch

Branch naming convention: `feat/issue-number-short-description`

```bash
# Create and checkout new branch from origin/main
git checkout -b feat/123-add-telegram-replies origin/main

# Or for fixes
git checkout -b fix/456-race-condition origin/main
```

**Update Todo tool**: Mark "Create branch" as complete.

---

### Step 6: Implement the Feature

Write the code following these principles:

1. **Small, focused commits** - Each commit should be atomic
2. **Commit message format**:
   ```
   type(scope): short description
   
   - Detail 1
   - Detail 2
   
   Closes #123
   ```
3. **Types**: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`
4. **Reference issue** in commits: `#123` or `Closes #123`

**Update Todo tool** after each significant piece of work.

---

### Step 7: Test End-to-End (No Mocks)

**Critical: Real testing, not mocked data.**

```bash
# 1. Run type checking
npm run typecheck

# 2. Run unit tests
npm test

# 3. Run E2E tests (REQUIRED for any plugin changes)
OPENCODE_E2E=1 npm run test:e2e

# 4. Manual verification
#    - Test the actual feature with real data
#    - For Telegram: send real messages
#    - For TTS: verify audio plays
#    - For reflection: verify judge runs
```

**If tests fail, fix before proceeding.** Do not skip failing tests.

**Add automated tests** for new functionality:
- Unit tests for pure logic
- Integration tests for component interactions
- E2E tests for user-facing flows

---

### Step 8: Create Pull Request

```bash
# Ensure branch is pushed
git push -u origin HEAD

# Create PR linking to issue
gh pr create \
  --title "feat: [Short description] (#ISSUE)" \
  --body "$(cat <<'EOF'
## Summary
[What this PR does]

## Changes
- [Change 1]
- [Change 2]

## Testing
- [ ] Unit tests pass
- [ ] E2E tests pass
- [ ] Manual testing completed

## Screenshots/Logs
[If applicable]

Closes #ISSUE_NUMBER
EOF
)"
```

---

### Step 9: Review PR

Self-review checklist:

```bash
# View the full diff
gh pr diff

# Check files changed
gh pr view --json files
```

**Review for:**
- [ ] No debug code or console.logs left
- [ ] No hardcoded secrets or credentials
- [ ] Error handling is appropriate
- [ ] Code is readable and well-commented
- [ ] No unrelated changes included
- [ ] Commit history is clean

**Clean up if needed:**
```bash
# Squash fixup commits
git rebase -i origin/main

# Force push after rebase (only on feature branch!)
git push --force-with-lease
```

---

### Step 10: Update GitHub Issue

Post implementation summary to the issue:

```bash
gh issue comment ISSUE_NUMBER --body "$(cat <<'EOF'
## Implementation Complete

### What was done
- [Summary of changes]

### Files changed
- `path/to/file.ts` - [description]

### How to test
1. [Step 1]
2. [Step 2]

### PR
#PR_NUMBER
EOF
)"
```

---

### Step 11: Wait for CI Checks to Pass

```bash
# Watch CI status
gh pr checks --watch

# Or check run status
gh run list --limit 5

# View specific run logs if failed
gh run view RUN_ID --log-failed
```

**If CI fails:**
1. Read the failure logs
2. Fix the issue locally
3. Push the fix
4. Wait for CI again

**Only merge when all checks pass.**

```bash
# Merge when ready (if you have permission)
gh pr merge --squash --delete-branch
```

---

## Quick Reference

| Step | Command | Todo Status |
|------|---------|-------------|
| 1. Plan | Document in markdown | `pending` |
| 2. Issue | `gh issue create` | `pending` |
| 3. Scope | `gh issue comment` | `pending` |
| 4. Fetch | `git fetch origin` | `in_progress` |
| 5. Branch | `git checkout -b feat/...` | `in_progress` |
| 6. Implement | Write code, commit | `in_progress` |
| 7. Test | `npm test && npm run test:e2e` | `in_progress` |
| 8. PR | `gh pr create` | `in_progress` |
| 9. Review | `gh pr diff` | `in_progress` |
| 10. Update Issue | `gh issue comment` | `in_progress` |
| 11. CI Pass | `gh pr checks --watch` | `completed` |

---

## Common Issues

| Issue | Cause | Solution |
|-------|-------|----------|
| CI fails on push | Tests not run locally | Always run `npm test` before pushing |
| Merge conflicts | Branch out of date | `git rebase origin/main` |
| E2E tests timeout | Model too slow | Increase timeout or use faster model |
| PR has unrelated changes | Wrong base branch | Rebase onto correct branch |
| Forgot to link issue | Missing `Closes #N` | Edit PR body to add it |

---

## Anti-Patterns to Avoid

1. **Pushing directly to main** - Always use feature branches
2. **Skipping tests** - Tests exist for a reason
3. **Large PRs** - Break into smaller, focused changes
4. **Mocked E2E tests** - Real tests catch real bugs
5. **Ignoring CI failures** - Fix before merge, never skip
6. **No issue tracking** - Issues provide context and history
7. **Vague commit messages** - Be specific about what changed
8. **Force pushing to main** - Never force push to shared branches
