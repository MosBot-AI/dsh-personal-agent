import sys
import unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
from project_ready import ready_tasks
from project_sync import changes_for, reconcile


class ProjectWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.manifest = {'tasks': [{'id': 'PA-001', 'title': 'Foundation', 'depends_on': []},
                                   {'id': 'PA-035', 'title': 'Release', 'depends_on': ['PA-001']}]}
        self.mapping = {'tasks': {'PA-001': {'number': 1}, 'PA-035': {'number': 2}},
                        'project': {'id': 'test-project'}, 'fields': {'Status': {'id': 'test-status', 'options': [
                            {'name': name, 'id': name} for name in ('Ready', 'Backlog', 'Blocked', 'In review', 'Done')
                        ]}}}
        self.items = [{'id': str(i), 'isArchived': False,
                       'content': {'number': i, 'state': 'OPEN', 'stateReason': None,
                                   'url': f'https://github.com/example/repo/issues/{i}', 'labels': {'nodes': []}},
                       'status': {'name': 'Ready' if i == 1 else 'Backlog'}, 'agent': None, 'evidence': None}
                      for i in (1, 2)]
        self.snapshot = {'data': {'node': {'items': {'pageInfo': {'hasNextPage': False}, 'nodes': self.items}}}}

    def verified(self):
        self.items[0]['content'].update(state='CLOSED', stateReason='COMPLETED',
                                        labels={'nodes': [{'name': 'acceptance:verified'}]})
        self.items[0]['evidence'] = {'text': 'https://github.com/example/repo/pull/5'}
        self.items[0]['status']['name'] = 'Done'

    def test_initial_only_first_task_ready(self):
        self.assertEqual([r['id'] for r in ready_tasks(self.manifest, self.mapping, self.snapshot, 'desktop-alpha')], ['PA-001'])

    def test_verified_completion_unlocks_dependency(self):
        self.verified()
        self.assertEqual(changes_for(self.manifest, self.mapping, self.snapshot)[0]['new'], 'Ready')
        self.assertEqual(ready_tasks(self.manifest, self.mapping, self.snapshot, 'desktop-alpha')[0]['id'], 'PA-035')

    def test_closed_without_evidence_is_not_complete(self):
        self.verified(); self.items[0]['evidence'] = None
        changes = changes_for(self.manifest, self.mapping, self.snapshot)
        self.assertEqual(changes, [{'task': 'PA-001', 'item': '1', 'old': 'Done', 'new': 'In review'}])
        self.assertFalse(ready_tasks(self.manifest, self.mapping, self.snapshot, 'desktop-alpha'))

    def test_cancelled_issue_does_not_unlock(self):
        self.verified(); self.items[0]['content']['stateReason'] = 'NOT_PLANNED'
        self.assertFalse(ready_tasks(self.manifest, self.mapping, self.snapshot, 'desktop-alpha'))

    def test_claimed_task_not_offered(self):
        self.items[0]['agent'] = {'text': 'agent/run-1'}
        self.assertFalse(ready_tasks(self.manifest, self.mapping, self.snapshot, 'desktop-alpha'))

    def test_assigned_task_not_offered(self):
        self.items[0]['content']['assignees'] = {'nodes': [{'login': 'owner'}]}
        self.assertFalse(ready_tasks(self.manifest, self.mapping, self.snapshot, 'desktop-alpha'))

    def test_claim_in_progress_is_not_overwritten(self):
        self.verified(); self.items[1]['agent'] = {'text': 'agent/run-2'}
        self.assertEqual(changes_for(self.manifest, self.mapping, self.snapshot), [])

    def test_manual_blocker_is_preserved(self):
        self.verified(); self.items[1]['status']['name'] = 'Blocked'
        self.assertEqual(changes_for(self.manifest, self.mapping, self.snapshot), [])

    def test_dependency_reopened_blocks_active_work(self):
        self.items[1]['status']['name'] = 'In progress'
        self.assertEqual(changes_for(self.manifest, self.mapping, self.snapshot)[0]['new'], 'Blocked')

    def test_missing_item_fails_closed(self):
        self.items.pop()
        with self.assertRaises(ValueError):
            changes_for(self.manifest, self.mapping, self.snapshot)

    def test_pagination_fails_closed(self):
        self.snapshot['data']['node']['items']['pageInfo']['hasNextPage'] = True
        with self.assertRaises(ValueError):
            ready_tasks(self.manifest, self.mapping, self.snapshot, 'desktop-alpha')

    def test_verified_closed_issue_is_promoted_to_done(self):
        self.verified(); self.items[0]['status']['name'] = 'In review'
        self.assertEqual(changes_for(self.manifest, self.mapping, self.snapshot),
                         [{'task': 'PA-001', 'item': '1', 'old': 'In review', 'new': 'Done'}])
        self.assertEqual(ready_tasks(self.manifest, self.mapping, self.snapshot, 'desktop-alpha'), [])

    def test_active_dependent_is_preserved_while_verified_closure_settles(self):
        self.verified()
        self.items[0]['status']['name'] = 'In review'
        self.items[1]['status']['name'] = 'In progress'
        self.assertEqual(changes_for(self.manifest, self.mapping, self.snapshot),
                         [{'task': 'PA-001', 'item': '1', 'old': 'In review', 'new': 'Done'}])

    def reconcile_test_snapshot(self, write):
        def remote(payload):
            if payload['query'].startswith('query'):
                return self.snapshot
            mutation = payload['variables']['i']
            write(mutation['itemId'], mutation['value']['singleSelectOptionId'])
        with patch('project_sync.api', side_effect=remote), patch('builtins.print'):
            return reconcile(self.manifest, self.mapping, apply=True)

    def test_apply_confirms_done_before_promoting_dependent(self):
        self.verified()
        self.items[0]['status']['name'] = 'In review'
        writes = []

        def write(item_id, status):
            writes.append((item_id, status))
            self.items[int(item_id) - 1]['status']['name'] = status

        self.assertEqual(self.reconcile_test_snapshot(write), 2)
        self.assertEqual(writes, [('1', 'Done'), ('2', 'Ready')])

    def test_apply_does_not_promote_when_completion_is_not_visible(self):
        self.verified()
        self.items[0]['status']['name'] = 'In review'
        writes = []

        def write(item_id, status):
            writes.append((item_id, status))

        self.assertEqual(self.reconcile_test_snapshot(write), 1)
        self.assertEqual(writes, [('1', 'Done')])
        self.assertEqual(ready_tasks(self.manifest, self.mapping, self.snapshot, 'desktop-alpha'), [])

    def test_apply_does_not_promote_when_completion_write_fails(self):
        self.verified()
        self.items[0]['status']['name'] = 'In review'
        writes = []

        def write(item_id, status):
            writes.append((item_id, status))
            raise ValueError('Test write failure')

        with self.assertRaisesRegex(ValueError, 'Test write failure'):
            self.reconcile_test_snapshot(write)
        self.assertEqual(writes, [('1', 'Done')])

    def test_apply_rechecks_dependency_before_promotion(self):
        self.verified()
        self.items[0]['status']['name'] = 'In review'
        writes = []
        reads = 0

        def remote(payload):
            nonlocal reads
            if payload['query'].startswith('query'):
                reads += 1
                if reads == 4:
                    self.items[0]['content']['state'] = 'OPEN'
                return self.snapshot
            mutation = payload['variables']['i']
            item_id, status = mutation['itemId'], mutation['value']['singleSelectOptionId']
            writes.append((item_id, status))
            self.items[int(item_id) - 1]['status']['name'] = status

        with patch('project_sync.api', side_effect=remote), patch('builtins.print'):
            self.assertEqual(reconcile(self.manifest, self.mapping, apply=True), 1)
        self.assertEqual(writes, [('1', 'Done')])


if __name__ == '__main__':
    unittest.main()
