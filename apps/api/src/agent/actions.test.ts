import { describe, expect, test } from "bun:test"
import {
	askedFor,
	needsOk,
	outsideAction,
	targetsOf,
	type ApiRequest,
} from "./actions"

const request = (overrides: Partial<ApiRequest>): ApiRequest => ({
	resource: "slack",
	method: "POST",
	path: "/slack",
	body: null,
	asPerson: false,
	slackWrite: false,
	...overrides,
})

describe("needsOk", () => {
	test("a DM as the person needs their OK and shows the text", () => {
		const risky = needsOk(
			request({
				action: "dm",
				asPerson: true,
				body: { to: "<@U1>", text: "hi <!channel>" },
			}),
		)
		expect(risky?.label).toBe("send a Slack DM as them to <@U1>")
		expect(risky?.detail).toContain("> hi &lt;!channel&gt;")
		expect(
			needsOk(
				request({
					action: "dm",
					asPerson: true,
					body: { to: "U099WGMMFPW", text: "hi" },
				}),
			)?.detail,
		).toContain("to <@U099WGMMFPW>:")
	})

	test("a DM from laddu doesn't", () => {
		expect(
			needsOk(
				request({ action: "dm", body: { to: "<@U1>", text: "hi" } }),
			),
		).toBeNull()
	})

	test("Slack writes as the person need it, except ones only they see", () => {
		const as = (method: string, slackWrite = true) =>
			needsOk(
				request({
					action: "api",
					asPerson: true,
					slackWrite,
					body: { method },
				}),
			)
		expect(as("chat.postMessage")).not.toBeNull()
		expect(as("chat.delete")).not.toBeNull()
		expect(as("conversations.kick")).not.toBeNull()
		expect(as("reactions.add")).toBeNull()
		expect(as("users.setPresence")).toBeNull()
		expect(as("conversations.history", false)).toBeNull()
		expect(
			needsOk(
				request({
					action: "api",
					body: { method: "chat.postMessage" },
				}),
			),
		).toBeNull()
	})

	test("Microsoft 365: sending and deleting need it, other changes don't", () => {
		const graph = (method: string, path: string) =>
			needsOk(
				request({
					resource: "ms",
					action: "request",
					body: { method, path },
				}),
			)
		expect(graph("POST", "me/sendMail")).not.toBeNull()
		expect(graph("POST", "me/messages/AAA/reply")).not.toBeNull()
		expect(graph("POST", "chats/19:abc/messages")).not.toBeNull()
		expect(graph("POST", "me/drive/items/1/createLink?x=1")).not.toBeNull()
		expect(graph("DELETE", "me/events/1")).not.toBeNull()
		expect(graph("GET", "me/messages")).toBeNull()
		expect(graph("POST", "me/events")).toBeNull()
		expect(graph("PATCH", "me/messages/1")).toBeNull()
	})

	test("Azure DevOps: deleting and merging need it", () => {
		const ado = (body: Record<string, unknown>) =>
			needsOk(request({ resource: "ado", action: "write", body }))
		expect(
			ado({ method: "DELETE", path: "wit/workitems/1" }),
		).not.toBeNull()
		expect(
			ado({ path: "git/pullrequests/7", body: { status: "completed" } }),
		).not.toBeNull()
		expect(ado({ path: "wit/workitems/1", body: [] })).toBeNull()
	})
})

describe("OK requests read plainly", () => {
	test("plain words with real names, never the API call", () => {
		const detail = needsOk(
			request({
				action: "api",
				asPerson: true,
				slackWrite: true,
				body: {
					method: "conversations.invite",
					args: { channel: "C0B7T5KD15H", users: "U0A6QDUQYTY" },
				},
			}),
		)!.detail
		expect(detail).toBe("Add <@U0A6QDUQYTY> to <#C0B7T5KD15H>, *as you*")
	})

	test("an email reads as an email", () => {
		const detail = needsOk(
			request({
				resource: "ms",
				action: "request",
				body: {
					method: "POST",
					path: "me/sendMail",
					body: {
						message: {
							subject: "Lunch",
							body: {
								contentType: "HTML",
								content: "<p>Pizza at 1?</p>",
							},
							toRecipients: [
								{
									emailAddress: {
										address: "ana@example.com",
									},
								},
							],
						},
					},
				},
			}),
		)!.detail
		expect(detail).toBe(
			'Send an email *as you* to ana@example.com, subject "Lunch":\n> Pizza at 1?',
		)
	})
})

