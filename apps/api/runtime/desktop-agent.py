"""
The far end of `desktop` on another of the person's computers: sent over SSH by runtime/desktop
(never installed there) and run with that machine's own Python, standard library only, plus
PyGObject for D-Bus and the accessibility tree. It reads one JSON request per line on stdin and
writes one JSON reply per line on stdout, for as long as the SSH connection lasts.

KDE Plasma (Wayland or X11) for now:
- screenshots: spectacle, all screens in one picture (runtime/desktop cuts out the one it shows)
- windows, focus, the pointer's position: a KWin script, which reports back over D-Bus
- mouse and keyboard: two virtual devices made through /dev/uinput (a tablet, so a move lands on
  an exact pixel, and a keyboard). Plasma gives the person at the screen access to it already
  (KDE Connect's udev rule), so nothing needs installing
- controls: the accessibility tree (AT-SPI); positions in it are relative to their window on
  Wayland, so they're moved by the window's place from KWin
- clipboard: Klipper, or wl-clipboard
"""
import fcntl
import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import time
import base64

# ---- the person's graphical session --------------------------------------------------------

def session_env():
    """The desktop session's environment (display, session bus), from the systemd user manager."""
    env = dict(os.environ)
    env.setdefault("XDG_RUNTIME_DIR", f"/run/user/{os.getuid()}")
    try:
        out = subprocess.run(
            ["systemctl", "--user", "show-environment"], env=env, capture_output=True, timeout=10,
        ).stdout.decode()
        for line in out.splitlines():
            key, _, value = line.partition("=")
            if key in ("DISPLAY", "WAYLAND_DISPLAY", "XDG_CURRENT_DESKTOP", "XDG_SESSION_TYPE",
                       "DBUS_SESSION_BUS_ADDRESS", "XAUTHORITY", "XDG_SESSION_DESKTOP"):
                env[key] = value
    except (OSError, subprocess.TimeoutExpired):
        pass
    env.setdefault("DBUS_SESSION_BUS_ADDRESS", f"unix:path={env['XDG_RUNTIME_DIR']}/bus")
    return env


ENV = session_env()
os.environ.update(ENV)
DESKTOP = ENV.get("XDG_CURRENT_DESKTOP", "")
SESSION = ENV.get("XDG_SESSION_TYPE", "")

try:
    import gi
    gi.require_version("Gio", "2.0")
    from gi.repository import Gio, GLib
    BUS = Gio.bus_get_sync(Gio.BusType.SESSION)
except Exception:  # no PyGObject, or no session bus: info() says what's missing
    gi = BUS = None


def dbus(service, path, iface, method, signature=None, args=None, timeout=5000):
    params = GLib.Variant(signature, args) if signature else None
    reply = BUS.call_sync(service, path, iface, method, params, None, 0, timeout, None)
    return reply.unpack() if reply else ()


# ---- KWin scripts ------------------------------------------------------------------------------

REPORT_NAME = f"org.dot.Desktop.p{os.getpid()}"
REPORTS = []


def _listen():
    xml = (
        "<node><interface name='org.dot.Desktop'><method name='Report'>"
        "<arg type='s' direction='in'/></method></interface></node>"
    )

    def on_call(conn, sender, path, iface, method, params, invocation):
        REPORTS.append(params.unpack()[0])
        invocation.return_value(None)

    BUS.register_object("/", Gio.DBusNodeInfo.new_for_xml(xml).interfaces[0], on_call, None, None)
    dbus("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "RequestName",
         "(su)", (REPORT_NAME, 4))


LISTENING = False


