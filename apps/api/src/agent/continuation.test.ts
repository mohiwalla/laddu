import { expect, test } from "bun:test"
import {
	earlyStopContinuation,
	MAX_CONTINUATIONS,
	reportsBlocker,
} from "./continuation"

test("catches real Kamal early-stop with unfinished to-dos and partial workbook", () => {
	const result = earlyStopContinuation({
		text: "Attached **Lusha-Tech-Public-Research-Partial.xlsx**. Public sources added company evidence for **61 more leads**, bringing Gray to **101**.\n\nThe research is **incomplete**. Another **2,931 leads** still need public checks. They’re marked **Research pending**, not as failed lookups. No paid enrichment was run.",
		steps: 13,
		todos: {
			items: [
				{ text: "Group pending rows by company", status: "completed" },
				{ text: "Research remaining companies", status: "in_progress" },
				{ text: "Build final workbook", status: "pending" },
			],
		},
		request: "Then proceed.",
		waitingOnUser: false,
		continuations: 0,
	})
	expect(result?.reason).toBe("unfinished_todos")
	expect(result?.prompt).toContain("Research remaining companies")
})

test("catches real Kamal early-stop even without a to-do list", () => {
	const result = earlyStopContinuation({
		text: "Attached **Lusha-Tech-Public-Research-Partial.xlsx**. Public sources added company evidence for **61 more leads**, bringing Gray to **101**.\n\nThe research is **incomplete**. Another **2,931 leads** still need public checks. They’re marked **Research pending**, not as failed lookups. No paid enrichment was run.",
		steps: 7,
		request: "Then proceed.",
		waitingOnUser: false,
		continuations: 0,
	})
	expect(result?.reason).toBe("incomplete_reply")
})

test.each([
	[
		"Vishal 0/500 with negated CAPTCHA/rate-limit",
		"**0 of 500 leads verified. No CSV batches sent.** I confirmed all five requested filters in Lusha and checked the first company, Nooks. LinkedIn showed **505 associated members**, above the 50-member limit, so I excluded it.\n\nI didn’t finish the search in this run. No LinkedIn CAPTCHA or rate limit appeared during the check.",
	],
	[
		"Vishal 1/500 with negated blocker",
		"**1 of 500 leads verified. No batch finalized.** I saved Clera and its verified decision-maker. This run ended before the first 50. No LinkedIn blocker appeared, and the remaining results haven’t been checked.",
	],
	[
		"Vishal 3/500 ended before stopping point",
		"**3 of 500 leads verified. No 50-lead batch finalized.** I added Edra and closed its research tabs. LinkedIn didn’t block verification. I ended the run before your requested stopping point, and nothing is running in the background.",
	],
	[
		"Vishal 4/500 single-site block is not a run-wide blocker",
		"Lusha is set to **11–50 employees only**. The verified total is **4 of 500**, so no CSV batch is ready. RepVue was left out because its official website blocked browser verification. The run ended before the first batch, and no background verification is running.",
	],
	[
		"Kamal Nov 4 high-effort incomplete batch",
		"The batch is still incomplete; I haven’t produced the workbook. I searched for 145 supplied person–company pairs and saved the results for review. The remaining website matches, red flags and signals still need validation.",
	],
])("catches real production early stop: %s", (_, text) => {
	const result = earlyStopContinuation({
		text,
		steps: 16,
		waitingOnUser: false,
		continuations: 0,
	})
	expect(result?.reason).toBe("incomplete_reply")
})

test.each([
	[
		"Lusha monthly search limit exhausted",
		"29 of 50 new leads are verified. Lusha has now hit its monthly search limit and says access will renew next cycle. I saved the 29 verified leads and haven’t sent a partial CSV, as requested.",
	],
	[
		"Chromium stopped responding",
		"The checkpoint still has 11 of 50 verified leads. LinkedIn is signed in, but Chromium stopped responding reliably to clicks, so I couldn’t reopen the filtered Lusha search.",
	],
	[
		"Clay plan restriction",
		"Clay’s GUI confirmed the blocker. Mobile phone enrichment requires the Launch plan or higher. No batch sent.",
	],
	[
		"Candidates exhausted",
		"Verified 18 of 50 leads; there are no more candidates matching the requested filters.",
	],
])("does not continue on genuine run-wide blocker: %s", (_, text) => {
	expect(reportsBlocker(text)).toBe(true)
	expect(
		earlyStopContinuation({
			text,
			steps: 20,
			waitingOnUser: false,
			continuations: 0,
		}),
	).toBeNull()
})

test("never continues on 0-step replies, special replies, waiting on user, or max continuations", () => {
	const base = {
		text: "The research is incomplete. Another 2,931 leads still need public checks.",
		steps: 5,
		waitingOnUser: false,
		continuations: 0,
	}
	expect(earlyStopContinuation({ ...base, steps: 0 })).toBeNull()
	expect(earlyStopContinuation({ ...base, waitingOnUser: true })).toBeNull()
	expect(
		earlyStopContinuation({ ...base, continuations: MAX_CONTINUATIONS }),
	).toBeNull()
	expect(
		earlyStopContinuation({ ...base, text: "[REACT:speech_balloon]" }),
	).toBeNull()
	expect(earlyStopContinuation({ ...base, text: "[SILENT]" })).toBeNull()
	expect(earlyStopContinuation({ ...base, text: "[SKIP]" })).toBeNull()
})

test("respects explicit user request for a partial or sample batch", () => {
	expect(
		earlyStopContinuation({
			text: "Attached partial workbook with the first 10 rows.",
			steps: 4,
			request:
				"Just check the first 10 leads and send a partial workbook",
			waitingOnUser: false,
			continuations: 0,
		}),
	).toBeNull()
})

test("does not continue when work is complete and all to-dos are done", () => {
	expect(
		earlyStopContinuation({
			text: "Attached **Sales Navigator Leads - 26 November.xlsx**. All 51 Green leads verified and uploaded to SharePoint.",
			steps: 25,
			todos: {
				items: [
					{ text: "Verify leads", status: "completed" },
					{ text: "Build workbook", status: "completed" },
				],
			},
			waitingOnUser: false,
			continuations: 0,
		}),
	).toBeNull()
})
