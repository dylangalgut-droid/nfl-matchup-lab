"""Use an owner-only Site service credential through hidden stdin. No secrets on disk."""
import argparse
import datetime as dt
import getpass
import hashlib
import hmac
import json
import sys
import time
from pathlib import Path
from urllib.request import Request, urlopen

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--configure", action="store_true")
    parser.add_argument("--bundle", type=Path)
    parser.add_argument("--url")
    args = parser.parse_args()
    token = getpass.getpass("Site service credential (hidden): ")
    key = hmac.digest(token.encode(), b"NFL Matchup Lab / snapshot signing / v1", "sha256")
    if args.configure:
        # Only setup orchestration captures this output and puts it in a runtime secret.
        print(key.hex())
        return
    payload = args.bundle.read_bytes()
    digest = hashlib.sha256(payload).hexdigest()
    observed = json.loads(Path("docs/data.json").read_bytes())["updatedAt"]
    stamp = int(dt.datetime.fromisoformat(observed.replace("Z","+00:00")).timestamp())
    issued = int(time.time())
    signature = hmac.digest(key,f"{digest}\n{issued}\n{stamp}".encode(),"sha256").hex()
    req = Request(args.url.rstrip("/")+"/snapshot-upload",method="PUT",data=payload,headers={
        "User-Agent":"NFL-Matchup-Lab/1.0 (public sports analysis)","Content-Type":"application/octet-stream",
        "X-Snapshot-Sha256":digest,"X-Update-Signature":signature,"X-Update-Time":str(issued),"X-Data-Time":str(stamp)})
    with urlopen(req,timeout=90) as result:
        if result.status != 200 or result.read() != b'Updated':
            sys.exit("Writer did not confirm update")
    print("Verified upload accepted.")
if __name__ == "__main__":
    main()
