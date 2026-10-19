import { connection } from "./user-tokens"
import {
	type SlackClient,
	type Person,
	resolveChannel,
	SlackToolError,
} from "./api"

const MAX_BYTES = 50 * 1024 * 1024
function slackUrl(input: string) {
	const url = new URL(input)
	if (
		url.protocol !== "https:" ||
		!(
			url.hostname === "files.slack.com" ||
			url.hostname.endsWith(".slack.com") ||
			url.hostname.endsWith(".slack-edge.com")
		)
	)
		throw new SlackToolError("Slack returned an unexpected file host.", 502)
	return url
}

export async function transfer(
	client: SlackClient,
	person: Person,
	request: Request,
	action: "upload" | "download",
) {
	const saved = await connection(person)
	if (!saved)
		throw new SlackToolError("Connect Slack first with slack connect.", 409)
	const token = saved.token
	const query = new URL(request.url).searchParams
	if (action === "download") {
		const id = query.get("file")
		if (!id) throw new SlackToolError("Give the file ID.")
		const { file } = await client.files.info({ token, file: id })
		if (!file?.url_private_download)
			throw new SlackToolError("File isn't downloadable.", 404)
		if ((file.size ?? 0) > MAX_BYTES)
			throw new SlackToolError("Download limit is 50 MB.", 413)
		let url = slackUrl(file.url_private_download)
		for (let redirects = 0; redirects < 4; redirects++) {
			const response = await fetch(url, {
				headers: { Authorization: `Bearer ${token}` },
				redirect: "manual",
				signal: AbortSignal.timeout(30_000),
			})
			if ([301, 302, 303, 307, 308].includes(response.status)) {
				await response.body?.cancel()
				url = slackUrl(
					new URL(response.headers.get("location") ?? "", url).href,
				)
				continue
			}
			if (
				!response.ok ||
				(response.headers.get("content-type")?.includes("text/html") &&
					file.mimetype !== "text/html")
			) {
				await response.body?.cancel()
				throw new SlackToolError("Slack file download failed.", 502)
			}
			// Enforce a byte cap even if metadata or Content-Length is absent or stale.
			const reader = response.body!.getReader()
			const chunks: Uint8Array[] = []
			let size = 0
			try {
				while (true) {
					const { done, value } = await reader.read()
					if (done) break
					size += value.byteLength
					if (size > MAX_BYTES)
						throw new SlackToolError(
							"Download limit is 50 MB.",
							413,
						)
					chunks.push(value)
				}
			} finally {
				await reader.cancel()
			}
			const bytes = new Uint8Array(size)
			let offset = 0
			for (const chunk of chunks) {
				bytes.set(chunk, offset)
				offset += chunk.byteLength
			}
			return new Response(bytes, {
				headers: {
					"content-type": file.mimetype ?? "application/octet-stream",
				},
			})
		}
		throw new SlackToolError("Too many Slack download redirects.", 502)
	}
	const channel = query.get("channel")
	const filename = query.get("filename")
	if (!channel || !filename)
		throw new SlackToolError("Give a channel and filename.")
	const target = await resolveChannel(client, person, channel, token)
	const bytes = await request.arrayBuffer()
	if (!bytes.byteLength || bytes.byteLength > MAX_BYTES)
		throw new SlackToolError(
			"Upload must be between 1 byte and 50 MB.",
			413,
		)
	const result = await client.files.getUploadURLExternal({
		token,
		filename,
		length: bytes.byteLength,
	})
	if (!result.upload_url || !result.file_id)
		throw new SlackToolError("Slack didn't provide an upload URL.", 502)
	const upload = await fetch(slackUrl(result.upload_url), {
		method: "POST",
		body: bytes,
		headers: { "content-type": "application/octet-stream" },
		redirect: "error",
		signal: AbortSignal.timeout(60_000),
	})
	if (!upload.ok) throw new SlackToolError("Slack upload failed.", 502)
	await upload.body?.cancel()
	const completed = await client.files.completeUploadExternal({
		token,
		files: [{ id: result.file_id, title: query.get("title") ?? filename }],
		channel_id: target,
		...(query.get("thread_ts")
			? { thread_ts: query.get("thread_ts")! }
			: {}),
	})
	return Response.json({ text: JSON.stringify(completed) })
}
