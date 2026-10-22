#!/usr/bin/env bun
/**
 * `bun create laddu` (or `bunx create-laddu`): sets up a bot. bunx runs this from a throwaway
 * cache, and a bot's service runs the package's code where it's installed, so this installs the
 * package globally first and hands over to that copy's `laddu setup`, which also leaves `laddu`
 * on the PATH for later.
 */
import { bun } from "./paths"
import { fail, step } from "./terminal"

step("Installing laddu")
const install = await Bun.spawn([bun, "add", "-g", "create-laddu@latest"], {
	stdio: ["inherit", "inherit", "inherit"],
}).exited
if (install !== 0) {
	fail("Couldn't install laddu.")
	process.exit(1)
}
const laddu = `${(await Bun.$`${bun} pm bin -g`.text()).trim()}/laddu`
const setup = Bun.spawn([laddu, "setup", ...Bun.argv.slice(2)], {
	stdio: ["inherit", "inherit", "inherit"],
})
process.exit(await setup.exited)