describe("asked for exactly this", () => {
	const dmAs = (to: string, text = "hi") =>
		request({ action: "dm", asPerson: true, body: { to, text } })
	// The names the bot found, for the first target (the recipient).
	const known = (target: ApiRequest, names: string[] = []) =>
		targetsOf(target)?.map((found, index) => ({
			target: found,
			names: index ? [] : names,
		})) ?? null
	const vikash = ["U0VIKASH1", "vikash@example.com", "vikash", "vikash kumar"]
	const invite = (channel: string) =>
		request({
			action: "api",
			asPerson: true,
			slackWrite: true,
			body: {
				method: "conversations.invite",
				args: { channel, users: "U0VIKASH1" },
			},
		})
	const email = (message: Record<string, unknown>) =>
		request({
			resource: "ms",
			action: "request",
			body: { method: "POST", path: "me/sendMail", body: { message } },
		})
	const to = (address: string) => [{ emailAddress: { address } }]
	const removeItem = (number: number) =>
		request({
			resource: "ado",
			action: "write",
			body: {
				method: "DELETE",
				path: `Proj/_apis/wit/workitems/${number}`,
			},
		})

	test("the exact ask goes through", () => {
		expect(
			askedFor(
				["<@U0LADDU1> DM <@U0VIKASH1> a story about crocodiles"],
				known(dmAs("U0VIKASH1")),
				"C0HERE001",
			),
		).toBe(true)
		// By a name the bot found for them, in any case.
		expect(
			askedFor(
				["dm Vikash a story about crocodiles"],
				known(dmAs("U0VIKASH1"), vikash),
				"C0HERE001",
			),
		).toBe(true)
		expect(
			askedFor(
				["add <@U0VIKASH1> to this channel"],
				known(invite("C0HERE001")),
				"C0HERE001",
			),
		).toBe(true)
		expect(
			askedFor(
				["email <mailto:ana@example.com|ana@example.com> the notes"],
				known(email({ toRecipients: to("Ana@Example.com") })),
				"C0HERE001",
			),
		).toBe(true)
		expect(
			askedFor(
				["delete work item 123"],
				known(removeItem(123)),
				"C0HERE001",
			),
		).toBe(true)
		expect(
			askedFor(["delete #123"], known(removeItem(123)), "C0HERE001"),
		).toBe(true)
	})

	test("a target they didn't name asks", () => {
		// Their request was about something else: the DM came from a file, page or someone's message.
		expect(
			askedFor(
				["summarize the incident doc"],
				known(dmAs("U0VIKASH1"), vikash),
				"C0HERE001",
			),
		).toBe(false)
		// They named Vikash, but the message also pings people they didn't.
		expect(
			askedFor(
				["DM Vikash a story"],
				known(dmAs("U0VIKASH1", "story <@U0OTHER01>"), vikash),
				"C0HERE001",
			),
		).toBe(false)
		expect(
			askedFor(
				["DM Vikash a story"],
				known(dmAs("U0VIKASH1", "<!channel> story"), vikash),
				"C0HERE001",
			),
		).toBe(false)
		// A name inside someone else's email isn't them.
		expect(
			askedFor(
				["forward it to vikash@other.example"],
				known(dmAs("U0VIKASH1"), vikash),
				"C0HERE001",
			),
		).toBe(false)
		// "this channel" only means the conversation they're writing in.
		expect(
			askedFor(
				["add <@U0VIKASH1> to this channel"],
				known(invite("C0ELSE001")),
				"C0HERE001",
			),
		).toBe(false)
		// A number in passing isn't a work item.
		expect(
			askedFor(
				["in 5 minutes, tidy up the board"],
				known(removeItem(5)),
				"C0HERE001",
			),
		).toBe(false)
		// Every recipient, Bcc too.
		expect(
			askedFor(
				["email ana@example.com the notes"],
				known(
					email({
						toRecipients: to("ana@example.com"),
						bccRecipients: to("eve@example.com"),
					}),
				),
				"C0HERE001",
			),
		).toBe(false)
	})

	test("what nobody can name in words always asks", () => {
		const graph = (method: string, path: string) =>
			targetsOf(
				request({
					resource: "ms",
					action: "request",
					body: { method, path },
				}),
			)
		expect(graph("DELETE", "me/events/AAMk1")).toBeNull()
		expect(graph("POST", "me/messages/AAMk1/reply")).toBeNull()
		expect(graph("POST", "chats/19:abc/messages")).toBeNull()
		expect(
			targetsOf(
				request({
					action: "api",
					asPerson: true,
					slackWrite: true,
					body: { method: "files.delete", args: { file: "F123" } },
				}),
			),
		).toBeNull()
		expect(
			targetsOf(
				request({
					resource: "ado",
					action: "write",
					body: { method: "DELETE", path: "Proj/_apis/git/refs" },
				}),
			),
		).toBeNull()
		expect(askedFor(["delete that event"], null, "C0HERE001")).toBe(false)
	})

	test("no words of theirs this turn (a scheduled run, an answer) asks", () => {
		expect(askedFor([], known(dmAs("U0VIKASH1")), "C0HERE001")).toBe(false)
		expect(askedFor([" "], known(dmAs("U0VIKASH1")), "C0HERE001")).toBe(
			false,
		)
	})
})

describe("outsideAction", () => {
	test("changes outside the conversation are named", () => {
		expect(
			outsideAction(request({ action: "dm", body: { to: "<@U1>" } })),
		).toBe("sent a Slack DM to <@U1>")
		expect(outsideAction(request({ action: "post" }))).toBe(
			"posted in this thread",
		)
		expect(
			outsideAction(
				request({
					resource: "ado",
					action: "git",
					path: "/ado/git/org/proj/_git/repo/git-receive-pack",
				}),
			),
		).toBe("pushed to Azure Repos")
		expect(outsideAction(request({ resource: "schedule" }))).toBe(
			"added a scheduled task",
		)
	})

	test("reads and harmless calls aren't", () => {
		expect(outsideAction(request({ action: "todo" }))).toBeNull()
		expect(outsideAction(request({ action: "ask" }))).toBeNull()
		expect(
			outsideAction(
				request({
					action: "api",
					body: { method: "conversations.history" },
				}),
			),
		).toBeNull()
		expect(
			outsideAction(
				request({
					resource: "ms",
					action: "request",
					body: { method: "GET", path: "me" },
				}),
			),
		).toBeNull()
		expect(
			outsideAction(
				request({
					resource: "ado",
					action: "git",
					method: "GET",
					path: "/ado/git/x/info/refs",
				}),
			),
		).toBeNull()
	})
})
