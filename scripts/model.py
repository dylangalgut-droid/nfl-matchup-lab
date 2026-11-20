"""Build point-in-time NFL allowances, projections and walk-forward comparisons."""
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from math import sqrt
from statistics import mean

ROLES = (
    ("qb_pocket", "Lower-rush QB", "QB"), ("qb_mobile", "Mobile QB", "QB"),
    ("qb_unknown", "QB · limited history", "QB"), ("rb_lead", "Lead rushing back", "RB"),
    ("rb_receiving", "Receiving back", "RB"), ("rb_rotation", "Rotational back", "RB"),
    ("rb_unknown", "RB · limited history", "RB"), 
    ("wr_short", "Short-target receiver", "WR"), ("wr_intermediate", "Intermediate-target receiver", "WR"),
    ("wr_deep", "Deep-target receiver", "WR"), ("wr_unknown", "WR · limited history", "WR"),
    ("te_primary", "Primary receiving TE", "TE"), ("te_secondary", "Secondary TE", "TE"),
    ("te_unknown", "TE · limited history", "TE"),
)
# Each threshold is in the native unit. It filters small movements, not probability.
MARKETS = {
    "passing_yards": ("Passing yards", "yards", ("QB",), 5),
    "passing_tds": ("Passing touchdowns", "TDs", ("QB",), .12),
    "rushing_yards": ("Rushing yards", "yards", ("RB", "QB"), 2),
    "carries": ("Rushing attempts", "attempts", ("RB", "QB"), .65),
    "receiving_yards": ("Receiving yards", "yards", ("WR", "TE", "RB"), 2),
    "receptions": ("Receptions", "receptions", ("WR", "TE", "RB"), .25),
    "rush_rec_yards": ("Rushing + receiving yards", "yards", ("RB", "WR", "TE"), 2.5),
    "tds": ("Touchdowns scored", "TDs", ("QB", "RB", "WR", "TE"), .08),
}
ROLE_NAME = {key: name for key, name, _ in ROLES}
OUT = {"out", "injured reserve", "ir", "reserve/injured", "reserve list", "exempt list", "physically unable to perform", "pup", "suspended"}


def stamp(value):
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)
    except (ValueError, TypeError):
        return None


def number(row, key):
    value = row.get(key)
    return value if isinstance(value, (int, float)) else None


def series(rows, stat):
    return [v for row in rows if (v := number(row, stat)) is not None]


def avg(rows, stat):
    values = series(rows, stat)
    return mean(values) if values else None


def eligible(row):
    attempts, carries, targets = (row.get(s) or 0 for s in ("attempts", "carries", "targets"))
    if row["position"] == "QB":
        return attempts >= 5 or carries >= 3
    return row["position"] in ("RB", "WR", "TE") and carries + targets >= 1


def role_for(position, history, tight_end_leader, player):
    if position == "WR":
        targeted = [r for r in history if (number(r, "targets") or 0) > 0]
        targets = sum(r["targets"] for r in targeted)
        if len(targeted) < 3 or targets < 12 or any(number(r, "receiving_air_yards") is None for r in targeted):
            return "wr_unknown"
        depth = sum(r["receiving_air_yards"] for r in targeted) / targets
        if depth < 8:
            return "wr_short"
        return "wr_intermediate" if depth < 13 else "wr_deep"
    if len(history) < 3:
        return position.lower() + "_unknown"
    if position == "QB":
        return "qb_mobile" if (avg(history, "carries") or 0) >= 4 else "qb_pocket"
    if position == "TE":
        if tight_end_leader is None:
            return "te_unknown"
        return "te_primary" if player == tight_end_leader else "te_secondary"
    rushes = avg(history, "carries") or 0
    targets = avg(history, "targets") or 0
    if rushes >= 10:
        return "rb_lead"
    if targets >= 2.5 and targets >= .45 * rushes:
        return "rb_receiving"
    return "rb_rotation"


def recent(history, when, n=12):
    cutoff = when - timedelta(days=365)
    return [row for row in history[-n:] if row["_time"] >= cutoff]


def same_team(history, team):
    return [r for r in history if r["team"] == team]


