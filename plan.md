# Plan

## Issue #57: Reflection JSON output visible to user

Goal: Fix TTS and Telegram plugins so they skip reflection-injected messages (self-assessment JSON, feedback) and show/speak the actual user-facing assistant response instead.

Checklist:
- [x] Identify root cause: reflection-3 injects assessment prompt, agent responds with JSON that becomes last visible message
- [x] Fix `tts.ts`: add `findReflectionCutoffIndex()` using marker constants, rewrite `extractFinalResponse()` to skip past reflection messages
- [x] Fix `telegram.ts`: replace fragile `findStaticReflectionPromptIndex()` with marker-based detection, forward scan
- [x] Add tests in `test/tts.test.ts` for reflection message filtering (9 tests)
- [x] Run typecheck, test, test:load — all pass (1 flaky Whisper timeout is pre-existing on main)
- [x] Update plan.md
- [ ] Commit and create PR for issue #57

## Issue #60: (next)
- [ ] Read issue and plan work
