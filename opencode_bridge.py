import argparse
import datetime
import json
import os
import re
import sys
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ValidationError

from models import (
    AwardsSection,
    BasicsSection,
    EducationSection,
    EvaluationData,
    GitHubProfile,
    GitHubSelectedProjects,
    JSONResume,
    ProjectsSection,
    SkillsSection,
    WorkSection,
)
from prompts.template_manager import TemplateManager
from transform import (
    convert_github_data_to_text,
    convert_json_resume_to_text,
    transform_parsed_data,
)


SECTION_MODELS: dict[str, type[BaseModel]] = {
    "basics": BasicsSection,
    "work": WorkSection,
    "education": EducationSection,
    "skills": SkillsSection,
    "projects": ProjectsSection,
    "awards": AwardsSection,
}

MODEL_ALIASES: dict[str, type[BaseModel]] = {
    **SECTION_MODELS,
    "resume": JSONResume,
    "json_resume": JSONResume,
    "evaluation": EvaluationData,
    "evaluation_data": EvaluationData,
    "github_profile": GitHubProfile,
    "github_selected_projects": GitHubSelectedProjects,
    "selected_projects": GitHubSelectedProjects,
}

SECTION_NAMES = tuple(SECTION_MODELS.keys())


def fail(message: str, exit_code: int = 1) -> None:
    print(message, file=sys.stderr)
    raise SystemExit(exit_code)


def load_json(path: str) -> Any:
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except FileNotFoundError:
        fail(f"Input file not found: {path}")
    except json.JSONDecodeError as error:
        fail(f"Invalid JSON in {path}: {error}")


def dump_json(data: Any) -> None:
    print(json.dumps(data, indent=2, ensure_ascii=False))


def model_for_name(model_name: str) -> type[BaseModel]:
    normalized_name = model_name.lower().replace("-", "_")
    model = MODEL_ALIASES.get(normalized_name)
    if model is None:
        valid_names = ", ".join(sorted(MODEL_ALIASES))
        fail(f"Unknown model '{model_name}'. Valid models: {valid_names}")
    return model


def validate_model(model_name: str, data: Any) -> BaseModel:
    model = model_for_name(model_name)
    try:
        return model.model_validate(data)
    except ValidationError as error:
        fail(f"Validation failed for {model_name}:\n{error}")


def extract_pdf_markdown(pdf_path: str) -> str:
    path = Path(pdf_path)
    if not path.exists():
        fail(f"PDF file not found: {pdf_path}")
    if not path.is_file():
        fail(f"PDF path is not a file: {pdf_path}")

    try:
        import pymupdf

        from pymupdf_rag import to_markdown

        with pymupdf.open(path) as doc:
            return to_markdown(doc, pages=range(doc.page_count)) or ""
    except ModuleNotFoundError as error:
        fail(f"Missing PDF extraction dependency: {error.name}")
    except Exception as error:
        fail(f"Failed to extract text from PDF '{pdf_path}': {error}")


def template_manager() -> TemplateManager:
    template_dir = Path(__file__).resolve().parent / "prompts" / "templates"
    return TemplateManager(str(template_dir))


def payload_text(payload: dict[str, Any]) -> str:
    for key in ("text_content", "resume_text", "markdown", "text"):
        value = payload.get(key)
        if isinstance(value, str):
            return value
    fail("Input JSON must include one of: text_content, resume_text, markdown, text")


