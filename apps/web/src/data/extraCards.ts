export type CatalogTone =
	| "slate"
	| "emerald"
	| "amber"
	| "violet"
	| "cyan"
	| "crimson"
	| "blue"
	| "plum"
	| "espresso"
	| "pine"
	| "bone"
	| "saffron"
	| "cobalt"
	| "forest"
	| "burgundy"
	| "sand"
	| "mint"
	| "terracotta"
	| "graphite"

export type CatalogCardSpec =
	| {
			id: string
			kind: "slack-mini"
			tone: CatalogTone
			channel: string
			user: string
			init: string
			ask: string
			reply: string
			attachment?: { ext: string; name: string }
			reactions: readonly string[]
	  }
	| {
			id: string
			kind: "poster"
			tone: CatalogTone
			tag: string
			word: string
			copy: string
			icon:
				| "lock"
				| "server"
				| "shield"
				| "code"
				| "bolt"
				| "globe"
				| "key"
				| "slack"
				| "cpu"
			brandIcon?: string
	  }
	| {
			id: string
			kind: "terminal"
			tone: CatalogTone
			host: string
			badge: string
			brandIcon?: string
			lines: readonly {
				kind: "cmd" | "ok" | "dim" | "accent"
				text: string
			}[]
			copyText?: string
	  }
	| {
			id: string
			kind: "diff"
			tone: CatalogTone
			title: string
			repo: string
			brandIcon?: string
			add: string
			del: string
			lines: readonly {
				kind: "ctx" | "del" | "add"
				ln: string
				code: string
			}[]
			footer: string
	  }
	| {
			id: string
			kind: "metric-chart"
			tone: CatalogTone
			badge: string
			title: string
			chart:
				| "spark"
				| "bars"
				| "stacked"
				| "waterfall"
				| "firewall"
				| "split"
				| "ring"
			stat: string
			caption: string
	  }
	| {
			id: string
			kind: "file-artifact"
			tone: CatalogTone
			ext: "XLSX" | "PPTX" | "PDF" | "CSV" | "DOCX" | "MD" | "SVG"
			name: string
			meta: string
			preview: "sheet" | "slides" | "doc" | "csv"
			rows: readonly (readonly string[])[]
			foot: string
	  }
	| {
			id: string
			kind: "workflow"
			tone: CatalogTone
			badge: string
			brandIcon?: string
			title: string
			timing: string
			steps: readonly { n: string; label: string; meta: string }[]
	  }
	| {
			id: string
			kind: "integration"
			tone: CatalogTone
			icons: readonly string[]
			kicker: string
			title: string
			pills: readonly string[]
			foot: string
	  }
	| {
			id: string
			kind: "mascot-card"
			tone: CatalogTone
			mascotId: "laddu" | "jalebi" | "kaju" | "jamun" | "rasgulla"
			label: string
			tagline: string
			accentHex: string
	  }
	| {
			id: string
			kind: "checklist"
			tone: CatalogTone
			badge: string
			brandIcon?: string
			title: string
			items: readonly string[]
	  }

