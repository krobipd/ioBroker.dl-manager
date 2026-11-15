#!/bin/bash
# Tribler in the container recorder. Tribler binds its REST API to 127.0.0.1 (tribler_config.py DEFAULT_CONFIG
# api.http_host) and writes its whole default configuration on the first start (run_tribler.py init_config, once
# CORE_API_PORT is set). The recorder reaches it over the Docker network only on 0.0.0.0: the first start runs until the
# API answers, the host is changed in the file Tribler wrote, and Tribler starts again — the settings it then answers
# are those of a real installation, not a file the recorder wrote.
set -u
# IPv8 tries to reach Tribler's bootstrap servers on the Internet the container does not have: one line per packet,
# hundreds a minute — they would bury everything else in the log the recorder prints on a failure
exec > >(grep --line-buffered -v 'rust_endpoint\] Could not send packet') 2>&1
echo "tribler-start: $(id)"
# 8.0.7 keeps its IPv8 keys in ~/.Tribler whatever TSTATEDIR says (tribler_config.py DEFAULT_CONFIG ipv8.keys; 8.4's
# run_tribler.py moves them below TSTATEDIR) and does not create the folder: without it the first start ends in a
# FileNotFoundError on ec_multichain.pem
mkdir -p "$HOME/.Tribler"
/usr/share/tribler/tribler -s &
pid=$!
for _ in $(seq 1 240); do
  code=$(curl -s -o /dev/null -w '%{http_code}' -H "X-Api-Key: $CORE_API_KEY" \
    "http://127.0.0.1:$CORE_API_PORT/api/versioning/versions/current" || true)
  [ "$code" = "200" ] && break
  sleep 1
done
echo "tribler-start: first start answered $code"
kill "$pid"
for _ in $(seq 1 60); do
  kill -0 "$pid" 2>/dev/null || break
  sleep 1
done
kill -9 "$pid" 2>/dev/null
# the folder below TSTATEDIR is the version Tribler keeps its state for (VERSION_SUBDIR: "8.0", "git" from source)
conf=$(ls "$TSTATEDIR"/*/configuration.json | head -n 1)
sed -i 's/"http_host": "127.0.0.1"/"http_host": "0.0.0.0"/' "$conf"
echo "tribler-start: $conf: $(grep '"http_host"' "$conf")"
exec /usr/share/tribler/tribler -s
