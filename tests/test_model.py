import copy
from datetime import datetime, timedelta, timezone
import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from model import analyse, eligible, role_for


class ModelChecks(unittest.TestCase):
    def setUp(self):
        start = datetime(2025, 9, 7, 17, tzinfo=timezone.utc)
        self.data = dict(season=2025, updatedAt=(start + timedelta(weeks=6, days=2)).isoformat(),
                         teams=[], games=[], players=[], stats=[], injuries=[])
        for t in ('A', 'B'):
            for p in ('star', 'bench', 'missing'):
                self.data['players'].append(dict(id=t+p, team=t, position='WR', name=t+p,
                                                 injury='Out' if p=='bench' else None, activeRoster=True))
        for w in range(1, 10):
            final = w <= 6
            game = dict(id=str(w), season=2025, week=w, home='A', away='B', status='final' if final else 'scheduled',
                        kickoff=(start+timedelta(weeks=w-1)).isoformat() if w < 9 else None, boxVerified=final)
            self.data['games'].append(game)
            if not final:
                continue
            for t, opp in [('A','B'),('B','A')]:
                for p, yards, targets in [('star',100 if t=='A' else 20,7),('bench',0,2),('missing',0,0)]:
                    self.data['stats'].append(dict(game=str(w),player=t+p,team=t,opponent=opp,position='WR',
                                                  targets=targets,receiving_yards=yards))

    def test_raw_differences_and_qualifying_zeros(self):
        result = analyse(self.data)
        cell = result['weeks']['2025-6']['cells']['wr_unknown']['receiving_yards']['B']
        self.assertEqual(cell, dict(n=10, leagueN=20, avg=50, league=30, diff=20))
        self.assertFalse(eligible(dict(position='RB', attempts=0, targets=0, carries=0)))
        self.assertTrue(eligible(dict(position='WR', targets=1, receptions=0)))

    def test_changing_outcome_does_not_change_its_prediction(self):
        modified = copy.deepcopy(self.data)
        for row in modified['stats']:
            if row['game'] == '6':
                row['receiving_yards'] = 300
        initial, altered = analyse(self.data), analyse(modified)
        self.assertEqual(initial['weeks']['2025-6'], altered['weeks']['2025-6'])
        self.assertNotEqual(initial['performance'], altered['performance'])
        self.assertNotEqual(initial['weeks']['2025-8']['cells'], altered['weeks']['2025-8']['cells'])

    def test_roster_membership_and_tba(self):
        result = analyse(self.data)
        future = result['weeks']['2025-8']['players']
        by_id = {m['id']:m for m in future}
        self.assertEqual(len(by_id), 6)
        self.assertEqual(by_id['Amissing']['flags'], [])
        self.assertEqual(by_id['Abench']['injury'], 'Out')
        self.assertEqual(by_id['Abench']['flags'], [])
        self.assertEqual(len(result['weeks']['2025-9']['players']), 6)

    def test_archived_roster_enriches_drilldown_without_hindsight_forecasts(self):
        original = analyse(self.data)
        changed = copy.deepcopy(self.data)
        changed['_weeklyRosters'] = {'2025-1': [dict(id='Arookie', team='A', position='WR', name='Rookie', rosterStatus='ACT')]}
        result = analyse(changed)
        rookie = next(p for p in result['weeks']['2025-1']['players'] if p['id']=='Arookie')
        self.assertEqual(rookie['flags'], [])
        self.assertEqual(result['performance'], original['performance'])

    def test_injury_and_future_forecasts_do_not_rewrite_performance(self):
        original = analyse(self.data)
        changed = copy.deepcopy(self.data)
        for p in changed['players']:
            p['injury'] = 'Out'
        for game in changed['games']:
            game['roof'] = 'outdoors'
            game['weather'] = {'gustMph': 65}
        self.assertEqual(analyse(changed)['performance'], original['performance'])

    def test_roles_are_exclusive_and_sparse_history_is_labelled(self):
        rows = [dict(carries=14,targets=8)] * 5
        self.assertEqual(role_for('RB', rows, None, '1'), 'rb_lead')
        self.assertEqual(role_for('RB', rows[:2], None, '1'), 'rb_unknown')
        self.assertEqual(role_for('WR', [], None, '1'), 'wr_unknown')


    def test_wr_target_depth_uses_weighted_opportunities(self):
        def role(air, targets=(8, 2, 2)):
            rows = [dict(receiving_air_yards=a, targets=t) for a, t in zip(air, targets)]
            return role_for('WR', rows, None, 'receiver')
        self.assertEqual(role((10,40,40)), 'wr_short')
        self.assertEqual(role((16,40,40)), 'wr_intermediate')
        self.assertEqual(role((76,40,40)), 'wr_deep')
        self.assertEqual(role((76,None,40)), 'wr_unknown')
        self.assertEqual(role((76,40,40), (6,2,2)), 'wr_unknown')


if __name__ == '__main__':
    unittest.main()