class Bucket:
    def __init__(self):
        self.n = self.total = self.residual = self.residual_n = 0
        self.chances = self.eff_yards = 0

    def add(self, value, baseline, row, stat):
        self.n += 1
        self.total += value
        if baseline is not None:
            self.residual += value - baseline
            self.residual_n += 1
        chance = {"passing_yards": "attempts", "rushing_yards": "carries", "receiving_yards": "targets"}.get(stat)
        if chance and (number(row, chance) or 0) > 0:
            self.chances += row[chance]
            self.eff_yards += value

    def average(self):
        return self.total / self.n if self.n else None


class ErrorScore:
    def __init__(self):
        self.n = self.ae = self.se = self.base_ae = self.base_se = self.directional = self.correct = 0

    def record(self, actual, base, projected):
        err = projected - actual
        naive = base - actual
        self.n += 1
        self.ae += abs(err)
        self.se += err ** 2
        self.base_ae += abs(naive)
        self.base_se += naive ** 2
        if abs(actual - base) > 1e-7 and abs(projected - base) > 1e-7:
            self.directional += 1
            self.correct += (projected - base) * (actual - base) > 0

    def report(self, stat):
        n = self.n
        return dict(stat=stat, n=n, mae=round(self.ae/n, 3) if n else None,
                    baselineMae=round(self.base_ae/n, 3) if n else None,
                    rmse=round(sqrt(self.se/n), 3) if n else None,
                    baselineRmse=round(sqrt(self.base_se/n), 3) if n else None,
                    directionalN=self.directional,
                    directionalAccuracy=round(100*self.correct/self.directional, 1) if self.directional else None)


def leaders(histories, members, when):
    candidates = defaultdict(list)
    for member in members:
        if member["position"] != "TE":
            continue
        rows = same_team(recent(histories[member["id"]], when, 5), member["team"])
        if len(rows) >= 3:
            candidates[member["team"]].append((avg(rows, "targets") or 0, member["id"]))
    return {team: max(items)[1] for team, items in candidates.items()}


def volume_context(rows):
    """Game level attempts and carries, used only when both are populated."""
    totals = []
    for offense in rows:
        attempts = sum(series(offense, "attempts"))
        rushes = sum(series(offense, "carries"))
        if attempts and rushes:
            totals.append((attempts, rushes))
    return totals


