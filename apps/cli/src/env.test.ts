import { expect, test } from "bun:test"
import { parseEnv, updateEnvText } from "./env"

test("parses quoted, unquoted and commented values", () => {
	expect(
		parseEnv(
			[
				'A="x y" # note',
				"B=plain # note",
				"# C=off",
				"D='single'",
				'E="a\\$b and\\nc"',
				"export F=1",
			].join("\n"),
		),
	).toEqual({ A: "x y", B: "plain", D: "single", E: "a$b and\nc", F: "1" })
})

test("updates in place, removes, appends, and quotes", () => {
	const text = '# header\nA="1"\nB="2" # keep?\n\n'
	expect(updateEnvText(text, { A: "one", B: null, C: "a$b" })).toBe(
		'# header\nA="one"\nC="a\\$b"\n',
	)
	expect(() => updateEnvText("", { A: 'say "hi"' })).toThrow()
})

test("round-trips", () => {
	const value = "tricky $HOME \\ path # not a comment"
	expect(parseEnv(updateEnvText("", { V: value })).V).toBe(value)
})
