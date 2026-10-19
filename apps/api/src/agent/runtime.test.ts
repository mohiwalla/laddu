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
					DOT_HISTORY_DIR: "/dev/null/history",
					DOT_MEMORY_DIR: "/dev/null/memory",
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
	const fixture = `/tmp/dot-desktop-test-${crypto.randomUUID()}.json`
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
