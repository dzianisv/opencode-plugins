# Plan

Goal: Update reflection-3 to enforce completion gates with GenAI verification (tests, PR/CI, no skipped tests, no direct push).

Checklist:
- [x] Update reflection-3 workflow requirements for tests/PR/CI and command evidence
- [x] Align self-assessment prompt and evaluation logic with new gates
- [x] Update reflection-3 unit tests for new enforcement
- [x] Run required tests: npm run typecheck, npm test, npm run test:load, OPENCODE_E2E=1 npm run test:e2e
- [x] Update plan.md with completion status
