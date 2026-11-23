import { Button } from "@ui-sdk/react/button"
import { TextMorph } from "torph/react"
import { CATALOG_MAP, type CatalogCardSpec } from "../data/extraCards"
import { MASCOTS, type Mascot } from "../data/showcase"
import { CopyButton } from "./CopyButton"

export interface CatalogCardProps {
	id: string
	mascot: Mascot
	onSelectMascot: (id: string) => void
	onCopySuccess: (text: string) => void
}

function PosterIcon({
	icon,
}: {
	icon: Extract<CatalogCardSpec, { kind: "poster" }>["icon"]
}) {
	switch (icon) {
		case "lock":
			return (
				<svg className="ico" viewBox="0 0 24 24" aria-hidden="true">
					<rect width="18" height="11" x="3" y="11" rx="2" />
					<path d="M7 11V7a5 5 0 0 1 10 0v4" />
				</svg>
			)
		case "server":
			return (
				<svg className="ico" viewBox="0 0 24 24" aria-hidden="true">
					<rect width="20" height="8" x="2" y="2" rx="2" />
					<rect width="20" height="8" x="2" y="14" rx="2" />
					<line x1="6" x2="6.01" y1="6" y2="6" />
					<line x1="6" x2="6.01" y1="18" y2="18" />
				</svg>
			)
		case "shield":
			return (
				<svg className="ico" viewBox="0 0 24 24" aria-hidden="true">
					<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10" />
				</svg>
			)
		case "code":
			return (
				<svg className="ico" viewBox="0 0 24 24" aria-hidden="true">
					<polyline points="16 18 22 12 16 6" />
					<polyline points="8 6 2 12 8 18" />
				</svg>
			)
		case "bolt":
			return (
				<svg className="ico" viewBox="0 0 24 24" aria-hidden="true">
					<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8Z" />
				</svg>
			)
		case "globe":
			return (
				<svg className="ico" viewBox="0 0 24 24" aria-hidden="true">
					<circle cx="12" cy="12" r="10" />
					<path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
				</svg>
			)
		case "key":
			return (
				<svg className="ico" viewBox="0 0 24 24" aria-hidden="true">
					<circle cx="7.5" cy="15.5" r="5.5" />
					<path d="m21 2-9.6 9.6M15.5 7.5l3 3" />
				</svg>
			)
		case "slack":
			return (
				<svg className="ico" viewBox="0 0 24 24" aria-hidden="true">
					<line x1="4" x2="20" y1="9" y2="9" />
					<line x1="4" x2="20" y1="15" y2="15" />
					<line x1="10" x2="8" y1="3" y2="21" />
					<line x1="16" x2="14" y1="3" y2="21" />
				</svg>
			)
		case "cpu":
			return (
				<svg className="ico" viewBox="0 0 24 24" aria-hidden="true">
					<rect width="16" height="16" x="4" y="4" rx="2" />
					<rect width="6" height="6" x="9" y="9" rx="1" />
					<path d="M15 2v2M15 20v2M2 15h2M2 9h2M20 15h2M20 9h2M9 2v2M9 20v2" />
				</svg>
			)
	}
}