export const CATALOG_CARDS: readonly CatalogCardSpec[] = [
	/* ------------------------------------------
	   1. SLACK MINI THREADS (10 cards)
	   ------------------------------------------ */
	{
		id: "sm-review",
		kind: "slack-mini",
		tone: "slate",
		channel: "#eng",
		user: "Rohan",
		init: "R",
		ask: "review PR #512 for race conditions before merge",
		reply: "Found an unguarded cache write on line 84 and posted inline review comments on Azure Repos.",
		reactions: ["👀 2", "✅ 3"],
	},
	{
		id: "sm-ops",
		kind: "slack-mini",
		tone: "crimson",
		channel: "#ops",
		user: "Neha",
		init: "N",
		ask: "summarize the last 40 messages into an incident timeline",
		reply: "Built a 6-step UTC timeline from the alert spike at 09:12 through rollback at 09:29.",
		attachment: { ext: "MD", name: "incident-timeline.md" },
		reactions: ["🙌 4"],
	},
	{
		id: "sm-csv",
		kind: "slack-mini",
		tone: "emerald",
		channel: "#finance",
		user: "Asha",
		init: "A",
		ask: "clean this messy invoice CSV and group spend by vendor",
		reply: "Deduplicated 14 rows, normalized currency formatting, and uploaded the pivoted workbook.",
		attachment: { ext: "XLSX", name: "vendor-spend-q4.xlsx" },
		reactions: ["💚 3", "📊 2"],
	},
	{
		id: "sm-design",
		kind: "slack-mini",
		tone: "plum",
		channel: "#design",
		user: "Kabir",
		init: "K",
		ask: "open staging on mobile width and grab screenshots of checkout",
		reply: "Opened staging in Chromium inside your container at 390×844 and uploaded 3 viewport captures.",
		attachment: { ext: "PNG", name: "checkout-mobile.png" },
		reactions: ["✨ 2"],
	},
	{
		id: "sm-deck",
		kind: "slack-mini",
		tone: "amber",
		channel: "#product",
		user: "Sana",
		init: "S",
		ask: "turn our Q4 roadmap doc into a clean 6-slide leadership deck",
		reply: "Drafted 6 slides with milestones, owners, and risks—ready to present or edit in PowerPoint.",
		attachment: { ext: "PPTX", name: "q4-roadmap-deck.pptx" },
		reactions: ["🔥 3"],
	},
	{
		id: "sm-triage",
		kind: "slack-mini",
		tone: "cyan",
		channel: "#support",
		user: "Vikram",
		init: "V",
		ask: "check if this webhook timeout matches last month's bug",
		reply: "Searched past Slack threads—same retry header bug from Oct 14. Linked the fix PR below.",
		reactions: ["⚡ 2", "✅ 2"],
	},
	{
		id: "sm-standup",
		kind: "slack-mini",
		tone: "violet",
		channel: "DM",
		user: "You",
		init: "Y",
		ask: "every weekday at 8:45 AM list my open Azure DevOps PRs",
		reply: "Scheduled a personal recurring reminder for Mon–Fri at 8:45 AM in this DM.",
		reactions: ["⏰ 1"],
	},
	{
		id: "sm-docker",
		kind: "slack-mini",
		tone: "blue",
		channel: "#infra",
		user: "Dev",
		init: "D",
		ask: "why did our worker image jump from 180 MB to 640 MB?",
		reply: "DevDependencies leaked past the build stage. Opened a PR trimming the multi-stage copy.",
		attachment: { ext: "PR", name: "PR #604 · slim-worker" },
		reactions: ["🚀 3"],
	},
	{
		id: "sm-pdf",
		kind: "slack-mini",
		tone: "espresso",
		channel: "#legal",
		user: "Meera",
		init: "M",
		ask: "pull the renewal dates and notice windows from these 3 PDFs",
		reply: "Extracted all 3 contract clauses into a side-by-side table and flagged one 60-day auto-renew.",
		attachment: { ext: "PDF", name: "renewal-summary.pdf" },
		reactions: ["🙏 3"],
	},
	{
		id: "sm-onboard",
		kind: "slack-mini",
		tone: "pine",
		channel: "#team",
		user: "Arjun",
		init: "A",
		ask: "DM @tara with the staging login checklist once CI turns green",
		reply: "Watched the build, confirmed all checks passed, and sent @tara the checklist in DM.",
		reactions: ["✅ 2"],
	},

	/* ------------------------------------------
	   2. HIGH-CONTRAST EDITORIAL POSTERS (9 cards)
	   ------------------------------------------ */
	{
		id: "p-onebox",
		kind: "poster",
		tone: "cobalt",
		tag: "INFRASTRUCTURE",
		word: "1 BOX",
		copy: "Runs on a single Linux VM with systemd. No Kubernetes cluster required.",
		icon: "server",
		brandIcon: "/icons/linux.svg",
	},
	{
		id: "p-noseats",
		kind: "poster",
		tone: "bone",
		tag: "ZERO SEAT TAX",
		word: "$0",
		copy: "laddu never charges per seat. Every teammate uses their own AI provider.",
		icon: "bolt",
		brandIcon: "/icons/osi.svg",
	},
	{
		id: "p-isolated",
		kind: "poster",
		tone: "forest",
		tag: "SANDBOXING",
		word: "1 : 1",
		copy: "One private Docker container per person—files and logins never mix.",
		icon: "shield",
		brandIcon: "/icons/docker.svg",
	},
	{
		id: "p-nolan",
		kind: "poster",
		tone: "burgundy",
		tag: "NETWORK EGRESS",
		word: "NO LAN",
		copy: "Containers reach the public web only. Your host and internal network stay blocked.",
		icon: "lock",
	},
	{
		id: "p-ownkey",
		kind: "poster",
		tone: "sand",
		tag: "CREDENTIALS",
		word: "YOURS",
		copy: "Your ChatGPT, Claude, Antigravity, or OpenCode login stays inside your container.",
		icon: "key",
	},
	{
		id: "p-inslack",
		kind: "poster",
		tone: "terracotta",
		tag: "ZERO NEW APPS",
		word: "@TAG",
		copy: "Lives in channels, threads, DMs, and App Home where your team already works.",
		icon: "slack",
		brandIcon: "/icons/slack.svg",
	},
	{
		id: "p-realos",
		kind: "poster",
		tone: "mint",
		tag: "REAL COMPUTER",
		word: "FULL OS",
		copy: "Linux shell, Chromium browser, desktop GUI, and persistent workspace disk.",
		icon: "cpu",
		brandIcon: "/icons/chromium.svg",
	},
	{
		id: "p-reboot",
		kind: "poster",
		tone: "graphite",
		tag: "RELIABILITY",
		word: "24 / 7",
		copy: "Managed by systemd user services. Recovers automatically after server reboots.",
		icon: "globe",
		brandIcon: "/icons/linux.svg",
	},
	{
		id: "p-source",
		kind: "poster",
		tone: "saffron",
		tag: "OPEN SOURCE",
		word: "AUDIT",
		copy: "Every line of the installer, runtime, and sandbox config is public on GitHub.",
		icon: "code",
		brandIcon: "/icons/github.svg",
	},

	/* ------------------------------------------
	   3. CLI / TERMINAL CARDS (9 cards)
	   ------------------------------------------ */
	{
		id: "t-docker",
		kind: "terminal",
		tone: "pine",
		host: "docker ps",
		badge: "Isolated",
		brandIcon: "/icons/docker.svg",
		lines: [
			{ kind: "dim", text: "CONTAINER         STATUS       NETWORK" },
			{
				kind: "ok",
				text: "laddu-u-you       Up 6 days    internet-only",
			},
			{
				kind: "ok",
				text: "laddu-u-priya     Up 4 days    internet-only",
			},
			{
				kind: "ok",
				text: "laddu-u-dev       Up 2 days    internet-only",
			},
		],
	},
	{
		id: "t-logs",
		kind: "terminal",
		tone: "slate",
		host: "journalctl",
		badge: "Live logs",
		brandIcon: "/icons/linux.svg",
		lines: [
			{ kind: "dim", text: "10:14:02  socket connected to Slack" },
			{ kind: "ok", text: "10:14:08  routed @laddu mention → u-you" },
			{
				kind: "accent",
				text: "10:14:16  uploaded q4-tracker.xlsx (48 KB)",
			},
		],
		copyText: "journalctl --user -u laddu -f",
	},
	{
		id: "t-restart",
		kind: "terminal",
		tone: "emerald",
		host: "systemd",
		badge: "Zero-hassle",
		brandIcon: "/icons/linux.svg",
		lines: [
			{ kind: "cmd", text: "$ systemctl --user restart laddu" },
			{ kind: "ok", text: "✓ Bot reconnected in 1.1s" },
			{ kind: "dim", text: "  Active user containers preserved" },
		],
		copyText: "systemctl --user restart laddu",
	},
	{
		id: "t-bun",
		kind: "terminal",
		tone: "amber",
		host: "bun test",
		badge: "Inside sandbox",
		brandIcon: "/icons/bun.svg",
		lines: [
			{ kind: "cmd", text: "$ bun test packages/billing" },
			{ kind: "ok", text: "✓ 24 pass  0 fail  [312ms]" },
			{ kind: "accent", text: "→ Ready to open PR on Azure Repos" },
		],
	},
	{
		id: "t-git",
		kind: "terminal",
		tone: "blue",
		host: "git push",
		badge: "Your identity",
		brandIcon: "/icons/git.svg",
		lines: [
			{ kind: "cmd", text: "$ git push -u origin fix/oauth-refresh" },
			{ kind: "dim", text: "Enumerating objects: 9, done." },
			{ kind: "ok", text: "remote: Pull Request #429 created" },
		],
	},
	{
		id: "t-install-check",
		kind: "terminal",
		tone: "cyan",
		host: "install.sh",
		badge: "Preflight",
		brandIcon: "/icons/linux.svg",
		lines: [
			{ kind: "ok", text: "✓ Ubuntu 24.04 + systemd detected" },
			{ kind: "ok", text: "✓ Docker & Bun installed automatically" },
			{ kind: "ok", text: "✓ Slack app manifest provisioned" },
		],
		copyText: "curl -fsSL https://laddu.wtf/install.sh | sh",
	},
	{
		id: "t-volumes",
		kind: "terminal",
		tone: "plum",
		host: "docker volume ls",
		badge: "Persistent",
		brandIcon: "/icons/docker.svg",
		lines: [
			{ kind: "dim", text: "DRIVER   VOLUME NAME" },
			{ kind: "ok", text: "local    laddu_home_you" },
			{ kind: "ok", text: "local    laddu_home_maya" },
			{ kind: "ok", text: "local    laddu_home_dev" },
		],
	},
	{
		id: "t-firewall",
		kind: "terminal",
		tone: "crimson",
		host: "egress check",
		badge: "Verified",
		lines: [
			{ kind: "cmd", text: "$ curl -m 2 http://169.254.169.254" },
			{ kind: "accent", text: "✗ Blocked: metadata & LAN unreachable" },
			{ kind: "ok", text: "✓ Public HTTPS egress reachable" },
		],
	},
	{
		id: "t-cron",
		kind: "terminal",
		tone: "espresso",
		host: "schedules",
		badge: "Recurring",
		lines: [
			{ kind: "dim", text: "CRON           TARGET        TASK" },
			{ kind: "ok", text: "0 9 * * 1      #product      Weekly digest" },
			{ kind: "ok", text: "30 17 * * 5    DM @you       PR wrap-up" },
		],
	},

	/* ------------------------------------------
	   4. CODE DIFF & PR SNIPPETS (7 cards)
	   ------------------------------------------ */
	{
		id: "d-sql",
		kind: "diff",
		tone: "blue",
		title: "perf(db): add composite index on invoices",
		repo: "azure-repos · billing-api",
		brandIcon: "/icons/azure.svg",
		add: "+12",
		del: "-2",
		lines: [
			{ kind: "ctx", ln: "18", code: "CREATE INDEX CONCURRENTLY" },
			{
				kind: "del",
				ln: "19",
				code: "-  idx_inv_org ON invoices(org_id);",
			},
			{
				kind: "add",
				ln: "19",
				code: "+  idx_inv_org_due ON invoices(org_id, due_at);",
			},
			{
				kind: "ctx",
				ln: "20",
				code: "-- cuts monthly export from 4.2s → 48ms",
			},
		],
		footer: "Opened as @you · Migration tested locally",
	},
	{
		id: "d-oauth",
		kind: "diff",
		tone: "emerald",
		title: "fix(auth): refresh expiring Graph tokens",
		repo: "aws-codecommit · m365-sync",
		brandIcon: "/icons/aws.svg",
		add: "+19",
		del: "-7",
		lines: [
			{ kind: "ctx", ln: "44", code: "const skewMs = 60_000" },
			{
				kind: "del",
				ln: "45",
				code: "-if (token.expiresAt < Date.now()) {",
			},
			{
				kind: "add",
				ln: "45",
				code: "+if (token.expiresAt - skewMs <= Date.now()) {",
			},
			{
				kind: "add",
				ln: "46",
				code: "+  return refreshDelegatedToken(userId)",
			},
		],
		footer: "Unit tests green · Awaiting reviewer",
	},
	{
		id: "d-csv",
		kind: "diff",
		tone: "amber",
		title: "fix(export): escape embedded quotes in CSV",
		repo: "azure-repos · reporting",
		brandIcon: "/icons/azure.svg",
		add: "+8",
		del: "-3",
		lines: [
			{
				kind: "ctx",
				ln: "91",
				code: "export function csvCell(v: string) {",
			},
			{ kind: "del", ln: "92", code: '-  return `"${v}"`' },
			{
				kind: "add",
				ln: "92",
				code: '+  return `"${v.replaceAll(\'"\', \'""\')}"`',
			},
			{ kind: "ctx", ln: "93", code: "}" },
		],
		footer: "Repro fixture added · 11 tests passing",
	},
	{
		id: "d-docker",
		kind: "diff",
		tone: "cyan",
		title: "chore(docker): cache bun install layer",
		repo: "aws-codecommit · worker",
		brandIcon: "/icons/docker.svg",
		add: "+6",
		del: "-4",
		lines: [
			{ kind: "del", ln: "11", code: "-COPY . ." },
			{ kind: "add", ln: "11", code: "+COPY package.json bun.lock ./" },
			{
				kind: "add",
				ln: "12",
				code: "+RUN bun install --frozen-lockfile",
			},
			{ kind: "add", ln: "13", code: "+COPY . ." },
		],
		footer: "Build time cut 3× · Verified in container",
	},
	{
		id: "d-ts",
		kind: "diff",
		tone: "violet",
		title: "refactor(api): tighten webhook payload schema",
		repo: "azure-repos · core-api",
		brandIcon: "/icons/azure.svg",
		add: "+14",
		del: "-9",
		lines: [
			{ kind: "ctx", ln: "27", code: "type EventKind =" },
			{ kind: "del", ln: "28", code: "-  | string" },
			{
				kind: "add",
				ln: "28",
				code: "+  | 'invoice.paid' | 'invoice.failed'",
			},
			{ kind: "ctx", ln: "29", code: "  | 'seat.updated'" },
		],
		footer: "Typecheck passes with 0 warnings",
	},
	{
		id: "d-retry",
		kind: "diff",
		tone: "crimson",
		title: "fix(queue): cap exponential backoff jitter",
		repo: "aws-codecommit · jobs",
		brandIcon: "/icons/aws.svg",
		add: "+9",
		del: "-5",
		lines: [
			{
				kind: "ctx",
				ln: "62",
				code: "export function nextDelay(attempt: number) {",
			},
			{ kind: "del", ln: "63", code: "-  return 2 ** attempt * 1000" },
			{
				kind: "add",
				ln: "63",
				code: "+  return Math.min(30_000, 2 ** attempt * 500)",
			},
			{ kind: "ctx", ln: "64", code: "}" },
		],
		footer: "PR opened on CodeCommit as @dev",
	},
	{
		id: "d-ci",
		kind: "diff",
		tone: "pine",
		title: "ci: run smoke tests on PR branches",
		repo: "azure-repos · pipelines",
		brandIcon: "/icons/azure.svg",
		add: "+11",
		del: "-1",
		lines: [
			{ kind: "ctx", ln: "14", code: "- script: bun run typecheck" },
			{ kind: "add", ln: "15", code: "+- script: bun test --bail" },
			{ kind: "add", ln: "16", code: "+  displayName: 'Run unit suite'" },
			{ kind: "ctx", ln: "17", code: "  env: { CI: 'true' }" },
		],
		footer: "Ready for merge · Signed off in #eng",
	},

	/* ------------------------------------------
	   5. INLINE SVG METRIC & DIAGRAM CARDS (7 cards)
	   ------------------------------------------ */
	{
		id: "mc-spark",
		kind: "metric-chart",
		tone: "amber",
		badge: "Chart output",
		title: "Plots CSV metrics into PNG charts",
		chart: "spark",
		stat: "p95 −38%",
		caption:
			"Generated inside your container and posted straight into the thread.",
	},
	{
		id: "mc-bars",
		kind: "metric-chart",
		tone: "emerald",
		badge: "Weekly breakdown",
		title: "Visualizes spend, traffic, or sprint data",
		chart: "bars",
		stat: "6 cohorts",
		caption:
			"Drop a spreadsheet in Slack—get clean charts without opening BI tools.",
	},
	{
		id: "mc-firewall",
		kind: "metric-chart",
		tone: "blue",
		badge: "Network boundary",
		title: "Outbound web allowed, host LAN dropped",
		chart: "firewall",
		stat: "0 LAN routes",
		caption:
			"Every teammate container sits behind strict egress isolation.",
	},
	{
		id: "mc-waterfall",
		kind: "metric-chart",
		tone: "cyan",
		badge: "Step waterfall",
		title: "Visible timings for every tool step",
		chart: "waterfall",
		stat: "4 steps",
		caption:
			"No black-box waiting—plain-language updates stream live in Slack.",
	},
	{
		id: "mc-stacked",
		kind: "metric-chart",
		tone: "plum",
		badge: "Deliverable mix",
		title: "Hands back sheets, slides, PDFs & code",
		chart: "stacked",
		stat: "6 formats",
		caption:
			"Real files ready to share with stakeholders, not just markdown walls.",
	},
	{
		id: "mc-split",
		kind: "metric-chart",
		tone: "violet",
		badge: "BYO routing",
		title: "Each teammate picks their own engine",
		chart: "split",
		stat: "4 engines",
		caption:
			"ChatGPT, Claude, Antigravity, or OpenCode—switch anytime in App Home.",
	},
	{
		id: "mc-ring",
		kind: "metric-chart",
		tone: "pine",
		badge: "Container footprint",
		title: "Idle containers stay lean on one VM",
		chart: "ring",
		stat: "1 Linux host",
		caption:
			"Built on Bun + Docker so small teams run comfortably on a single server.",
	},

	/* ------------------------------------------
	   6. FILE ARTIFACT PREVIEW CARDS (7 cards)
	   ------------------------------------------ */
	{
		id: "fa-xlsx",
		kind: "file-artifact",
		tone: "emerald",
		ext: "XLSX",
		name: "q4-headcount-plan.xlsx",
		meta: "Formulas · 3 tabs",
		preview: "sheet",
		rows: [
			["Team", "Q3", "Q4"],
			["Platform", "6", "8"],
			["Product", "4", "5"],
		],
		foot: "Built with live SUM formulas and uploaded directly to #finance.",
	},
	{
		id: "fa-pptx",
		kind: "file-artifact",
		tone: "amber",
		ext: "PPTX",
		name: "launch-readiness.pptx",
		meta: "8 slides · 16:9",
		preview: "slides",
		rows: [
			["01 · Launch Goals", "Milestones & owners"],
			["02 · Rollout Plan", "Staged channel invite"],
		],
		foot: "Generated from a 30-message Slack thread with clean slide layout.",
	},
	{
		id: "fa-pdf",
		kind: "file-artifact",
		tone: "crimson",
		ext: "PDF",
		name: "security-architecture.pdf",
		meta: "4 pages · Print-ready",
		preview: "doc",
		rows: [
			["1. Isolation Model", "Per-user Docker container"],
			["2. Credential Scope", "Zero shared API keys"],
		],
		foot: "Formatted executive PDF ready to attach for IT review.",
	},
	{
		id: "fa-csv",
		kind: "file-artifact",
		tone: "cyan",
		ext: "CSV",
		name: "cleaned-leads-nov.csv",
		meta: "1,420 rows · UTF-8",
		preview: "csv",
		rows: [
			["region,accounts,mrr_delta"],
			["apac,48,+14.2%"],
			["emea,62,+9.8%"],
		],
		foot: "Parsed, normalized, and validated inside your sandbox.",
	},
	{
		id: "fa-docx",
		kind: "file-artifact",
		tone: "blue",
		ext: "DOCX",
		name: "vendor-rfp-response.docx",
		meta: "Styled Word doc",
		preview: "doc",
		rows: [
			["Executive Summary", "Self-hosted on Linux"],
			["Data Residency", "Zero external cloud"],
		],
		foot: "Editable Word document matching your team's tone and headings.",
	},
	{
		id: "fa-md",
		kind: "file-artifact",
		tone: "plum",
		ext: "MD",
		name: "release-notes-v2.4.md",
		meta: "Changelog · Linked PRs",
		preview: "doc",
		rows: [
			["Highlights", "Faster webhook retries"],
			["Fixes", "4 PRs merged this week"],
		],
		foot: "Compiled straight from merged Azure Repos commits.",
	},
	{
		id: "fa-svg",
		kind: "file-artifact",
		tone: "violet",
		ext: "SVG",
		name: "service-topology.svg",
		meta: "Vector diagram",
		preview: "slides",
		rows: [
			["Slack → Host", "Socket Mode"],
			["Host → Sandbox", "Per-user bridge"],
		],
		foot: "Crisp vector diagram you can drop into docs or slides.",
	},

	/* ------------------------------------------
	   7. WORKFLOW / RUNBOOK CARDS (7 cards)
	   ------------------------------------------ */
	{
		id: "wf-runbook",
		kind: "workflow",
		tone: "plum",
		badge: "Self-written how-to",
		title: "Remembers repeatable playbooks",
		timing: "Saved to memory",
		steps: [
			{
				n: "01",
				label: "Learns your weekly export format",
				meta: "once",
			},
			{
				n: "02",
				label: "Saves steps as a personal runbook",
				meta: "auto",
			},
			{ n: "03", label: "Reuses it next time you ask", meta: "instant" },
		],
	},
	{
		id: "wf-2fa",
		kind: "workflow",
		tone: "amber",
		badge: "Human-in-the-loop",
		title: "Smooth 2FA & CAPTCHA handoff",
		timing: "App Home",
		steps: [
			{
				n: "01",
				label: "Browser hits SSO or MFA prompt",
				meta: "pauses",
			},
			{
				n: "02",
				label: "You take over live in Slack Home",
				meta: "click",
			},
			{ n: "03", label: "Hand back control—task resumes", meta: "done" },
		],
	},
	{
		id: "wf-ado",
		kind: "workflow",
		tone: "blue",
		badge: "Azure DevOps",
		brandIcon: "/icons/azure.svg",
		title: "Works as you in repos & boards",
		timing: "Delegated",
		steps: [
			{
				n: "01",
				label: "Reads only work items you can see",
				meta: "scoped",
			},
			{
				n: "02",
				label: "Branches, edits, and runs tests",
				meta: "sandbox",
			},
			{
				n: "03",
				label: "Opens PR under your own identity",
				meta: "tracked",
			},
		],
	},
	{
		id: "wf-m365",
		kind: "workflow",
		tone: "cyan",
		badge: "Microsoft 365",
		brandIcon: "/icons/microsoft.svg",
		title: "Drafts & lookups with your permissions",
		timing: "Per-user auth",
		steps: [
			{
				n: "01",
				label: "Checks your calendar & recent docs",
				meta: "read",
			},
			{
				n: "02",
				label: "Summarizes notes into action items",
				meta: "draft",
			},
			{
				n: "03",
				label: "Posts summary back in your thread",
				meta: "reply",
			},
		],
	},
	{
		id: "wf-recall",
		kind: "workflow",
		tone: "violet",
		badge: "Slack search",
		brandIcon: "/icons/slack.svg",
		title: "Searches past threads on demand",
		timing: "On request",
		steps: [
			{
				n: "01",
				label: "Finds prior decisions in channels",
				meta: "search",
			},
			{ n: "02", label: "Pulls exact context & links", meta: "cite" },
			{
				n: "03",
				label: "Answers without asking you to paste",
				meta: "clean",
			},
		],
	},
	{
		id: "wf-digest",
		kind: "workflow",
		tone: "emerald",
		badge: "Recurring job",
		brandIcon: "/icons/slack.svg",
		title: "Automated Monday channel digest",
		timing: "Mon 9:00 AM",
		steps: [
			{
				n: "01",
				label: "Scans merged PRs & open blockers",
				meta: "08:59",
			},
			{ n: "02", label: "Formats 5 concise bullets", meta: "09:00" },
			{ n: "03", label: "Posts digest in #product", meta: "sent" },
		],
	},
	{
		id: "wf-cc",
		kind: "workflow",
		tone: "espresso",
		badge: "AWS CodeCommit",
		brandIcon: "/icons/aws.svg",
		title: "Ships branches to CodeCommit",
		timing: "Git + PR",
		steps: [
			{
				n: "01",
				label: "Clones repo into your container",
				meta: "isolated",
			},
			{
				n: "02",
				label: "Runs tests & formats changes",
				meta: "verified",
			},
			{ n: "03", label: "Pushes branch & creates PR", meta: "ready" },
		],
	},

	/* ------------------------------------------
	   8. BRAND INTEGRATION CARDS (6 cards, local svgl.app icons)
	   ------------------------------------------ */
	{
		id: "int-openai",
		kind: "integration",
		tone: "emerald",
		icons: ["/icons/openai.svg", "/icons/slack.svg"],
		kicker: "Codex engine",
		title: "Bring your ChatGPT plan or OpenAI key",
		pills: ["Personal OAuth", "Or API key", "Stays in container"],
		foot: "Pay OpenAI directly—zero markup or middleware.",
	},
	{
		id: "int-claude",
		kind: "integration",
		tone: "amber",
		icons: ["/icons/claude.svg", "/icons/slack.svg"],
		kicker: "Claude Code engine",
		title: "Bring your Claude plan or Anthropic key",
		pills: ["Personal login", "Full CLI tools", "Switch anytime"],
		foot: "Each person signs in inside their own sandbox.",
	},
	{
		id: "int-antigravity",
		kind: "integration",
		tone: "violet",
		icons: ["/icons/antigravity.svg", "/icons/slack.svg"],
		kicker: "Antigravity engine",
		title: "Plug in Antigravity per teammate",
		pills: ["Per-user choice", "Isolated session", "Slack native"],
		foot: "Pick the engine that fits your workflow in App Home.",
	},
	{
		id: "int-opencode",
		kind: "integration",
		tone: "cyan",
		icons: ["/icons/opencode.svg", "/icons/slack.svg"],
		kicker: "OpenCode engine",
		title: "BYO models through OpenCode",
		pills: ["OpenRouter", "Local or hosted", "Zero lock-in"],
		foot: "Connect whichever model provider your team prefers.",
	},
	{
		id: "int-azure",
		kind: "integration",
		tone: "blue",
		icons: ["/icons/azure.svg", "/icons/microsoft.svg"],
		kicker: "Microsoft ecosystem",
		title: "Azure Repos, Boards & Microsoft 365",
		pills: ["Acts as you", "Least privilege", "Pull requests"],
		foot: "Never sees a single repo or file outside your permissions.",
	},
	{
		id: "int-stack",
		kind: "integration",
		tone: "pine",
		icons: ["/icons/bun.svg", "/icons/docker.svg", "/icons/aws.svg"],
		kicker: "Lean self-hosted stack",
		title: "Bun + Docker + AWS CodeCommit",
		pills: ["Fast startup", "systemd service", "1 Linux box"],
		foot: "Installer sets up Docker and Bun if your server doesn't have them.",
	},

	/* ------------------------------------------
	   9. MASCOT IDENTITY CARDS (5 cards — interactive switcher!)
	   ------------------------------------------ */
	{
		id: "m-laddu",
		kind: "mascot-card",
		tone: "amber",
		mascotId: "laddu",
		label: "@laddu",
		tagline: "Default handle & avatar—rename anytime for your workspace.",
		accentHex: "#f47654",
	},
	{
		id: "m-jalebi",
		kind: "mascot-card",
		tone: "crimson",
		mascotId: "jalebi",
		label: "@jalebi",
		tagline: "Pick a custom bot name and icon during Slack setup.",
		accentHex: "#fb7185",
	},
	{
		id: "m-kaju",
		kind: "mascot-card",
		tone: "slate",
		mascotId: "kaju",
		label: "@kaju",
		tagline: "Swap the avatar in one click to preview it across the site.",
		accentHex: "#cbd5e1",
	},
	{
		id: "m-jamun",
		kind: "mascot-card",
		tone: "espresso",
		mascotId: "jamun",
		label: "@jamun",
		tagline:
			"Match your team's vibe with built-in icons or your own image.",
		accentHex: "#d97706",
	},
	{
		id: "m-rasgulla",
		kind: "mascot-card",
		tone: "mint",
		mascotId: "rasgulla",
		label: "@rasgulla",
		tagline: "Clean, recognizable presence in every channel and thread.",
		accentHex: "#4cc38a",
	},

	/* ------------------------------------------
	   10. ADMIN & SECURITY CHECKLIST CARDS (5 cards)
	   ------------------------------------------ */
	{
		id: "ck-admin",
		kind: "checklist",
		tone: "pine",
		badge: "Admin setup",
		brandIcon: "/icons/bun.svg",
		title: "Up and running in one command",
		items: [
			"Installs Bun & Docker if missing",
			"Creates Slack app & systemd service",
			"DMs you privately first for safe testing",
		],
	},
	{
		id: "ck-security",
		kind: "checklist",
		tone: "blue",
		badge: "Security model",
		brandIcon: "/icons/docker.svg",
		title: "Built for real IT scrutiny",
		items: [
			"One isolated Docker container per user",
			"Host filesystem & internal LAN blocked",
			"No telemetry, no external vendor cloud",
		],
	},
	{
		id: "ck-creds",
		kind: "checklist",
		tone: "violet",
		badge: "Zero shared keys",
		title: "Private credential boundaries",
		items: [
			"Each teammate logs in to their own AI",
			"Tokens stay inside that user's container",
			"Admins never need a giant pooled API bill",
		],
	},
	{
		id: "ck-teammate",
		kind: "checklist",
		tone: "amber",
		badge: "For teammates",
		brandIcon: "/icons/slack.svg",
		title: "Zero learning curve in Slack",
		items: [
			"Tag @laddu in any channel, thread, or DM",
			"Watch live plain-language progress steps",
			"Open App Home to view desktop or switch AI",
		],
	},
	{
		id: "ck-linux",
		kind: "checklist",
		tone: "slate",
		badge: "Host requirements",
		brandIcon: "/icons/linux.svg",
		title: "Runs on any standard Linux box",
		items: [
			"Ubuntu, Debian, Fedora, Arch, or RHEL",
			"Any VM with systemd & outbound HTTPS",
			"Zero open inbound ports required (Socket Mode)",
		],
	},
] as const

export const CATALOG_MAP: ReadonlyMap<string, CatalogCardSpec> = new Map(
	CATALOG_CARDS.map(card => [card.id, card]),
)
