# Battle Bots — a self-contained, shareable image.
#
# Everything the game needs is baked in: the engine player, the scene bundle, the
# seeded project files and the audio. There is no host mount, no volume and no
# network access at runtime, so this image runs the same on any machine that has
# Docker and nothing else.
#
# Build it with `node tools/package-game.mjs`, which rebuilds the game first — the
# COPY below takes whatever is in build/battle-bots at that moment, and a stale build
# would be shipped without complaint.
#
#   docker build -f deploy/Dockerfile -t battle-bots:latest .
#   docker run --rm -p 4300:8080 battle-bots:latest
#
# Unprivileged nginx: it runs as uid 101 and listens on 8080 rather than 80, so the
# container needs no root and no added capabilities. That matters more than usual for
# something meant to be handed to other people — nobody should have to run a game as
# root to look at it.
FROM nginxinc/nginx-unprivileged:alpine

LABEL org.opencontainers.image.title="Battle Bots" \
      org.opencontainers.image.description="Physics-based robot combat. Built on the DSD SMPL-Engine." \
      org.opencontainers.image.licenses="UNLICENSED"

COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY build/battle-bots/ /usr/share/nginx/html/

EXPOSE 8080

# A build with no index.html is the failure this whole pipeline is designed against:
# it would start, serve 404s, and look like a networking problem. Fail at build time
# instead, where the message can say what is actually wrong.
RUN test -f /usr/share/nginx/html/index.html \
 && test -f /usr/share/nginx/html/player.js \
 && test -f /usr/share/nginx/html/seed.js \
 || (echo "FATAL: build/battle-bots is incomplete — run tools/package-game.mjs" && exit 1)

HEALTHCHECK --interval=30s --timeout=3s --start-period=2s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/ || exit 1