class WeeklyState:
    def __init__(self, samples, team_logs, when):
        self.cell = defaultdict(Bucket)
        self.pool = defaultdict(Bucket)
        self.allowed_volume = defaultdict(list)
        self.league_volume = []
        start = when - timedelta(days=365)
        for time, row, role, baselines in samples:
            if time < start:
                continue
            for stat, base in baselines.items():
                value = number(row, stat)
                if value is None:
                    continue
                self.cell[role, stat, row["opponent"]].add(value, base, row, stat)
                self.pool[role, stat].add(value, base, row, stat)
        for time, defense, vol in team_logs:
            if time >= start:
                self.allowed_volume[defense].append(vol)
                self.league_volume.append(vol)
        self.target_volume = self.rate(self.league_volume)
        self.team_volume = {d: self.rate(v) for d, v in self.allowed_volume.items()}

    @staticmethod
    def rate(volumes):
        if not volumes:
            return None
        return tuple(mean(v[index] for v in volumes) for index in (0, 1))

    def cells(self):
        output = defaultdict(lambda: defaultdict(dict))
        for (role, stat, team), box in self.cell.items():
            if not box.n:
                continue
            pool = self.pool[role, stat].average()
            value = box.average()
            output[role][stat][team] = {
                "n": box.n, "leagueN": self.pool[role, stat].n,
                "avg": round(value, 3), "league": round(pool, 3), "diff": round(value - pool, 3)
            }
        return output

    def project(self, role, stat, foe, rows, base):
        bucket = self.cell.get((role, stat, foe))
        pool = self.pool.get((role, stat))
        if not bucket or not pool or not bucket.n:
            return None
        diff = bucket.average() - pool.average()
        strength = bucket.n / (bucket.n + 12)
        residual = 0
        if bucket.residual_n and pool.residual_n:
            residual = (bucket.residual/bucket.residual_n - pool.residual/pool.residual_n)
            residual *= bucket.residual_n / (bucket.residual_n + 12)
        ratio = {"passing_yards": "attempts", "receiving_yards": "targets", "rushing_yards": "carries"}.get(stat)
        efficiency = 0
        if ratio and bucket.chances and pool.chances:
            efficiency = (bucket.eff_yards/bucket.chances - pool.eff_yards/pool.chances) * (avg(rows, ratio) or 0)
        trend = (avg(rows[-3:], stat) if series(rows[-3:], stat) else base) - base
        # Counts proxy game speed and pass/rush balance jointly; cap because both
        # depend on opponent quality and game state.
        volume = 0
        if foe in self.team_volume and self.target_volume:
            def plays(vol):
                if stat in ("rush_rec_yards", "tds"):
                    return sum(vol)
                return vol[1] if stat in ("carries", "rushing_yards") else vol[0]
            vol_ratio = plays(self.team_volume[foe])/plays(self.target_volume) - 1
            volume = base * max(-.12, min(.12, vol_ratio)) * .15 * strength
        components = {
            "role allowance": .35 * strength * diff, "opponent-adjusted form": .27 * residual,
            "yards per opportunity": .10 * efficiency * strength, "recent form": .16 * trend,
            "pass/rush volume": volume,
        }
        # Small workload signals complement the underlying outcome trend. They
        # are capped so short-term role volatility cannot dominate a projection.
        workload_key = {"receiving_yards": "target_share", "receptions": "target_share",
                        "rushing_yards": "carries"}.get(stat)
        if workload_key:
            historic = avg(rows, workload_key)
            short = avg(rows[-3:], workload_key)
            if historic and short is not None:
                shift = max(-.35, min(.35, short/historic - 1))
                components["usage share"] = .10 * base * shift
        if stat == "tds":
            rz = [sum((r["red_zone_targets"],r["red_zone_carries"])) for r in rows
                  if number(r, "red_zone_targets") is not None and number(r, "red_zone_carries") is not None]
            if len(rz) >= 4:
                components["red-zone involvement"] = .04 * max(-2, min(2, mean(rz[-3:]) - mean(rz)))
            components = {k:v * .55 for k, v in components.items()}
        prediction = max(0, base + sum(components.values()))
        return prediction, diff, bucket.n, components


def injury_change(stat, rows, team_members, histories, when):
    """Require explicit near-term absence and workload overlap within position."""
    if not rows:
        return 0, None
    team = rows[-1]["team"]
    for mate in team_members:
        if mate["id"] == rows[-1]["player"] or mate["position"] != rows[-1]["position"]:
            continue
        if str(mate.get("injury") or "").strip().lower() not in OUT:
            continue
        mate_rows = same_team(recent(histories[mate["id"]], when), team)
        if len(mate_rows) < 3:
            continue
        played = {r["game"] for r in mate_rows}
        # The recent baseline has already absorbed an extended absence.
        if not any(r["game"] in played for r in rows[-3:]):
            continue
        together = [r for r in rows if r["game"] in played]
        apart = [r for r in rows if r["game"] not in played]
        if len(series(together, stat)) < 3 or len(series(apart, stat)) < 3:
            continue
        with_mate, without = avg(together, stat), avg(apart, stat)
        base = avg(rows, stat) or 0
        # Discount earlier games already contributing to the baseline.
        delta = .20 * (without - with_mate) * len(together)/len(rows)
        bound = max(MARKETS[stat][3] / 2, abs(base) * .10)
        return min(bound, max(-bound, delta)), mate["name"]
    return 0, None


