/**
 * Files between Slack and Codex: attachments are downloaded for Codex to read, and files Codex
 * leaves in its outbox are uploaded to the thread.
 */
import type { App } from "@slack/bolt"
import type { TurnFile } from "../agent/codex"
import type { SlackAttachment } from "./context"

type WebClient = App["client"]

/** Keeps the original name (and so the extension tools rely on) but makes it safe as a path. */
const safeName = (name: string) =>
	name
		.replace(/[^\w.-]+/g, "_")
		.replace(/^\.+/, "")
		.slice(-100) || "file"

/** Fetches each attachment with the bot token (needs `files:read`). Ones that fail are skipped, not fatal. */
export async function downloadAttachments(
	token: string,
	attachments: SlackAttachment[],
): Promise<TurnFile[]> {
	const results = await Promise.all(
		attachments.map(async (attachment): Promise<TurnFile | null> => {
			try {
				const response = await fetch(attachment.url, {
					headers: { authorization: `Bearer ${token}` },
				})
				// Without access Slack answers 200 with its HTML sign-in page.
				const type = response.headers.get("content-type") ?? ""
				const signInPage =
					type.startsWith("text/html") &&
					attachment.mimetype !== "text/html"
				if (!response.ok || signInPage)
					throw new Error(`HTTP ${response.status} ${type}`)
				return {
					// Prefixed with the Slack file ID: two attachments can share a name.
					fileName: `${attachment.id}-${safeName(attachment.name)}`,
					title: attachment.title,
					data: await response.bytes(),
					image: attachment.image,
				}
			} catch (error) {
				console.warn(
					`[attachments] could not download ${attachment.id} (${attachment.title}):`,
					error,
				)
				return null
			}
		}),
	)
	return results.filter(file => file !== null)
}

/** Uploads files to the thread as one message (needs `files:write`). */
export async function uploadFiles(
	client: WebClient,
	channel: string,
	threadTs: string,
	files: { name: string; data: Uint8Array }[],
): Promise<void> {
	if (!files.length) return
	const uploaded = await Promise.all(
		files.map(async ({ name, data }) => {
			const { upload_url, file_id } =
				await client.files.getUploadURLExternal({
					filename: name,
					length: data.length,
				})
			const response = await fetch(upload_url!, {
				method: "POST",
				body: data,
			})
			if (!response.ok)
				throw new Error(
					`Uploading ${name} failed: HTTP ${response.status}`,
				)
			return { id: file_id!, title: name }
		}),
	)
	await client.files.completeUploadExternal({
		files: uploaded as [(typeof uploaded)[number], ...typeof uploaded],
		channel_id: channel,
		thread_ts: threadTs,
	})
}
