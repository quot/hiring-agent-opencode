# Hiring Agent

OpenCode-first resume evaluation pipeline that extracts structured data from PDFs, enriches with GitHub signals, and produces an auditable score report.

## Overview

Use `/evaluate-resume ./path/to/resume.pdf` inside OpenCode. The command delegates to the project-local OpenCode plugin, which calls deterministic Python helpers plus structured OpenCode prompts.

## Setup

- Python 3.11+
- OpenCode installed for this workspace
- Optional `GITHUB_TOKEN` for GitHub API rate limits

Install Python dependencies:

```bash
pip install -r requirements.txt
```

Restart OpenCode after changing anything under `.opencode/`.

## Usage

Evaluate a resume in OpenCode:

```text
/evaluate-resume ./path/to/candidate.pdf
```

Deterministic helper CLI commands are available for debugging and validation:

```text
python opencode_bridge.py schema evaluation
python opencode_bridge.py extract-text ./path/to/candidate.pdf
python opencode_bridge.py render-prompt basics --input /path/to/input.json
python opencode_bridge.py validate evaluation --input /path/to/evaluation.json
```

## Configuration

Runtime configuration is now mostly handled by OpenCode and `.opencode/` files.

- `GITHUB_TOKEN` is optional and only improves GitHub API rate limits.
- Legacy provider environment settings are retired.

## Repository Layout

```text
.
├── .opencode/
├── opencode_bridge.py
├── models.py
├── transform.py
├── prompts/
├── pymupdf_rag.py
├── requirements.txt
└── README.md
```

## Legacy Flow

`score.py` and the old provider-specific modules are retired. They remain only as migration stubs for anyone still invoking the pre-OpenCode flow.