def describe(stat, role, diff, n, components, injury_mate, injury_delta, rows):
    label, unit, _, _ = MARKETS[stat]
    role_label = ROLE_NAME[role].lower()
    text = f"The defence allowed {abs(diff):.2f} {unit} {'above' if diff >= 0 else 'below'} the league average for {role_label} ({n} qualifying player-games)."
    evidence = {k:v for k,v in components.items() if k != "role allowance"}
    if injury_mate and abs(injury_delta) > .005:
        evidence["injury split"] = injury_delta
    name, value = max(evidence.items(), key=lambda item: abs(item[1]))
    descriptions = {
        "recent form": "Production over the last three eligible games",
        "opponent-adjusted form": "How previous opponents performed relative to their own averages",
        "yards per opportunity": "The defence’s efficiency per opportunity at this player’s usual workload",
        "pass/rush volume": "The defence’s pass/rush volume profile",
        "usage share": "The recent change in established carries or target share",
        "red-zone involvement": "The recent change in red-zone carries and targets",
        "injury split": f"The observed split in games with and without a qualifying line for {injury_mate}",
    }
    if abs(value) > .005:
        text += f" {descriptions[name]} {'adds' if value > 0 else 'subtracts'} {abs(value):.2f} {unit} in the estimate."
    else:
        text += "Recent production and opponent-adjusted results add little to the role allowance."
    if stat == "tds":
        carries, targets = avg(rows, "red_zone_carries"), avg(rows, "red_zone_targets")
        if carries is not None and targets is not None:
            text += f" The player averaged {carries+targets:.1f} red-zone carries plus targets."
    return text


METHODS = [
    {"title":"Who qualifies","body":"Count one player once per final, verified game and market. A QB needs at least five pass attempts or three carries. A back, receiver or tight end needs at least one carry or target. A recorded zero stays in the average when that player qualifies. Missing stats are excluded. These are averages conditional on involvement."},
    {"title":"Position and role","body":"Roles use up to five earlier qualifying games with the same team. QBs averaging four or more official carries are mobile (carries may include kneels). Lower-rush QB is a proxy for pocket usage. Backs averaging 10+ carries are lead backs. Of the rest, backs averaging 2.5+ targets and at least 0.45 targets per carry are receiving backs. The rest are rotational. The TE with the highest prior target average among eligible teammates is primary. QBs, RBs and TEs with fewer than three qualifying games in that window have a limited-history role."},
    {"title":"Receiver coverage","body":"WR roles use average target depth (total intended air yards divided by total targets) from prior games with the same team in the five-game window. Short is below 8 yards per target, intermediate is 8 to under 13, and deep is 13 or more. A receiver needs 12 targets over at least three targeted games with complete air-yard data. Other receivers appear under limited history. Target depth describes where passes were aimed. Slot and outside alignment and untargeted routes require separate tracking data. Each player-game counts once."},
    {"title":"Reading the heatmap","body":"Each cell subtracts the pooled league average from the defence’s average for the same role and market over the preceding 365 days. Every qualifying player-game has equal weight. Green means more allowed and red means fewer. Cells with fewer than eight player-games have small samples. The predictor continuously shrinks the allowance by n/(n+12)."},
    {"title":"Forecast construction","body":"The baseline is the player’s last 12 eligible games within a year, with at least three measured values. The forecast adds 35% of the shrunk role allowance, 27% of the shrunk opponent-adjusted difference, 10% of the shrunk yards-per-opportunity difference at the player’s usual volume, 16% of the last-three change, a capped pass/rush volume adjustment, and small capped shifts for recent carries, target share or scoring-area involvement when available. Opponent adjustments compare each prior opponent’s result with their own prior baseline. Volume uses pass attempts and rushes allowed as a pace and game-script proxy. Touchdown adjustments are reduced by 45%."},
    {"title":"Scoring, workload and venue","body":"Touchdowns scored exclude passing touchdowns thrown. Scoring is infrequent, so this view has lower confidence. Carries, targets, target share and red-zone involvement are shown where available. Team pace uses pass/rush volume rather than seconds per play. Venue, line injuries and defensive injuries are context. For an upcoming open-air game with forecast gusts of 25+ mph, passing and receiving yardage are conservatively trimmed 1–2.5% of baseline. This estimate is unvalidated. Unknown or closed roofs receive no adjustment."},
    {"title":"Injury treatment","body":"Current availability applies only to the team’s next upcoming game within eight days. An explicitly absent same-position teammate can affect a projection when at least three recent games fall on each side of the teammate’s recorded involvement, with recent overlap. The model discounts that difference heavily and caps it at 10% of baseline or half the signal threshold, whichever is larger. A missing qualifying line is a workload proxy and does not prove that a player was inactive. Without observed evidence the numerical adjustment is zero. Historical injury and weather adjustments are untested."},
    {"title":"Walk-forward comparison","body":"Each week freezes at its first scheduled kickoff, or the snapshot timestamp if earlier. Only verified games at least 24 hours before that cutoff enter training. Historical roles use each player’s earlier history. Metrics compare forecasts and trailing player averages on the same later qualifying player-games with available results. MAE is mean absolute error, RMSE weights large errors more. Directional accuracy compares the sign of predicted and actual change from baseline, excluding exact ties. The baseline always forecasts no change. Results cover all eligible forecasts, including small unflagged changes, and are conditional on later participation."},
    {"title":"Interpreting selections","body":"An above- or below-average signal must exceed a market-specific minimum movement as well as 4% of baseline. Signal strength describes production relative to the player’s usual average. It does not estimate the chance of beating a bookmaker line, the odds, or expected value."},
]


