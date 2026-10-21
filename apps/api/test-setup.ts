import { afterAll } from "bun:test"

// Bun loads .env into tests too, so without this a test could write into the live bot's data.
const dataDir = (await Bun.$`mktemp -d`.text()).trim()
Bun.env.DATA_DIR = dataDir
afterAll(async () => {
	await Bun.$`rm -rf ${dataDir}`.quiet()
})
