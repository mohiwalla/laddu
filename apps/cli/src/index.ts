#!/usr/bin/env bun
/** `slack-dot`: set up and run dot, the Slack assistant backed by Codex. */
import {
	configure,
	doctor,
	list,
	login,
	logs,
	power,
	uninstall,
	update,
} from "./commands"
import { checkName, pickInstance } from "./instance"
import { setup } from "./setup"
import { bold, dim, fail } from "./terminal"

const HELP = `${bold("slack-dot")}: set up and run dot, the Slack assistant backed by Codex

${bold("Usage")}  slack-dot <command> [--name <bot>]

  setup        Set up a bot (or fix one): Slack app, ChatGPT sign-in, service
  configure    Change a bot's settings
  login        Sign in to ChatGPT again
  doctor       Check that everything a bot needs works
  update       Update slack-dot and restart every bot
  list         The bots on this machine
  logs [-f]    A bot's log (-f follows it)
  start | stop | restart | status
  uninstall    Remove a bot (--yes: without asking, data included)

${dim("--name picks the bot; with just one, it's that one. setup's default name is \"dot\".")}
`

function parse(argv: string[]) {
	const flags = new Map<string, string | true>()
	const rest: string[] = []
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index]!
		if (arg === "--name" || arg === "-n")
			flags.set("name", argv[++index] ?? "")
		else if (arg.startsWith("--name=")) flags.set("name", arg.slice(7))
		else if (arg.startsWith("-")) flags.set(arg.replace(/^-+/, ""), true)
		else rest.push(arg)
	}
	const name = flags.get("name")
	return {
		command: rest[0] ?? "help",
		name: typeof name === "string" ? name : undefined,
		has: (...names: string[]) => names.some(flag => flags.has(flag)),
	}
}

async function main(): Promise<boolean> {
	const { command, name, has } = parse(Bun.argv.slice(2))
	if (command === "help" || has("help", "h")) {
		console.log(HELP)
		return true
	}
	if (command === "version" || has("version", "v")) {
		const pkg = await Bun.file(
			new URL("../package.json", import.meta.url),
		).json()
		console.log(pkg.version)
		return true
	}
	if (command === "setup") {
		const chosen = name ?? "dot"
		const problem = checkName(chosen)
		if (problem) throw new Error(problem)
		return setup(chosen)
	}
	if (command === "list") {
		await list()
		return true
	}
	if (command === "update") return update(has("finish"))

	const instance = await pickInstance(name)
	if (typeof instance === "string") throw new Error(instance)
	switch (command) {
		case "configure":
			return configure(instance)
		case "login":
			return login(instance)
		case "doctor":
			return doctor(instance)
		case "logs":
			await logs(instance, has("f", "follow"))
			return true
		case "start":
		case "stop":
		case "restart":
		case "status":
			return power(command, instance)
		case "uninstall":
			return uninstall(instance, has("yes", "y"))
	}
	throw new Error(`Unknown command "${command}". See \`slack-dot help\`.`)
}

try {
	const ok = await main()
	// Prompts may leave stdin open; nothing else is pending once a command returns.
	process.exit(ok ? 0 : 1)
} catch (error) {
	fail((error as Error).message)
	process.exit(1)
}
