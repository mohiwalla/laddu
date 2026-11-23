import { Toggle } from "@ui-sdk/react/toggle"
import { TextMorph } from "torph/react"
import type { ExtraHandcraftedId, Mascot } from "../data/showcase"
import { CopyButton } from "./CopyButton"

export interface ExtraCardProps {
	id: ExtraHandcraftedId
	mascot: Mascot
	stoppedMine: boolean
	teamInvited: boolean
	onStoppedMineChange: (v: boolean) => void
	onTeamInvitedChange: (v: boolean) => void
	onCopySuccess: (text: string) => void
}

export function ExtraShowcaseCard({
	id,
	mascot,
	stoppedMine,
	teamInvited,
	onStoppedMineChange,
	onTeamInvitedChange,
	onCopySuccess,
}: ExtraCardProps) {
	const bot = mascot.name

	switch (id) {
		/* 13. PER-PERSON STOP IN SHARED THREADS (448x324, Crimson-Charcoal) */
		case "stop":
			return (
				<div className="tile-inner card-stop">
					<div className="x-head">
						<span className="x-badge crimson">
							<svg
								className="ico ico-xs"
								viewBox="0 0 24 24"
								aria-hidden="true"
							>
								<rect
									width="12"
									height="12"
									x="6"
									y="6"
									rx="2"
								/>
							</svg>
							<span>Per-person stop</span>
						</span>
						<Toggle
							className="stop-btn"
							pressed={stoppedMine}
							onPressedChange={onStoppedMineChange}
						>
							<TextMorph as="span" duration={280}>
								{stoppedMine ? "Restart mine" : "Stop mine"}
							</TextMorph>
						</Toggle>
					</div>

					<h3 className="x-title">
						Stop cancels your run—never a teammate’s
					</h3>

					<div className="stop-lanes">
						<div
							className="stop-lane"
							data-stopped={stoppedMine ? "true" : "false"}
						>
							<span className="stop-dot" />
							<div className="stop-txt">
								<strong>@you · Refactor auth middleware</strong>
								<TextMorph as="span" duration={300}>
									{stoppedMine
										? "Stopped cleanly on your command"
										: "Working inside @you’s container…"}
								</TextMorph>
							</div>
						</div>
						<div className="stop-lane">
							<span className="stop-dot live" />
							<div className="stop-txt">
								<strong>@priya · Export Q4 metrics CSV</strong>
								<span>
									Still running untouched in same thread
								</span>
							</div>
						</div>
					</div>
				</div>
			)

		/* 14. DM TEAMMATES FOR YOU (412x316, Slate-Teal) */
		case "dm":
			return (
				<div className="tile-inner card-dm">
					<div className="x-head">
						<span className="x-badge teal">
							<svg
								className="ico ico-xs"
								viewBox="0 0 24 24"
								aria-hidden="true"
							>
								<path d="m22 2-7 20-4-9-9-4Z" />
								<path d="M22 2 11 13" />
							</svg>
							<span>Direct messages</span>
						</span>
						<span className="tile-note">On your behalf</span>
					</div>

					<div className="dm-bubble">
						<div className="dm-from">
							<img
								src={mascot.thumb}
								alt=""
								width={22}
								height={22}
								className="dm-av"
							/>
							<TextMorph as="strong" duration={340}>
								{bot}
							</TextMorph>
							<span className="dm-arrow">→ @priya</span>
						</div>
						<p className="dm-text">
							Hey Priya—@you asked me to ping you once the Q4
							launch sheet was ready for review.
						</p>
						<div className="dm-meta">
							<svg
								className="ico ico-xs"
								viewBox="0 0 24 24"
								aria-hidden="true"
							>
								<path d="M20 6 9 17l-5-5" />
							</svg>
							<span>Delivered in Slack DM · 14:22</span>
						</div>
					</div>

					<p className="x-foot">
						Delegate follow-ups and handoffs without leaving your
						thread.
					</p>
				</div>
			)

		/* 15. SLACK HOME DASHBOARD (412x376, Deep Violet) */
		case "home":
			return (
				<div className="tile-inner card-home">
					<div className="x-head">
						<span className="home-brand">
							<img
								src="/icons/slack.svg"
								alt=""
								width={15}
								height={15}
								className="brand-ico"
							/>
							<span className="tile-title">App Home</span>
						</span>
						<span className="home-live">Online</span>
					</div>

					<div className="home-stats">
						<div className="home-stat">
							<span className="home-k">Container</span>
							<span className="home-v tabular">
								Running · 412 MB
							</span>
						</div>
						<div className="home-stat">
							<span className="home-k">Engine</span>
							<span className="home-v">
								Claude · Personal login
							</span>
						</div>
						<div className="home-stat">
							<span className="home-k">Workspace</span>
							<span className="home-v mono">/home/you/work</span>
						</div>
					</div>

					<div className="home-actions">
						<span className="home-chip">
							<svg
								className="ico ico-xs"
								viewBox="0 0 24 24"
								aria-hidden="true"
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
							<span>Open desktop</span>
						</span>
						<span className="home-chip">
							<svg
								className="ico ico-xs"
								viewBox="0 0 24 24"
								aria-hidden="true"
							>
								<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
								<circle cx="12" cy="12" r="3" />
							</svg>
							<span>Switch engine</span>
						</span>
					</div>

					<p className="x-foot">
						Check container health, sign in, or open your desktop
						right from Slack.
					</p>
				</div>
			)

		/* 16. WEB RESEARCH WITH SOURCES (468x288, Deep Petrol-Teal) */
		case "research":
			return (
				<div className="tile-inner card-research">
					<div className="x-head">
						<span className="x-badge cyan">
							<svg
								className="ico ico-xs"
								viewBox="0 0 24 24"
								aria-hidden="true"
							>
								<circle cx="12" cy="12" r="10" />
								<path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
							</svg>
							<span>Live web research</span>
						</span>
						<span className="tile-note">Cited in thread</span>
					</div>

					<h3 className="x-title">
						Checks current docs &amp; links its sources
					</h3>

					<p className="res-quote">
						“Bun 1.4’s native HTML bundler hashes imported assets
						directly into <code className="inline-code">dist/</code>
						—no separate copy step needed for module imports.”
					</p>

					<div className="res-sources">
						<span className="res-src">
							<span className="res-num">1</span>
							<span>bun.sh/docs/bundler</span>
						</span>
						<span className="res-src">
							<span className="res-num">2</span>
							<span>developer.mozilla.org</span>
						</span>
						<span className="res-src">
							<span className="res-num">3</span>
							<span>docs.astro.build</span>
						</span>
					</div>
				</div>
			)

		/* 17. TRANSPARENT LIVE STEP TIMELINE (464x332, Warm Stone) */
		case "audit":
			return (
				<div className="tile-inner card-audit">
					<div className="x-head">
						<span className="tile-title">
							Plain-language progress
						</span>
						<span className="audit-total tabular">6.2s total</span>
					</div>

					<div className="audit-list">
						{[
							["Read 18 replies in #ops", "0.4s"],
							["Queried staging metrics export", "1.9s"],
							["Rendered latency p95 chart", "3.1s"],
							["Posted summary & PNG in thread", "0.8s"],
						].map(([step, dur], i) => (
							<div className="audit-row" key={step}>
								<span className="audit-idx tabular">
									0{i + 1}
								</span>
								<span className="audit-label">{step}</span>
								<span className="audit-dur tabular">{dur}</span>
							</div>
						))}
					</div>
				</div>
			)

		/* 18. REAL VISUAL BROWSER (512x360, Midnight Blue) */
		case "browser":
			return (
				<div className="tile-inner card-browser">
					<div className="x-head">
						<span className="x-badge blue">
							<img
								src="/icons/chromium.svg"
								alt=""
								width={14}
								height={14}
								className="brand-ico"
							/>
							<span>Real Chromium browser</span>
						</span>
						<span className="tile-note">Inside container</span>
					</div>

					<h3 className="x-title">Reaches web apps with no API</h3>

					<div className="br-tabs">
						<span className="br-tab active">Billing Portal</span>
						<span className="br-tab">Vendor Dashboard</span>
						<span className="br-tab">Admin Console</span>
					</div>

					<div className="br-caps">
						<div className="br-cap">
							<svg
								className="ico ico-xs"
								viewBox="0 0 24 24"
								aria-hidden="true"
							>
								<path d="M20 6 9 17l-5-5" />
							</svg>
							<span>
								Clicks, types, downloads exports &amp;
								screenshots
							</span>
						</div>
						<div className="br-cap">
							<svg
								className="ico ico-xs"
								viewBox="0 0 24 24"
								aria-hidden="true"
							>
								<path d="M20 6 9 17l-5-5" />
							</svg>
							<span>
								Keeps your cookies isolated to your container
							</span>
						</div>
					</div>

					<p className="x-foot">
						Full desktop browser—step in live whenever a site asks
						for 2FA.
					</p>
				</div>
			)

		/* 19. WRITING & SUMMARIES (468x292, Warm Espresso) */
		case "writing":
			return (
				<div className="tile-inner card-writing">
					<div className="x-head">
						<span className="x-badge amber">
							<svg
								className="ico ico-xs"
								viewBox="0 0 24 24"
								aria-hidden="true"
							>
								<path d="M12 20h9" />
								<path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
							</svg>
							<span>Writing &amp; summaries</span>
						</span>
						<span className="tile-note">14 msgs → 3 lines</span>
					</div>

					<div className="write-card">
						<div className="write-row">
							<span className="write-tag">Decision</span>
							<span>
								Ship v2 billing webhooks on Tuesday at 10 AM.
							</span>
						</div>
						<div className="write-row">
							<span className="write-tag">Blocker</span>
							<span>
								Retry timer race in PR #418 needs final
								sign-off.
							</span>
						</div>
						<div className="write-row">
							<span className="write-tag">Owner</span>
							<span>
								@dev merges after CI; @maya posts release note.
							</span>
						</div>
					</div>
				</div>
			)

		/* 20. SYSTEMD SERVICE HEALTH (512x312, Pine Obsidian) */
		case "systemd":
			return (
				<div className="tile-inner card-systemd">
					<div className="x-head">
						<span className="term-host">
							<img
								src="/icons/linux.svg"
								alt=""
								width={14}
								height={14}
								className="brand-ico"
							/>
							<span>laddu.service</span>
						</span>
						<span className="sys-active">active (running)</span>
					</div>

					<div className="sys-box">
						<div className="sys-line">
							<span className="sys-k">Loaded:</span>
							<span>systemd user unit (enabled)</span>
						</div>
						<div className="sys-line">
							<span className="sys-k">Runtime:</span>
							<span>Bun + Docker containers</span>
						</div>
						<div className="sys-line">
							<span className="sys-k">Restart:</span>
							<span>always · survives server reboot</span>
						</div>
					</div>

					<div className="cmd-pill">
						<code className="cmd-str">
							<span className="cmd-p" aria-hidden="true">
								$
							</span>
							systemctl --user status laddu
						</code>
						<CopyButton
							text="systemctl --user status laddu"
							onCopied={onCopySuccess}
						/>
					</div>
				</div>
			)

		/* 21. PERSISTENT FILESYSTEM (412x340, Slate-Plum) */
		case "persist":
			return (
				<div className="tile-inner card-persist">
					<div className="x-head">
						<span className="tile-title">Persistent files</span>
						<span className="tile-note">Never wiped</span>
					</div>

					<div className="tree-box">
						<div className="tree-row dir">
							<svg
								className="ico ico-xs"
								viewBox="0 0 24 24"
								aria-hidden="true"
							>
								<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
							</svg>
							<span>/workspace/repos/billing-api</span>
						</div>
						<div className="tree-row dir">
							<svg
								className="ico ico-xs"
								viewBox="0 0 24 24"
								aria-hidden="true"
							>
								<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
							</svg>
							<span>/workspace/runbooks</span>
						</div>
						<div className="tree-row">
							<svg
								className="ico ico-xs"
								viewBox="0 0 24 24"
								aria-hidden="true"
							>
								<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
								<path d="M14 2v4a2 2 0 0 0 2 2h4" />
							</svg>
							<span>q4-launch-tracker.xlsx</span>
						</div>
						<div className="tree-row">
							<svg
								className="ico ico-xs"
								viewBox="0 0 24 24"
								aria-hidden="true"
							>
								<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
								<path d="M14 2v4a2 2 0 0 0 2 2h4" />
							</svg>
							<span>deploy-checklist.md</span>
						</div>
					</div>

					<p className="x-foot">
						Cloned repos, runbooks, and exports stay ready across
						chats.
					</p>
				</div>
			)

		/* 22. BOLD SAFFRON STATEMENT POSTER (384x248, High-Contrast Saffron Break Card!) */
		case "privacy":
			return (
				<div className="tile-inner card-privacy">
					<div className="priv-top">
						<span className="priv-tag">SELF-HOSTED</span>
						<svg
							className="ico"
							viewBox="0 0 24 24"
							aria-hidden="true"
						>
							<rect width="18" height="11" x="3" y="11" rx="2" />
							<path d="M7 11V7a5 5 0 0 1 10 0v4" />
						</svg>
					</div>

					<div className="priv-big">ZERO</div>

					<p className="priv-copy">
						vendor cloud. Your server, your containers, your
						provider keys.
					</p>
				</div>
			)

		/* 23. FULL THREAD CONTEXT (520x320, Cool Graphite) */
		case "threads":
			return (
				<div className="tile-inner card-threads">
					<div className="x-head">
						<span className="tile-title">
							Reads the whole thread
						</span>
						<span className="tile-note">
							No copy-pasting context
						</span>
					</div>

					<div className="thr-chain">
						<div className="thr-item">
							<span className="thr-av">A</span>
							<div className="thr-body">
								<strong>Arjun</strong> shared{" "}
								<code>q4-signups.csv</code>
							</div>
						</div>
						<div className="thr-item">
							<span className="thr-av">M</span>
							<div className="thr-body">
								<strong>Maya</strong> “Can someone group this by
								region?”
							</div>
						</div>
						<div className="thr-item active">
							<span className="thr-av bot">
								<img
									src={mascot.thumb}
									alt=""
									width={18}
									height={18}
								/>
							</span>
							<div className="thr-body">
								<TextMorph as="strong" duration={340}>
									{`@${bot}`}
								</TextMorph>{" "}
								reads the CSV + replies &amp; posts the
								breakdown right here.
							</div>
						</div>
					</div>
				</div>
			)

		/* 24. PRIVATE FIRST-RUN ROLLOUT (512x324, Warm Amber-Obsidian) */
		case "private":
			return (
				<div className="tile-inner card-private">
					<div className="x-head">
						<span className="x-badge amber">
							<svg
								className="ico ico-xs"
								viewBox="0 0 24 24"
								aria-hidden="true"
							>
								<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10" />
							</svg>
							<span>Safe rollout</span>
						</span>
						<Toggle
							className="tile-pill"
							pressed={teamInvited}
							onPressedChange={onTeamInvitedChange}
						>
							<TextMorph as="span" duration={280}>
								{teamInvited ? "Team enabled" : "Invite team"}
							</TextMorph>
						</Toggle>
					</div>

					<TextMorph as="h3" className="x-title" duration={320}>
						{teamInvited
							? "Now answering teammates you invite"
							: "Answers only you until you’re ready"}
					</TextMorph>

					<div className="priv-steps">
						<div className="priv-step done">
							<span className="priv-n tabular">01</span>
							<span>Installer DMs you privately first</span>
						</div>
						<div
							className={
								teamInvited ? "priv-step done" : "priv-step"
							}
						>
							<span className="priv-n tabular">02</span>
							<TextMorph as="span" duration={300}>
								{teamInvited
									? "Added to #product & #eng channels"
									: "Test safely, then invite channels when ready"}
							</TextMorph>
						</div>
					</div>
				</div>
			)
	}
}
