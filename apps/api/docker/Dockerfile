# Per-user runtime for dot: every Slack user gets their own container from this image.
# Codex runs inside it, so whatever it executes only sees this container, never the host.
# Built by src/agent/containers.ts; the build context also holds `codex/`, the platform
# folder of the @openai/codex npm package (same version the SDK expects), layout intact.
FROM debian:trixie

RUN apt-get update \
 && apt-get install -y --no-install-recommends bash ca-certificates curl git jq less procps python3 unzip \
 && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --uid 1000 --shell /bin/bash dot \
 && mkdir -p /home/dot/workspace /home/dot/.codex \
 && chown -R dot:dot /home/dot

COPY codex /opt/codex

USER dot
WORKDIR /home/dot/workspace
ENV HOME=/home/dot CODEX_HOME=/home/dot/.codex PATH=/opt/codex/bin:/opt/codex/codex-path:$PATH
CMD ["sleep", "infinity"]
