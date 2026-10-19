import { expect, test } from "bun:test"
import { cronProblem, nextRun } from "./scheduler"

test.each([
	["* * * * *", "2026-10-19T09:01:00.000Z"],
	["*/5 * * * *", "2026-10-19T09:05:00.000Z"],
	["1,3 * * * *", "2026-10-19T09:01:00.000Z"],
	["2-4 * * * *", "2026-10-19T09:02:00.000Z"],
	["0 * * * *", "2026-10-19T10:00:00.000Z"],
])(
	"recurring schedule %s is accepted and finds its next run",
	(cron, expected) => {
		expect(cronProblem(cron)).toBeNull()
		expect(
			nextRun(
				{ cron, timezone: "UTC" },
				new Date("2026-10-19T09:00:30Z"),
			)?.toISOString(),
		).toBe(expected)
	},
)

test("second-based schedules are rejected with the one-minute minimum", () => {
	expect(cronProblem("*/1 * * * * *")).toContain(
		"minimum interval is one minute",
	)
	expect(cronProblem("*/30 * * * * *")).toContain(
		"minimum interval is one minute",
	)
})
