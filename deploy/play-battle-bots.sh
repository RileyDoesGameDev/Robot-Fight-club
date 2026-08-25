#!/usr/bin/env bash
# Battle Bots — macOS / Linux launcher.
#
# The Windows equivalent is Play-Battle-Bots.cmd. This does the same three things:
# find the image (already loaded, local tarball, or the GitHub release), start the
# container, open a browser.
#
#   chmod +x play-battle-bots.sh && ./play-battle-bots.sh
#
# On macOS, renaming this to play-battle-bots.command makes it double-clickable
# from Finder.
set -uo pipefail

IMAGE="battle-bots:latest"
CONTAINER="battle-bots"
PORT="${PORT:-4300}"
TARBALL="battle-bots-image.tar"
RELEASE_TAG="v0.9.0"
RELEASE_URL="https://github.com/RileyDoesGameDev/Robot-Fight-club/releases/download/${RELEASE_TAG}/${TARBALL}"

cd "$(dirname "$0")"

echo
echo "  ============================================"
echo "    BATTLE BOTS"
echo "  ============================================"
echo

fail() { echo; echo "  [X] $1"; [ $# -gt 1 ] && { echo; echo "      $2"; }; echo; exit 1; }

command -v docker >/dev/null 2>&1 \
  || fail "Docker is not installed, or is not on your PATH." \
          "Install Docker Desktop: https://www.docker.com/products/docker-desktop/"

# `docker info` is the check that matters — the CLI existing does not mean the
# daemon is up, and not starting it is the most common reason this fails.
docker info >/dev/null 2>&1 \
  || fail "Docker is installed but not running." \
          "Start Docker Desktop, wait for it to finish starting, then run this again."
echo "  [1/4] Docker is running."

if docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "  [2/4] Game image already loaded."
elif [ -f "$TARBALL" ]; then
  echo "  [2/4] Loading the game from $TARBALL ..."
  docker load -i "$TARBALL" || fail "Could not load $TARBALL — the file may be incomplete."
else
  echo "  [2/4] No local copy found. Downloading (about 27 MB) ..."
  echo "        $RELEASE_URL"
  curl -L --fail --progress-bar -o "$TARBALL" "$RELEASE_URL" \
    || fail "Download failed." \
            "No internet, or the release is not published yet. You can also copy $TARBALL next to this script by hand."
  docker load -i "$TARBALL" || fail "The download finished but Docker could not load it."
fi

# A leftover container makes the next run fail with "name already in use", which
# reads like a real problem and is not one.
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true

echo "  [3/4] Starting the game ..."
docker run -d --name "$CONTAINER" --restart unless-stopped -p "${PORT}:8080" \
  --read-only --tmpfs /tmp --tmpfs /var/cache/nginx \
  --security-opt no-new-privileges:true "$IMAGE" >/dev/null \
  || fail "The container would not start." \
          "If the message above mentions the port, something else is using ${PORT}. Try: PORT=8080 ./play-battle-bots.sh"

echo "  [4/4] Waiting for it to come up ..."
for _ in $(seq 1 15); do
  curl -s -o /dev/null --max-time 2 "http://localhost:${PORT}/" && break
  sleep 1
done

cat <<EOF

  ============================================
    Ready — http://localhost:${PORT}
  ============================================

    Player 1:  W/S drive   A/D turn   E weapon   R self-right   Esc pause
    Player 2:  numpad 8/5 drive   4/6 turn   9 weapon   7 self-right

    The weapon is a TOGGLE — press once on, once off.

    Two things that look like bugs and are not:
      * Keep the tab in front. Browsers stop animation in background tabs,
        so the game does not slow down, it stops.
      * Click once before expecting sound. Browsers refuse to start audio
        until you have interacted with the page.

    To stop:  docker rm -f ${CONTAINER}

EOF

if command -v open >/dev/null 2>&1; then open "http://localhost:${PORT}/"
elif command -v xdg-open >/dev/null 2>&1; then xdg-open "http://localhost:${PORT}/" >/dev/null 2>&1 &
fi
