# Reflection & Judging for Coding Agents: Research Summary

## Overview

This document synthesizes academic research on self-reflection, LLM-as-judge, and feedback mechanisms for coding agents.

**Critical Finding:** Pure self-reflection without external feedback degrades performance (Huang et al., ICLR 2024). Execution-based verification is mandatory for code tasks.

---

## Key Papers

### 1. Reflexion: Verbal Reinforcement Learning
**arXiv:2303.11366 | NeurIPS 2023 | Shinn et al.**

- Agents reflect verbally on task feedback, storing reflections in episodic memory
- Achieves 91% pass@1 on HumanEval (vs 80% GPT-4 baseline)
- Memory accumulation across attempts improves performance

**Architecture:**
```
Actor → Evaluator → Self-Reflect → Memory → Actor (next attempt)
```

### 2. Self-Refine: Iterative Refinement
**arXiv:2303.17651 | NeurIPS 2023 | Madaan et al.**

- Single LLM: generator, critic, refiner
- No training required, works at inference time
- ~20% absolute improvement across 7 tasks

**Loop:**
```
Generate → Critique → Refine → (repeat until stop)
```

### 3. Self-Debugging for Code
**arXiv:2304.05128 | ICLR 2024 | Chen et al. (DeepMind)**

- "Rubber duck debugging": model explains code line-by-line to find errors
- Works without error messages in some cases
- +12% accuracy with unit tests, +2-3% without

### 4. LLM-as-Judge
**arXiv:2306.05685 | NeurIPS 2023 | Zheng et al.**

- GPT-4 achieves >80% human agreement (matches human-human)
- Key biases: position, verbosity, self-enhancement
- Mitigations: position swapping, reference-guided judging, chain-of-thought

### 5. Cannot Self-Correct Reasoning
**arXiv:2310.01798 | ICLR 2024 | Huang et al. (DeepMind)**

- Intrinsic self-correction (without external feedback) **degrades** performance
- Self-correction works ONLY with external feedback signals
- Asking models to "check their work" can make correct answers wrong

### 6. CRITIC: Tool-Interactive Correction
**arXiv:2305.11738 | ICLR 2024 | Gou et al.**

- LLMs can self-correct when using external tools for validation
- Tools: code interpreter, search engine, calculator
- External tool feedback is crucial; pure self-reflection insufficient

### 7. Constitutional AI
**arXiv:2212.08073 | Anthropic**

- Self-improvement through critique and revision against principles
- Two phases: SL (critique+revise) + RLAIF (preference learning)

---

## Best Practices

### DO
1. **Always use external feedback** - execution results, test outcomes, linter output
2. **Structured rubrics** with clear scoring criteria
3. **Chain-of-thought judging** - require reasoning before verdict
4. **Concrete, actionable feedback** - reference specific failures
5. **Only inject feedback on failure** - success should not trigger loops
6. **Position bias mitigation** - swap order in pairwise comparisons

### DON'T
1. Ask models to "double-check" without external signals
2. Self-correct without execution feedback
3. Inject feedback on successful completions (causes infinite loops)
4. Use vague feedback ("try harder", "be more careful")
5. Trust intrinsic self-evaluation for reasoning tasks

---

## Recommended Judge Prompt Structure

```
## Task Given
{original_task}

## Agent Output
{code_and_actions}

## Execution Results
{test_results}  ← CRITICAL: External signal

## Evaluation Criteria
1. Functional correctness (tests pass?)
2. Completeness (all requirements?)
3. Quality (clean, readable?)

## Instructions
Analyze step-by-step, then output:
VERDICT: PASS or VERDICT: FAIL
If FAIL: specific, actionable feedback referencing concrete failures.
```

---

## Optimal Architecture for Coding Agents

```
┌─────────────────────────────────────┐
│          REFLECTION LOOP            │
├─────────────────────────────────────┤
│ 1. Agent executes task              │
│ 2. External verification:           │
│    - Execute tests                  │
│    - Run linter/typecheck           │
│    - Capture failure signals        │
│ 3. Judge evaluates with rubric      │
│    - Chain-of-thought reasoning     │
│    - PASS → done, FAIL → feedback   │
│ 4. Inject targeted feedback         │
│    - Reference concrete failures    │
│ 5. Agent retries (max N attempts)   │
└─────────────────────────────────────┘
```

---

## Code-Specific Evaluation Rubric

| Score | Criteria |
|-------|----------|
| 5 | All tests pass, handles edge cases, clean code, efficient, follows idioms |
| 4 | Primary tests pass, minor edge case issues, generally clean |
| 3 | Most tests pass (>70%), some logic errors, functional but messy |
| 2 | Few tests pass (<50%), major errors, hard to maintain |
| 1 | Doesn't run or completely wrong |

---

## Severity Classification

| Level | Criteria | Action |
|-------|----------|--------|
| BLOCKER | Security, auth, data loss, E2E broken | Must fix, complete=false |
| HIGH | Major functionality degraded, CI red | Must fix |
| MEDIUM | Partial degradation, uncertain coverage | Should fix |
| LOW | Cosmetic, non-impacting | Optional |
| NONE | No issues OR waiting for user input | Pass or wait |

---

## References

1. Shinn, N. et al. (2023). Reflexion: Language Agents with Verbal Reinforcement Learning. arXiv:2303.11366
2. Madaan, A. et al. (2023). Self-Refine: Iterative Refinement with Self-Feedback. arXiv:2303.17651
3. Chen, X. et al. (2023). Teaching Large Language Models to Self-Debug. arXiv:2304.05128
4. Zheng, L. et al. (2023). Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena. arXiv:2306.05685
5. Huang, J. et al. (2023). Large Language Models Cannot Self-Correct Reasoning Yet. arXiv:2310.01798
6. Gou, Z. et al. (2023). CRITIC: Large Language Models Can Self-Correct with Tool-Interactive Critiquing. arXiv:2305.11738
7. Bai, Y. et al. (2022). Constitutional AI: Harmlessness from AI Feedback. arXiv:2212.08073
8. Kim, S. et al. (2023). Prometheus: Inducing Fine-grained Evaluation Capability. arXiv:2310.08491