def render_prompt(task: str, payload: dict[str, Any]) -> str:
    manager = template_manager()

    if task in SECTION_MODELS:
        rendered = manager.render_template(task, text_content=payload_text(payload))
    elif task == "system_message":
        section_name = payload.get("section_name") or payload.get("section_name_param")
        if not section_name:
            fail("system_message requires section_name or section_name_param")
        rendered = manager.render_template(
            "system_message", section_name_param=section_name
        )
    elif task == "github_project_selection":
        projects_data = payload.get("projects_data", payload.get("projects"))
        if projects_data is None:
            fail("github_project_selection requires projects_data or projects")
        if not isinstance(projects_data, str):
            projects_data = json.dumps(projects_data, indent=2, ensure_ascii=False)
        rendered = manager.render_template(task, projects_data=projects_data)
    elif task == "resume_evaluation_criteria":
        rendered = manager.render_template(
            task, text_content=evaluation_input_text(payload)
        )
    elif task == "resume_evaluation_system_message":
        rendered = manager.render_template(task)
    else:
        valid_tasks = sorted(
            [
                *SECTION_MODELS,
                "github_project_selection",
                "resume_evaluation_criteria",
                "resume_evaluation_system_message",
                "system_message",
            ]
        )
        fail(f"Unknown prompt task '{task}'. Valid tasks: {', '.join(valid_tasks)}")

    if rendered is None:
        fail(f"Failed to render prompt task: {task}")
    return rendered


def normalize_section(section: str, data: Any) -> dict[str, Any]:
    if section not in SECTION_MODELS:
        fail(f"Unknown section '{section}'. Valid sections: {', '.join(SECTION_NAMES)}")
    transformed = transform_parsed_data(data)
    validated = validate_model(section, transformed)
    return validated.model_dump(mode="json")


def merge_resume_sections(sections_dir: str) -> dict[str, Any]:
    directory = Path(sections_dir)
    if not directory.is_dir():
        fail(f"Sections path is not a directory: {sections_dir}")

    merged: dict[str, Any] = {
        "basics": None,
        "work": None,
        "volunteer": None,
        "education": None,
        "awards": None,
        "certificates": None,
        "publications": None,
        "skills": None,
        "languages": None,
        "interests": None,
        "references": None,
        "projects": None,
    }

    for section in SECTION_NAMES:
        section_path = directory / f"{section}.json"
        if not section_path.exists():
            continue
        section_data = normalize_section(section, load_json(str(section_path)))
        merged.update(section_data)

    resume = validate_model("resume", merged)
    return resume.model_dump(mode="json")


def extract_github_username(github_url: str) -> str | None:
    if not github_url:
        return None

    github_url = github_url.strip().replace(" ", "")
    patterns = [
        r"https?://github\.com/([^/?#]+)",
        r"github\.com/([^/?#]+)",
        r"@([^/?#]+)",
        r"^([a-zA-Z0-9-]+)$",
    ]
    for pattern in patterns:
        match = re.search(pattern, github_url)
        if match:
            username = match.group(1)
            if username in {"", "orgs", "users", "repos", "topics"}:
                return None
            return username
    return None


