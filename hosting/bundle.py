"""Package only public data for atomic upload, or build the included-hosting edition."""
import argparse
import base64
import gzip
import hashlib
import json
import struct
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
docs = root / "docs"
sys.path.insert(0, str(root / "scripts"))
from verify import verify

def encode(data):
    return json.dumps(data, separators=(",", ":")).encode()

def pack():
    data = json.loads((docs / "data.json").read_bytes())
    files = ["data.json", *data["model"]["weeks"].values()]
    blocks, index, offset = [], {}, 0
    for name in files:
        compressed = gzip.compress((docs / name).read_bytes(), compresslevel=6, mtime=0)
        index["/" + name] = [offset, len(compressed)]
        blocks.append(compressed)
        offset += len(compressed)
    header = encode(index)
    return struct.pack(">I",len(header)) + header + b"".join(blocks), index, blocks

def build(destination, index, blocks):
    assets = {}
    types = {".html":"text/html", ".js":"text/javascript", ".css":"text/css"}
    for file in docs.iterdir():
        if file.suffix in types:
            assets["/" + file.name] = [types[file.suffix],file.read_text()]
    seed = {path:base64.b64encode(body).decode() for path, body in zip(index, blocks)}
    target = destination / "server/index.js"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(b"const assets="+encode(assets)+b";\nconst seed="+encode(seed)+b";\n" +
                       (root/"hosting/worker.js").read_bytes())

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("output", type=Path)
    parser.add_argument("--build", type=Path)
    args = parser.parse_args()
    verify()
    payload, index, blocks = pack()
    args.output.write_bytes(payload)
    print(hashlib.sha256(payload).hexdigest())
    if args.build:
        build(args.build,index,blocks)
