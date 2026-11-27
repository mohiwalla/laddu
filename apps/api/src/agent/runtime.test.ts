import { expect, test } from "bun:test"

for (const tool of ["desktop", "memory", "recall"]) {
	test.each(["--help", "-h", "help"])(
		`${tool} %s exits successfully without touching user data`,
		async flag => {
			const command = Bun.fileURLToPath(
				new URL(`../../runtime/${tool}`, import.meta.url),
			)
			const child = Bun.spawn(["python3", command, flag], {
				env: {
					...Bun.env,
					LADDU_HISTORY_DIR: "/dev/null/history",
					LADDU_MEMORY_DIR: "/dev/null/memory",
				},
				stdout: "pipe",
				stderr: "pipe",
			})
			const [code, stdout, stderr] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			])
			expect(code).toBe(0)
			expect(stdout).toContain(tool)
			expect(stderr).toBe("")
		},
	)
}

test.each(["--help", "-h", "help"])(
	"webfetch %s exits successfully",
	async flag => {
		const command = Bun.fileURLToPath(
			new URL("../../runtime/webfetch", import.meta.url),
		)
		const child = Bun.spawn([Bun.argv[0]!, command, flag], {
			stdout: "pipe",
			stderr: "pipe",
		})
		const [code, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		])
		expect(code).toBe(0)
		expect(stdout).toContain("webfetch")
		expect(stderr).toBe("")
	},
)

test("desktop exec supplies the desktop session and preserves the child exit code", async () => {
	const command = Bun.fileURLToPath(
		new URL("../../runtime/desktop", import.meta.url),
	)
	const fixture = `/tmp/laddu-desktop-test-${crypto.randomUUID()}.json`
	await Bun.write(
		fixture,
		JSON.stringify({
			DBUS_SESSION_BUS_ADDRESS: "unix:path=/tmp/test-desktop-bus",
		}),
	)
	try {
		// Avoid starting a real display; exercise the CLI with an actual child process and saved session.
		const child = Bun.spawn(
			[
				"python3",
				"-c",
				`
import runpy, sys
from pathlib import Path
module = runpy.run_path(sys.argv[1])
g = module['main'].__globals__
g.update(start=lambda: False, touch=lambda: None, person_in_control=lambda: False, ENV_FILE=Path(sys.argv[2]))
module['main'](['exec', '--', 'python3', '-c', "import os,sys; print(os.environ['DISPLAY']); print(os.environ['DBUS_SESSION_BUS_ADDRESS']); sys.exit(7)"])
`,
				command,
				fixture,
			],
			{ stdout: "pipe", stderr: "pipe" },
		)
		const [code, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		])
		expect(code).toBe(7)
		expect(stdout).toBe(":1\nunix:path=/tmp/test-desktop-bus\n")
		expect(stderr).toBe("")
	} finally {
		await Bun.file(fixture).delete()
	}
})

test("desktop exec does not act while the person has control", async () => {
	const command = Bun.fileURLToPath(
		new URL("../../runtime/desktop", import.meta.url),
	)
	const child = Bun.spawn(
		[
			"python3",
			"-c",
			`
import runpy, sys
module = runpy.run_path(sys.argv[1])
g = module['main'].__globals__
g['person_in_control'] = lambda: True
module['main'](['exec', 'python3', '-c', "print('should not run')"])
`,
			command,
		],
		{ stdout: "pipe", stderr: "pipe" },
	)
	const [code, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	])
	expect(code).not.toBe(0)
	expect(stdout).toBe("")
	expect(stderr).toContain("the person has control")
})

test("desktop start clears stale Chromium Singleton locks and keeps live ones", async () => {
	const command = Bun.fileURLToPath(
		new URL("../../runtime/desktop", import.meta.url),
	)
	const child = Bun.spawn(
		[
			"python3",
			"-c",
			`
import os, runpy, sys, tempfile
from pathlib import Path

module = runpy.run_path(sys.argv[1])
clear = module["clear_stale_chromium_locks"]

with tempfile.TemporaryDirectory() as tmp:
    root = Path(tmp)
    proc = root / "proc"

    def make_profile(name, lock_target, sock_exists=False):
        profile = root / name
        profile.mkdir()
        if lock_target is not None:
            os.symlink(lock_target, profile / "SingletonLock")
        sock_target = root / f"{name}-sock"
        if sock_exists:
            sock_target.write_text("")
        os.symlink(str(sock_target), profile / "SingletonSocket")
        os.symlink("123456789", profile / "SingletonCookie")
        return profile

    def make_proc(pid, argv0):
        d = proc / str(pid)
        d.mkdir(parents=True)
        (d / "cmdline").write_bytes(argv0.encode() + b"\\0--no-sandbox\\0")

    # 1. Hostname mismatch (e.g. dot -> laddu migration)
    p1 = make_profile("mismatch", "dot-9117", sock_exists=False)
    assert clear(p1, hostname="laddu", proc_root=proc) is True
    assert not any(os.path.lexists(p1 / f) for f in ("SingletonLock", "SingletonSocket", "SingletonCookie"))

    # 2. Same hostname, dead PID
    p2 = make_profile("dead", "laddu-9117", sock_exists=False)
    assert clear(p2, hostname="laddu", proc_root=proc) is True
    assert not os.path.lexists(p2 / "SingletonLock")

    # 3. Same hostname, recycled non-Chromium PID
    make_proc(462, "/usr/bin/xfce4-panel")
    p3 = make_profile("recycled", "laddu-462", sock_exists=True)
    assert clear(p3, hostname="laddu", proc_root=proc) is True
    assert not os.path.lexists(p3 / "SingletonLock")

    # 4. Same hostname, live Chromium PID, but broken /tmp socket
    make_proc(500, "/usr/lib/chromium/chromium")
    p4 = make_profile("broken-sock", "laddu-500", sock_exists=False)
    assert clear(p4, hostname="laddu", proc_root=proc) is True
    assert not os.path.lexists(p4 / "SingletonLock")

    # 5. Live Chromium lock (matching hostname, Chromium PID, existing socket) stays intact
    p5 = make_profile("live", "laddu-500", sock_exists=True)
    assert clear(p5, hostname="laddu", proc_root=proc) is False
    assert all(os.path.lexists(p5 / f) for f in ("SingletonLock", "SingletonSocket", "SingletonCookie"))

    # 6. No SingletonLock (mid-startup): leave other files untouched
    p6 = make_profile("no-lock", None, sock_exists=True)
    assert clear(p6, hostname="laddu", proc_root=proc) is False
    assert os.path.lexists(p6 / "SingletonSocket")
    assert os.path.lexists(p6 / "SingletonCookie")

    # 7. desktop start invokes lock cleanup even when X is already running
    p7 = make_profile("already-running", "dot-9117", sock_exists=False)
    g = module["start"].__globals__
    g.update(
        CHROMIUM_DIR=p7,
        x_running=lambda: True,
        ENV_FILE=root / "env.json",
    )
    (root / "env.json").write_text("{}")
    assert module["start"]() is False
    assert not os.path.lexists(p7 / "SingletonLock")
`,
			command,
		],
		{ stdout: "pipe", stderr: "pipe" },
	)
	const [code, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	])
	expect(stderr).toBe("")
	expect(stdout).toBe("")
	expect(code).toBe(0)
})
