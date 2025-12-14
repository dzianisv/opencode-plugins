# OpenCode Reflection Plugin - Development Guidelines

## Critical Learnings

### 1. SDK Timeout Issues - NEVER Use Blocking `prompt()` for Long Operations

**Problem:** The OpenCode SDK's `client.session.prompt()` is a blocking call with a ~90 second timeout. Slower models like Claude Opus 4.5 can exceed this timeout, causing silent failures.

**Solution:** Always use `promptAsync()` + polling for any LLM calls:

```typescript
// WRONG - will timeout with slow models
await client.session.prompt({ path: { id }, body: { parts: [...] } })

// CORRECT - non-blocking with polling
await client.session.promptAsync({ path: { id }, body: { parts: [...] } })
const response = await waitForResponse(id, TIMEOUT_MS) // poll for completion
```

**Key constants:**
- `JUDGE_RESPONSE_TIMEOUT = 180_000` (3 minutes for Opus 4.5)
- `POLL_INTERVAL = 2_000` (2 seconds between polls)

### 2. Tests Must Fail, Never Skip

**Rule:** Tests must fail on LLM errors, not silently skip. Silent skips hide real bugs.

```typescript
// WRONG - hides failures
if (!result.success && result.error?.includes("LLM")) {
    console.log(`[Test] SKIPPED: ${result.error}`)
    return // BUG: Test appears to pass!
}

// CORRECT - fails loudly
assert.ok(result.success, `Session did not complete: ${result.error}`)
```

**Action items when modifying LLM-related code:**
1. Run E2E tests with `OPENCODE_E2E=1 npm run test:e2e`
2. Tests MUST fail if LLM times out or errors
3. Test manually with the actual model (Opus 4.5) before committing
4. Ensure test timeout (120s) accommodates model response time + polling

### 3. Preserve Async Polling Patterns

**History:** Commit 67016b8 added polling (60s). Commit 6d57db0 accidentally removed it during refactoring, assuming `prompt()` returns synchronously. This broke Opus 4.5 support.

**Rule:** When refactoring, preserve these async patterns:
- `waitForJudgeResponse()` - polls for judge completion
- `waitForSessionIdle()` - polls for session completion
- `shouldSkipSession()` - checks session state before reflection

### 4. Infinite Loop Prevention Layers

The plugin has 5 defense layers against infinite reflection loops. Do not remove any:

1. `judgeSessions.has()` - fast path for known judge sessions
2. `reflectingSessions.has()` - blocks concurrent reflection on same session
3. `shouldSkipSession("empty")` - catches newly created sessions
4. `shouldSkipSession("judge")` - catches judge sessions by content analysis
5. `extractInitialTask()` null check - final defense before reflection runs

### 5. Judge Session Lifecycle

```
1. Create judge session → immediately add to judgeSessions set
2. Send prompt with promptAsync → non-blocking
3. Poll for response → waitForJudgeResponse()
4. Process verdict
5. Cleanup in finally block → remove from judgeSessions set
```

## Testing Checklist

Before committing changes to reflection logic:

- [ ] `npm run typecheck` passes
- [ ] Unit tests pass: `npm test`
- [ ] E2E tests pass with real LLM: `OPENCODE_E2E=1 npm run test:e2e`
- [ ] Check E2E logs for "SKIPPED" (hidden failures)
- [ ] Manual test with Opus 4.5 (slowest model)
- [ ] Verify no "Already reflecting" spam in logs
- [ ] Verify judge sessions are properly skipped

## Architecture

```
┌─────────────────┐
│  User Session   │
│  (session.idle) │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ shouldSkipSession│ ─── skip if judge/empty
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  runReflection  │
│  (async + poll) │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Judge Session  │ ─── tracked in judgeSessions set
│  (promptAsync)  │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ waitForJudge    │ ─── polls up to 3 minutes
│ Response        │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Parse Verdict  │
│  PASS or FAIL   │
└─────────────────┘
```
