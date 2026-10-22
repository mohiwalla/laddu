/** Shared Git smart HTTP relay; provider credentials stay on the host. */
export async function relayGit(
	request: Request,
	upstream: URL,
	userId: string,
	authorization: string,
): Promise<Response> {
	const url = new URL(request.url)
	const service = upstream.pathname.endsWith("info/refs")
		? "info/refs"
		: upstream.pathname.split("/").at(-1)!
	const problem = (status: number, text: string) =>
		new Response(text, { status })
	const discovery = service === "info/refs"
	const requestedService = url.searchParams.get("service")
	if (
		(discovery &&
			(request.method !== "GET" ||
				!["git-upload-pack", "git-receive-pack"].includes(
					requestedService ?? "",
				) ||
				[...url.searchParams].length !== 1)) ||
		(!discovery && (request.method !== "POST" || url.search))
	)
		return problem(400, "Use Git smart HTTP discovery, fetch or push.")
	if (
		!discovery &&
		request.headers.get("content-type") !==
			`application/x-${service}-request`
	)
		return problem(415, "Invalid Git content type.")
	let body: Uint8Array | undefined
	if (!discovery) {
		body = new Uint8Array(await request.arrayBuffer())
		if (body.length > 64 * 1024 * 1024)
			return problem(413, "Git requests must be under 64 MB.")
		if (service === "git-receive-pack") {
			// Receive-pack command lines precede the binary pack. Inspect every ref before forwarding.
			if (request.headers.has("content-encoding"))
				return problem(415, "Compressed Git pushes aren't supported.")
			const refused = pushProblem(body, userId)
			if (refused) return problem(403, refused)
		}
	}
	upstream.search = url.search
	const headers = new Headers({
		authorization: authorization,
		"accept-encoding": "identity",
	})
	for (const name of ["content-type", "content-encoding", "git-protocol"])
		if (request.headers.has(name))
			headers.set(name, request.headers.get(name)!)
	const response = await fetch(upstream, {
		method: request.method,
		headers,
		body,
		redirect: "manual",
		signal: request.signal,
	})
	const contentType = response.headers.get("content-type") ?? ""
	if (!response.ok || !contentType.startsWith("application/x-git-")) {
		await response.body?.cancel()
		return problem(
			response.status >= 400 ? response.status : 502,
			"The repository refused the Git request. Check your sign-in and repository permissions; redirects aren't followed.",
		)
	}
	return new Response(response.body, {
		status: response.status,
		headers: { "content-type": contentType, "cache-control": "no-store" },
	})
}

/** Reject deletions, other people's branches, protected refs and malformed command packets. */
function pushProblem(body: Uint8Array, userId: string): string | null {
	const decode = new TextDecoder("utf-8", { fatal: true })
	let offset = 0
	let commands = 0
	try {
		while (offset + 4 <= body.length) {
			const header = decode.decode(body.subarray(offset, offset + 4))
			if (!/^[0-9a-f]{4}$/i.test(header)) break
			const size = parseInt(header, 16)
			if (size === 0) return commands ? null : "No Git push commands."
			if (size < 4 || offset + size > body.length) break
			const line = decode
				.decode(body.subarray(offset + 4, offset + size))
				.split("\0")[0]!
				.trimEnd()
			const match =
				/^([0-9a-f]{40}) ([0-9a-f]{40}) (refs\/heads\/[^\s]+)$/.exec(
					line,
				)
			if (!match || /^0+$/.test(match[2]!))
				return "Git branch deletion or an invalid push isn't allowed."
			const ref = match[3]!
			if (!ref.startsWith(`refs/heads/laddu/${userId.toLowerCase()}/`))
				return "Only your laddu task branches can be pushed; open a PR to change the target branch."
			if (
				!/^[a-zA-Z0-9._/-]+$/.test(ref) ||
				ref.includes("..") ||
				ref.includes("//") ||
				ref.endsWith("/") ||
				ref.endsWith(".") ||
				ref
					.split("/")
					.some(
						part => part.startsWith(".") || part.endsWith(".lock"),
					)
			)
				return "Invalid task branch."
			commands++
			offset += size
		}
	} catch {
		/* Invalid UTF-8 in command packets. */
	}
	return "Malformed Git push."
}
