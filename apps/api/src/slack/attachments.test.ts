import { afterEach, expect, mock, spyOn, test } from "bun:test"
import type { App } from "@slack/bolt"
import { uploadFiles } from "./attachments"

afterEach(() => {
	;(globalThis.fetch as unknown as { mockRestore?(): void }).mockRestore?.()
})

function fakeClient() {
	let next = 0
	spyOn(globalThis, "fetch").mockImplementation(
		(async () => new Response("ok")) as unknown as typeof fetch,
	)
	return {
		files: {
			getUploadURLExternal: mock(async () => ({
				upload_url: "https://files.slack.com/upload",
				file_id: `F${++next}`,
			})),
			completeUploadExternal: mock(async () => ({ ok: true })),
		},
	}
}

const files = [
	{ name: "doraemon.png", data: new Uint8Array([1]) },
	{ name: "notes.pdf", data: new Uint8Array([2]) },
]

test("files are shared as one message wearing the person's name and picture", async () => {
	const client = fakeClient()
	const as = { username: "kanha", icon_url: "https://x/kanha.png" }
	await uploadFiles(
		client as unknown as App["client"],
		"C1",
		"1.1",
		files,
		as,
	)
	expect(client.files.completeUploadExternal).toHaveBeenCalledTimes(1)
	expect(client.files.completeUploadExternal).toHaveBeenCalledWith({
		files: [
			{ id: "F1", title: "doraemon.png" },
			{ id: "F2", title: "notes.pdf" },
		],
		channel_id: "C1",
		thread_ts: "1.1",
		...as,
	})
})

test("without a name or picture, files are shared as the app", async () => {
	const client = fakeClient()
	await uploadFiles(
		client as unknown as App["client"],
		"C1",
		undefined,
		files,
	)
	expect(client.files.completeUploadExternal).toHaveBeenCalledWith({
		files: [
			{ id: "F1", title: "doraemon.png" },
			{ id: "F2", title: "notes.pdf" },
		],
		channel_id: "C1",
	})
})
