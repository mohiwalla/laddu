import { Button } from "@ui-sdk/react/button"
import {
	Collapsible,
	CollapsiblePanel,
	CollapsibleTrigger,
} from "@ui-sdk/react/collapsible"
import { Toggle, ToggleGroup } from "@ui-sdk/react/toggle"
import { memo, useEffect, useRef } from "react"
import { TextMorph } from "torph/react"
import {
	EXTRA_HANDCRAFTED_IDS,
	INSTALL_COMMAND,
	MASCOTS,
	SCENARIOS,
	type CardId,
	type ExtraHandcraftedId,
	type Mascot,
} from "../data/showcase"
import { CopyButton } from "./CopyButton"
import { CatalogShowcaseCard } from "./ShowcaseCardsCatalog"
import { ExtraShowcaseCard } from "./ShowcaseCardsMore"

const EXTRA_SET = new Set<string>(EXTRA_HANDCRAFTED_IDS)

export interface CardProps {
	id: CardId
	mascot: Mascot
	promptIdx: number
	showTrace: boolean
	takenOver: boolean
	reminderPaused: boolean
	activeModel: string
	stoppedMine: boolean
	teamInvited: boolean
	onCyclePrompt: () => void
	onShowTraceChange: (open: boolean) => void
	onTakenOverChange: (pressed: boolean) => void
	onReminderPausedChange: (pressed: boolean) => void
	onStoppedMineChange: (pressed: boolean) => void
	onTeamInvitedChange: (pressed: boolean) => void
	onSelectModel: (model: string) => void
	onSelectMascot: (id: string) => void
	onOpenInstall: () => void
	onCopySuccess: (text: string) => void
}

const MODELS = [
	{
		id: "chatgpt",
		name: "ChatGPT",
		sub: "Codex · Plan or API key",
		tag: "BYO",
		icon: "/icons/openai.svg",
	},
	{
		id: "claude",
		name: "Claude",
		sub: "Claude Code · Plan or key",
		tag: "BYO",
		icon: "/icons/claude.svg",
	},
	{
		id: "antigravity",
		name: "Antigravity",
		sub: "Google Antigravity agent",
		tag: "BYO",
		icon: "/icons/antigravity.svg",
	},
	{
		id: "opencode",
		name: "OpenCode",
		sub: "Bring your own models",
		tag: "BYO",
		icon: "/icons/opencode.svg",
	},
] as const

