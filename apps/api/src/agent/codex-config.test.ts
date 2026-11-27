import { describe, expect, test } from "bun:test"
import { codexConfig } from "./codex-config"

describe("codexConfig", () => {
	test("uncaps Codex subagent concurrency without disturbing top-level or MCP sections", () => {
		for (const desktop of [undefined, "/opt/laddu/runtime/bin/desktop"]) {
			const toml = codexConfig({ desktop })
			const parsed = Bun.TOML.parse(toml) as {
				forced_login_method?: string
				web_search?: string
				model_reasoning_summary?: string
				agents?: { max_concurrent_threads_per_session?: number }
				mcp_servers?: Record<string, { command?: string }>
			}

			expect(parsed.forced_login_method).toBe("chatgpt")
			expect(parsed.web_search).toBe("live")
			expect(parsed.model_reasoning_summary).toBe("concise")
			expect(parsed.agents?.max_concurrent_threads_per_session).toBe(1000)
			expect(parsed.mcp_servers?.desktop?.command).toBe(desktop)

			// scripts/codex-docker.sh appends ~/.laddu/mcp.toml directly to this output.
			const combined = Bun.TOML.parse(
				`${toml}\n[mcp_servers.extra]\nurl = "https://example.com/mcp"\n`,
			) as {
				agents?: { max_concurrent_threads_per_session?: number }
				mcp_servers?: Record<string, { url?: string }>
			}
			expect(combined.agents?.max_concurrent_threads_per_session).toBe(
				1000,
			)
			expect(combined.mcp_servers?.extra?.url).toBe(
				"https://example.com/mcp",
			)
		}
	})
})
