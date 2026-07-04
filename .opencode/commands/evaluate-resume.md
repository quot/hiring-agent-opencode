---
description: Evaluate a resume PDF using the project-local OpenCode resume evaluator
agent: build
---

Evaluate the resume PDF passed in `$ARGUMENTS`.

If `$ARGUMENTS` is empty, ask the user for a resume PDF path and do not call any tools yet.

Use the `resume_evaluate` tool with:
- `pdf_path`: `$ARGUMENTS`
- `include_github`: true
- `write_artifacts`: true
- `output_format`: "both"

After the tool returns, summarize the tool output for the user.

Include:
- overall score
- category scores
- key evidence
- strengths
- improvement areas
- bonus points
- deductions
- warnings, if any
- artifact paths, if present

Do not re-score the candidate yourself.
Do not add new evaluation criteria.
Treat the `resume_evaluate` tool result as the source of truth.
