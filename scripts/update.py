"""Download public NFL feeds, build a verified snapshot, replace the published file atomically."""
from pass_profile import add_target, season_profiles
import csv
import gzip
import io
import json
import math
import re
import time
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

NFLDATA = 'https://raw.githubusercontent.com/nflverse/nfldata/master/data/'
RELEASE = 'https://github.com/nflverse/nflverse-data/releases/download/'
ESPN = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/'
OUTPUT = Path(__file__).resolve().parents[1] / 'docs/data.json'
SKILL_POS = {'QB', 'RB', 'TE', 'WR', 'FB', 'HB'}
MEASURES = ('passing_yards', 'passing_tds', 'attempts', 'carries', 'rushing_yards',
            'receptions', 'targets', 'receiving_yards', 'receiving_air_yards', 'target_share')
TZ = ZoneInfo('America/New_York')


def download(url, optional_missing=False):
    for attempt in range(3):
        try:
            req = Request(url, headers={'User-Agent': 'NFL-Matchup-Lab/1.0 (public sports analysis)'})
            with urlopen(req, timeout=60) as response:
                return response.read()
        except HTTPError as exc:
            if optional_missing and exc.code == 404:
                return None
            if exc.code < 500 and exc.code != 429:
                raise
        except (OSError, TimeoutError):
            if attempt == 2:
                raise
        time.sleep(2 ** attempt)
    raise RuntimeError('Unable to fetch ' + url)


def rows(content):
    if content is None:
        return iter(())
    stream = io.BytesIO(content)
    if content.startswith(b'\x1f\x8b'):
        stream = gzip.GzipFile(fileobj=stream)
    return csv.DictReader(io.TextIOWrapper(stream, encoding='utf-8-sig', newline=''))


def number(v):
    if v in (None, '', 'NA', 'NaN'):
        return None
    n = float(v)
    if not math.isfinite(n):
        return None
    return int(n) if n.is_integer() else round(n, 5)


def canon_pos(pos):
    return 'RB' if pos in ('FB', 'HB') else pos


