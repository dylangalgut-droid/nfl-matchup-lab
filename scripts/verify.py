"""Validate all public snapshot files before they are eligible for publication."""
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / "docs"

def verify():
    data = json.loads((ROOT / "data.json").read_bytes())
    teams = {team["id"] for team in data["teams"]}
    assert len(teams) == 32
    games = {game["id"]: game for game in data["games"]}
    assert len(games) == len(data["games"])
    results = {(row["game"], row["player"]) for row in data["stats"]}
    assert len(results) == len(data["stats"]) and results
    assert all(games[g]["boxVerified"] and games[g]["status"] == "final" for g, _ in results)
    for season, profile in data['passProfiles'].items():
        finals = sum(g['boxVerified'] for g in games.values() if g['season'] == int(season))
        if not finals:
            continue
        totals = []
        for mode in ('offence', 'defence'):
            records = profile[mode].values()
            assert sum(record['games'] for record in records) == 2 * finals
            league = [0,0,0,0]
            for record in records:
                groups = record['groups']
                targets, catches, measured, yards = groups['all']
                assert targets >= catches >= measured >= 0 and targets > 0
                for i, total in enumerate(groups['all']):
                    league[i] += total
                    for dimension in ('depth/', 'side/', 'zone/'):
                        assert sum(v[i] for k,v in groups.items() if k.startswith(dimension)) == total
            totals.append(league)
        assert totals[0] == totals[1]
        for team, record in profile['offence'].items():
            receivers = profile['receivers'][team].values()
            for key, values in record['groups'].items():
                assert sum(groups.get(key, 0) for groups in receivers) == values[0]
    cells = picks = 0
    for key, filename in data["model"]["weeks"].items():
        assert filename == f"weeks/{key}.json"
        week = json.loads((ROOT / filename).read_bytes())
        for role in week["cells"].values():
            for stat in role.values():
                for team, cell in stat.items():
                    assert team in teams and 0 < cell["n"] <= cell["leagueN"]
                    assert abs(cell["diff"] - (cell["avg"] - cell["league"])) < .002
                    cells += 1
        for player in week["players"]:
            assert player["game"] in games and player["team"] in teams
            for pick in player["flags"]:
                assert all(math.isfinite(pick[k]) for k in ("baseline", "projected", "delta"))
                assert pick["explanation"]
                picks += 1
    assert cells and any(row["n"] for row in data["model"]["performance"])
    print(f'{len(teams)} teams, {len(games)} fixtures, {len(results)} player results, {cells} allowances and {picks} flagged player markets verified.')

if __name__ == "__main__":
    verify()
