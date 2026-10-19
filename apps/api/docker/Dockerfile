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
# The desktop's look, as XFCE's system defaults (a person's own choices still win): Arc-Dark for
# apps and window borders, elementary's dark icons (without its HiDPI copy; the screen is never
# scaled), a flat dark background (a photo streams and screenshots heavier), and one top bar: app
# menu (no log-out or shutdown, which would end the session), launchers, open windows, clock. The
# terminal follows the theme. About 80 MB. (runtime/desktop moves older homes off XFCE's stock look.)
RUN apt-get update \
 && apt-get install -y --no-install-recommends arc-theme elementary-xfce-icon-theme xfce4-whiskermenu-plugin \
 && rm -rf /var/lib/apt/lists/* /usr/share/icons/elementary-xfce-hidpi \
 && x=/etc/xdg/xfce4/xfconf/xfce-perchannel-xml \
 && sed -i -e 's|"ThemeName" type="string" value="[^"]*"|"ThemeName" type="string" value="Arc-Dark"|' \
      -e 's|"IconThemeName" type="string" value="[^"]*"|"IconThemeName" type="string" value="elementary-xfce-dark"|' \
      $x/xsettings.xml \
 && printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>' '<channel name="xfwm4" version="1.0">' \
      '<property name="general" type="empty">' \
      '<property name="theme" type="string" value="Arc-Dark"/>' \
      '<property name="button_layout" type="string" value="O|HMC"/>' \
      '<property name="title_alignment" type="string" value="center"/>' \
      '</property></channel>' > $x/xfwm4.xml \
 && printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>' '<channel name="xfce4-desktop" version="1.0">' \
      '<property name="backdrop" type="empty"><property name="screen0" type="empty">' \
      '<property name="monitorVNC-0" type="empty"><property name="workspace0" type="empty">' \
      '<property name="color-style" type="int" value="0"/>' \
      '<property name="image-style" type="int" value="0"/>' \
      '<property name="rgba1" type="array"><value type="double" value="0.149"/><value type="double" value="0.161"/><value type="double" value="0.2"/><value type="double" value="1"/></property>' \
      '</property></property></property></property>' \
      '<property name="desktop-icons" type="empty"><property name="file-icons" type="empty">' \
      '<property name="show-filesystem" type="bool" value="false"/>' \
      '<property name="show-removable" type="bool" value="false"/>' \
      '</property></property></channel>' > $x/xfce4-desktop.xml \
 && printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>' '<channel name="xfce4-terminal" version="1.0">' \
      '<property name="color-use-theme" type="bool" value="true"/>' \
      '<property name="font-use-system" type="bool" value="true"/>' \
      '</channel>' > $x/xfce4-terminal.xml \
 && printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>' '<channel name="xfce4-panel" version="1.0">' \
      '<property name="configver" type="int" value="2"/>' \
      '<property name="panels" type="array"><value type="int" value="1"/>' \
      '<property name="dark-mode" type="bool" value="true"/>' \
      '<property name="panel-1" type="empty">' \
      '<property name="position" type="string" value="p=6;x=0;y=0"/>' \
      '<property name="length" type="uint" value="100"/>' \
      '<property name="position-locked" type="bool" value="true"/>' \
      '<property name="size" type="uint" value="30"/>' \
      '<property name="icon-size" type="uint" value="16"/>' \
      '<property name="plugin-ids" type="array">' \
      '<value type="int" value="1"/><value type="int" value="2"/><value type="int" value="3"/><value type="int" value="4"/><value type="int" value="5"/>' \
      '<value type="int" value="6"/><value type="int" value="7"/><value type="int" value="8"/><value type="int" value="9"/><value type="int" value="10"/>' \
      '</property></property></property>' \
      '<property name="plugins" type="empty">' \
      '<property name="plugin-1" type="string" value="whiskermenu">' \
      '<property name="favorites" type="array"><value type="string" value="chromium.desktop"/><value type="string" value="thunar.desktop"/><value type="string" value="xfce4-terminal.desktop"/><value type="string" value="org.xfce.mousepad.desktop"/></property>' \
      '<property name="show-command-lockscreen" type="bool" value="false"/>' \
      '<property name="show-command-switchuser" type="bool" value="false"/>' \
      '<property name="show-command-logout" type="bool" value="false"/>' \
      '<property name="show-command-restart" type="bool" value="false"/>' \
      '<property name="show-command-shutdown" type="bool" value="false"/>' \
      '<property name="show-command-suspend" type="bool" value="false"/>' \
      '<property name="show-command-hibernate" type="bool" value="false"/>' \
      '</property>' \
      '<property name="plugin-2" type="string" value="separator"><property name="style" type="uint" value="0"/></property>' \
      '<property name="plugin-3" type="string" value="launcher"><property name="items" type="array"><value type="string" value="chromium.desktop"/></property></property>' \
      '<property name="plugin-4" type="string" value="launcher"><property name="items" type="array"><value type="string" value="xfce4-terminal.desktop"/></property></property>' \
      '<property name="plugin-5" type="string" value="launcher"><property name="items" type="array"><value type="string" value="thunar.desktop"/></property></property>' \
      '<property name="plugin-6" type="string" value="separator"><property name="style" type="uint" value="0"/></property>' \
      '<property name="plugin-7" type="string" value="tasklist"><property name="grouping" type="uint" value="0"/><property name="show-handle" type="bool" value="false"/></property>' \
      '<property name="plugin-8" type="string" value="separator"><property name="expand" type="bool" value="true"/><property name="style" type="uint" value="0"/></property>' \
      '<property name="plugin-9" type="string" value="systray"><property name="square-icons" type="bool" value="true"/></property>' \
      '<property name="plugin-10" type="string" value="clock"><property name="digital-layout" type="uint" value="3"/><property name="digital-time-format" type="string" value="%a %d %b  %H:%M"/></property>' \
      '</property></channel>' > /etc/xdg/xfce4/panel/default.xml

# Speech-to-text is ready before the first voice message. Pin PyAV: faster-whisper 1.2.1
# passes metadata_errors to av.open(), which PyAV 19 removed. Keep the model outside the
# per-user home volume and load it locally, without downloads or installs during a turn.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3-venv \
 && rm -rf /var/lib/apt/lists/* \
 && python3 -m venv /opt/dot/audio \
 && /opt/dot/audio/bin/pip install --no-cache-dir \
      faster-whisper==1.2.1 av==16.1.0 ctranslate2==4.8.3 \
 && /opt/dot/audio/bin/python -c 'from faster_whisper.utils import download_model; download_model("base", output_dir="/opt/dot/audio/model", revision="ebe41f70d5b6dfa9166e2c581c45c9c0cfc57b66")' \
 && /opt/dot/audio/bin/pip check

USER dot
WORKDIR /home/dot/workspace
ENV HOME=/home/dot CODEX_HOME=/home/dot/.codex PATH=/opt/codex/bin:/opt/codex/codex-path:$PATH \
    MPLBACKEND=Agg
CMD ["sleep", "infinity"]
