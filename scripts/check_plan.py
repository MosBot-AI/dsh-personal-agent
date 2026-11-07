#!/usr/bin/env python3
"""Validate the documentation plan without installing or running the product."""

import argparse
import json
import re
import sys
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]
RELEASE_TARGETS = {"alpha": "PA-028", "desktop-alpha": "PA-035", "beta": "PA-029", "v1": "PA-030"}


def validate(manifest, check_sources=False):
    errors = []
    tasks = manifest.get("tasks", [])
    by_id = {}
    required = ("id", "phase", "release", "status", "title", "title_zh", "depends_on",
                "target_paths", "source_refs", "implementation_steps", "acceptance_ids",
                "test_files", "validation_commands", "evidence_path")
    scenarios = set(re.findall(r"\| (E\d{2}) \|", (ROOT / "docs/07-evaluation-and-release-gates.md").read_text()))
    for task in tasks:
        task_id = task.get("id", "<missing>")
        for key in required:
            if key not in task:
                errors.append(f"{task_id}: missing {key}")
        if not re.fullmatch(r"PA-\d{3}", task_id):
            errors.append(f"invalid task ID: {task_id}")
        if task_id in by_id:
            errors.append(f"duplicate task: {task_id}")
        by_id[task_id] = task
        if task.get("status") not in {"planned", "in_progress", "review", "done", "blocked"}:
            errors.append(f"{task_id}: invalid status")
        if task.get("phase") not in {f"M{i}" for i in range(6)}:
            errors.append(f"{task_id}: invalid phase")
        if task.get("release") not in RELEASE_TARGETS:
            errors.append(f"{task_id}: invalid release")
        for key in ("target_paths", "implementation_steps", "acceptance_ids", "test_files", "validation_commands"):
            if not isinstance(task.get(key), list) or not task[key]:
                errors.append(f"{task_id}: {key} must be a nonempty list")
        for scenario in task.get("acceptance_ids", []):
            if scenario not in scenarios:
                errors.append(f"{task_id}: unknown scenario {scenario}")
        for target in task.get("target_paths", []) + task.get("test_files", []) + [task.get("evidence_path", "")]:
            path = Path(target)
            if not target or path.is_absolute() or ".." in path.parts:
                errors.append(f"{task_id}: unsafe repository-relative path {target!r}")
        if task.get("status") in {"review", "done"} and not (ROOT / task.get("evidence_path", "<missing>")).is_file():
            errors.append(f"{task_id}: evidence file required for {task['status']}")
        if task.get("status") == "blocked" and not all(task.get(k) for k in ("blocking_condition", "resume_condition")):
            errors.append(f"{task_id}: blocked requires blocking_condition and resume_condition")
        if check_sources:
            for reference in task.get("source_refs", []):
                prefix, separator, path = reference.partition(":")
                base = manifest.get("source_roots", {}).get(prefix)
                if not separator or not base or not (Path(base) / path).exists():
                    errors.append(f"{task_id}: missing source {reference}")

    seen, visiting, order = set(), set(), []

    def visit(task_id):
        if task_id in visiting:
            errors.append(f"dependency cycle at {task_id}")
            return
        if task_id in seen:
            return
        if task_id not in by_id:
            errors.append(f"unknown dependency: {task_id}")
            return
        visiting.add(task_id)
        task = by_id[task_id]
        dependencies = task.get("depends_on", [])
        if len(dependencies) != len(set(dependencies)):
            errors.append(f"{task_id}: duplicate dependency")
        for dependency in dependencies:
            visit(dependency)
            if task.get("status") == "done" and by_id.get(dependency, {}).get("status") != "done":
                errors.append(f"{task_id}: done before dependency {dependency}")
        visiting.remove(task_id)
        seen.add(task_id)
        order.append(task_id)

    for task_id in by_id:
        visit(task_id)
    covered = {s for task in tasks for s in task.get("acceptance_ids", [])}
    for scenario in scenarios - covered:
        errors.append(f"scenario has no task: {scenario}")
    for name in ("06-agent-execution-guide.md", "06-agent-execution-guide-zh.md"):
        text = (ROOT / "docs" / name).read_text()
        indexed = set(re.findall(r"^\| (PA-\d{3}) \|", text, re.M))
        if indexed != set(by_id):
            errors.append(f"{name}: task index differs from manifest")
    return errors, by_id, order, scenarios


def validate_documents():
    errors = []
    docs = sorted((ROOT / "docs").glob("*.md"))
    for path in docs:
        if path.name == "operations.md":
            continue
        peer = path.with_name(path.name.replace("-zh.md", ".md") if path.name.endswith("-zh.md") else path.stem + "-zh.md")
        if not peer.exists():
            errors.append(f"missing bilingual counterpart: {peer.relative_to(ROOT)}")
        text = path.read_text()
        if not text.endswith("\n") or text.endswith("\n\n"):
            errors.append(f"{path.name}: expected one final newline")
        if re.search(r"^(<<<<<<<|=======|>>>>>>>)", text, re.M):
            errors.append(f"{path.name}: conflict marker")
        prose = re.sub(r"```.*?```", "", text, flags=re.S)
        for target in re.findall(r"\]\(([^)]+)\)", prose):
            target = target.strip("<>")
            parsed = urlsplit(target)
            if parsed.scheme or not parsed.path:
                continue
            resolved = path.parent / unquote(parsed.path)
            if not resolved.exists():
                errors.append(f"{path.name}: broken local link {target}")
    return errors


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check-sources", action="store_true")
    parser.add_argument("--manifest", type=Path, default=ROOT / "docs/implementation-tasks.json")
    args = parser.parse_args()
    try:
        manifest = json.loads(args.manifest.read_text())
        errors, tasks, order, scenarios = validate(manifest, args.check_sources)
        errors.extend(validate_documents())
    except (OSError, ValueError, TypeError, KeyError) as error:
        print(f"Plan invalid: {error}", file=sys.stderr)
        return 1
    if errors:
        print("\n".join(errors), file=sys.stderr)
        return 1
    ready = [task_id for task_id in order if tasks[task_id]["status"] == "planned"
             and all(tasks[d]["status"] == "done" for d in tasks[task_id]["depends_on"])]
    print(f"Plan valid: {len(tasks)} tasks, {len(scenarios)} scenarios, acyclic dependencies, bilingual documents and local links.")
    print("Ready: " + (", ".join(ready) or "none"))
    if args.check_sources:
        print("All pinned local source references exist.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
