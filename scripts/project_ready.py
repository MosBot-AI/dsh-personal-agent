#!/usr/bin/env python3
"""Read the live GitHub Project and list dependency-ready dshpa tasks."""

import argparse
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TARGETS = {"alpha": "PA-028", "desktop-alpha": "PA-035", "beta": "PA-029", "v1": "PA-030"}
QUERY = """query($id:ID!){node(id:$id){... on ProjectV2{
  items(first:100){pageInfo{hasNextPage} nodes{
    id isArchived content{... on Issue{number state stateReason url labels(first:100){nodes{name}} assignees(first:20){nodes{login}}}}
    status:fieldValueByName(name:"Status"){... on ProjectV2ItemFieldSingleSelectValue{name}}
    agent:fieldValueByName(name:"Execution agent"){... on ProjectV2ItemFieldTextValue{text}}
    evidence:fieldValueByName(name:"Evidence"){... on ProjectV2ItemFieldTextValue{text}}
  }}
}}}"""


def ready_tasks(manifest, mapping, snapshot, release):
    tasks = {task["id"]: task for task in manifest["tasks"]}
    required = set()

    def include(task_id):
        if task_id in required:
            return
        required.add(task_id)
        for dependency in tasks[task_id]["depends_on"]:
            include(dependency)

    include(TARGETS[release])
    items = snapshot["data"]["node"]["items"]
    if items["pageInfo"]["hasNextPage"]:
        raise ValueError("Project exceeds 100 items; add pagination before using this result")
    by_number = {item["content"]["number"]: item for item in items["nodes"]
                 if item.get("content") and "number" in item["content"] and not item["isArchived"]}
    live = {}
    for task_id in required:
        number = mapping["tasks"][task_id]["number"]
        if number not in by_number:
            raise ValueError(f"{task_id}: missing active Project Issue #{number}")
        live[task_id] = by_number[number]

    def completed(task_id):
        item = live[task_id]
        issue = item["content"]
        return (issue["state"] == "CLOSED" and issue["stateReason"] == "COMPLETED"
                and "acceptance:verified" in {x["name"] for x in issue.get("labels", {}).get("nodes", [])}
                and (item.get("status") or {}).get("name") == "Done"
                and bool((item.get("evidence") or {}).get("text", "").strip()))

    ready = []
    for task_id in sorted(required):
        item = live[task_id]
        status = (item.get("status") or {}).get("name")
        if (item["content"]["state"] == "OPEN" and status in {"Ready", "Backlog"}
                and not (item.get("agent") or {}).get("text", "").strip()
                and not item["content"].get("assignees", {}).get("nodes", [])
                and all(completed(dep) for dep in tasks[task_id]["depends_on"])):
            ready.append({"id": task_id, "title": tasks[task_id]["title"],
                          "url": item["content"]["url"], "status": status})
    return ready


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--release", choices=TARGETS, default="desktop-alpha")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    try:
        manifest = json.loads((ROOT / "docs/implementation-tasks.json").read_text())
        mapping = json.loads((ROOT / "docs/github-project.json").read_text())
        result = subprocess.run(["gh", "api", "graphql", "--input", "-"],
                                input=json.dumps({"query": QUERY, "variables": {"id": mapping["project"]["id"]}}),
                                text=True, capture_output=True)
        if result.returncode:
            raise ValueError(result.stderr.strip() or "GitHub request failed")
        snapshot = json.loads(result.stdout)
        if snapshot.get("errors"):
            raise ValueError(json.dumps(snapshot["errors"]))
        ready = ready_tasks(manifest, mapping, snapshot, args.release)
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(f"Cannot determine live readiness: {error}", file=sys.stderr)
        return 1
    if args.json:
        print(json.dumps(ready, indent=2))
    else:
        print(f"Dependency-ready tasks for {args.release} (recheck claims before starting):")
        for task in ready:
            print(f"{task['id']} [{task['status']}] {task['title']}\n  {task['url']}")
        if not ready:
            print("None. Inspect active work, blockers and missing completion evidence.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
