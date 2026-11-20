"""Restore the latest production observations before running the source update."""
import json
import sys
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

def restore(base, path=Path("docs/data.json")):
    remote = Request(base.rstrip("/") + "/data.json", headers={"User-Agent": "NFL-Matchup-Lab/1.0 (public sports analysis)"})
    try:
        with urlopen(remote, timeout=90) as response:
            body = response.read()
    except HTTPError as error:
        if error.code == 404:
            return
        raise
    candidate = json.loads(body)
    if not candidate.get("games") or not candidate.get("stats"):
        raise ValueError("Published snapshot has no fixtures or verified player results")
    if path.exists() and json.loads(path.read_bytes())["updatedAt"] >= candidate["updatedAt"]:
        return
    path.parent.mkdir(exist_ok=True, parents=True)
    temporary = path.with_suffix(".restore.tmp")
    temporary.write_bytes(body)
    temporary.replace(path)

if __name__ == "__main__":
    restore(sys.argv[1])
