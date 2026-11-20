# Scheduled data refresh

Open a fresh checkout of the linked NFL Site's source using its native scoped repository credential. Use its public live URL. Start in the checkout root.

1. Run `python scripts/restore_snapshot.py "$SITE_URL"` and then `python scripts/update.py`. Run `python -m unittest discover -s tests`, `node --test tests/*.cjs` and `python hosting/bundle.py /tmp/nfl-public.pack`. Stop on a failed check.
2. Read get_site for this specific linked Site. Keep its owner-only service access value in orchestration memory. Launch `python hosting/upload.py --bundle /tmp/nfl-public.pack --url "$SITE_URL"` with a PTY. When the hidden credential prompt appears, pass the returned siwc_bypass_bearer_token via hidden stdin. Do not log it, write it to disk or put it on a command line. The uploader uses a purpose-specific signing key derived locally from that value. Only a short-lived signature leaves the updater. The published server verifies it independently.
3. Fetch data.json and one of its listed weekly files from the published site using the NFL-Matchup-Lab user agent. Compare their contents with the local files, including updatedAt. Retry transient failures after checking the live result. The upload is atomic; incomplete, unsigned and stale snapshots leave the previous generation intact. No code edits, commits, new deployment or runtime configuration changes are needed.