function MiniChartSvg({
	chart,
	uid,
}: {
	chart: Extract<CatalogCardSpec, { kind: "metric-chart" }>["chart"]
	uid: string
}) {
	switch (chart) {
		case "spark":
			return (
				<svg
					viewBox="0 0 320 84"
					preserveAspectRatio="none"
					className="cat-chart-svg"
					aria-hidden="true"
				>
					<defs>
						<linearGradient
							id={`g-${uid}`}
							x1="0"
							y1="0"
							x2="0"
							y2="1"
						>
							<stop
								offset="0%"
								stopColor="#f59e0b"
								stopOpacity="0.34"
							/>
							<stop
								offset="100%"
								stopColor="#f59e0b"
								stopOpacity="0"
							/>
						</linearGradient>
					</defs>
					<line
						x1="0"
						y1="22"
						x2="320"
						y2="22"
						stroke="rgba(255,255,255,0.06)"
						vectorEffect="non-scaling-stroke"
					/>
					<line
						x1="0"
						y1="52"
						x2="320"
						y2="52"
						stroke="rgba(255,255,255,0.06)"
						vectorEffect="non-scaling-stroke"
					/>
					<path
						d="M0 20 C52 24, 72 34, 114 38 C156 42, 184 52, 224 58 C264 64, 290 68, 320 72 L320 84 L0 84 Z"
						fill={`url(#g-${uid})`}
					/>
					<path
						d="M0 20 C52 24, 72 34, 114 38 C156 42, 184 52, 224 58 C264 64, 290 68, 320 72"
						fill="none"
						stroke="#fbbf24"
						strokeWidth="2.4"
						strokeLinecap="round"
						vectorEffect="non-scaling-stroke"
					/>
				</svg>
			)
		case "bars":
			return (
				<div className="cat-bars-grid" aria-hidden="true">
					{[
						{ label: "W1", pct: 38 },
						{ label: "W2", pct: 62 },
						{ label: "W3", pct: 50 },
						{ label: "W4", pct: 82 },
						{ label: "W5", pct: 70 },
						{ label: "W6", pct: 100, peak: true },
					].map(b => (
						<div className="cat-bar-col" key={b.label}>
							<div className="cat-bar-track">
								<span
									className={
										b.peak
											? "cat-bar-fill peak"
											: "cat-bar-fill"
									}
									style={{ height: `${b.pct}%` }}
								/>
							</div>
							<span className="cat-bar-lbl tabular">
								{b.label}
							</span>
						</div>
					))}
				</div>
			)
		case "firewall":
			return (
				<div className="cat-fw-grid" aria-hidden="true">
					<div className="cat-fw-node">
						<img
							src="/icons/docker.svg"
							alt=""
							width={16}
							height={16}
							loading="lazy"
							decoding="async"
							className="brand-ico"
						/>
						<span>sandbox</span>
					</div>
					<div className="cat-fw-routes">
						<div className="cat-fw-row ok">
							<span className="cat-fw-line" />
							<span className="cat-fw-pill ok">
								Public web · OK
							</span>
						</div>
						<div className="cat-fw-row drop">
							<span className="cat-fw-line" />
							<span className="cat-fw-pill drop">
								Host &amp; LAN · DROP
							</span>
						</div>
					</div>
				</div>
			)
		case "waterfall":
			return (
				<div className="cat-wf-bars" aria-hidden="true">
					{[
						{
							label: "Read",
							left: "0%",
							w: "16%",
							dur: "0.4s",
							col: "#67e8f9",
						},
						{
							label: "Query",
							left: "16%",
							w: "32%",
							dur: "1.8s",
							col: "#38bdf8",
						},
						{
							label: "Build",
							left: "48%",
							w: "34%",
							dur: "2.1s",
							col: "#818cf8",
						},
						{
							label: "Reply",
							left: "82%",
							w: "18%",
							dur: "0.6s",
							col: "#4cc38a",
						},
					].map(s => (
						<div className="cat-wf-row" key={s.label}>
							<span className="cat-wf-lbl">{s.label}</span>
							<div className="cat-wf-track">
								<span
									className="cat-wf-seg"
									style={{
										left: s.left,
										width: s.w,
										background: s.col,
									}}
								/>
							</div>
							<span className="cat-wf-dur tabular">{s.dur}</span>
						</div>
					))}
				</div>
			)
		case "stacked":
			return (
				<div className="cat-formats-grid">
					{[
						["xlsx", "XLSX", "Sheets"],
						["pptx", "PPTX", "Slides"],
						["pdf", "PDF", "Briefs"],
						["png", "PNG", "Charts"],
						["csv", "CSV", "Data"],
						["docx", "DOCX", "Docs"],
					].map(([cls, ext, desc]) => (
						<div className="cat-fmt-item" key={ext}>
							<span className={`file-chip ${cls}`}>{ext}</span>
							<span className="cat-fmt-desc">{desc}</span>
						</div>
					))}
				</div>
			)
		case "split":
			return (
				<div className="cat-engines-grid">
					{[
						{
							label: "Codex",
							icon: "/icons/openai.svg",
							border: "rgb(76 195 138 / 0.45)",
						},
						{
							label: "Claude",
							icon: "/icons/claude.svg",
							border: "rgb(244 118 84 / 0.45)",
						},
						{
							label: "Antigravity",
							icon: "/icons/antigravity.svg",
							border: "rgb(167 139 250 / 0.45)",
						},
						{
							label: "OpenCode",
							icon: "/icons/opencode.svg",
							border: "rgb(56 189 248 / 0.45)",
						},
					].map(eng => (
						<div
							key={eng.label}
							className="cat-engine-chip"
							style={
								{
									"--eng-border": eng.border,
								} as React.CSSProperties
							}
						>
							<img
								src={eng.icon}
								alt=""
								width={20}
								height={20}
								loading="lazy"
								decoding="async"
								className="brand-ico"
							/>
							<span>{eng.label}</span>
						</div>
					))}
				</div>
			)
		case "ring":
			return (
				<div className="cat-ring-box">
					<svg
						viewBox="0 0 76 76"
						className="cat-ring-svg"
						aria-hidden="true"
					>
						<circle
							cx="38"
							cy="38"
							r="28"
							fill="none"
							stroke="rgba(255,255,255,0.08)"
							strokeWidth="9"
						/>
						<circle
							cx="38"
							cy="38"
							r="28"
							fill="none"
							stroke="#4cc38a"
							strokeWidth="9"
							strokeDasharray="118 176"
							strokeLinecap="round"
							transform="rotate(-90 38 38)"
						/>
					</svg>
					<div className="cat-ring-meta">
						<div className="cat-ring-icons">
							<img
								src="/icons/bun.svg"
								alt=""
								width={16}
								height={16}
								loading="lazy"
								decoding="async"
								className="brand-ico"
							/>
							<img
								src="/icons/docker.svg"
								alt=""
								width={16}
								height={16}
								loading="lazy"
								decoding="async"
								className="brand-ico"
							/>
							<span>Bun + isolated Docker</span>
						</div>
						<span className="cat-ring-sub">
							Per-user containers wake on mention
						</span>
					</div>
				</div>
			)
	}
}

