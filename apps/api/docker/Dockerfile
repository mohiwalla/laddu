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

# dot's computer (runtime/desktop, started when first used): KasmVNC is the display and the web
# viewer people watch it in (its "watch" login can only look); XFCE is the desktop; Chromium and
# the usual apps. AT-SPI exposes on-screen controls by name, xdotool sends real mouse and keyboard
# input, wmctrl/xclip handle windows and the clipboard. About 1 GB.
ARG KASMVNC=1.5.0
RUN arch="$(dpkg --print-architecture)" \
 && curl -fsSLo /tmp/kasmvnc.deb \
      "https://github.com/kasmtech/KasmVNC/releases/download/v${KASMVNC}/kasmvncserver_trixie_${KASMVNC}_${arch}.deb" \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      /tmp/kasmvnc.deb \
      xfce4-session xfwm4 xfce4-panel xfdesktop4 xfce4-terminal thunar mousepad \
      dbus dbus-x11 at-spi2-core libatk-adaptor python3-gi gir1.2-atspi-2.0 python3-pyatspi \
      xdotool wmctrl xclip x11-utils x11-xserver-utils \
      chromium fonts-liberation \
 && rm -rf /var/lib/apt/lists/* /tmp/kasmvnc.deb
# For every Chromium launch (from dot, the menu, or someone who took control): the container is
# the sandbox (Chromium's own needs namespaces the container doesn't grant), pages appear in the
# accessibility tree, and saved passwords work without a desktop keyring.
RUN printf '%s\n' 'export CHROMIUM_FLAGS="$CHROMIUM_FLAGS --no-sandbox --test-type --force-renderer-accessibility --password-store=basic --no-first-run --no-default-browser-check"' \
      > /etc/chromium.d/dot
# Fonts for the desktop and the pages it shows: Inter for the interface and sans-serif text
# (instead of DejaVu), also where pages ask for Apple, Windows or Android UI fonts by name;
# JetBrains Mono for code; Noto CJK so Chinese, Japanese and Korean aren't boxes. Grayscale
# antialiasing with slight hinting, which also streams better than subpixel colour fringes.
# (runtime/desktop sets the same for XFCE's own settings when it starts.)
RUN apt-get update \
 && apt-get install -y --no-install-recommends fonts-inter-variable fonts-jetbrains-mono fonts-noto-cjk \
 && rm -rf /var/lib/apt/lists/* \
 && { printf '%s\n' '<?xml version="1.0"?>' '<!DOCTYPE fontconfig SYSTEM "fonts.dtd">' '<fontconfig>' \
      '<alias binding="strong"><family>sans-serif</family><prefer><family>Inter Variable</family></prefer></alias>' \
      '<alias binding="strong"><family>system-ui</family><prefer><family>Inter Variable</family></prefer></alias>' \
      '<alias binding="strong"><family>monospace</family><prefer><family>JetBrains Mono</family></prefer></alias>'; \
      for ui in -apple-system BlinkMacSystemFont "SF Pro Text" "SF Pro Display" "Helvetica Neue" "Segoe UI" Roboto Ubuntu Cantarell; do \
        printf '<alias binding="same"><family>%s</family><prefer><family>Inter Variable</family></prefer></alias>\n' "$ui"; done; \
      printf '%s\n' '<match target="font"><edit name="antialias" mode="assign"><bool>true</bool></edit><edit name="hinting" mode="assign"><bool>true</bool></edit><edit name="hintstyle" mode="assign"><const>hintslight</const></edit><edit name="rgba" mode="assign"><const>none</const></edit></match>' \
      '</fontconfig>'; } > /etc/fonts/local.conf \
 && fc-cache -f >/dev/null

USER dot
WORKDIR /home/dot/workspace
ENV HOME=/home/dot CODEX_HOME=/home/dot/.codex PATH=/opt/codex/bin:/opt/codex/codex-path:$PATH \
    MPLBACKEND=Agg
CMD ["sleep", "infinity"]