def archived_members(history, meta, cutoff):
    result = []
    for pid, rows in history.items():
        if not rows:
            continue
        last = rows[-1]
        if cutoff - last["_time"] > timedelta(days=42):
            continue
        result.append({"id": pid, "name": meta.get(pid, {}).get("name", pid),
                       "position": last["position"], "team": last["team"]})
    return result


def freeze_game(rows, game, histories, meta, time):
    """Assign historical role and baseline before observing this game's output."""
    members = archived_members(histories, meta, time)
    leader = leaders(histories, members, time)
    samples = []
    volumes = []
    for defense in (game["home"], game["away"]):
        offense = [r for r in rows if r["opponent"] == defense]
        for volume in volume_context([offense]):
            volumes.append((time, defense, volume))
    for row in rows:
        if not eligible(row):
            continue
        pid = row["player"]
        earlier = recent(histories[pid], time)
        own = same_team(earlier[-5:], row["team"])
        role = role_for(row["position"], own, leader.get(row["team"]), pid)
        baselines = {}
        for stat, (_, _, positions, _) in MARKETS.items():
            if row["position"] in positions and number(row, stat) is not None:
                vals = series(earlier, stat)
                baselines[stat] = mean(vals) if len(vals) >= 3 else None
        samples.append((time, dict(row, _time=time), role, baselines))
    return samples, volumes


def health_note(injuries, teams):
    names = []
    for report in injuries:
        if report.get("team") not in teams:
            continue
        if report.get("position") not in ("C","OL","OG","OT","G","T","DE","DT","DL","LB","CB","S","DB","OLB","ILB","FS","SS","NT"):
            continue
        names.append(f'{report.get("name", "Player")} ({report.get("position")}, {report.get("status", "reported")})')
    if names:
        return "Line/defensive availability (context only): " + ", ".join(names[:3]) + (" and others." if len(names) > 3 else ".")
    return ""