def kwin(js):
    """Runs a KWin script whose `report(value)` comes back as this call's result."""
    global LISTENING
    if not LISTENING:
        _listen()
        LISTENING = True
    with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False) as f:
        f.write(
            f"function report(v) {{ callDBus('{REPORT_NAME}', '/', 'org.dot.Desktop', 'Report', "
            f"JSON.stringify(v)); }}\n{js}"
        )
    plugin = f"dot-desktop-{time.time_ns()}"
    try:
        (sid,) = dbus("org.kde.KWin", "/Scripting", "org.kde.kwin.Scripting", "loadScript",
                      "(ss)", (f.name, plugin))
        dbus("org.kde.KWin", f"/Scripting/Script{sid}", "org.kde.kwin.Script", "run")
        context = GLib.MainContext.default()
        deadline = time.monotonic() + 5
        while not REPORTS and time.monotonic() < deadline:
            context.iteration(False)
            time.sleep(0.003)
    finally:
        dbus("org.kde.KWin", "/Scripting", "org.kde.kwin.Scripting", "unloadScript", "(s)", (plugin,))
        os.unlink(f.name)
    if not REPORTS:
        raise RuntimeError("KWin didn't answer")
    return json.loads(REPORTS.pop())


WINDOW_JS = """
function info(w) {
  const f = w.frameGeometry, c = w.clientGeometry;
  return {id: w.internalId.toString().replace(/[{}]/g, "").slice(0, 8), title: w.caption,
          app: w.resourceClass, pid: w.pid, active: w === workspace.activeWindow,
          minimized: w.minimized, frame: [f.x, f.y, f.width, f.height],
          client: [c.x, c.y, c.width, c.height]};
}
function windows() {
  return workspace.stackingOrder.filter(w => (w.normalWindow || w.dialog) && !w.skipTaskbar)
    .map(info).reverse();
}
"""


def layout():
    """Screens (KWin's positions, in the same pixels as the screenshot), windows, the pointer."""
    return kwin(WINDOW_JS + """
report({
  screens: workspace.screens.map(s => ({name: s.name, x: s.geometry.x, y: s.geometry.y,
                                        width: s.geometry.width, height: s.geometry.height})),
  windows: windows(),
  pointer: [workspace.cursorPos.x, workspace.cursorPos.y],
});
""")


def focus(target):
    found = kwin(WINDOW_JS + f"""
const target = {json.dumps(target.lower())};
const w = workspace.stackingOrder.find(w => info(w).id === target)
  || workspace.stackingOrder.slice().reverse().find(w => (w.normalWindow || w.dialog)
       && w.caption.toLowerCase().includes(target));
if (w) {{ w.minimized = false; workspace.activeWindow = w; }}
report(w ? info(w) : null);
""")
    if not found:
        raise ValueError(f"no window matching {target!r}; see windows")
    return found


# ---- screenshots -------------------------------------------------------------------------------

def screenshot():
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "screen.png")
        result = subprocess.run(
            ["spectacle", "--background", "--nonotify", "--fullscreen", "--output", path],
            env=ENV, capture_output=True, timeout=20,
        )
        if not os.path.exists(path):
            raise RuntimeError("spectacle took no screenshot: " + result.stderr.decode(errors="replace")[-300:])
        with open(path, "rb") as f:
            return base64.b64encode(f.read()).decode()


# ---- virtual mouse and keyboard (uinput) ---------------------------------------------------

EV_SYN, EV_KEY, EV_REL, EV_ABS = 0, 1, 2, 3
BTN = {"left": 0x110, "right": 0x111, "middle": 0x112}
REL_HWHEEL, REL_WHEEL = 6, 8
UI_SET_EVBIT, UI_SET_KEYBIT, UI_SET_RELBIT, UI_SET_ABSBIT = 0x40045564, 0x40045565, 0x40045566, 0x40045567
UI_DEV_SETUP, UI_ABS_SETUP, UI_DEV_CREATE, UI_DEV_DESTROY = 0x405C5503, 0x401C5504, 0x5501, 0x5502
EVENT = struct.Struct("llHHi")  # struct input_event on 64-bit Linux


