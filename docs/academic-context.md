# Academic Verification of Reflection Layers in Coding Agents

This document synthesizes key academic research validating the architectural decisions behind **Reflection-3** (structured self-assessment, execution-based verification, and escalating feedback).

## Core Thesis
Recent literature (2023-2024) consistently demonstrates that **LLMs cannot reliability self-correct code without external execution signals**, and that **agentic loops with structured reflection** significantly outperform single-shot generation.

---

## 1. The Necessity of External Feedback (Execution)

**"Large Language Models Cannot Self-Correct Reasoning Yet"**
*Huang et al. (Google DeepMind, UIUC), ICLR 2024*
[arXiv:2310.01798](https://arxiv.org/abs/2310.01798)

> **Finding:** Intrinsic self-correction (asking the model "is this correct?") often degrades performance.
> **Relevance:** Validates Reflection-3's design choice to **never** trust a model's verbal "I fixed it" claim without `evidence.tests` or `evidence.build`.
> **Key Quote:** *"LLMs struggle to self-correct reasoning without external feedback... performance often deteriorates after self-correction."*

**"InterCode: Standardizing and Benchmarking Interactive Coding Agents"**
*Yang et al. (Princeton, UT Austin), NeurIPS 2023*
[arXiv:2306.14897](https://arxiv.org/abs/2306.14897)

> **Finding:** Agents that interact with a shell/interpreter to run code outperform those that only generate code. The "execution-feedback loop" is the primary driver of success.
> **Relevance:** Supports Reflection-3's **Action Loop Detector** and **Test Verification** gates. The agent must *interact* (run tests), not just *act* (write code).

## 2. Structured Reflection Architectures

**"Reflexion: Language Agents with Verbal Reinforcement Learning"**
*Shinn et al. (Northeastern, MIT), NeurIPS 2023*
[arXiv:2303.11366](https://arxiv.org/abs/2303.11366)

> **Finding:** Adding a "Reflector" agent that verbally analyzes failures and stores them in memory improves HumanEval pass@1 from 80% (GPT-4) to 91%.
> **Relevance:** This is the direct ancestor of the "Reflection" concept. Reflection-3 implements a **structured** version of this, forcing the reflection to be about *workflow gates* (tests/CI) rather than just abstract reasoning.

**"LATS: Language Agent Tree Search"**
*Zhou et al. (UIUC, UPenn), 2023*
[arXiv:2310.04406](https://arxiv.org/abs/2310.04406)

> **Finding:** Combining Monte Carlo Tree Search with LLM reflection allows agents to "backtrack" and try alternative paths when tests fail.
> **Relevance:** Validates the **Escalating Feedback** and **Attempt Counter** in Reflection-3. If an approach fails (tests don't pass), the agent is nudged to "rethink the approach" (backtrack) rather than blindly retry.

## 3. The "Agent-Computer Interface" (ACI)

**"SWE-agent: Agent-Computer Interfaces Enable Automated Software Engineering"**
*Yang et al. (Princeton), 2024*
[arXiv:2405.15793](https://arxiv.org/abs/2405.15793)

> **Finding:** The interface exposed to the agent matters as much as the model. Agents need "lint-check" and "test-run" commands that return concise, actionable feedback.
> **Relevance:** Reflection-3 acts as a **middleware** for this ACI. It detects when the agent is using the interface poorly (e.g., "Planning Loop": reading files without action) and injects feedback to correct the usage pattern.

## 4. LLM-as-a-Judge for Verification

**"Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena"**
*Zheng et al. (UC Berkeley), NeurIPS 2023*
[arXiv:2306.05685](https://arxiv.org/abs/2306.05685)

> **Finding:** Strong LLMs (GPT-4) match human agreement levels (>80%) when evaluating the quality of text/code, *provided* they are prompted correctly (chain-of-thought, rubrics).
> **Relevance:** Justifies the **Self-Assessment** and **Cross-Model Review** mechanisms. We use the model to judge *its own* workflow compliance, which requires careful prompt engineering (as detailed in `evals/prompts/task-verification.txt`) to avoid "self-enhancement bias."

## 5. Automated Debugging Loops

**"Teaching Large Language Models to Self-Debug"**
*Chen et al. (Google DeepMind), ICLR 2024*
[arXiv:2304.05128](https://arxiv.org/abs/2304.05128)

> **Finding:** Asking the model to "explain the code line-by-line" (rubber ducking) before fixing a bug improves fix rates.
> **Relevance:** Supports the **Stuck Detection** logic. When Reflection-3 detects a stuck agent, it prompts for a "plan" or "alternate approach," effectively triggering this self-debugging mode.

---

## Synthesis: Why Reflection-3 Works

The academic consensus points to a "Dual System" architecture for coding agents:
1.  **System 1 (Actor):** The coding model (OpenCode/Codex) that generates tokens. Fast, intuitive, prone to errors.
2.  **System 2 (Critic/Reflector):** The verification layer (Reflection-3). Slower, deliberate, checks execution results, enforces constraints.

Reflection-3 operationalizes these papers into a concrete CLI plugin:
- **Huang et al. (2024)** $\rightarrow$ We enforce `evidence.tests` (external feedback).
- **Shinn et al. (2023)** $\rightarrow$ We inject verbal feedback on failure (Reflexion).
- **Yang et al. (2024)** $\rightarrow$ We detect "Planning Loops" to fix ACI misuse.
- **Zheng et al. (2023)** $\rightarrow$ We use structured prompts to minimize judge bias.