def iso(dt):
    return dt.astimezone(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')


def stamp(value):
    return datetime.fromisoformat(value.replace('Z', '+00:00'))


def score_status(event):
    if not event:
        return 'unconfirmed'
    status = event['status']['type']
    if status['name'] in ('STATUS_POSTPONED', 'STATUS_CANCELED', 'STATUS_SUSPENDED', 'STATUS_DELAYED'):
        return 'postponed'
    if status.get('completed') and status['name'] == 'STATUS_FINAL':
        return 'final'
    return {'in': 'in_progress', 'pre': 'scheduled'}.get(status.get('state'), 'unconfirmed')


def make_games(schedule, events):
    games = []
    matches = set()
    for row in schedule:
        gid = row['game_id']
        event = events.get(row['espn'])
        status = score_status(event)
        competition = event['competitions'][0] if event else {}
        kickoff = None
        if competition.get('timeValid') and event.get('date'):
            kickoff = iso(stamp(event['date']))
        elif not event and row['gametime'] and int(row['week']) < 17:
            dt = datetime.fromisoformat(row['gameday'] + 'T' + row['gametime'])
            kickoff = iso(dt.replace(tzinfo=TZ))
        g = dict(id=gid,season=int(row['season']),week=int(row['week']),stage=row['game_type'],
                 home=row['home_team'],away=row['away_team'],kickoff=kickoff,status=status,
                 homeScore=None,awayScore=None,roof=row['roof'] or None,venue=row['stadium'] or None,
                 boxVerified=False,espn=row['espn'],usDate=row['gameday'])
        if status == 'final':
            scores = {t['homeAway']: number(t.get('score')) for t in competition['competitors']}
            g.update(homeScore=scores.get('home'),awayScore=scores.get('away'))
            if all(scores.get(k) is not None and scores[k] == number(row[k+'_score']) for k in ('home','away')):
                matches.add(gid)
        games.append(g)
    return games, matches


def plays_and_zones(pbp, games_by_id, counts=None, charts=None):
    touchdowns, rz_runs, rz_targets = Counter(), Counter(), Counter()
    complete, unknown_scorer = set(), set()
    for play in rows(pbp):
        gid = play['game_id']
        g = games_by_id.get(gid)
        if not g:
            continue
        if (play['desc'].upper().strip() in ('END GAME', 'END OF GAME') and
            (number(play['total_home_score']), number(play['total_away_score'])) == (g['homeScore'], g['awayScore'])):
            complete.add(gid)
        if play['play_type'] == 'no_play' or number(play['two_point_attempt']) == 1:
            continue
        if counts is not None and play.get('posteam') in (g['home'],g['away']) and play.get('receiver_player_id'):
            add_target(counts[gid, play['posteam']],play,charts.get((gid,play['play_id'])))
        if number(play['touchdown']) == 1:
            scorer = play['td_player_id']
            if scorer:
                touchdowns[gid, scorer] += 1
            else:
                unknown_scorer.add(gid)
        yardline = number(play['yardline_100'])
        if yardline is None or not 0 < yardline <= 20:
            continue
        if play['rusher_player_id'] and number(play['rush_attempt']) == 1:
            rz_runs[gid, play['rusher_player_id']] += 1
        if play['receiver_player_id'] and number(play['pass_attempt']) == 1:
            rz_targets[gid, play['receiver_player_id']] += 1
    return complete, unknown_scorer, touchdowns, rz_runs, rz_targets


def add_season(stats_file, pbp_file, games, matched, players, counts, charts):
    game_index = {g['id']: g for g in games}
    complete, unknown_scorer, tds, red_runs, red_targets = plays_and_zones(pbp_file, game_index, counts, charts)
    stats, keys = [], set()
    covered = defaultdict(set)
    for row in rows(stats_file):
        gid, pid, team = row['game_id'], row['player_id'], row['team']
        if gid not in matched or gid not in complete or not pid or row['position'] not in SKILL_POS:
            continue
        g = game_index[gid]
        if {team, row['opponent_team']} != {g['away'],g['home']}:
            raise ValueError('Box-score opponent mismatch for ' + gid)
        key = (gid, pid)
        if key in keys:
            raise ValueError('Duplicate player-game ' + str(key))
        keys.add(key)
        pos = canon_pos(row['position'])
        s = dict(game=gid, player=pid, team=team, opponent=row['opponent_team'], position=pos)
        s.update({field: number(row[field]) for field in MEASURES})
        run, rec = s['rushing_yards'], s['receiving_yards']
        s['rush_rec_yards'] = None if None in (run, rec) else run + rec
        s.update(tds=None if gid in unknown_scorer else tds[key],
                 red_zone_carries=red_runs[key], red_zone_targets=red_targets[key])
        stats.append(s)
        if (s['carries'] or 0) + (s['attempts'] or 0) + (s['targets'] or 0) > 0:
            covered[gid].add(team)
        players[pid] = dict(id=pid, name=row['player_display_name'] or row['player_name'], position=pos,
                            team=team, activeRoster=False, injury=None, injuryDate=None)
    verified = {gid for gid, teams in covered.items() if len(teams) == 2}
    for gid in verified:
        game_index[gid]['boxVerified'] = True
    return [r for r in stats if r['game'] in verified]


def archived_rosters(content):
    """Post-game roster membership is for the historical drill-down, never a training feature."""
    members = defaultdict(dict)
    for p in rows(content):
        if (not p['gsis_id'] or not p['week'] or p['position'] not in SKILL_POS or
                p['status'] not in ('ACT', 'RES', 'EXE')):
            continue
        key = p['season'] + '-' + p['week']
        member = dict(id=p['gsis_id'], name=p['full_name'], position=canon_pos(p['position']),
                      team=p['team'], rosterStatus=p['status'])
        members[key][(member['team'], member['id'])] = member
    return {key:list(group.values()) for key,group in members.items()}


def roster_lookup(contents, teams, players):
    roster = list(rows(contents))
    max_week = defaultdict(int)
    for p in roster:
        if p['week']:
            max_week[p['team']] = max(max_week[p['team']], int(p['week']))
    candidates = sorted((p for p in roster if p['team'] in teams and p['gsis_id'] and
                         p['position'] in SKILL_POS and p['week'] and int(p['week']) == max_week[p['team']]
                         and p['status'] in ('ACT','RES','EXE')),
                        key=lambda p: (int(p['week']), p['status']=='ACT'))
    ids = {}
    for p in candidates:
        pid = p['gsis_id']
        players[pid] = dict(id=pid,name=p['full_name'],team=p['team'],position=canon_pos(p['position']),
                            activeRoster=True,rosterWeek=int(p['week']),rosterStatus=p['status'],
                            injury={'RES':'Reserve list', 'EXE':'Exempt list'}.get(p['status']),injuryDate=None)
        if p['espn_id']:
            ids[p['espn_id']] = pid
    return ids, max_week


def add_injuries(payload, teams, players, ids):
    team_by_name = {t['name']:t['id'] for t in teams}
    injuries, results = [], {}
    for team_list in payload['injuries']:
        tid = team_by_name.get(team_list['displayName'])
        if tid is None:
            continue
        for record in team_list['injuries']:
            athlete = record['athlete']
            pid = None
            for link in athlete.get('links', []):
                m = re.search(r'/id/(\d+)(?:/|$)', link.get('href',''))
                if m:
                    pid=ids.get(m[1])
                    break
            key = (tid, athlete['displayName'])
            item = dict(team=tid,name=athlete['displayName'],position=athlete.get('position',{}).get('abbreviation'),
                        status=record['status'],date=record['date'],pid=pid)
            if key not in results or item['date'] > results[key]['date']:
                results[key]=item
    for record in results.values():
        pid=record.pop('pid')
        if record['status'] == 'Active':
            continue
        injuries.append(record)
        if pid and players[pid]['team'] == record['team']:
            players[pid].update(injury=record['status'],injuryDate=record['date'])
    return injuries


def forecast(game):
    try:
        summary = json.loads(download(ESPN+'summary?event='+game['espn']))
        w = summary.get('gameInfo',{}).get('weather') or {}
        if w and number(w.get('temperature')) is not None:
            game['weather'] = dict(temperatureF=number(w.get('temperature')),
                                   gustMph=number(w.get('gust')),
                                   precipitationPct=number(w.get('precipitation')),
                                   asOf=iso(datetime.now(timezone.utc)))
    except (ValueError, KeyError, OSError, RuntimeError) as exc:
        print('Forecast unavailable',game['id'],type(exc).__name__)


def get_data():
    now = datetime.now(timezone.utc)
    schedule = list(rows(download(NFLDATA+'games.csv')))
    last_year = now.year - (now.month < 3)
    season = max(int(r['season']) for r in schedule if int(r['season']) <= last_year)
    seasons = (season-1,season)
    schedule = [r for r in schedule if int(r['season']) in seasons and r['game_type'] in ('REG','WC','DIV','CON','SB')]
    jobs = dict(teams=(NFLDATA+'teams.csv',False),injuries=(ESPN+'injuries',False),
                roster=(RELEASE+'weekly_rosters/roster_weekly_'+str(season)+'.csv.gz',True),
                previous_roster=(RELEASE+'weekly_rosters/roster_weekly_'+str(season-1)+'.csv.gz',False))
    for year in range(season-1,season+2):
        jobs['events'+str(year)] = (ESPN+'scoreboard?dates='+str(year)+'&limit=1000',False)
    for year in seasons:
        # In the off-season next season's stats do not exist until the first games finish.
        optional = year == season and not any(r['season']==str(year) and r['home_score'] for r in schedule)
        jobs['stats'+str(year)] = (RELEASE+f'stats_player/stats_player_week_{year}.csv',optional)
        jobs['chart'+str(year)] = (RELEASE+f'ftn_charting/ftn_charting_{year}.csv',True)
        jobs['pbp'+str(year)] = (RELEASE+f'pbp/play_by_play_{year}.csv.gz',optional)
    with ThreadPoolExecutor(max_workers=6) as pool:
        fetches = {k:pool.submit(download,*v) for k,v in jobs.items()}
        sources = {k:f.result() for k,f in fetches.items()}
    team_rows = {r['team']:r for r in rows(sources['teams']) if int(r['season'])<=season}
    team_codes = {r['home_team'] for r in schedule if int(r['season'])==season}
    teams = sorted((dict(id=t,name=team_rows[t]['full']) for t in team_codes),key=lambda x:x['id'])
    if len(teams)!=32:
        raise ValueError('Incomplete 32-team schedule')
    events = {}
    for y in range(season-1,season+2):
        events.update({e['id']:e for e in json.loads(sources['events'+str(y)])['events']})
    games, matched = make_games(schedule, events)
    players,stats = {},[]
    profiles = {}
    for year in seasons:
        counts = defaultdict(dict)
        charts = {(c['nflverse_game_id'],c['nflverse_play_id']):c for c in rows(sources['chart'+str(year)])}
        stats.extend(add_season(sources['stats'+str(year)],sources['pbp'+str(year)],
                                [g for g in games if g['season']==year], matched, players, counts, charts))
        profiles[str(year)] = season_profiles([g for g in games if g['season']==year],counts)
    ids,roster_weeks = roster_lookup(sources['roster'],team_codes,players)
    if sources['roster'] and len(roster_weeks)<32:
        raise ValueError('Incomplete weekly roster coverage')
    raw_injuries=json.loads(sources['injuries'])
    if not isinstance(raw_injuries.get('injuries'),list) or not raw_injuries['injuries']:
        raise ValueError('Invalid injury feed')
    injuries = add_injuries(raw_injuries,teams,players,ids)
    upcoming = [g for g in games if g['kickoff'] and g['status']=='scheduled' and
                now <= stamp(g['kickoff']) <= now+timedelta(days=7)]
    with ThreadPoolExecutor(max_workers=5) as pool:
        list(pool.map(forecast,upcoming))
    verified = sum(g['boxVerified'] for g in games)
    if not verified or not stats:
        raise ValueError('No verified weekly boxes')
    weekly = archived_rosters(sources['previous_roster'])
    weekly.update(archived_rosters(sources['roster']))
    return dict(season=season,updatedAt=iso(datetime.now(timezone.utc)),games=games,teams=teams,
                players=list(players.values()),_weeklyRosters=weekly,
                stats=stats,injuries=injuries,passProfiles=profiles,coverage=[
        dict(source='nflverse schedule + ESPN scoreboard',detail=f'{len(games)} regular-season and playoff fixtures across {seasons[0]}–{season}. TBD kickoffs remain blank.',url='https://github.com/nflverse/nfldata'),
        dict(source='nflverse player stats and play-by-play',detail=f'{verified} boxes reconciled against ESPN finals, schedule scores and end-of-game play totals. TDs use credited scorers. Red-zone opportunity uses the opponent 20-yard line.',url='https://github.com/nflverse/nflverse-data'),
        dict(source='nflverse weekly rosters',detail=f'{len(roster_weeks)} teams at their latest published roster week. Active, exempt and reserve players included. Practice squad players require elevation.',url='https://github.com/nflverse/nflverse-data/releases/tag/weekly_rosters'),
        dict(source='ESPN injury reports',detail=f"{len(injuries)} non-active reports across the latest {len(raw_injuries['injuries'])} team lists. Feed retrieved {iso(now)}. The source lists up to 25 recent updates per team. Unlisted availability is unconfirmed.",url='https://www.espn.com/nfl/injuries'),
        dict(source='ESPN game previews',detail=f'{sum("weather" in g for g in upcoming)} of {len(upcoming)} fixtures in the next seven days have a forecast. Venue and roof come from nflverse.',url='https://www.espn.com/nfl/scoreboard')
    ])


def preserve_verified(data, previous):
    """Abort on historical regression. Retain older archived finals for local bet settlement."""
    current = {g['id']:g for g in data['games']}
    archived=set()
    fresh_keys = {(s['game'],s['player']) for s in data['stats']}
    for g in previous['games']:
        if not g['boxVerified']:
            continue
        if g['season'] < data['season']-1:
            archived.add(g['id'])
            data['games'].append(g)
        elif not current.get(g['id'],{}).get('boxVerified'):
            raise ValueError('Formerly verified box no longer verified: '+g['id'])
    for row in previous['stats']:
        if row['game'] in archived:
            data['stats'].append(row)
        elif (row['game'],row['player']) not in fresh_keys:
            # Players removed by an official correction require review, not stale settlement.
            print('Source correction removed player-game',row['game'],row['player'])
    known = {p['id'] for p in data['players']}
    data['players'].extend(dict(p,activeRoster=False) for p in previous['players'] if p['id'] not in known)


def main():
    from model import analyse
    data = get_data()
    data['model'] = analyse(data)
    data.pop('_weeklyRosters',None)
    if OUTPUT.exists():
        preserve_verified(data,json.loads(OUTPUT.read_bytes()))
    weeks_dir = OUTPUT.parent / 'weeks'
    weeks_dir.mkdir(exist_ok=True)
    for week_key, value in data['model']['weeks'].items():
        if not re.fullmatch(r'\d{4}-\d{1,2}', week_key):
            raise ValueError('Invalid week identifier')
        path = weeks_dir / (week_key + '.json')
        tmp_week = path.with_suffix('.tmp')
        tmp_week.write_text(json.dumps(value,separators=(',',':'),ensure_ascii=False,allow_nan=False),
                            encoding='utf-8')
        tmp_week.replace(path)
        data['model']['weeks'][week_key] = 'weeks/' + path.name
    temp = OUTPUT.with_suffix('.tmp')
    temp.write_text(json.dumps(data,separators=(',',':'),ensure_ascii=False,allow_nan=False),encoding='utf-8')
    temp.replace(OUTPUT)
    print(f"Published snapshot: {len(data['games'])} fixtures, {len(data['stats'])} verified player-games, {OUTPUT.stat().st_size:,} bytes")


if __name__ == '__main__':
    main()
