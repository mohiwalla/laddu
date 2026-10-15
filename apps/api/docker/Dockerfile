# Per-user runtime for dot: every Slack user gets their own container from this image.
# Codex runs inside it, so whatever it executes only sees this container, never the host.
# Built by src/agent/containers.ts; the build context also holds `codex/`, the platform
# folder of the @openai/codex npm package (same version the SDK expects), layout intact.
FROM debian:trixie

# Shell basics, then what Codex needs to read and make files people send and ask for: data and
# charts (pandas, matplotlib), documents (pandoc: Markdown ⇄ docx/pptx/html; python-docx,
# openpyxl, reportlab, pypdf; poppler/qpdf for PDFs), images and media (Pillow, ImageMagick, ffmpeg).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash ca-certificates curl git jq less procps file ripgrep sqlite3 unzip zip xz-utils \
      python3 python3-numpy python3-pandas python3-matplotlib python3-openpyxl python3-docx \
      python3-reportlab python3-pypdf python3-pil python3-bs4 python3-requests python3-yaml \
      pandoc poppler-utils qpdf ghostscript imagemagick ffmpeg \
      fonts-dejavu-core fonts-noto-color-emoji \
 && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --uid 1000 --shell /bin/bash dot \
 && mkdir -p /home/dot/workspace /home/dot/.codex \
 && chown -R dot:dot /home/dot

COPY codex /opt/codex

# For the bot's network rules (src/agent/containers.ts): applied from a short-lived root helper
# with NET_ADMIN; the user's own container has no capabilities, so it can't run or undo them.
RUN apt-get update \
 && apt-get install -y --no-install-recommends iptables \
 && rm -rf /var/lib/apt/lists/*

USER dot
WORKDIR /home/dot/workspace
ENV HOME=/home/dot CODEX_HOME=/home/dot/.codex PATH=/opt/codex/bin:/opt/codex/codex-path:$PATH \
    MPLBACKEND=Agg
CMD ["sleep", "infinity"]
