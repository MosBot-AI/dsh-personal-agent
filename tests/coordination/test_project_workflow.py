import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
from project_ready import ready_tasks
from project_sync import changes_for


class ProjectWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.manifest = {'tasks': [{'id': 'PA-001', 'title': 'Foundation', 'depends_on': []},
                                   {'id': 'PA-035', 'title': 'Release', 'depends_on': ['PA-001']}]}
        self.mapping = {'tasks': {'PA-001': {'number': 1}, 'PA-035': {'number': 2}}}
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
        self.assertEqual(changes_for(self.manifest, self.mapping, self.snapshot)[0]['new'], 'Done')


if __name__ == '__main__':
    unittest.main()
