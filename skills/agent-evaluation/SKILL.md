---
name: agent-evaluation
description: Evaluate GenAI agent task execution using LLM-as-judge. Produces structured scores (0-5), feedback, and improvement recommendations.
metadata:
  author: opencode-reflection-plugin
  version: "1.0"
---

# Agent Evaluation Skill

Evaluate AI agent task execution using world-class LLM-as-judge patterns from DeepEval, RAGAS, and G-Eval frameworks.

## Output Format

Evaluation results are saved to `evals/results/eval-${yyyy-mm-dd-hh-mm}-${commit_id}.md`

### Results Table

| Task Input | Agent Output | Reflection Input | Reflection Output | Score | Verdict | Feedback |
|------------|--------------|------------------|-------------------|-------|---------|----------|
| Create hello.js... | I've created hello.js with... | Task: Create hello.js Agent Output: ... | Task complete | 5/5 | COMPLETE | Agent produced output; Found completion indicators |
| Fix the bug... | I found the issue and... | Task: Fix bug Agent Output: ... | (none) | 3/5 | PARTIAL | Agent produced output; Missing reflection |

### Run Evaluation

```bash
# Run E2E evaluation
npx tsx eval.ts

# Or via npm
npm run eval:e2e

# Output saved to: evals/results/eval-2026-01-28-12-30-abc1234.md
```

---

## Evaluation Rubric (0-5)

| Score | Verdict | Criteria |
|-------|---------|----------|
| **5** | COMPLETE | Task fully accomplished. All requirements met. Optimal execution. |
| **4** | MOSTLY_COMPLETE | Task done with minor issues. 1-2 suboptimal steps. |
| **3** | PARTIAL | Core objective achieved but significant gaps or errors. |
| **2** | ATTEMPTED | Progress made but failed to complete. Correct intent, wrong execution. |
| **1** | FAILED | Wrong approach or incorrect result. |
| **0** | NO_ATTEMPT | No meaningful progress. Crashed or no output. |

**Pass threshold**: >= 3 (development), >= 4 (production)

---

## Evaluation Prompt Template

Use this prompt for LLM-as-judge evaluation:

```
You are an expert evaluator assessing AI agent task completion.

## Original Task
{{task}}

## Execution Trace
{{trace}}

## Final Output
{{output}}

## Evaluation Criteria
1. Was the core objective achieved?
2. Were appropriate tools selected?
3. Were tool arguments correct?
4. Was execution efficient (minimal steps)?
5. Is the final output accurate and complete?

## Scoring Rubric
- 5: COMPLETE - All requirements met perfectly
- 4: MOSTLY_COMPLETE - Minor issues only
- 3: PARTIAL - Core done but significant gaps
- 2: ATTEMPTED - Progress made but failed
- 1: FAILED - Wrong approach or result
- 0: NO_ATTEMPT - No meaningful progress

## Instructions
1. Analyze the execution step-by-step
2. Identify specific issues or strengths
3. Score using the rubric
4. Provide actionable recommendations

## Response Format (JSON only)
{
  "reasoning": "<step-by-step analysis>",
  "score": <0-5>,
  "verdict": "<COMPLETE|MOSTLY_COMPLETE|PARTIAL|ATTEMPTED|FAILED|NO_ATTEMPT>",
  "feedback": "<1-2 sentence summary>",
  "recommendations": ["<improvement 1>", "<improvement 2>"]
}
```

---

## Quick Evaluation Playbook

### Step 1: Extract Data

```bash
# Get task from session
TASK=$(cat .reflection/session_*.json | jq -r '.task' | head -1)

# Get execution trace (last 20 messages)
TRACE=$(opencode session messages --limit 20 --format json)

# Get final output
OUTPUT=$(opencode session messages --last --format text)
```

### Step 2: Run Evaluation