export function CatalogShowcaseCard({
	id,
	mascot,
	onSelectMascot,
	onCopySuccess,
}: CatalogCardProps) {
	const spec = CATALOG_MAP.get(id)
	if (!spec) return null

	const bot = mascot.name

	switch (spec.kind) {
		case "slack-mini":
			return (
				<div
					className={`tile-inner cat-card cat-slack tone-${spec.tone}`}
				>
					<div className="x-head">
						<span className="cat-chan">
							<img
								src="/icons/slack.svg"
								alt=""
								width={13}
								height={13}
								className="brand-ico"
							/>
							<span>{spec.channel}</span>
						</span>
						<span className="tile-note">Thread</span>
					</div>

					<div className="cat-sm-ask">
						<span className="cat-sm-av">{spec.init}</span>
						<p className="cat-sm-p">
							<strong>{spec.user}</strong>{" "}
							<TextMorph
								as="span"
								className="mention"
								duration={340}
							>
								{`@${bot}`}
							</TextMorph>{" "}
							{spec.ask}
						</p>
					</div>

					<div className="cat-sm-reply">
						<img
							src={mascot.thumb}
							alt=""
							width={20}
							height={20}
							className="cat-sm-bot"
						/>
						<div className="cat-sm-body">
							<p>{spec.reply}</p>
							{spec.attachment && (
								<span className="cat-sm-file">
									<span className="cat-sm-ext">
										{spec.attachment.ext}
									</span>
									<span>{spec.attachment.name}</span>
								</span>
							)}
						</div>
					</div>

					<div className="cat-sm-reacts">
						{spec.reactions.map(r => (
							<span className="s-react" key={r}>
								{r}
							</span>
						))}
					</div>
				</div>
			)

		case "poster":
			return (
				<div className={`tile-inner cat-poster tone-${spec.tone}`}>
					<div className="cat-poster-top">
						<span className="cat-poster-tag">{spec.tag}</span>
						{spec.brandIcon ? (
							<img
								src={spec.brandIcon}
								alt=""
								width={20}
								height={20}
								loading="lazy"
								decoding="async"
								className="brand-ico"
							/>
						) : (
							<PosterIcon icon={spec.icon} />
						)}
					</div>
					<div className="cat-poster-word">{spec.word}</div>
					<p className="cat-poster-copy">{spec.copy}</p>
				</div>
			)

		case "terminal":
			return (
				<div
					className={`tile-inner cat-card cat-term tone-${spec.tone}`}
				>
					<div className="x-head">
						<span className="term-host">
							{spec.brandIcon ? (
								<img
									src={spec.brandIcon}
									alt=""
									width={14}
									height={14}
									loading="lazy"
									decoding="async"
									className="brand-ico"
								/>
							) : (
								<svg
									className="ico ico-xs"
									viewBox="0 0 24 24"
									aria-hidden="true"
								>
									<path d="m4 17 6-6-6-6M12 19h8" />
								</svg>
							)}
							<span>{spec.host}</span>
						</span>
						<span className="cat-term-badge">{spec.badge}</span>
					</div>

					<div className="cat-term-box">
						{spec.lines.map((line, idx) => (
							<div
								key={idx}
								className={`cat-term-line ${line.kind}`}
							>
								{line.text}
							</div>
						))}
					</div>

					{spec.copyText && (
						<div className="cmd-pill">
							<code className="cmd-str">
								<span className="cmd-p" aria-hidden="true">
									$
								</span>
								{spec.copyText}
							</code>
							<CopyButton
								text={spec.copyText}
								onCopied={onCopySuccess}
							/>
						</div>
					)}
				</div>
			)

		case "diff":
			return (
				<div
					className={`tile-inner cat-card cat-diff tone-${spec.tone}`}
				>
					<div className="pr-top">
						<div className="pr-top-l">
							{spec.brandIcon ? (
								<span
									className="cat-diff-ico"
									aria-hidden="true"
								>
									<img
										src={spec.brandIcon}
										alt=""
										width={16}
										height={16}
										loading="lazy"
										decoding="async"
										className="brand-ico"
									/>
								</span>
							) : (
								<span
									className="pr-icon-badge"
									aria-hidden="true"
								>
									<svg
										className="ico ico-xs"
										viewBox="0 0 24 24"
									>
										<circle cx="18" cy="18" r="3" />
										<circle cx="6" cy="6" r="3" />
										<path d="M13 6h3a2 2 0 0 1 2 2v7M6 9v12" />
									</svg>
								</span>
							)}
							<div style={{ minWidth: 0 }}>
								<div className="pr-title cat-ellipsis">
									{spec.title}
								</div>
								<div className="pr-meta">{spec.repo}</div>
							</div>
						</div>
						<div className="pr-diff">
							<span className="diff-add">{spec.add}</span>
							<span className="diff-del">{spec.del}</span>
						</div>
					</div>

					<div className="diff-block cat-diff-block">
						{spec.lines.map((l, i) => (
							<div className={`diff-line ${l.kind}`} key={i}>
								<span className="ln">{l.ln}</span>
								<code>{l.code}</code>
							</div>
						))}
					</div>

					<p className="x-foot">{spec.footer}</p>
				</div>
			)

		case "metric-chart":
			return (
				<div
					className={`tile-inner cat-card cat-metric tone-${spec.tone}`}
				>
					<div className="x-head">
						<span className="cat-kicker">{spec.badge}</span>
						<span className="cat-stat tabular">{spec.stat}</span>
					</div>
					<h3 className="x-title">{spec.title}</h3>
					<div className="cat-chart-frame">
						<MiniChartSvg chart={spec.chart} uid={spec.id} />
					</div>
					<p className="x-foot">{spec.caption}</p>
				</div>
			)

		case "file-artifact":
			return (
				<div
					className={`tile-inner cat-card cat-file tone-${spec.tone}`}
				>
					<div className="x-head">
						<div className="cat-file-head">
							<span
								className={`file-chip ${spec.ext.toLowerCase()}`}
							>
								{spec.ext}
							</span>
							<span className="file-name">{spec.name}</span>
						</div>
						<span className="tile-note">{spec.meta}</span>
					</div>

					{spec.preview === "sheet" && (
						<div className="cat-sheet">
							{spec.rows.map((row, rIdx) => (
								<div
									key={rIdx}
									className={
										rIdx === 0
											? "cat-sheet-row head"
											: "cat-sheet-row"
									}
								>
									{row.map((cell, cIdx) => (
										<span key={cIdx}>{cell}</span>
									))}
								</div>
							))}
						</div>
					)}

					{spec.preview === "slides" && (
						<div className="cat-slides">
							{spec.rows.map((row, rIdx) => (
								<div className="cat-slide" key={rIdx}>
									<strong>{row[0]}</strong>
									<span>{row[1]}</span>
								</div>
							))}
						</div>
					)}

					{spec.preview === "doc" && (
						<div className="cat-doc">
							{spec.rows.map((row, rIdx) => (
								<div className="cat-doc-row" key={rIdx}>
									<strong>{row[0]}</strong>
									<span>{row[1]}</span>
								</div>
							))}
						</div>
					)}

					{spec.preview === "csv" && (
						<div className="cat-term-box">
							{spec.rows.map((row, rIdx) => (
								<div
									key={rIdx}
									className={
										rIdx === 0
											? "cat-term-line dim"
											: "cat-term-line ok"
									}
								>
									{row[0]}
								</div>
							))}
						</div>
					)}

					<p className="x-foot">{spec.foot}</p>
				</div>
			)

		case "workflow":
			return (
				<div className={`tile-inner cat-card cat-wf tone-${spec.tone}`}>
					<div className="x-head">
						<span className="cat-kicker-row">
							{spec.brandIcon && (
								<img
									src={spec.brandIcon}
									alt=""
									width={14}
									height={14}
									loading="lazy"
									decoding="async"
									className="brand-ico"
								/>
							)}
							<span className="cat-kicker">{spec.badge}</span>
						</span>
						<span className="tile-note">{spec.timing}</span>
					</div>
					<h3 className="x-title">{spec.title}</h3>
					<div className="audit-list">
						{spec.steps.map(s => (
							<div className="audit-row" key={s.n}>
								<span className="audit-idx tabular">{s.n}</span>
								<span className="audit-label">{s.label}</span>
								<span className="audit-dur tabular">
									{s.meta}
								</span>
							</div>
						))}
					</div>
				</div>
			)

		case "integration":
			return (
				<div
					className={`tile-inner cat-card cat-int tone-${spec.tone}`}
				>
					<div className="x-head">
						<span className="cat-kicker">{spec.kicker}</span>
						<div className="cat-int-icons">
							{spec.icons.map(src => (
								<span className="cat-int-ic" key={src}>
									<img
										src={src}
										alt=""
										width={16}
										height={16}
										className="brand-ico"
									/>
								</span>
							))}
						</div>
					</div>
					<h3 className="x-title">{spec.title}</h3>
					<div className="cat-int-pills">
						{spec.pills.map(p => (
							<span className="cat-int-pill" key={p}>
								{p}
							</span>
						))}
					</div>
					<p className="x-foot">{spec.foot}</p>
				</div>
			)

		case "mascot-card": {
			const m = MASCOTS.find(x => x.id === spec.mascotId) ?? MASCOTS[0]!
			const active = mascot.id === m.id
			return (
				<div
					className={`tile-inner cat-card cat-mascot tone-${spec.tone}`}
					data-active={active ? "true" : "false"}
				>
					<div className="x-head">
						<span className="cat-kicker">Custom identity</span>
						<Button
							className="tile-pill"
							onClick={e => {
								e.stopPropagation()
								onSelectMascot(m.id)
							}}
						>
							<TextMorph as="span" duration={280}>
								{active ? "Active" : `Use ${spec.label}`}
							</TextMorph>
						</Button>
					</div>

					<div className="cat-mascot-body">
						<img
							src={m.thumb}
							alt={`${m.name} mascot`}
							width={84}
							height={84}
							loading="lazy"
							decoding="async"
							className="cat-mascot-img"
						/>
						<div className="cat-mascot-txt">
							<div
								className="cat-mascot-handle"
								style={{ color: spec.accentHex }}
							>
								{spec.label}
							</div>
							<p className="x-foot">{spec.tagline}</p>
						</div>
					</div>
				</div>
			)
		}

		case "checklist":
			return (
				<div
					className={`tile-inner cat-card cat-check tone-${spec.tone}`}
				>
					<div className="x-head">
						<span className="cat-kicker">{spec.badge}</span>
						{spec.brandIcon ? (
							<img
								src={spec.brandIcon}
								alt=""
								width={16}
								height={16}
								loading="lazy"
								decoding="async"
								className="brand-ico"
							/>
						) : (
							<svg
								className="ico ico-xs"
								viewBox="0 0 24 24"
								aria-hidden="true"
								style={{ color: "var(--positive)" }}
							>
								<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10" />
							</svg>
						)}
					</div>
					<h3 className="x-title">{spec.title}</h3>
					<div className="cat-check-list">
						{spec.items.map(item => (
							<div className="cat-check-row" key={item}>
								<svg
									className="ico ico-xs"
									viewBox="0 0 24 24"
									aria-hidden="true"
								>
									<path d="M20 6 9 17l-5-5" />
								</svg>
								<span>{item}</span>
							</div>
						))}
					</div>
				</div>
			)
	}
}
