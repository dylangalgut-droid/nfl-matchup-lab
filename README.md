# NFL Matchup Lab

Four mobile-friendly views for NFL defensive allowances, player-stat matchups, chronological backtests and a private bet record. The NFL site has its own code, data and storage namespace.

## Using the site

- Select a season/week and a Melbourne game day. Select a statistic and click any defence cell for the raw averages, qualifying sample and matching opponents. Scroll the matrix horizontally on a phone.
- Game matchups shows player baselines, projections and evidence for higher or lower production. Performance compares the frozen pre-week forecasts with player averages in the same units.
- Bet tracker saves singles and multis on the current browser and website origin. Enter past or future games. Export a backup before clearing site data or moving to a different browser, phone or site address. Import restores that backup. The web app never uploads bets. Source refreshes operate only on public football data.

## Feeds and coverage

The updater reads the nflverse schedule, weekly player statistics, rosters and play-by-play releases, and ESPN scoreboard, game preview and injury feeds. Coverage and timestamps appear under the four pages. Only reconciled final games with matching scores and verified event data are available for automatic grading. Markets require explicit player records. Review DNP, push, ambiguous or repriced results against the bookmaker's rules. The line-based tracker grades outcomes separately from the model's production signals.

Week filters use the NFL season and week. Displayed dates, times and daily records use Australia/Melbourne, including daylight saving. Some future kickoff times are unpublished. Conditions, roster status and injuries can change after a download. Position labels describe usage. Slot, outside and route participation are unavailable in the source used here.

## Run or publish

From the repository root, generate the first snapshot with `python scripts/update.py`, then run `python -m http.server --directory docs` and open the local address shown. No dependency installation or API credentials are required (Python 3.11+ and Node 22+ for development). Subsequent local views can use the downloaded snapshot offline.

For GitHub Pages, use a public repository, enable Actions, and choose **Settings → Pages → Source → GitHub Actions**. Push this project to the main branch or run **Update NFL data and publish**. The workflow runs only for public repositories using a standard hosted Linux runner. No paid runner, database, API subscription or external build service is configured. Cron requests fresh downloads at 01:37 and 13:37 UTC. Scheduling can be delayed, and GitHub can disable schedules after 60 days without repository activity. A failed fetch or validation leaves the last deployed site in service.

For the included ChatGPT hosting edition, refer to [hosting/REFRESH.md](hosting/REFRESH.md). The schedule belongs to the deployed site. The reload button only reads the published data.

## Local checks

```sh
python scripts/update.py
python -m unittest discover -s tests
node --test tests/*.cjs
python scripts/verify.py
```

Source credits: [nflverse data](https://github.com/nflverse/nflverse-data), [nflverse schedules](https://github.com/nflverse/nfldata), [ESPN NFL](https://www.espn.com/nfl/). Design adapted from the owner's NBA Matchup Lab.
