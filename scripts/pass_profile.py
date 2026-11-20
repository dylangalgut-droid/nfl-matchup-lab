"""Summarise targeted throws by observed depth, field direction and charted design."""

def add_target(groups, p, chart):
    if (p.get('pass_attempt') != '1' or not p.get('receiver_player_id') or
        p.get('sack') == '1' or p.get('qb_spike') == '1' or
        p.get('two_point_attempt') == '1' or p.get('play_type') == 'no_play'):
        return
    air = p.get('air_yards')
    depth = 'unknown' if air in (None, '', 'NA') else (
        'behind' if float(air) < 0 else 'short' if float(air) < 10 else
        'intermediate' if float(air) < 20 else 'deep')
    side = p.get('pass_location')
    if side not in ('left','middle','right'):
        side = 'unknown'
    keys = ['all', 'depth/'+depth, 'side/'+side, 'zone/'+depth+'/'+side]
    flags = ('is_screen_pass','is_play_action','is_rpo')
    if chart and all(chart.get(f) in ('TRUE','FALSE') for f in flags):
        keys.append('charted')
        keys.extend('concept/'+f for f in flags if chart[f]=='TRUE')
        if all(chart[f]=='FALSE' for f in flags):
            keys.append('concept/other')
    caught = int(p.get('complete_pass') == '1')
    yards = p.get('receiving_yards')
    measured = caught and yards not in ('',None,'NA')
    for key in keys:
        bucket = groups.setdefault(key,[0,0,0,0])
        bucket[0] += 1
        bucket[1] += caught
        bucket[2] += int(bool(measured))
        if measured:
            bucket[3] += int(float(yards))

def season_profiles(games, counts):
    out = {}
    for g in games:
        if not g['boxVerified']:
            continue
        for off, defense in [(g['home'],g['away']),(g['away'],g['home'])]:
            stats = counts.get((g['id'],off),{})
            for mode,team in [('offence',off),('defence',defense)]:
                record = out.setdefault(mode,{}).setdefault(team,{'games':0,'groups':{}})
                record['games'] += 1
                for key, values in stats.items():
                    bucket = record['groups'].setdefault(key,[0,0,0,0])
                    for i, v in enumerate(values):
                        bucket[i] += v
    return out
