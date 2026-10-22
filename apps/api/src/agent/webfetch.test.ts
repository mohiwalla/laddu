import { afterAll, expect, test } from "bun:test"

const root = `/tmp/laddu-webfetch-tests-${crypto.randomUUID()}`
const command = Bun.fileURLToPath(
	new URL("../../runtime/webfetch", import.meta.url),
)
let limitedRequests = 0
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch(request) {
		switch (new URL(request.url).pathname) {
			case "/redirect":
				return new Response(null, {
					status: 302,
					headers: { location: "/compressed" },
				})
			case "/compressed":
				return new Response(Bun.gzipSync('{"value":42}'), {
					headers: {
						"content-type": "application/json",
						"content-encoding": "gzip",
					},
				})
			case "/false":
				return Response.json(false)
			case "/invalid-json":
				return new Response("not JSON", {
					headers: { "content-type": "application/json" },
				})
			case "/html":
				return new Response(
					"<!doctype html><html><title>Sign in</title></html>",
					{ headers: { "content-type": "text/html" } },
				)
			case "/challenge":
				return new Response(
					"<!doctype html><title>Just a moment...</title>",
					{ headers: { "content-type": "text/html" } },
				)
			case "/limited":
				limitedRequests++
				return new Response("Too Many Requests", {
					status: 429,
					headers: { "retry-after": "60" },
				})
			case "/denied":
				return new Response("Forbidden", { status: 403 })
			case "/empty":
				return new Response(null, { status: 204 })
			default:
				return new Response("Not found", { status: 404 })
		}
	},
})

afterAll(async () => {
	server.stop(true)
	await Bun.$`/bin/rm -rf -- ${root}`.quiet()
})

async function download(route: string, path: string, kind = "auto") {
	const child = Bun.spawn(
		[
			Bun.argv[0]!,
			command,
			new URL(route, server.url).href,
			path,
			"--type",
			kind,
		],
		{
			stdout: "pipe",
			stderr: "pipe",
		},
	)
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	])
	return { exitCode, stdout, stderr }
}

test("redirected compressed JSON is decompressed and validated before replacing a file", async () => {
	const path = `${root}/with spaces/data.json`
	const result = await download("/redirect", path)
	expect(result.exitCode).toBe(0)
	expect(result.stderr).toBe("")
	expect(await Bun.file(path).json()).toEqual({ value: 42 })
	expect(JSON.parse(result.stdout)).toMatchObject({
		status: 200,
		type: "json",
		path,
	})
})

test("valid JSON false is accepted", async () => {
	const path = `${root}/false.json`
	expect((await download("/false", path)).exitCode).toBe(0)
	expect(await Bun.file(path).json()).toBe(false)
})

test.each([
	["/missing", "json", "HTTP 404"],
	["/denied", "json", "HTTP 403"],
	["/invalid-json", "json", "not valid JSON"],
	["/html", "json", "Expected json"],
	["/html", "image", "Expected image"],
	["/html", "binary", "Expected binary"],
	["/challenge", "html", "browser verification"],
	["/empty", "binary", "empty response"],
])(
	"%s (%s) fails without replacing existing data",
	async (route, kind, error) => {
		const path = `${root}/preserved-${crypto.randomUUID()}.data`
		await Bun.write(path, "existing good data", { createPath: true })
		const result = await download(route!, path, kind)
		expect(result.exitCode).not.toBe(0)
		expect(result.stderr).toContain(error!)
		expect(result.stdout).toBe("")
		expect(await Bun.file(path).text()).toBe("existing good data")
		expect(
			await Array.fromAsync(new Bun.Glob(".webfetch-*").scan(root)),
		).toEqual([])
	},
)

test("429 explains throttling without repeatedly hitting the source", async () => {
	const path = `${root}/rate-limited.json`
	const result = await download("/limited", path)
	expect(result.exitCode).not.toBe(0)
	expect(result.stderr).toContain("HTTP 429")
	expect(limitedRequests).toBe(1)
	expect(await Bun.file(path).exists()).toBe(false)
})
