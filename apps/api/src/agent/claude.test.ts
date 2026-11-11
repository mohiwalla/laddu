import { expect, test } from "bun:test"
import { signInLink } from "./claude"

test("a sign-in that prints after its link still ends cleanly", async () => {
	// Like `claude auth login`: the link, a wait for the code, then "Login successful." and exit 0.
	const proc = Bun.spawn(
		[
			"sh",
			"-c",
			'echo "visit: https://claude.com/cai/oauth/authorize?code=true&state=abc"; read code; sleep 0.2; echo "Login successful."',
		],
		{ stdin: "pipe", stdout: "pipe", stderr: "pipe" },
	)
	expect(await signInLink(proc.stdout)).toBe(
		"https://claude.com/cai/oauth/authorize?code=true&state=abc",
	)
	proc.stdin.write("code#state\n")
	await proc.stdin.flush()
	proc.stdin.end()
	expect(await proc.exited).toBe(0)
	expect(proc.signalCode).toBeNull()
})

test("no sign-in link is an error that says what was printed instead", async () => {
	const proc = Bun.spawn(["sh", "-c", "echo 'Login failed: offline'"], {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	})
	await expect(signInLink(proc.stdout)).rejects.toThrow("Login failed: offline")
})
