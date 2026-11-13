#!/usr/bin/env python3
"""Reconcile readiness and explicitly verified completion through GitHub CLI."""
import argparse
import json
import subprocess
from project_ready import ROOT, QUERY, dependency_done, verified_closure


def changes_for(manifest, mapping, snapshot):
    connection = snapshot['data']['node']['items']
    if connection['pageInfo']['hasNextPage']:
        raise ValueError('Pagination is required before reconciling this Project')
    items = {i['content']['number']: i for i in connection['nodes']
             if i.get('content') and 'number' in i['content'] and not i['isArchived']}
    live = {}
    for task in manifest['tasks']:
        key = task['id']
        number = mapping['tasks'][key]['number']
        if number not in items:
            raise ValueError(f'{key}: missing active Project item')
        live[key] = items[number]

    changes = []
    for task in manifest['tasks']:
        key = task['id']; item = live[key]
        old = (item.get('status') or {}).get('name')
        new = old
        if verified_closure(item):
            new = 'Done'
        elif old == 'Done':
            new = 'In review' if item['content']['state'] == 'CLOSED' else 'Blocked'
        elif (item['content']['state'] == 'OPEN' and old in {'Ready', 'Backlog'}
              and not (item.get('agent') or {}).get('text', '').strip()
              and not item['content'].get('assignees', {}).get('nodes', [])):
            if all(dependency_done(live[d]) for d in task['depends_on']):
                new = 'Ready'
            else:
                new = 'Backlog'
        elif item['content']['state'] == 'OPEN' and old in {'In progress', 'In review'}:
            # A verified closure can be waiting for its Project Done write.
            if not all(verified_closure(live[d]) for d in task['depends_on']):
                new = 'Blocked'
        if old != new:
            changes.append({'task': key, 'item': item['id'], 'old': old, 'new': new})
    return changes


def api(payload):
    result = subprocess.run(['gh', 'api', 'graphql', '--input', '-'],
                            input=json.dumps(payload), text=True, capture_output=True)
    if result.returncode:
        raise ValueError(result.stderr.strip())
    value = json.loads(result.stdout)
    if value.get('errors'):
        raise ValueError(json.dumps(value['errors']))
    return value


def reconcile(manifest, mapping, apply):
    project_id = mapping['project']['id']

    def current_changes():
        snapshot = api({'query': QUERY, 'variables': {'id': project_id}})
        return changes_for(manifest, mapping, snapshot)

    changes = current_changes()
    if not apply:
        for change in changes:
            print(f"{change['task']}: {change['old']} -> {change['new']}")
        return len(changes)

    count = 0
    for completion_phase in (True, False):
        for change in changes:
            changes_completion = 'Done' in (change['old'], change['new'])
            if changes_completion != completion_phase:
                continue
            # Re-read before each write to avoid overriding a newly claimed task.
            if change not in current_changes():
                print('Skipped changed state; re-run reconciliation.')
                continue
            field = mapping['fields']['Status']
            option = next(o['id'] for o in field['options'] if o['name'] == change['new'])
            api({'query': 'mutation($i:UpdateProjectV2ItemFieldValueInput!){updateProjectV2ItemFieldValue(input:$i){clientMutationId}}',
                 'variables': {'i': {'projectId': project_id, 'itemId': change['item'],
                                    'fieldId': field['id'], 'value': {'singleSelectOptionId': option}}}})
            print(f"{change['task']}: {change['old']} -> {change['new']}")
            count += 1
        if completion_phase:
            changes = current_changes()
    return count


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true', help='Write changes; default is read-only')
    args = parser.parse_args()
    manifest = json.loads((ROOT / 'docs/implementation-tasks.json').read_text())
    mapping = json.loads((ROOT / 'docs/github-project.json').read_text())
    count = reconcile(manifest, mapping, args.apply)
    summary = f'Apply: {count} changes written' if args.apply else f'Dry run: {count} proposed changes'
    print(f'{summary}. GitHub writes are not atomic claims.')


if __name__ == '__main__':
    main()