class Device:
    def __init__(self, name, keys, size=None):
        self.fd = os.open("/dev/uinput", os.O_WRONLY | os.O_NONBLOCK)
        fcntl.ioctl(self.fd, UI_SET_EVBIT, EV_KEY)
        for code in keys:
            fcntl.ioctl(self.fd, UI_SET_KEYBIT, code)
        if size:  # an absolute pointer, like a VM's tablet: one axis per screen pixel
            fcntl.ioctl(self.fd, UI_SET_EVBIT, EV_ABS)
            fcntl.ioctl(self.fd, UI_SET_EVBIT, EV_REL)
            for code in (REL_WHEEL, REL_HWHEEL):
                fcntl.ioctl(self.fd, UI_SET_RELBIT, code)
            for code, top in ((0, size[0] - 1), (1, size[1] - 1)):
                fcntl.ioctl(self.fd, UI_SET_ABSBIT, code)
                fcntl.ioctl(self.fd, UI_ABS_SETUP, struct.pack("H2x6i", code, 0, 0, top, 0, 0, 0))
        fcntl.ioctl(self.fd, UI_DEV_SETUP, struct.pack("HHHH80sI", 3, 0xD07, 1, 1, name.encode(), 0))
        fcntl.ioctl(self.fd, UI_DEV_CREATE)

    def send(self, *events):
        for kind, code, value in events:
            os.write(self.fd, EVENT.pack(0, 0, kind, code, value))
        os.write(self.fd, EVENT.pack(0, 0, EV_SYN, 0, 0))

    def close(self):
        try:
            fcntl.ioctl(self.fd, UI_DEV_DESTROY)
            os.close(self.fd)
        except OSError:
            pass


# Linux key codes for xdotool's key names (the names the desktop tools document).
KEYS = {
    "Escape": 1, "BackSpace": 14, "Tab": 15, "Return": 28, "Enter": 28, "space": 57,
    "minus": 12, "equal": 13, "bracketleft": 26, "bracketright": 27, "semicolon": 39,
    "apostrophe": 40, "grave": 41, "backslash": 43, "comma": 51, "period": 52, "slash": 53,
    "ctrl": 29, "control": 29, "Control_L": 29, "Control_R": 97, "shift": 42, "Shift_L": 42,
    "Shift_R": 54, "alt": 56, "Alt_L": 56, "Alt_R": 100, "super": 125, "Super_L": 125,
    "Super_R": 126, "meta": 125, "Menu": 127, "Caps_Lock": 58, "Print": 99, "Insert": 110,
    "Delete": 111, "Home": 102, "End": 107, "Page_Up": 104, "Prior": 104, "Page_Down": 109,
    "Next": 109, "Up": 103, "Down": 108, "Left": 105, "Right": 106, "Pause": 119,
    "XF86AudioMute": 113, "XF86AudioLowerVolume": 114, "XF86AudioRaiseVolume": 115,
    "XF86AudioPlay": 164, "XF86AudioNext": 163, "XF86AudioPrev": 165,
    **{f"F{n}": code for n, code in zip(range(1, 13), [59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 87, 88])},
    **dict(zip("1234567890", [2, 3, 4, 5, 6, 7, 8, 9, 10, 11])),
    **dict(zip("qwertyuiop", range(16, 26))), **dict(zip("asdfghjkl", range(30, 39))),
    **dict(zip("zxcvbnm", range(44, 51))),
}
# Characters → (key, shift) on a US layout, for typing.
CHARS = {c: (KEYS[c], False) for c in "1234567890qwertyuiopasdfghjklzxcvbnm"}
CHARS.update({c.upper(): (KEYS[c], True) for c in "qwertyuiopasdfghjklzxcvbnm"})
CHARS.update({
    " ": (57, False), "\n": (28, False), "\t": (15, False), "-": (12, False), "=": (13, False),
    "[": (26, False), "]": (27, False), ";": (39, False), "'": (40, False), "`": (41, False),
    "\\": (43, False), ",": (51, False), ".": (52, False), "/": (53, False),
    **{c: (KEYS[d], True) for c, d in zip("!@#$%^&*()", "1234567890")},
    "_": (12, True), "+": (13, True), "{": (26, True), "}": (27, True), ":": (39, True),
    '"': (40, True), "~": (41, True), "|": (43, True), "<": (51, True), ">": (52, True),
    "?": (53, True),
})

POINTER = KEYBOARD = None
POINTER_SIZE = None


