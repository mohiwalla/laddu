import { afterAll, expect, test } from "bun:test"
import { readJson, writeJsonPrivate } from "./files"

const dir = `${Bun.env.TMPDIR ?? "/tmp"}/laddu-files-test-${crypto.randomUUID()}`
afterAll(async () => {
	await Bun.$`rm -rf ${dir}`.quiet()
})

test("writes are private and leave no temporary files", async () => {
	const path = `${dir}/a/state.json`
	await writeJsonPrivate(path, { n: 1 })
	await writeJsonPrivate(path, { n: 2 })
	expect(await readJson(path)).toEqual({ n: 2 })
	expect((await Bun.$`stat -c %a ${path}`.text()).trim()).toBe("600")
	expect((await Bun.$`ls ${dir}/a`.text()).trim()).toBe("state.json")
})

test("a file that won't parse is moved aside and read as missing", async () => {
	const path = `${dir}/broken.json`
	await Bun.write(path, '{"cut off')
	expect(await readJson(path)).toBeNull()
	expect(await Bun.file(path).exists()).toBe(false)
	expect(await Bun.$`ls ${dir}`.text()).toContain("broken.json.corrupt-")
})
