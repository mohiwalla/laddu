import { describe, expect, test } from "bun:test"
import type { BotConfig } from "../config"
import { containerOptions } from "./containers"

const baseConfig = (overrides: Partial<BotConfig> = {}): BotConfig =>
	({
		isolateNetwork: true,
		desktop: true,
		workdir: "/tmp/persona",
		localDir: "/tmp/persona",
		unlimitedContainerUsers: new Set<string>(),
		...overrides,
	}) as BotConfig

describe("containerOptions", () => {
	test("raises default nofile limit while keeping standard resource caps for regular users", () => {
		const opts = containerOptions({
			config: baseConfig({
				unlimitedContainerUsers: new Set(["U_OWNER"]),
			}),
			teamId: "T1",
			userId: "U_OTHER",
			image: "laddu-runtime:test",
		})

		expect(opts).toContain("--ulimit")
		expect(opts[opts.indexOf("--ulimit") + 1]).toBe("nofile=65536:524288")
		expect(opts[opts.indexOf("--memory") + 1]).toBe("3g")
		expect(opts[opts.indexOf("--cpus") + 1]).toBe("2")
		expect(opts[opts.indexOf("--pids-limit") + 1]).toBe("4096")
		expect(opts[opts.indexOf("--shm-size") + 1]).toBe("1g")
	})

	test("omits memory, CPU and PID caps and raises nofile for unlimited users", () => {
		for (const unlimitedContainerUsers of [
			new Set(["U_OWNER"]),
			"*" as const,
		]) {
			const opts = containerOptions({
				config: baseConfig({ unlimitedContainerUsers }),
				teamId: "T1",
				userId: "U_OWNER",
				image: "laddu-runtime:test",
			})

			expect(opts).not.toContain("--memory")
			expect(opts).not.toContain("--cpus")
			expect(opts).not.toContain("--pids-limit")
			expect(opts[opts.indexOf("--ulimit") + 1]).toBe(
				"nofile=524288:524288",
			)
			// Security isolation and desktop shm stay intact.
			expect(opts[opts.indexOf("--cap-drop") + 1]).toBe("ALL")
			expect(opts[opts.indexOf("--security-opt") + 1]).toBe(
				"no-new-privileges",
			)
			expect(opts[opts.indexOf("--shm-size") + 1]).toBe("1g")
		}
	})
})