def github_headers() -> dict[str, str]:
    headers = {"Accept": "application/vnd.github+json"}
    token = os.environ.get("GITHUB_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def fetch_github_api(api_url: str, params: dict[str, Any] | None = None) -> Any:
    try:
        import requests
    except ModuleNotFoundError as error:
        fail(f"Missing GitHub fetch dependency: {error.name}")

    response = requests.get(
        api_url, params=params, headers=github_headers(), timeout=15
    )
    if response.status_code == 404:
        return None
    if response.status_code >= 400:
        fail(f"GitHub API error {response.status_code} for {api_url}: {response.text}")
    return response.json()


def contribution_counts(owner: str, repo_name: str) -> tuple[int, int, int]:
    contributors = fetch_github_api(
        f"https://api.github.com/repos/{owner}/{repo_name}/contributors"
    )
    if not isinstance(contributors, list):
        return 0, 0, 0

    author_commit_count = 0
    total_commit_count = 0
    for contributor in contributors:
        if not isinstance(contributor, dict):
            continue
        contributions = int(contributor.get("contributions") or 0)
        total_commit_count += contributions
        if str(contributor.get("login", "")).lower() == owner.lower():
            author_commit_count = contributions
    return author_commit_count, total_commit_count, len(contributors)


def fetch_github(github_url: str, max_repos: int) -> dict[str, Any]:
    username = extract_github_username(github_url)
    if not username:
        fail(f"Could not extract GitHub username from: {github_url}")

    profile_data = fetch_github_api(f"https://api.github.com/users/{username}")
    if not profile_data:
        fail(f"GitHub user not found: {username}")

    profile = GitHubProfile(
        username=username,
        name=profile_data.get("name"),
        bio=profile_data.get("bio"),
        location=profile_data.get("location"),
        company=profile_data.get("company"),
        public_repos=profile_data.get("public_repos"),
        followers=profile_data.get("followers"),
        following=profile_data.get("following"),
        created_at=profile_data.get("created_at"),
        updated_at=profile_data.get("updated_at"),
        avatar_url=profile_data.get("avatar_url"),
        blog=profile_data.get("blog"),
        twitter_username=profile_data.get("twitter_username"),
        hireable=profile_data.get("hireable"),
    )

    repos_data = fetch_github_api(
        f"https://api.github.com/users/{username}/repos",
        params={"sort": "updated", "per_page": min(max_repos, 100), "type": "all"},
    )
    projects = []
    for repo in repos_data or []:
        if not isinstance(repo, dict):
            continue
        if repo.get("fork") and int(repo.get("forks_count") or 0) < 5:
            continue

        repo_name = repo.get("name") or ""
        author_commits, total_commits, contributor_count = contribution_counts(
            username, repo_name
        )
        project_type = "open_source" if contributor_count > 1 else "self_project"
        projects.append(
            {
                "name": repo_name,
                "description": repo.get("description"),
                "github_url": repo.get("html_url"),
                "live_url": repo.get("homepage") or None,
                "technologies": [repo.get("language")] if repo.get("language") else [],
                "project_type": project_type,
                "contributor_count": contributor_count,
                "author_commit_count": author_commits,
                "total_commit_count": total_commits,
                "github_details": {
                    "stars": repo.get("stargazers_count", 0),
                    "forks": repo.get("forks_count", 0),
                    "language": repo.get("language"),
                    "description": repo.get("description"),
                    "created_at": repo.get("created_at"),
                    "updated_at": repo.get("updated_at"),
                    "topics": repo.get("topics", []),
                    "open_issues": repo.get("open_issues_count", 0),
                    "size": repo.get("size", 0),
                    "fork": repo.get("fork", False),
                    "archived": repo.get("archived", False),
                    "default_branch": repo.get("default_branch"),
                    "contributors": contributor_count,
                },
            }
        )

    projects.sort(key=lambda project: project["github_details"]["stars"], reverse=True)
    return {
        "profile": profile.model_dump(mode="json"),
        "projects": projects,
        "total_projects": len(projects),
        "fetched_at": datetime.datetime.now(datetime.UTC).isoformat(),
    }


def evaluation_input_text(payload: dict[str, Any]) -> str:
    if isinstance(payload.get("text_content"), str):
        return payload["text_content"]

    resume_data = payload.get("resume") or payload.get("resume_data")
    if resume_data is None:
        return payload_text(payload)

    resume = validate_model("resume", resume_data)
    text = convert_json_resume_to_text(resume)

    github_data = payload.get("github") or payload.get("github_data")
    if github_data:
        text += convert_github_data_to_text(github_data)
    return text


def format_report(data: Any) -> str:
    evaluation = validate_model("evaluation", data)
    scores = evaluation.scores
    category_scores = scores.model_dump()
    category_total = sum(
        min(category["score"], category["max"]) for category in category_scores.values()
    )
    category_max = sum(category["max"] for category in category_scores.values())
    total = category_total + evaluation.bonus_points.total - evaluation.deductions.total
    total = min(total, category_max + 20)

    lines = [
        "# Resume Evaluation Report",
        "",
        f"Overall score: {total:.1f}/{category_max}",
        "",
        "## Category Scores",
    ]

    for category_name, category in category_scores.items():
        display_name = category_name.replace("_", " ").title()
        score = min(category["score"], category["max"])
        lines.extend(
            [
                f"- {display_name}: {score}/{category['max']}",
                f"  Evidence: {category['evidence']}",
            ]
        )

    lines.extend(
        [
            "",
            "## Bonus Points",
            f"{evaluation.bonus_points.total}: {evaluation.bonus_points.breakdown}",
            "",
            "## Deductions",
            f"{evaluation.deductions.total}: {evaluation.deductions.reasons}",
            "",
            "## Key Strengths",
        ]
    )
    lines.extend(f"- {strength}" for strength in evaluation.key_strengths)
    lines.extend(["", "## Areas For Improvement"])
    lines.extend(f"- {area}" for area in evaluation.areas_for_improvement)
    return "\n".join(lines)


def command_extract_text(args: argparse.Namespace) -> None:
    print(extract_pdf_markdown(args.pdf_path))


def command_render_prompt(args: argparse.Namespace) -> None:
    payload = load_json(args.input)
    if not isinstance(payload, dict):
        fail("Prompt input must be a JSON object")
    print(render_prompt(args.task, payload))


def command_schema(args: argparse.Namespace) -> None:
    dump_json(model_for_name(args.model_name).model_json_schema())


def command_validate(args: argparse.Namespace) -> None:
    validated = validate_model(args.model_name, load_json(args.input))
    dump_json(validated.model_dump(mode="json"))


def command_normalize_section(args: argparse.Namespace) -> None:
    dump_json(normalize_section(args.section, load_json(args.input)))


def command_merge_resume(args: argparse.Namespace) -> None:
    dump_json(merge_resume_sections(args.sections))


def command_fetch_github(args: argparse.Namespace) -> None:
    dump_json(fetch_github(args.github_url, args.max_repos))


def command_format_evaluation_input(args: argparse.Namespace) -> None:
    payload = {"resume": load_json(args.resume)}
    if args.github:
        payload["github"] = load_json(args.github)
    print(evaluation_input_text(payload))


def command_format_report(args: argparse.Namespace) -> None:
    print(format_report(load_json(args.evaluation)))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Deterministic bridge commands for the OpenCode resume evaluator."
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    extract_text = subparsers.add_parser("extract-text")
    extract_text.add_argument("pdf_path")
    extract_text.set_defaults(func=command_extract_text)

    render = subparsers.add_parser("render-prompt")
    render.add_argument("task")
    render.add_argument("--input", required=True)
    render.set_defaults(func=command_render_prompt)

    schema = subparsers.add_parser("schema")
    schema.add_argument("model_name")
    schema.set_defaults(func=command_schema)

    validate = subparsers.add_parser("validate")
    validate.add_argument("model_name")
    validate.add_argument("--input", required=True)
    validate.set_defaults(func=command_validate)

    normalize = subparsers.add_parser("normalize-section")
    normalize.add_argument("section", choices=SECTION_NAMES)
    normalize.add_argument("--input", required=True)
    normalize.set_defaults(func=command_normalize_section)

    merge = subparsers.add_parser("merge-resume")
    merge.add_argument("--sections", required=True)
    merge.set_defaults(func=command_merge_resume)

    fetch = subparsers.add_parser("fetch-github")
    fetch.add_argument("github_url")
    fetch.add_argument("--max-repos", type=int, default=100)
    fetch.set_defaults(func=command_fetch_github)

    evaluation_input = subparsers.add_parser("format-evaluation-input")
    evaluation_input.add_argument("--resume", required=True)
    evaluation_input.add_argument("--github")
    evaluation_input.set_defaults(func=command_format_evaluation_input)

    report = subparsers.add_parser("format-report")
    report.add_argument("--evaluation", required=True)
    report.set_defaults(func=command_format_report)

    return parser


def main() -> None:
    args = build_parser().parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
