import { expect, test } from "bun:test"
import {
	AuthRequiredError,
	LostSessionError,
	probeAcpSession,
	runAcpTurn,
	toItem,
} from "./acp"

test("toItem maps Antigravity CommandLine, Path, Url, Query, and desktop MCP tools", () => {
	expect(
		toItem({
			toolCallId: "cmd-1",
			kind: "execute",
			title: "run_command",
			status: "in_progress",
			rawInput: { CommandLine: "git status" },
		}),
	).toEqual({
		id: "cmd-1",
		type: "command_execution",
		command: "git status",
		aggregated_output: "",
		status: "in_progress",
	})

	expect(
		toItem({
			toolCallId: "read-1",
			kind: "read",
			title: "read_file",
			status: "completed",
			rawInput: { Path: "/home/laddu/workspace/notes.md" },
		}),
	).toEqual({
		id: "read-1",
		type: "tool",
		title: "Reading notes.md",
		status: "completed",
	})

	expect(
		toItem({
			toolCallId: "edit-1",
			kind: "edit",
			title: "edit_file",
			status: "completed",
			rawInput: { TargetFile: "/home/laddu/workspace/app.ts" },
		}),
	).toEqual({
		id: "edit-1",
		type: "file_change",
		changes: [{ path: "/home/laddu/workspace/app.ts", kind: "update" }],
		status: "completed",
	})

	expect(
		toItem({
			toolCallId: "fetch-1",
			kind: "fetch",
			title: "fetch_url",
			status: "in_progress",
			rawInput: { Url: "https://example.com" },
		}),
	).toEqual({
		id: "fetch-1",
		type: "command_execution",
		command: "webfetch https://example.com",
		aggregated_output: "",
		status: "in_progress",
	})

	expect(
		toItem({
			toolCallId: "search-1",
			kind: "search",
			title: "web_search",
			status: "completed",
			rawInput: { Query: "laddu slack bot" },
		}),
	).toEqual({
		id: "search-1",
		type: "web_search",
		query: "laddu slack bot",
	})

	for (const title of [
		"desktop_observe",
		"desktop.observe",
		"mcp_desktop_observe",
		"mcp__desktop__observe",
		"desktop:observe",
		"desktop/observe",
	]) {
		expect(
			toItem({
				toolCallId: "desk-1",
				kind: "other",
				title,
				status: "in_progress",
				rawInput: { x: 10 },
			}),
		).toEqual({
			id: "desk-1",
			type: "mcp_tool_call",
			server: "desktop",
			tool: "observe",
			arguments: { x: 10 },
			status: "in_progress",
		})
	}
})

test("toItem holds back incomplete execute calls until command input arrives", () => {
	expect(
		toItem({
			toolCallId: "cmd-empty",
			kind: "execute",
			title: "run_command",
			status: "in_progress",
			rawInput: {},
		}),
	).toBeNull()
})

/** Tiny ACP stub over stdio that requires `authenticate` unless already authenticated. */
const FAKE_ACP = `
let authed = false;
let buf = "";
for await (const chunk of Bun.stdin.stream().pipeThrough(new TextDecoderStream())) {
  buf += chunk;
  const lines = buf.split("\\n");
  buf = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    const reply = (result) => Bun.write(Bun.stdout, JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\\n");
    const fail = (code, message) => Bun.write(Bun.stdout, JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code, message } }) + "\\n");
    if (msg.method === "initialize") {
      reply({
        protocolVersion: 1,
        agentCapabilities: { promptCapabilities: { image: true }, sessionCapabilities: { resume: {} } },
      });
    } else if (msg.method === "authenticate") {
      authed = msg.params?.methodId === "gemini-api-key";
      if (authed) reply({});
      else fail(-32000, "Authentication required");
    } else if (msg.method === "session/new") {
      if (!authed) fail(-32000, "Authentication required");
      else reply({ sessionId: "s-1", configOptions: [] });
    } else if (msg.method === "session/resume") {
      if (!authed) fail(-32000, "Authentication required");
      else fail(-32002, "Session not found");
    }
  }
}
`

test("ACP -32000 surfaces AuthRequiredError instead of LostSessionError, and authMethod authenticates", async () => {
	const command = [Bun.argv[0]!, "-e", FAKE_ACP]
	await expect(
		probeAcpSession({
			command,
			env: {},
			cwd: "/tmp",
			stop: async () => {},
		}),
	).rejects.toBeInstanceOf(AuthRequiredError)

	const probed = await probeAcpSession({
		command,
		env: {},
		cwd: "/tmp",
		authMethod: "gemini-api-key",
		stop: async () => {},
	})
	expect(probed.sessionId).toBe("s-1")
	expect(probed.images).toBe(true)

	await expect(
		runAcpTurn(
			{
				command,
				env: {},
				cwd: "/tmp",
				mcpServers: [],
				stop: async () => {},
			},
			{
				sessionId: "existing",
				prompt: [{ type: "text", text: "hi" }],
				onItem: () => {},
			},
		),
	).rejects.toBeInstanceOf(AuthRequiredError)

	await expect(
		runAcpTurn(
			{
				command,
				env: {},
				cwd: "/tmp",
				mcpServers: [],
				authMethod: "gemini-api-key",
				stop: async () => {},
			},
			{
				sessionId: "missing",
				prompt: [{ type: "text", text: "hi" }],
				onItem: () => {},
			},
		),
	).rejects.toBeInstanceOf(LostSessionError)
})

test("aborting during session/set_config_option does not dispatch session/prompt", async () => {
	const marker = `/tmp/laddu-acp-prompt-${crypto.randomUUID()}`
	const script = `
let buf = "";
for await (const chunk of Bun.stdin.stream().pipeThrough(new TextDecoderStream())) {
  buf += chunk;
  const lines = buf.split("\\n");
  buf = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    const reply = (result) => Bun.write(Bun.stdout, JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\\n");
    if (msg.method === "initialize") {
      reply({ protocolVersion: 1, agentCapabilities: {} });
    } else if (msg.method === "session/new") {
      reply({
        sessionId: "s-abort",
        configOptions: [{
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "a",
          options: [{ value: "a", name: "A" }, { value: "b", name: "B" }],
        }],
      });
    } else if (msg.method === "session/set_config_option") {
      await Bun.sleep(80);
      reply({ configOptions: [] });
    } else if (msg.method === "session/prompt") {
      await Bun.write(${JSON.stringify(marker)}, "dispatched");
      reply({ stopReason: "end_turn" });
    }
  }
}
`
	const controller = new AbortController()
	setTimeout(() => controller.abort(new Error("stopped")), 40)
	try {
		await expect(
			runAcpTurn(
				{
					command: [Bun.argv[0]!, "-e", script],
					env: {},
					cwd: "/tmp",
					mcpServers: [],
					model: "b",
					stop: async () => {},
				},
				{
					prompt: [{ type: "text", text: "hi" }],
					signal: controller.signal,
					onItem: () => {},
				},
			),
		).rejects.toThrow()
		expect(await Bun.file(marker).exists()).toBe(false)
	} finally {
		await Bun.$`rm -f ${marker}`.quiet().nothrow()
	}
})
