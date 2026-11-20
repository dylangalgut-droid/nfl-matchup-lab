import csv
import io
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from pass_profile import season_profiles
from update import make_games, plays_and_zones, preserve_verified


class SourceIntegrityTests(unittest.TestCase):
    def test_design_sample_excludes_partial_games_and_counts_zero_screen_games(self):
        games = [dict(id=i, home='A', away='B', boxVerified=True) for i in range(3)]
        counts = {(i,'A'): {'all':[2,1,1,12], 'charted':[2,1,1,12]} for i in range(3)}
        counts[0,'A']['concept/is_screen_pass'] = [1,1,1,12]
        counts[2,'A'].update({'charted':[1,1,1,12], 'concept/is_screen_pass':[1,1,1,12]})
        profiles = season_profiles(games, counts)
        for mode, team in [('offence','A'), ('defence','B')]:
            record = profiles[mode][team]
            self.assertEqual(record['designSample'], {'games':2,'groups':{'concept/is_screen_pass':[1,1,1,12]}})
            self.assertEqual(record['groups']['concept/is_screen_pass'][3], 24)

    def test_tbd_never_uses_placeholder_and_mismatched_scores_are_unverified(self):
        row = dict(game_id='g1', espn='91', season='2026', week='18', game_type='REG',
                   gameday='2027-01-10', gametime='13:00', away_score='14',home_score='10',
                   away_team='A',home_team='B',roof='outdoors',stadium='Venue')
        event = dict(date='2027-01-10T05:00Z',status={'type':{'name':'STATUS_FINAL','completed':True}},
                     competitions=[{'timeValid':False,'competitors':[
                         {'homeAway':'home','score':'7'},{'homeAway':'away','score':'14'}]}])
        games, verified = make_games([row],{'91':event})
        self.assertIsNone(games[0]['kickoff'])
        self.assertEqual(games[0]['status'],'final')
        self.assertFalse(verified)

    def test_passing_scorer_two_point_and_no_play(self):
        fields = ('game_id','desc','total_home_score','total_away_score','play_type','two_point_attempt',
                  'touchdown','td_player_id','yardline_100','rusher_player_id','rush_attempt',
                  'receiver_player_id','pass_attempt','passer_player_id')
        base = dict(game_id='g',desc='TD pass',total_home_score='6',total_away_score='0',
                    play_type='pass',two_point_attempt='0',touchdown='1',td_player_id='wr',
                    yardline_100='12',rusher_player_id='',rush_attempt='0',receiver_player_id='wr',
                    pass_attempt='1',passer_player_id='qb')
        stream=io.StringIO()
        writer=csv.DictWriter(stream,fieldnames=fields)
        writer.writeheader()
        writer.writerows([base,dict(base,play_type='no_play'),dict(base,two_point_attempt='1'),
                          dict(base,desc='END GAME',touchdown='0',pass_attempt='0')])
        complete, unknown, tds, runs, targets = plays_and_zones(stream.getvalue().encode(),
            {'g':{'homeScore':6,'awayScore':0}})
        self.assertEqual(complete,{'g'})
        self.assertEqual(tds[('g','wr')],1)
        self.assertEqual(tds[('g','qb')],0)
        self.assertEqual(targets[('g','wr')],1)
        self.assertFalse(unknown or runs)

    def test_prior_verified_box_cannot_silently_disappear(self):
        previous={'games':[{'id':'g','season':2026,'boxVerified':True}],'stats':[],'players':[]}
        current={'season':2026,'games':[],'stats':[],'players':[]}
        with self.assertRaisesRegex(ValueError,'Formerly verified'):
            preserve_verified(current,previous)


if __name__ == '__main__':
    unittest.main()