export const ShowcaseCard = memo(function ShowcaseCard({
	id,
	mascot,
	promptIdx,
	showTrace,
	takenOver,
	reminderPaused,
	activeModel,
	stoppedMine,
	teamInvited,
	onCyclePrompt,
	onShowTraceChange,
	onTakenOverChange,
	onReminderPausedChange,
	onStoppedMineChange,
	onTeamInvitedChange,
	onSelectModel,
	onSelectMascot,
	onOpenInstall,
	onCopySuccess,
}: CardProps) {
	const slackBodyRef = useRef<HTMLDivElement>(null)
	const prevPromptRef = useRef(promptIdx)

	useEffect(() => {
		if (id !== "slack" || prevPromptRef.current === promptIdx) return
		prevPromptRef.current = promptIdx
		const el = slackBodyRef.current
		if (
			!el ||
			window.matchMedia("(prefers-reduced-motion: reduce)").matches
		)
			return
		el.animate(
			[
				{
					opacity: 0.35,
					filter: "blur(2px)",
					transform: "translateX(10px)",
				},
				{ opacity: 1, filter: "blur(0px)", transform: "none" },
			],
			{ duration: 220, easing: "cubic-bezier(0.23, 1, 0.32, 1)" },
		)
	}, [id, promptIdx])

	const bot = mascot.name

	switch (id) {
		/* 1. SLACK THREAD (540x404, Aubergine-tinted Slack window) */
		case "slack": {
			const s = SCENARIOS[promptIdx] ?? SCENARIOS[0]!
			return (
				<div className="tile-inner card-slack">
					<div className="slack-chrome">
						<div className="slack-chrome-l">
							<span className="win-dots" aria-hidden="true">
								<i />
								<i />
								<i />
							</span>
							<span className="slack-chan-pill">
								<img
									src="/icons/slack.svg"
									alt=""
									width={14}
									height={14}
									className="brand-ico"
								/>
								<TextMorph as="span" duration={300}>
									{`#${s.channel}`}
								</TextMorph>
							</span>
						</div>
						<div className="tile-actions">
							<TextMorph
								as="span"
								className="tile-note"
								duration={300}
							>
								{s.caption}
							</TextMorph>
							<Button
								className="tile-pill"
								onClick={e => {
									e.stopPropagation()
									onCyclePrompt()
								}}
							>
								<svg
									className="ico ico-xs"
									viewBox="0 0 24 24"
									aria-hidden="true"
								>
									<path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
									<path d="M3 3v5h5M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
									<path d="M16 16h5v5" />
								</svg>
								<span>Next</span>
							</Button>
						</div>
					</div>

					<div className="card-body" ref={slackBodyRef}>
						<div className="s-msg">
							<div className="s-av" aria-hidden="true">
								{s.init}
							</div>
							<div>
								<div className="s-head">
									<TextMorph
										as="span"
										className="s-name"
										duration={300}
									>
										{s.user}
									</TextMorph>
									<TextMorph
										as="span"
										className="s-time"
										duration={300}
									>
										{s.time}
									</TextMorph>
								</div>
								<div className="s-text">
									{s.askBefore}
									<TextMorph
										as="span"
										className="mention"
										duration={340}
									>
										{`@${bot}`}
									</TextMorph>
									{s.askAfter}
								</div>
							</div>
						</div>

						<div className="s-msg">
							<div className="s-av bot">
								<img
									src={mascot.thumb}
									alt={bot}
									width={28}
									height={28}
								/>
							</div>
							<div>
								<div className="s-head">
									<TextMorph
										as="span"
										className="s-name"
										duration={340}
									>
										{bot}
									</TextMorph>
									<span className="s-badge">APP</span>
									<TextMorph
										as="span"
										className="s-time"
										duration={300}
									>
										{s.time}
									</TextMorph>
								</div>

								<Collapsible
									open={showTrace}
									onOpenChange={open =>
										onShowTraceChange(open)
									}
								>
									<CollapsibleTrigger className="s-status">
										<span className="s-status-l">
											<svg
												className="ico ico-xs"
												viewBox="0 0 24 24"
												aria-hidden="true"
												style={{
													color: "var(--positive)",
												}}
											>
												<path d="M20 6 9 17l-5-5" />
											</svg>
											<TextMorph as="span" duration={320}>
												{`${bot} ${s.stepSuffix}`}
											</TextMorph>
										</span>
										<span className="s-step-chev">
											<TextMorph as="span" duration={260}>
												{showTrace ? "Hide" : "Steps"}
											</TextMorph>
											<svg
												className="ico ico-xs"
												viewBox="0 0 24 24"
												aria-hidden="true"
											>
												<path d="m6 9 6 6 6-6" />
											</svg>
										</span>
									</CollapsibleTrigger>
									<CollapsiblePanel className="trace-panel">
										<div className="s-trace">
											{s.trace.map(([label, dur]) => (
												<div
													className="s-trace-row"
													key={label}
												>
													<span>{label}</span>
													<span>{dur}</span>
												</div>
											))}
										</div>
									</CollapsiblePanel>
								</Collapsible>

								<div
									className="s-text"
									style={{ marginTop: 8 }}
								>
									{s.reply}
								</div>
								<ul className="s-list">
									{s.bullets.map(([lead, body]) => (
										<li key={lead}>
											<strong>{lead}</strong> {body}
										</li>
									))}
								</ul>

								{s.file && (
									<div className="s-file">
										<span className="s-file-l">
											<svg
												className="ico ico-xs"
												viewBox="0 0 24 24"
												aria-hidden="true"
												style={{
													color: "var(--accent-bright)",
												}}
											>
												<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
												<path d="M14 2v4a2 2 0 0 0 2 2h4" />
											</svg>
											<span className="s-file-name">
												{s.file.name}
											</span>
										</span>
										<span className="s-file-meta">
											{s.file.meta}
										</span>
									</div>
								)}

								<div className="s-reacts">
									{s.reactions.map(r => (
										<span className="s-react" key={r.emoji}>
											<span>{r.emoji}</span>
											<span className="tabular">
												{r.count}
											</span>
										</span>
									))}
								</div>
							</div>
						</div>
					</div>
				</div>
			)
		}

		/* 2. TERMINAL INSTALL (472x288, Deep Obsidian Shell) */
		case "install":
			return (
				<div className="tile-inner card-terminal">
					<div className="term-bar">
						<div className="term-bar-l">
							<span className="win-dots" aria-hidden="true">
								<i />
								<i />
								<i />
							</span>
							<span className="term-host">
								<svg
									className="ico ico-xs"
									viewBox="0 0 24 24"
									aria-hidden="true"
								>
									<path d="m4 17 6-6-6-6M12 19h8" />
								</svg>
								<span>ubuntu@prod-box</span>
							</span>
						</div>
						<Button
							className="tile-pill"
							onClick={e => {
								e.stopPropagation()
								onOpenInstall()
							}}
						>
							Details
						</Button>
					</div>

					<div className="card-body">
						<div className="cmd-pill">
							<code className="cmd-str">
								<span className="cmd-p" aria-hidden="true">
									$
								</span>
								{INSTALL_COMMAND}
							</code>
							<CopyButton
								text={INSTALL_COMMAND}
								onCopied={onCopySuccess}
							/>
						</div>

						<div className="term-steps">
							<div className="term-step">
								<span className="term-dot ok" />
								<span>
									Installs Docker &amp; Bun if missing
								</span>
								<span
									className="term-badges"
									aria-hidden="true"
								>
									<img
										src="/icons/docker.svg"
										alt=""
										width={14}
										height={14}
									/>
									<img
										src="/icons/bun.svg"
										alt=""
										width={14}
										height={14}
									/>
								</span>
							</div>
							<div className="term-step">
								<span className="term-dot ok" />
								<span>
									Creates your Slack app &amp; signs you in
								</span>
							</div>
							<div className="term-step">
								<span className="term-dot ok" />
								<span>
									Boots systemd service &amp; DMs you first
								</span>
							</div>
						</div>
					</div>
				</div>
			)

		/* 3. ISOLATION TOPOLOGY (368x484, Tall Slate Blueprint with SVG network diagram) */
		case "isolation":
			return (
				<div className="tile-inner card-blueprint">
					<div className="bp-top">
						<span className="bp-kicker">
							<img
								src="/icons/docker.svg"
								alt=""
								width={15}
								height={15}
								className="brand-ico"
							/>
							<span>Sandboxed per person</span>
						</span>
						<span className="bp-pill tabular">
							1 container / user
						</span>
					</div>

					<h3 className="bp-title">
						Private computers. Zero cross-access.
					</h3>

					{/* Bespoke SVG network isolation diagram with crisp 14px box spacing */}
					<div className="bp-diagram" aria-hidden="true">
						<svg viewBox="0 0 344 268" className="bp-svg">
							{/* Internet cloud node */}
							<rect
								x="104"
								y="6"
								width="136"
								height="34"
								rx="17"
								fill="#172231"
								stroke="rgba(120, 175, 255, 0.35)"
							/>
							<text
								x="172"
								y="27"
								textAnchor="middle"
								fill="#93c5fd"
								fontSize="11"
								fontWeight="600"
								fontFamily="var(--mono)"
							>
								INTERNET ONLY
							</text>

							{/* Animated egress lines */}
							<path
								d="M54 94 C54 58, 134 62, 144 40"
								fill="none"
								stroke="rgba(76, 195, 138, 0.55)"
								strokeWidth="1.5"
								strokeDasharray="4 4"
								className="bp-flow"
							/>
							<path
								d="M172 94 L172 40"
								fill="none"
								stroke="rgba(76, 195, 138, 0.55)"
								strokeWidth="1.5"
								strokeDasharray="4 4"
								className="bp-flow"
							/>
							<path
								d="M290 94 C290 58, 210 62, 200 40"
								fill="none"
								stroke="rgba(76, 195, 138, 0.55)"
								strokeWidth="1.5"
								strokeDasharray="4 4"
								className="bp-flow"
							/>

							{/* Three clearly separated containers (14px gutters) */}
							{[
								{ x: 4, label: "@you", sub: "Desktop" },
								{ x: 122, label: "@priya", sub: "Browser" },
								{ x: 240, label: "@dev", sub: "Workspace" },
							].map(box => (
								<g key={box.label}>
									<rect
										x={box.x}
										y="94"
										width="100"
										height="80"
										rx="12"
										fill="#141b26"
										stroke="rgba(255,255,255,0.12)"
									/>
									<circle
										cx={box.x + 15}
										cy="114"
										r="3.5"
										fill="#4cc38a"
									/>
									<text
										x={box.x + 25}
										y="118"
										fill="#ededed"
										fontSize="11.5"
										fontWeight="600"
										fontFamily="var(--sans)"
									>
										{box.label}
									</text>
									<text
										x={box.x + 12}
										y="141"
										fill="#8da2be"
										fontSize="10"
										fontFamily="var(--mono)"
									>
										{box.sub}
									</text>
									<text
										x={box.x + 12}
										y="158"
										fill="#64748b"
										fontSize="9.5"
										fontFamily="var(--mono)"
									>
										Own AI login
									</text>
								</g>
							))}

							{/* Firewall line */}
							<line
								x1="4"
								y1="198"
								x2="340"
								y2="198"
								stroke="rgba(244, 118, 84, 0.55)"
								strokeWidth="1.5"
								strokeDasharray="5 5"
							/>
							<rect
								x="42"
								y="216"
								width="260"
								height="38"
								rx="10"
								fill="rgba(211, 79, 37, 0.1)"
								stroke="rgba(244, 118, 84, 0.35)"
							/>
							<text
								x="172"
								y="239"
								textAnchor="middle"
								fill="#f6b394"
								fontSize="11"
								fontWeight="600"
								fontFamily="var(--mono)"
							>
								HOST &amp; INTERNAL LAN · BLOCKED
							</text>
						</svg>
					</div>

					<p className="bp-foot">
						Credentials stay inside each person’s own container.
					</p>
				</div>
			)

		/* 4. LIVE DESKTOP TAKEOVER (472x380, Mini Browser + Animated Cursor) */
		case "takeover":
			return (
				<div
					className="tile-inner card-desktop"
					data-user-control={takenOver ? "true" : "false"}
				>
					<div className="desk-top">
						<div className="desk-top-l">
							<svg
								className="ico ico-xs"
								viewBox="0 0 24 24"
								aria-hidden="true"
								style={{
									color: takenOver
										? "var(--accent-bright)"
										: "var(--positive)",
								}}
							>
								<rect
									width="20"
									height="14"
									x="2"
									y="3"
									rx="2"
								/>
								<path d="M8 21h8M12 17v4" />
							</svg>
							<span className="tile-title">
								Slack Home · Live desktop
							</span>
						</div>
						<span
							className="desk-status"
							data-user={takenOver ? "true" : "false"}
						>
							<span className="desk-dot" />
							<TextMorph as="span" duration={300}>
								{takenOver ? "You driving" : `${bot} driving`}
							</TextMorph>
						</span>
					</div>

					<div
						className="desk-viewport"
						data-paused={takenOver ? "true" : "false"}
					>
						<div className="desk-urlbar">
							<span className="win-dots sm" aria-hidden="true">
								<i />
								<i />
								<i />
							</span>
							<span className="desk-url">
								<svg
									className="ico ico-xs"
									viewBox="0 0 24 24"
									aria-hidden="true"
								>
									<rect
										width="18"
										height="11"
										x="3"
										y="11"
										rx="2"
									/>
									<path d="M7 11V7a5 5 0 0 1 10 0v4" />
								</svg>
								<span>portal.internal.app/approvals</span>
							</span>
						</div>

						<div className="desk-canvas">
							<div className="desk-skeleton">
								<div className="desk-row-bar w60" />
								<div className="desk-row-bar w90" />
								<div className="desk-row-bar w45" />
							</div>
							<div className="desk-action-row">
								<span className="desk-fake-btn">
									Export CSV
								</span>
								<span className="desk-fake-btn primary">
									Approve #418
								</span>
							</div>

							{/* Animated agent cursor */}
							<div className="desk-cursor" aria-hidden="true">
								<svg viewBox="0 0 24 24" width="18" height="18">
									<path
										d="M5 3l14 9-6.5 1.5L10 20 5 3Z"
										fill={takenOver ? "#f47654" : "#ededed"}
										stroke="#111111"
										strokeWidth="1.5"
									/>
								</svg>
								<TextMorph
									as="span"
									className="desk-cursor-tag"
									duration={300}
								>
									{takenOver ? "you" : bot}
								</TextMorph>
							</div>
						</div>
					</div>

					<div className="desk-foot">
						<TextMorph as="p" className="desk-copy" duration={320}>
							{takenOver
								? "Paused for you—finish MFA or review, then hand back."
								: "Clicks through tools with no API. Watch or step in anytime."}
						</TextMorph>
						<Toggle
							className="take-toggle"
							pressed={takenOver}
							onPressedChange={pressed =>
								onTakenOverChange(pressed)
							}
						>
							<TextMorph as="span" duration={280}>
								{takenOver ? "Hand back" : "Take over"}
							</TextMorph>
						</Toggle>
					</div>
				</div>
			)

		/* 5. REAL FILES + LIVE SVG CHART (540x352, Warm Plum/Amber Surface) */
		case "files":
			return (
				<div className="tile-inner card-files">
					<div className="files-head">
						<div>
							<span className="files-eyebrow">
								Real deliverables
							</span>
							<h3 className="files-title">
								Hands back files, not walls of text
							</h3>
						</div>
						<span className="files-count">
							<svg
								className="ico ico-xs"
								viewBox="0 0 24 24"
								aria-hidden="true"
							>
								<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
							</svg>
							<span>In Slack</span>
						</span>
					</div>

					<div className="files-showcase">
						{/* Mini live SVG chart preview */}
						<div className="files-chart-box">
							<div className="files-chart-top">
								<span className="file-chip png">PNG</span>
								<span className="files-chart-name">
									p95-latency.png
								</span>
							</div>
							<svg
								viewBox="0 0 220 74"
								className="files-svg-chart"
								aria-hidden="true"
							>
								<defs>
									<linearGradient
										id="chartFill"
										x1="0"
										y1="0"
										x2="0"
										y2="1"
									>
										<stop
											offset="0%"
											stopColor="#f47654"
											stopOpacity="0.38"
										/>
										<stop
											offset="100%"
											stopColor="#f47654"
											stopOpacity="0"
										/>
									</linearGradient>
								</defs>
								<path
									d="M6 58 L38 52 L72 56 L108 36 L142 42 L178 20 L214 14 L214 70 L6 70 Z"
									fill="url(#chartFill)"
								/>
								<path
									d="M6 58 L38 52 L72 56 L108 36 L142 42 L178 20 L214 14"
									fill="none"
									stroke="#f47654"
									strokeWidth="2.2"
									strokeLinecap="round"
									strokeLinejoin="round"
								/>
								<circle
									cx="214"
									cy="14"
									r="3.5"
									fill="#ffd0b8"
								/>
							</svg>
						</div>

						{/* 3 distinct color-coded file chips */}
						<div className="files-stack">
							<div className="file-pill-card">
								<span className="file-chip xlsx">XLSX</span>
								<div className="file-pill-txt">
									<span className="file-name">
										q4-tracker.xlsx
									</span>
									<span className="file-sub">
										Formulas &amp; pivot table
									</span>
								</div>
							</div>
							<div className="file-pill-card">
								<span className="file-chip pptx">PPTX</span>
								<div className="file-pill-txt">
									<span className="file-name">
										ops-review.pptx
									</span>
									<span className="file-sub">
										8 slides from thread
									</span>
								</div>
							</div>
							<div className="file-pill-card">
								<span className="file-chip pdf">PDF</span>
								<div className="file-pill-txt">
									<span className="file-name">
										release-brief.pdf
									</span>
									<span className="file-sub">
										Formatted executive doc
									</span>
								</div>
							</div>
						</div>
					</div>
				</div>
			)

		/* 6. CODE DIFF & PR CARD (540x320, Midnight Git Surface) */
		case "prs":
			return (
				<div className="tile-inner card-pr">
					<div className="pr-top">
						<div className="pr-top-l">
							<span className="cat-diff-ico" aria-hidden="true">
								<img
									src="/icons/azure.svg"
									alt=""
									width={16}
									height={16}
									className="brand-ico"
								/>
							</span>
							<div>
								<div className="pr-title">
									fix(webhooks): retry backoff race
								</div>
								<div className="pr-meta">
									PR #418 · Azure Repos &amp; CodeCommit
								</div>
							</div>
						</div>
						<span className="pr-diff">
							<span className="diff-add">+42</span>
							<span className="diff-del">-19</span>
						</span>
					</div>

					<div className="diff-block" aria-label="Code diff preview">
						<div className="diff-line ctx">
							<span className="ln">41</span>
							<code>const wait = backoffMs(attempt)</code>
						</div>
						<div className="diff-line del">
							<span className="ln">42</span>
							<code>
								- await sleep(wait + Math.random() * 400)
							</code>
						</div>
						<div className="diff-line add">
							<span className="ln">42</span>
							<code>
								+ await clock.advance(wait + jitter(seed))
							</code>
						</div>
						<div className="diff-line add">
							<span className="ln">43</span>
							<code>
								+ expect(retries).toEqual([100, 200, 400])
							</code>
						</div>
					</div>

					<div className="pr-checks">
						<span className="pr-check-pill">
							<svg
								className="ico ico-xs"
								viewBox="0 0 24 24"
								aria-hidden="true"
							>
								<path d="M20 6 9 17l-5-5" />
							</svg>
							<span>18/18 tests</span>
						</span>
						<span className="pr-check-pill">
							<svg
								className="ico ico-xs"
								viewBox="0 0 24 24"
								aria-hidden="true"
							>
								<path d="M20 6 9 17l-5-5" />
							</svg>
							<span>typecheck</span>
						</span>
						<span className="pr-check-pill muted">
							Opened as @you
						</span>
					</div>
				</div>
			)

		/* 7. MODELS & ENGINES PICKER (428x416, Interactive 4-engine tiles) */
		case "models":
			return (
				<div className="tile-inner card-models">
					<div className="models-head">
						<div>
							<span className="models-eyebrow">
								Pick your engine
							</span>
							<h3 className="models-title">
								Zero vendor lock-in
							</h3>
						</div>
						<span className="models-pill">Per person</span>
					</div>

					<ToggleGroup
						className="models-grid"
						aria-label="Choose AI provider"
						value={[activeModel]}
						deselectable={false}
						onValueChange={vals => {
							const next = vals[0]
							if (next) onSelectModel(next)
						}}
					>
						{MODELS.map(m => (
							<Toggle
								className="model-tile"
								key={m.id}
								value={m.id}
							>
								<div className="model-tile-top">
									<span className="model-ico">
										<img
											src={m.icon}
											alt=""
											width={18}
											height={18}
											className="brand-ico"
										/>
									</span>
									<span className="model-tag">{m.tag}</span>
								</div>
								<div className="model-name">{m.name}</div>
								<div className="model-sub">{m.sub}</div>
							</Toggle>
						))}
					</ToggleGroup>
				</div>
			)

		/* 8. MASCOT HERO SHOWCASE (472x408, Warm Saffron Radial Spotlight + 512px Art) */
		case "skins":
			return (
				<div className="tile-inner card-skins">
					<div className="skins-stage">
						<div className="skins-glow" aria-hidden="true" />
						<img
							key={mascot.id}
							className="skins-hero-img"
							src={mascot.hero}
							alt={mascot.name}
							width={156}
							height={156}
							fetchPriority="high"
							decoding="async"
						/>
						<div className="skins-caption">
							<TextMorph
								as="span"
								className="skins-display"
								duration={360}
							>
								{`@${mascot.name}`}
							</TextMorph>
							<span className="skins-sub">
								Rename &amp; pick any avatar
							</span>
						</div>
					</div>

					<ToggleGroup
						className="skin-row"
						aria-label="Choose bot avatar"
						value={[mascot.id]}
						deselectable={false}
						onValueChange={values => {
							const next = values[0]
							if (next) onSelectMascot(next)
						}}
					>
						{MASCOTS.map(m => (
							<Toggle
								className="skin-btn"
								key={m.id}
								value={m.id}
							>
								<img
									src={m.thumb}
									alt={m.name}
									width={36}
									height={36}
								/>
								<span>{m.name}</span>
							</Toggle>
						))}
					</ToggleGroup>
				</div>
			)

		/* 9. MEMORY GRAPH (368x292, Deep Indigo Constellation) */
		case "memory":
			return (
				<div className="tile-inner card-memory">
					<div className="mem-head">
						<span className="mem-ico" aria-hidden="true">
							<svg className="ico ico-xs" viewBox="0 0 24 24">
								<circle cx="12" cy="12" r="3" />
								<circle cx="5" cy="6" r="2" />
								<circle cx="19" cy="6" r="2" />
								<circle cx="19" cy="18" r="2" />
								<path d="M6.7 7.3 9.8 10M17.3 7.3 14.2 10M14.2 14l3.1 2.7" />
							</svg>
						</span>
						<span className="tile-title">
							Memory &amp; runbooks
						</span>
					</div>

					<div className="mem-nodes">
						<div className="mem-node">
							<svg
								className="ico ico-xs"
								viewBox="0 0 24 24"
								aria-hidden="true"
							>
								<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
								<circle cx="12" cy="7" r="4" />
							</svg>
							<div className="mem-txt">
								<strong>Personal memory</strong>
								<span>
									Remembers your reply style &amp; context
								</span>
							</div>
						</div>
						<div className="mem-node">
							<svg
								className="ico ico-xs"
								viewBox="0 0 24 24"
								aria-hidden="true"
							>
								<circle cx="11" cy="11" r="8" />
								<path d="m21 21-4.3-4.3" />
							</svg>
							<div className="mem-txt">
								<strong>Thread search</strong>
								<span>
									Finds past Slack conversations on demand
								</span>
							</div>
						</div>
						<div className="mem-node">
							<svg
								className="ico ico-xs"
								viewBox="0 0 24 24"
								aria-hidden="true"
							>
								<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2zM22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
							</svg>
							<div className="mem-txt">
								<strong>Self-written how-tos</strong>
								<span>
									Saves repeatable runbooks for your tasks
								</span>
							</div>
						</div>
					</div>
				</div>
			)

		/* 10. REMINDERS & SCHEDULE (428x324, Forest Green Clock Card) */
		case "reminders":
			return (
				<div className="tile-inner card-reminders">
					<div className="rem-top">
						<div className="rem-top-l">
							<span
								className={
									reminderPaused
										? "rem-clock paused"
										: "rem-clock"
								}
								aria-hidden="true"
							>
								<svg className="ico" viewBox="0 0 24 24">
									<circle cx="12" cy="12" r="9" />
									<path d="M12 7v5l3 2" />
								</svg>
							</span>
							<div>
								<div className="tile-title">
									Scheduled tasks
								</div>
								<TextMorph
									as="div"
									className="rem-sub"
									duration={300}
								>
									{reminderPaused
										? "Paused"
										: "Running on your server"}
								</TextMorph>
							</div>
						</div>
						<Toggle
							className="tile-pill"
							pressed={reminderPaused}
							onPressedChange={pressed =>
								onReminderPausedChange(pressed)
							}
						>
							<TextMorph as="span" duration={280}>
								{reminderPaused ? "Resume" : "Pause"}
							</TextMorph>
						</Toggle>
					</div>

					<div className="rem-list">
						<div className="rem-item">
							<span className="rem-time tabular">Mon 09:00</span>
							<span className="rem-desc">
								Summarize open sprint blockers in #product
							</span>
						</div>
						<div className="rem-item">
							<span className="rem-time tabular">In 20 min</span>
							<span className="rem-desc">
								DM @priya once the staging deploy finishes
							</span>
						</div>
						<div className="rem-item">
							<span className="rem-time tabular">Fri 16:30</span>
							<span className="rem-desc">
								Draft weekly changelog from merged PRs
							</span>
						</div>
					</div>
				</div>
			)

		/* 11. AZURE & M365 PERMISSIONS (428x336, Cobalt Identity Card) */
		case "m365":
			return (
				<div className="tile-inner card-m365">
					<div className="m365-head">
						<span className="m365-badge">
							<svg
								className="ico ico-xs"
								viewBox="0 0 24 24"
								aria-hidden="true"
							>
								<rect
									width="18"
									height="11"
									x="3"
									y="11"
									rx="2"
								/>
								<path d="M7 11V7a5 5 0 0 1 10 0v4" />
							</svg>
							<span>Acts as @you</span>
						</span>
						<span className="tile-note">Scoped permissions</span>
					</div>

					<div className="m365-copy-block">
						<h3 className="m365-title">
							Works in your tools—sees only what you can
						</h3>
						<p className="m365-sub">
							Uses your own sign-in inside your container—no
							shared service accounts.
						</p>
					</div>

					<div className="m365-chips">
						<div className="m365-chip">
							<img
								src="/icons/azure.svg"
								alt=""
								width={16}
								height={16}
								className="brand-ico"
							/>
							<span>Azure DevOps</span>
						</div>
						<div className="m365-chip">
							<img
								src="/icons/microsoft.svg"
								alt=""
								width={15}
								height={15}
								className="brand-ico"
							/>
							<span>Microsoft 365</span>
						</div>
						<div className="m365-chip">
							<img
								src="/icons/azure.svg"
								alt=""
								width={16}
								height={16}
								className="brand-ico"
							/>
							<span>Azure Repos</span>
						</div>
						<div className="m365-chip">
							<img
								src="/icons/aws.svg"
								alt=""
								width={16}
								height={16}
								className="brand-ico"
							/>
							<span>AWS CodeCommit</span>
						</div>
					</div>
				</div>
			)

		/* 12. HIGH-CONTRAST EDITORIAL MIT POSTER (368x300, Warm Off-White Break Card) */
		case "oss":
			return (
				<div className="tile-inner card-oss">
					<div className="oss-top">
						<span className="oss-tag">OPEN SOURCE</span>
						<img
							src="/icons/osi.svg"
							alt=""
							width={20}
							height={20}
							className="brand-ico"
						/>
					</div>

					<div className="oss-big">MIT</div>

					<div className="oss-foot">
						<p className="oss-copy">
							Free forever. No seat tax, no vendor cloud, no
							lock-in.
						</p>
						<a
							className="oss-link"
							href="https://github.com/mohiwalla/laddu"
							target="_blank"
							rel="noreferrer"
						>
							<span>mohiwalla/laddu</span>
							<svg
								className="ico ico-xs"
								viewBox="0 0 20 20"
								aria-hidden="true"
							>
								<path d="M6 14 14 6M8 6h6v6" />
							</svg>
						</a>
					</div>
				</div>
			)

		default:
			if (EXTRA_SET.has(id)) {
				return (
					<ExtraShowcaseCard
						id={id as ExtraHandcraftedId}
						mascot={mascot}
						stoppedMine={stoppedMine}
						teamInvited={teamInvited}
						onStoppedMineChange={onStoppedMineChange}
						onTeamInvitedChange={onTeamInvitedChange}
						onCopySuccess={onCopySuccess}
					/>
				)
			}
			return (
				<CatalogShowcaseCard
					id={id}
					mascot={mascot}
					onSelectMascot={onSelectMascot}
					onCopySuccess={onCopySuccess}
				/>
			)
	}
}, areCardPropsEqual)

function areCardPropsEqual(prev: CardProps, next: CardProps): boolean {
	if (prev.id !== next.id) return false
	const id = next.id
	if (id === "slack") {
		return (
			prev.mascot.id === next.mascot.id &&
			prev.promptIdx === next.promptIdx &&
			prev.showTrace === next.showTrace
		)
	}
	if (id === "takeover") {
		return (
			prev.mascot.id === next.mascot.id &&
			prev.takenOver === next.takenOver
		)
	}
	if (id === "models") return prev.activeModel === next.activeModel
	if (id === "reminders") return prev.reminderPaused === next.reminderPaused
	if (id === "stop") return prev.stoppedMine === next.stoppedMine
	if (id === "private") return prev.teamInvited === next.teamInvited
	if (
		id === "skins" ||
		id === "dm" ||
		id === "threads" ||
		id.startsWith("sm-") ||
		id.startsWith("m-")
	) {
		return prev.mascot.id === next.mascot.id
	}
	return true
}