def forecast_member(member, foe, game, week, histories, own_team, leader, state, live, injuries, actual, metrics, save):
    when = week["cutoff"]
    pid, team, pos = member["id"], member["team"], member["position"]
    if pos not in ("QB","RB","WR","TE"):
        return None
    rows = recent(histories[pid], when)
    team_rows = same_team(rows, team)
    role = role_for(pos, same_team(rows[-5:], team), leader.get(team), pid)
    injury = member.get("injury") if live else None
    display_injury = injury
    if not live and member.get("activeRoster") and member.get("injury"):
        display_injury = f'Currently {member["injury"]}; game availability unconfirmed'
    is_out = str(injury or "").lower().strip() in OUT
    workload = {stat:round(v, 2) for stat in ("carries", "targets", "target_share", "red_zone_carries", "red_zone_targets")
                if (v := avg(rows, stat)) is not None}
    member_out = dict(game=game["id"], team=team, opponent=foe, id=pid, name=member["name"], position=pos,
                      role=role, injury=display_injury, flags=[], workload=workload)
    line_note = health_note(injuries, (team, foe)) if live else ""
    if save and line_note:
        member_out["context"] = line_note
    for stat, (_, unit, positions, minimum) in MARKETS.items():
        if pos not in positions or is_out:
            continue
        values = series(rows, stat)
        if len(values) < 3:
            continue
        base = mean(values)
        projection = state.project(role, stat, foe, rows, base)
        if projection is None:
            continue
        core, diff, n, components = projection
        if actual and number(actual, stat) is not None:
            metrics[stat].record(actual[stat], base, core)
        if not save:
            continue
        amount, mate = (injury_change(stat, team_rows, own_team, histories, when)
                        if live and team_rows else (0, None))
        # A forecast is current-only. Do not use realised weather in a backtest.
        gust = number(game.get("weather") or {}, "gustMph") if live else None
        gust_adjustment = 0
        if (gust is not None and gust >= 25 and str(game.get("roof", "")).lower() in ("open", "outdoors")
                and stat in ("passing_yards", "receiving_yards")):
            gust_adjustment = -base * min(.025, .01 + (gust - 25) * .0005)
        prediction = max(0, core + amount + gust_adjustment)
        delta = prediction - base
        if abs(delta) < max(minimum, .04 * abs(base)):
            continue
        reasons = []
        if n < 8:
            reasons.append(f"Small defensive sample ({n} player-games).")
        if len(values) < 6:
            reasons.append(f"Short player history ({len(values)} games).")
        if injury:
            reasons.append(f"Availability: {injury}.")
        if live and not injury:
            reasons.append("No individual designation supplied; availability unconfirmed.")
        if not live and not display_injury:
            reasons.append("Availability unavailable for this cutoff.")
        if gust_adjustment:
            reasons.append(f"Outdoor forecast gusts {gust:.0f} mph: estimated {gust_adjustment:+.2f} {unit}; unvalidated.")
        if mate:
            reasons.append(f"Estimated usage change from {mate}’s reported absence; not historically validated.")
        if stat in ("tds", "passing_tds"):
            reasons.append("Touchdown totals have high game-to-game variability.")
        if role.endswith("_unknown"):
            reasons.append("Insufficient recent same-team usage to assign a more specific role.")
        if line_note:
            reasons.append(line_note)
        info = describe(stat, role, diff, n, components, mate, amount, rows)
        member_out["flags"].append(dict(stat=stat, baseline=round(base, 3), projected=round(prediction, 3),
                                        delta=round(delta, 3), direction="Favourable" if delta > 0 else "Unfavourable",
                                        explanation=info, limitations=" ".join(reasons), n=n, playerN=len(values)))
    return member_out