def devices(size):
    """The virtual mouse (spanning every screen) and keyboard, made once and kept."""
    global POINTER, KEYBOARD, POINTER_SIZE
    fresh = False
    if POINTER and POINTER_SIZE != size:  # screens were added, removed or resized
        POINTER.close()
        POINTER = None
    if not POINTER:
        POINTER = Device("dot pointer", BTN.values(), size)
        POINTER_SIZE = size
        fresh = True
    if not KEYBOARD:
        KEYBOARD = Device("dot keyboard", range(1, 248))
        fresh = True
    if fresh:
        time.sleep(0.6)  # until the compositor has picked the new devices up


def move(x, y):
    POINTER.send((EV_ABS, 0, x), (EV_ABS, 1, y))


def press(code, down):
    KEYBOARD.send((EV_KEY, code, 1 if down else 0))


def key_combo(combo):
    names = combo.split("+")
    codes = []
    for name in names:
        code = KEYS.get(name) or KEYS.get(name.lower()) or KEYS.get(name.capitalize())
        if code is None:
            raise ValueError(f"unknown key {name!r}")
        codes.append(code)
    for code in codes:
        press(code, True)
        time.sleep(0.01)
    for code in reversed(codes):
        press(code, False)
        time.sleep(0.01)


def type_text(text):
    if any(c not in CHARS for c in text):
        # Past a US keyboard's characters (accents, emoji, other scripts): paste it instead.
        old = clipboard_get()
        clipboard_set(text)
        time.sleep(0.1)
        key_combo("ctrl+v")
        time.sleep(0.3)
        clipboard_set(old)
        return "pasted"
    for c in text:
        code, shift = CHARS[c]
        if shift:
            press(42, True)
        press(code, True)
        press(code, False)
        if shift:
            press(42, False)
        time.sleep(0.008)
    return "typed"