```bash
# Using promptfoo (recommended)
cd evals && npx promptfoo eval \
  -c agent-eval.yaml \
  --var task="$TASK" \
  --var trace="$TRACE" \
  --var output="$OUTPUT" \
  -o results/eval-$(date +%s).json

# Or using direct API call
curl -X POST "https://api.openai.com/v1/chat/completions" \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o-mini",
    "messages": [{"role": "user", "content": "<EVAL_PROMPT>"}],
    "response_format": {"type": "json_object"}
  }' | jq '.choices[0].message.content | fromjson'
```

### Step 3: Parse Results

```bash
# Extract score and feedback
cat results/eval-*.json | jq '{
  score: .score,
  verdict: .verdict,
  feedback: .feedback,
  recommendations: .recommendations
}'
```

---

## Metrics Reference

### Core Agent Metrics

| Metric | Type | Description |
|--------|------|-------------|
| Task Completion | 0-5 | Overall goal achievement |
| Tool Correctness | binary | Right tools selected |
| Argument Accuracy | 0-1 | Tool arguments correct |
| Step Efficiency | 0-1 | Minimal steps to goal |

### Composite Scores

```
overall_score = (
  task_completion * 0.5 +
  tool_correctness * 0.2 +
  argument_accuracy * 0.2 +
  step_efficiency * 0.1
)
```

---

## promptfoo Config Example

Create `evals/agent-eval.yaml`:

```yaml
description: Agent task completion evaluation

prompts:
  - file://prompts/agent-evaluation.txt

providers:
  - id: azure:gpt-4.1-mini
    config:
      apiHost: eastus.api.cognitive.microsoft.com
      deployment_id: gpt-4.1-mini

defaultTest:
  assert:
    - type: is-json
    - type: javascript
      value: output.score >= 0 && output.score <= 5

tests:
  - vars:
      task: "Create a hello.js file that prints Hello World"
      trace: |
        1. Agent reads current directory
        2. Agent creates hello.js with console.log("Hello World")
        3. Agent confirms file created
      output: "Created hello.js with console.log('Hello World')"
    assert:
      - type: javascript
        value: JSON.parse(output).score >= 4
```

---

## Integration with Reflection Plugin

The reflection plugin uses this evaluation pattern internally:

```typescript
// reflection-3.ts - simplified evaluation flow
async function evaluateTask(sessionId: string): Promise<Evaluation> {
  const task = extractInitialTask(messages)
  const trace = formatExecutionTrace(messages)
  const output = extractFinalOutput(messages)
  
  const response = await llm.chat({
    messages: [{ role: "user", content: buildEvalPrompt(task, trace, output) }],
    response_format: { type: "json_object" }
  })
  
  return JSON.parse(response.content)
}
```

---

## Benchmarks

### Standard Test Cases

| # | Task | Expected Score | Notes |
|---|------|----------------|-------|
| 1 | Create file | 5 | Simple, single tool |
| 2 | Multi-file refactor | 4+ | Multiple edits |
| 3 | Debug test failure | 3+ | Iterative process |
| 4 | Research question | 4+ | Read-only, synthesis |

### Running Benchmarks

```bash
# Run full benchmark suite
npm run eval

# Run specific benchmark
npm run eval:judge

# View results
npm run eval:view
```

---

## Best Practices

1. **Always include reasoning** - Makes debugging possible
2. **Use structured JSON output** - Parse reliably
3. **Score consistently** - Same rubric across all evals
4. **Track over time** - Catch regressions
5. **Calibrate with humans** - Validate judge accuracy periodically
6. **Separate outcome vs process** - Score both what and how

---

## Troubleshooting

| Issue | Cause | Solution |
|-------|-------|----------|
| Score always 5 | Prompt too lenient | Add explicit failure criteria |
| Score always low | Rubric too strict | Calibrate with human evals |
| JSON parse error | LLM not following format | Add response_format constraint |
| Inconsistent scores | Ambiguous criteria | Make rubric more specific |
| Slow evaluation | Large trace | Truncate to last N messages |