def analyse(data):
    now = stamp(data["updatedAt"])
    meta = {p["id"]:p for p in data["players"]}
    games = sorted(data["games"], key=lambda g: g.get("kickoff") or "9999")
    boxes = defaultdict(dict)
    # Duplicate records would bias both league averages and role history.
    for row in data["stats"]:
        key = row["player"]
        if key in boxes[row["game"]]:
            raise ValueError(f'Duplicate player-game {key} in {row["game"]}')
        boxes[row["game"]][key] = row

    finals = [g for g in games if stamp(g.get("kickoff")) and g["status"] == "final" and g["boxVerified"] and boxes.get(g["id"])]
    historic_members = defaultdict(list)
    events, logs = [], []
    for game in finals:
        time = stamp(game["kickoff"])
        samples, volumes = freeze_game(boxes[game["id"]].values(), game, historic_members, meta, time)
        for _, row, _, _ in samples:
            historic_members[row["player"]].append(row)
        events.extend(samples)
        logs.extend(volumes)

    groups = defaultdict(list)
    for game in games:
        groups[game["season"], game["week"]].append(game)
    first_future_game = {}
    for game in games:
        if game.get("kickoff") and stamp(game["kickoff"]) >= now and game["status"] == "scheduled":
            for team in (game["home"], game["away"]):
                first_future_game.setdefault(team, game["id"])
    metrics = defaultdict(ErrorScore)
    weeks = {}
    tested_weeks = set()
    first_test = None
    last_test = None
    current_roster = [p for p in meta.values() if p.get("activeRoster")]
    for (season, number_week), week_games in sorted(groups.items(), key=lambda item: item[1][0].get("kickoff") or "9999"):
        first = stamp(week_games[0].get("kickoff")) or now
        cutoff = min(first, now)
        last_allowed = cutoff - timedelta(hours=24)
        training = [event for event in events if event[0] <= last_allowed and event[0] >= cutoff - timedelta(days=365)]
        history = defaultdict(list)
        for _, row, _, _ in training:
            history[row["player"]].append(row)
        state = WeeklyState(training, (entry for entry in logs if entry[0] <= last_allowed), cutoff)
        near_current = any(g["season"] == data["season"] and
                           ((stamp(g.get("kickoff")) or now) >= now or g["status"] in ("in_progress","unconfirmed"))
                           for g in week_games)
        # Use archived inferred members for final games even within the current week.
        archived = archived_members(history, meta, cutoff)
        leaders_past = leaders(history, archived, cutoff)
        leaders_now = leaders(history, current_roster, cutoff) if near_current else {}
        week_id = f"{season}-{number_week}"
        weekly_roster = data.get("_weeklyRosters", {}).get(week_id, [])
        week = {"cutoff":cutoff}
        players = []
        for game in week_games:
            current = near_current and ((stamp(game.get("kickoff")) or now) >= now or game["status"] == "in_progress") and game["status"] != "final" and current_roster
            members = current_roster if current else archived
            lead = leaders_now if current else leaders_past
            official = boxes[game["id"]] if game["status"] == "final" and game["boxVerified"] else {}
            measured_before = sum(v.n for v in metrics.values())
            for team, foe in ((game["home"], game["away"]), (game["away"], game["home"])):
                own_team = [p for p in members if p["team"] == team]
                live = current and first_future_game.get(team) == game["id"] and stamp(game["kickoff"]) <= now + timedelta(days=8)
                # Weekly rosters may contain a change made after the model cutoff.
                # They enrich the archived matchup drilldown but never create a forecast.
                recorded = {p["id"]:p for p in weekly_roster if p["team"] == team} if not current else {}
                seen = set()
                for p in own_team:
                    actual = official.get(p["id"])
                    if actual and (not eligible(actual) or actual["team"] != team):
                        actual = None
                    member = forecast_member(p, foe, game, week, history, own_team, lead, state, live,
                                             data.get("injuries", []), actual, metrics, True)
                    if member and (not recorded or p["id"] in recorded):
                        if recorded and recorded[p["id"]].get("rosterStatus") in ("RES", "EXE"):
                            member["injury"] = "On archived reserve/exempt list; game status unconfirmed"
                        seen.add(p["id"])
                        players.append(member)
                for pid, p in recorded.items():
                    if pid in seen or p["position"] not in ("QB", "RB", "WR", "TE"):
                        continue
                    earlier = same_team(recent(history[pid], cutoff, 5), team)
                    role = role_for(p["position"], earlier, lead.get(team), pid)
                    availability = ("On archived reserve/exempt list; game status unconfirmed"
                                    if p.get("rosterStatus") in ("RES","EXE") else None)
                    players.append(dict(game=game["id"], team=team, opponent=foe, id=pid, name=p["name"],
                                        position=p["position"], role=role, injury=availability, workload={}, flags=[]))
            if sum(v.n for v in metrics.values()) > measured_before:
                tested_weeks.add(week_id)
                first_test = min(first_test or game["kickoff"], game["kickoff"])
                last_test = max(last_test or game["kickoff"], game["kickoff"])
        roster_description = ("Archived weekly rosters show membership. Historical forecasts use only earlier appearances."
                              if weekly_roster else "Historical roster inferred from qualifying appearances within 42 days before the week.")
        if near_current and current_roster:
            roster_description = "Upcoming fixtures use the latest team roster. " + roster_description
        weeks[week_id] = dict(asOf=cutoff.isoformat(), cells=state.cells(), players=players,
                              rosterSource=roster_description)
    return {"roles":[dict(id=k,label=name,position=pos) for k,name,pos in ROLES],
            "stats":[dict(id=k,label=v[0],unit=v[1],positions=v[2]) for k,v in MARKETS.items()],
            "weeks":weeks, "performance":[metrics[s].report(s) for s in MARKETS],
            "testWindow":{"first": first_test, "last": last_test, "weeks":len(tested_weeks)},
            "methodology":METHODS}