def act(request):
    size = tuple(request["span"])
    devices(size)
    kind = request["action"]
    if kind == "click":
        move(*request["at"])
        time.sleep(0.05)
        button = BTN[request.get("button", "left")]
        for i in range(request.get("clicks", 1)):
            POINTER.send((EV_KEY, button, 1))
            time.sleep(0.03)
            POINTER.send((EV_KEY, button, 0))
            time.sleep(0.08)
    elif kind == "move":
        move(*request["at"])
    elif kind == "scroll":
        move(*request["at"])
        time.sleep(0.05)
        axis, step = {"up": (REL_WHEEL, 1), "down": (REL_WHEEL, -1),
                      "left": (REL_HWHEEL, -1), "right": (REL_HWHEEL, 1)}[request["direction"]]
        for _ in range(request.get("amount", 5)):
            POINTER.send((EV_REL, axis, step))
            time.sleep(0.03)
    elif kind == "drag":
        (x1, y1), (x2, y2) = request["from"], request["to"]
        move(x1, y1)
        time.sleep(0.05)
        POINTER.send((EV_KEY, BTN["left"], 1))
        time.sleep(0.15)
        move(x1 + 6, y1 + 6)
        steps = max(12, min(40, int(((x2 - x1) ** 2 + (y2 - y1) ** 2) ** 0.5 / 20)))
        for i in range(1, steps + 1):
            move(x1 + (x2 - x1) * i // steps, y1 + (y2 - y1) * i // steps)
            time.sleep(0.02)
        time.sleep(0.25)
        POINTER.send((EV_KEY, BTN["left"], 0))
    elif kind == "type":
        how = type_text(request["text"])
        if request.get("enter"):
            key_combo("Return")
        return how
    elif kind == "key":
        for combo in request["keys"].split():
            key_combo(combo)
            time.sleep(0.06)
    else:
        raise ValueError(f"unknown action {kind}")
    return "done"


# ---- the accessibility tree --------------------------------------------------------------

INTERACTIVE = {
    "button", "push button", "toggle button", "switch", "check box", "radio button", "link", "entry",
    "password text", "combo box", "menu item", "check menu item", "radio menu item",
    "page tab", "list item", "slider", "spin button", "menu", "icon", "tree item",
    "table cell", "text", "terminal", "heading",
}
TREE_BUDGET_S = 3.0
TREE_MAX_NODES = 4000
TREE_MAX_ELEMENTS = 150
TREE_MAX_CHILDREN = 200


def controls(windows, all_windows):
    """On-screen controls of the active window (or every window), at screen positions."""
    try:
        gi.require_version("Atspi", "2.0")
        from gi.repository import Atspi
    except Exception:
        return [], " (accessibility tree unavailable)"
    # Qt (and so KDE) apps only share their tree while the session's accessibility switch is on;
    # it's what a screen reader turns on, applies to running apps, and lasts until logout.
    try:
        dbus("org.a11y.Bus", "/org/a11y/bus", "org.freedesktop.DBus.Properties", "Set", "(ssv)",
             ("org.a11y.Status", "IsEnabled", GLib.Variant("b", True)))
    except Exception:
        pass
    S = Atspi.StateType
    wanted = [w for w in windows if (all_windows or w["active"]) and not w["minimized"]]
    deadline = time.monotonic() + TREE_BUDGET_S
    visited = 0
    found = []

    def spent():
        return visited >= TREE_MAX_NODES or time.monotonic() > deadline or len(found) >= TREE_MAX_ELEMENTS

    def walk(node, depth, origin, bounds):
        nonlocal visited
        if spent():
            return
        visited += 1
        try:
            states = node.get_state_set()
            if depth > 1 and not states.contains(S.SHOWING):
                return
            role = node.get_role_name()
            name = (node.get_name() or "").strip()
            footnote = role == "link" and name.startswith("[") and name.endswith("]")
            if role in INTERACTIVE and not footnote and (name or role in ("entry", "password text", "text")):
                box = node.get_extents(Atspi.CoordType.WINDOW)
                x, y = origin[0] + box.x + box.width // 2, origin[1] + box.y + box.height // 2
                inside = bounds[0] <= x < bounds[0] + bounds[2] and bounds[1] <= y < bounds[1] + bounds[3]
                if box.width > 0 and box.height > 0 and inside and not (
                    role == "text" and not states.contains(S.EDITABLE)
                ):
                    extra = [label for state, label in (
                        (S.FOCUSED, "focused"), (S.CHECKED, "checked"),
                    ) if states.contains(state)]
                    if not states.contains(S.ENABLED):
                        extra.append("disabled")
                    found.append({"role": role, "name": name[:80], "x": x, "y": y, "state": extra})
            if states.contains(S.MANAGES_DESCENDANTS):
                return
            for i in range(min(node.get_child_count(), TREE_MAX_CHILDREN)):
                if spent():
                    return
                walk(node.get_child_at_index(i), depth + 1, origin, bounds)
        except Exception:
            return

    desktop = Atspi.get_desktop(0)
    apps = []
    for i in range(desktop.get_child_count()):
        try:
            app = desktop.get_child_at_index(i)
            if app:
                apps.append((app.get_process_id(), app))
        except Exception:
            continue
    for window in wanted:
        frames = []
        for pid, app in apps:
            if pid != window["pid"]:
                continue
            for j in range(app.get_child_count()):
                frame = app.get_child_at_index(j)
                if frame:
                    frames.append(frame)
        # The window's own frame: same title, else the app's active one, else its only one.
        match = [f for f in frames if (f.get_name() or "").strip() == window["title"].strip()]
        match = match or [f for f in frames if f.get_state_set().contains(S.ACTIVE)]
        match = match or (frames if len(frames) == 1 else [])
        if match:
            walk(match[0], 0, window["client"][:2], window["frame"])
    note = " (list cut short)" if spent() else ""
    return found, note


# ---- clipboard, apps ---------------------------------------------------------------------

def clipboard_get():
    try:
        return dbus("org.kde.klipper", "/klipper", "org.kde.klipper.klipper", "getClipboardContents")[0]
    except Exception:
        if shutil.which("wl-paste"):
            return subprocess.run(["wl-paste", "--no-newline"], env=ENV, capture_output=True, timeout=5).stdout.decode(errors="replace")
        raise RuntimeError("no clipboard access (Klipper isn't running and wl-clipboard isn't installed)")


def clipboard_set(text):
    try:
        dbus("org.kde.klipper", "/klipper", "org.kde.klipper.klipper", "setClipboardContents", "(s)", (text,))
    except Exception:
        if not shutil.which("wl-copy"):
            raise RuntimeError("no clipboard access (Klipper isn't running and wl-clipboard isn't installed)")
        subprocess.run(["wl-copy"], input=text.encode(), env=ENV, timeout=5)


def launch(command):
    # Under the person's systemd user manager when there is one, so the app outlives this connection
    # and gets the session's environment; else detached from it.
    if shutil.which("systemd-run"):
        subprocess.run(["systemd-run", "--user", "--collect", "--quiet", "--", "sh", "-lc", command],
                       env=ENV, check=True, capture_output=True, timeout=15)
    else:
        subprocess.Popen(["sh", "-lc", command], env=ENV, stdin=subprocess.DEVNULL,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)


# ---- what's here, what's missing ---------------------------------------------------------

def locked():
    try:
        return bool(dbus("org.freedesktop.ScreenSaver", "/ScreenSaver", "org.freedesktop.ScreenSaver", "GetActive")[0])
    except Exception:
        return False


def info():
    """The desktop, and what's missing for dot to use it, with the fix for each."""
    missing = []
    if "KDE" not in DESKTOP.upper():
        missing.append(f"desktop {DESKTOP or SESSION or 'unknown'}: only KDE Plasma is supported for now")
    if BUS is None:
        missing.append("PyGObject for this Python (Arch: `sudo pacman -S python-gobject`, "
                       "Fedora: `sudo dnf install python3-gobject`, Debian/Ubuntu: `sudo apt install python3-gi`)")
    if not shutil.which("spectacle"):
        missing.append("spectacle, KDE's screenshot tool (Arch: `sudo pacman -S spectacle`)")
    if not os.access("/dev/uinput", os.W_OK):
        missing.append(
            "access to /dev/uinput, for the virtual mouse and keyboard. Plasma grants it to whoever "
            "is logged in at the screen (KDE Connect's udev rule); without it, run: "
            "`echo 'KERNEL==\"uinput\", SUBSYSTEM==\"misc\", TAG+=\"uaccess\", OPTIONS+=\"static_node=uinput\"' "
            "| sudo tee /etc/udev/rules.d/60-dot-uinput.rules && sudo udevadm control --reload && "
            "sudo udevadm trigger /dev/uinput`, then log out and back in"
        )
    try:
        Atspi_ok = gi is not None and gi.require_version("Atspi", "2.0") is None
    except Exception:
        Atspi_ok = False
    return {
        "desktop": DESKTOP, "session": SESSION, "host": os.uname().nodename,
        "missing": missing, "locked": locked() if BUS else False,
        "accessibility": Atspi_ok,
    }


# ---- requests ----------------------------------------------------------------------------

def handle(request):
    op = request["op"]
    if op == "info":
        return info()
    if op == "layout":
        return {**layout(), "locked": locked()}
    if op == "screenshot":
        return {"png": screenshot()}
    if op == "controls":
        return dict(zip(("controls", "note"), controls(request["windows"], request.get("all_windows"))))
    if op == "act":
        return {"result": act(request)}
    if op == "focus":
        return focus(request["window"])
    if op == "launch":
        launch(request["command"])
        return {}
    if op == "clipboard":
        if "text" in request:
            clipboard_set(request["text"])
            return {}
        return {"text": clipboard_get()}
    raise ValueError(f"unknown op {op}")


def serve():
    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            reply = {"ok": True, **handle(json.loads(line))}
        except Exception as error:
            reply = {"ok": False, "error": str(error) or type(error).__name__}
        sys.stdout.write(json.dumps(reply) + "\n")
        sys.stdout.flush()
    for device in (POINTER, KEYBOARD):
        if device:
            device.close()


serve()
