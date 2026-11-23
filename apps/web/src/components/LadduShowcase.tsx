import { Button } from "@ui-sdk/react/button"
import {
	SegmentedControl,
	SegmentedControlIndicator,
	SegmentedControlItem,
} from "@ui-sdk/react/segmented-control"
import {
	Toast,
	ToastDescription,
	ToastRegion,
	ToastTitle,
	createToaster,
} from "@ui-sdk/react/toast"
import {
	Component,
	type ReactNode,
	Suspense,
	lazy,
	startTransition,
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react"
import { TextMorph } from "torph/react"
import {
	DOCK_ITEMS,
	MACRO_H,
	MACRO_W,
	MASCOTS,
	MASONRY_LAYOUT,
	SCENARIOS,
	type CardId,
} from "../data/showcase"
import { ShinyInstallButton } from "./ShinyInstallButton"
import { ShowcaseCard } from "./ShowcaseCards"

const loadInstallDialog = () => import("./InstallDialog")
const LazyInstallDialog = lazy(loadInstallDialog)

class DialogErrorBoundary extends Component<
	{ children: ReactNode; onError: () => void },
	{ failed: boolean }
> {
	state = { failed: false }

	static getDerivedStateFromError() {
		return { failed: true }
	}

	componentDidCatch() {
		this.props.onError()
	}

	render() {
		return this.state.failed ? null : this.props.children
	}
}

const INITIAL_DELAYS = [0, 45, 80, 108, 130, 148]
const SPRING_K = 165
const SPRING_D = 24

const DOCK_SPECS = MASONRY_LAYOUT.filter(item =>
	DOCK_ITEMS.some(d => d.id === item.id),
)

interface VirtualCard {
	key: string
	cardId: CardId
	left: number
	top: number
	width: number
	height: number
	enterDelay?: number
}

interface SafeRect {
	left: number
	top: number
	width: number
	height: number
}

const useIsoLayoutEffect =
	typeof window !== "undefined" ? useLayoutEffect : useEffect

function getCanvasScale(vw: number) {
	if (vw < 640) return 0.66
	if (vw < 1024) return 0.84
	return 1
}

function computeInitialCamera(vw: number, vh: number) {
	const scale = getCanvasScale(vw)
	if (vw >= 1024) {
		const sidebarW = Math.min(528, Math.max(400, vw * 0.3))
		return {
			x: 830 - (sidebarW + (vw - sidebarW) / 2),
			y: 720 - (vh - 64) / 2,
			scale,
		}
	}
	return {
		x: 768 - vw / 2 / scale,
		y: 602 - (56 + Math.max(180, vh - 346) / 2) / scale,
		scale,
	}
}

function buildMacroCards(
	txMin: number,
	txMax: number,
	tyMin: number,
	tyMax: number,
	camX: number,
	camY: number,
	vwWorld: number,
	vhWorld: number,
	withEnter: boolean,
	margin = 360,
): VirtualCard[] {
	const out: VirtualCard[] = []
	let enterIdx = 0

	for (let ty = tyMin; ty <= tyMax; ty++) {
		const baseY = ty * MACRO_H
		for (let tx = txMin; tx <= txMax; tx++) {
			const baseX = tx * MACRO_W
			for (const item of MASONRY_LAYOUT) {
				const left = baseX + item.x
				const top = baseY + item.y
				if (
					left + item.w < camX - margin ||
					left > camX + vwWorld + margin ||
					top + item.h < camY - margin ||
					top > camY + vhWorld + margin
				) {
					continue
				}
				out.push({
					key: `${tx}:${ty}:${item.id}`,
					cardId: item.id,
					left,
					top,
					width: item.w,
					height: item.h,
					enterDelay: withEnter
						? INITIAL_DELAYS[
								Math.min(enterIdx++, INITIAL_DELAYS.length - 1)
							]
						: undefined,
				})
			}
		}
	}
	return out
}

function cardKeysSignature(list: readonly VirtualCard[]): string {
	let sig = ""
	for (let i = 0; i < list.length; i++) {
		sig += list[i]!.key + "|"
	}
	return sig
}

export function LadduShowcase() {
	const [mascotId, setMascotId] = useState("laddu")
	const [promptIdx, setPromptIdx] = useState(0)
	const [showTrace, setShowTrace] = useState(false)
	const [takenOver, setTakenOver] = useState(false)
	const [reminderPaused, setReminderPaused] = useState(false)
	const [activeModel, setActiveModel] = useState("claude")
	const [stoppedMine, setStoppedMine] = useState(false)
	const [teamInvited, setTeamInvited] = useState(false)
	const [installOpen, setInstallOpen] = useState(false)
	const [installMounted, setInstallMounted] = useState(false)
	const [activeDock, setActiveDock] = useState<CardId>("skins")
	const [cards, setCards] = useState<VirtualCard[]>(() =>
		buildMacroCards(-1, 1, -1, 1, -275, 302, 1680, 940, true, 160),
	)

	const [toaster] = useState(() => createToaster())
	useEffect(() => () => toaster.dismiss(), [toaster])

	const mascot = MASCOTS.find(m => m.id === mascotId) ?? MASCOTS[0]!

	const stageRef = useRef<HTMLElement>(null)
	const worldRef = useRef<HTMLDivElement>(null)
	const panelRef = useRef<HTMLElement>(null)
	const brandAvRef = useRef<HTMLSpanElement>(null)
	const quietBtnRef = useRef<HTMLButtonElement>(null)

	// Cached layout metrics (updated only on mount & resize — zero forced reflows during pan/wheel)
	const viewportRef = useRef({ vw: 1680, vh: 940 })
	const safeRectRef = useRef<SafeRect>({
		left: 504,
		top: 0,
		width: 1176,
		height: 876,
	})
	const activeDockRef = useRef<CardId>("skins")
	const mountedKeysRef = useRef("")
	const prefetchedDialogRef = useRef(false)

	// Camera coordinates are in world units; zoom scales cards on smaller screens
	const cam = useRef({ x: -275, y: 302, vx: 0, vy: 0, scale: 1 })
	const springTarget = useRef<{ x: number; y: number } | null>(null)
	const springCardIdRef = useRef<CardId | null>(null)
	const rafId = useRef(0)
	const wheelRafId = useRef(0)
	const wheelDeltaRef = useRef({ dx: 0, dy: 0 })
	const dockTimerRef = useRef<number | null>(null)
	const lastTick = useRef(0)
	const lastBucket = useRef("")
	const initializedCam = useRef(false)
	const dragRef = useRef({
		active: false,
		pointerId: -1,
		lastX: 0,
		lastY: 0,
		lastTime: 0,
	})

	const prefersReduced = () =>
		typeof window !== "undefined" &&
		window.matchMedia("(prefers-reduced-motion: reduce)").matches

	const measureLayout = useCallback(() => {
		const vw = window.innerWidth
		const vh = window.innerHeight
		viewportRef.current = { vw, vh }

		const panelRect = panelRef.current?.getBoundingClientRect()
		if (vw >= 1024) {
			const left = panelRect
				? panelRect.width
				: Math.min(528, Math.max(400, vw * 0.3))
			safeRectRef.current = {
				left,
				top: 0,
				width: Math.max(240, vw - left),
				height: Math.max(240, vh - 64),
			}
		} else {
			const bottomH = panelRect ? panelRect.height : 280
			safeRectRef.current = {
				left: 0,
				top: 56,
				width: vw,
				height: Math.max(180, vh - bottomH - 56),
			}
		}
	}, [])

	const syncGrid = useCallback((force = false) => {
		const world = worldRef.current
		if (!world) return

		const { x: camX, y: camY, scale } = cam.current
		world.style.transform = `scale(${scale}) translate3d(${-camX}px, ${-camY}px, 0)`

		const { vw, vh } = viewportRef.current
		if (vw === 0 || vh === 0) return

		const vwWorld = vw / scale
		const vhWorld = vh / scale

		const bx = Math.floor(camX / 240)
		const by = Math.floor(camY / 240)
		const bucketSig = `${bx}:${by}:${Math.round(vwWorld / 160)}:${Math.round(vhWorld / 160)}:${scale}`
		if (!force && bucketSig === lastBucket.current) return
		lastBucket.current = bucketSig

		const pad = 420
		const txMin = Math.floor((camX - pad) / MACRO_W) - 1
		const txMax = Math.floor((camX + vwWorld + pad) / MACRO_W) + 1
		const tyMin = Math.floor((camY - pad) / MACRO_H) - 1
		const tyMax = Math.floor((camY + vhWorld + pad) / MACRO_H) + 1

		const nextCards = buildMacroCards(
			txMin,
			txMax,
			tyMin,
			tyMax,
			camX,
			camY,
			vwWorld,
			vhWorld,
			false,
			400,
		)
		const nextSig = cardKeysSignature(nextCards)
		if (!force && nextSig === mountedKeysRef.current) return
		mountedKeysRef.current = nextSig

		startTransition(() => {
			setCards(nextCards)
		})
	}, [])

	const updateDockFromCamera = useCallback(() => {
		const safe = safeRectRef.current
		const scale = cam.current.scale
		const cx = cam.current.x + (safe.left + safe.width / 2) / scale
		const cy = cam.current.y + (safe.top + safe.height / 2) / scale
		const tx0 = Math.floor(cx / MACRO_W)
		const ty0 = Math.floor(cy / MACRO_H)

		let bestId: CardId | null = null
		let bestDist = Infinity
		for (let ty = ty0 - 1; ty <= ty0 + 1; ty++) {
			for (let tx = tx0 - 1; tx <= tx0 + 1; tx++) {
				for (const item of DOCK_SPECS) {
					const mx = tx * MACRO_W + item.x + item.w / 2
					const my = ty * MACRO_H + item.y + item.h / 2
					const d = Math.hypot(mx - cx, my - cy)
					if (d < bestDist) {
						bestDist = d
						bestId = item.id
					}
				}
			}
		}
		if (bestId && bestId !== activeDockRef.current) {
			activeDockRef.current = bestId
			setActiveDock(bestId)
		}
	}, [])

	const stopMotion = useCallback(() => {
		springTarget.current = null
		springCardIdRef.current = null
		cam.current.vx = 0
		cam.current.vy = 0
		if (rafId.current) {
			cancelAnimationFrame(rafId.current)
			rafId.current = 0
		}
		if (wheelRafId.current) {
			cancelAnimationFrame(wheelRafId.current)
			wheelRafId.current = 0
		}
		wheelDeltaRef.current.dx = 0
		wheelDeltaRef.current.dy = 0
	}, [])

	const ensureLoop = useCallback(() => {
		if (rafId.current) return
		lastTick.current = performance.now()

		const tick = (now: number) => {
			rafId.current = 0
			const dt = Math.min(
				0.032,
				Math.max(0.004, (now - lastTick.current) / 1000),
			)
			lastTick.current = now
			const c = cam.current
			const target = springTarget.current

			if (target) {
				const dx = target.x - c.x
				const dy = target.y - c.y
				const ax = dx * SPRING_K - c.vx * SPRING_D
				const ay = dy * SPRING_K - c.vy * SPRING_D
				c.vx += ax * dt
				c.vy += ay * dt
				c.x += c.vx * dt
				c.y += c.vy * dt
				syncGrid()

				if (
					Math.abs(dx) < 0.5 &&
					Math.abs(dy) < 0.5 &&
					Math.abs(c.vx) < 4 &&
					Math.abs(c.vy) < 4
				) {
					c.x = target.x
					c.y = target.y
					c.vx = 0
					c.vy = 0
					springTarget.current = null
					springCardIdRef.current = null
					syncGrid(true)
					updateDockFromCamera()
				} else {
					rafId.current = requestAnimationFrame(tick)
				}
				return
			}

			if (
				!prefersReduced() &&
				(Math.abs(c.vx) > 8 || Math.abs(c.vy) > 8)
			) {
				c.x += c.vx * dt
				c.y += c.vy * dt
				const decay = Math.pow(0.045, dt)
				c.vx *= decay
				c.vy *= decay
				syncGrid()
				rafId.current = requestAnimationFrame(tick)
			} else {
				c.vx = 0
				c.vy = 0
				updateDockFromCamera()
			}
		}

		rafId.current = requestAnimationFrame(tick)
	}, [syncGrid, updateDockFromCamera])

	const computeTargetForCard = useCallback((targetId: CardId) => {
		const spec = MASONRY_LAYOUT.find(item => item.id === targetId)
		if (!spec) return null

		const safe = safeRectRef.current
		const scale = cam.current.scale
		const centerX = cam.current.x + (safe.left + safe.width / 2) / scale
		const centerY = cam.current.y + (safe.top + safe.height / 2) / scale
		const tx0 = Math.floor(centerX / MACRO_W)
		const ty0 = Math.floor(centerY / MACRO_H)

		let bestX = cam.current.x
		let bestY = cam.current.y
		let bestDist = Infinity

		for (let ty = ty0 - 1; ty <= ty0 + 1; ty++) {
			for (let tx = tx0 - 1; tx <= tx0 + 1; tx++) {
				const wx = tx * MACRO_W + spec.x + spec.w / 2
				const wy = ty * MACRO_H + spec.y + spec.h / 2
				const d = Math.hypot(wx - centerX, wy - centerY)
				if (d < bestDist) {
					bestDist = d
					bestX = wx - (safe.left + safe.width / 2) / scale
					bestY = wy - (safe.top + safe.height / 2) / scale
				}
			}
		}

		return { x: bestX, y: bestY }
	}, [])

	const jumpToCard = useCallback(
		(targetId: CardId) => {
			activeDockRef.current = targetId
			setActiveDock(targetId)
			const target = computeTargetForCard(targetId)
			if (!target) return

			if (prefersReduced()) {
				stopMotion()
				cam.current.x = target.x
				cam.current.y = target.y
				syncGrid(true)
				return
			}

			stopMotion()
			springCardIdRef.current = targetId
			springTarget.current = target
			ensureLoop()
		},
		[computeTargetForCard, ensureLoop, stopMotion, syncGrid],
	)

	// Place hero composition identically to pre-paint inline script (zero layout shift on refresh)
	useIsoLayoutEffect(() => {
		const updateLayout = () => {
			measureLayout()
			const { vw, vh } = viewportRef.current
			cam.current.scale = getCanvasScale(vw)

			if (!initializedCam.current) {
				initializedCam.current = true
				const init = computeInitialCamera(vw, vh)
				cam.current.x = init.x
				cam.current.y = init.y
				cam.current.scale = init.scale
			} else if (springTarget.current && springCardIdRef.current) {
				const recomputed = computeTargetForCard(springCardIdRef.current)
				if (recomputed) springTarget.current = recomputed
			}
			syncGrid(true)
		}
		updateLayout()
		window.addEventListener("resize", updateLayout, { passive: true })
		return () => {
			window.removeEventListener("resize", updateLayout)
			stopMotion()
		}
	}, [computeTargetForCard, measureLayout, stopMotion, syncGrid])

	// Coalesce high-frequency trackpad wheel events into 1 transform write per rAF + debounced dock sync
	useEffect(() => {
		const stage = stageRef.current
		if (!stage) return

		const flushWheel = () => {
			wheelRafId.current = 0
			const { dx, dy } = wheelDeltaRef.current
			if (dx === 0 && dy === 0) return
			wheelDeltaRef.current.dx = 0
			wheelDeltaRef.current.dy = 0
			const s = cam.current.scale
			cam.current.x += dx / s
			cam.current.y += dy / s
			syncGrid()
		}

		const onWheel = (e: WheelEvent) => {
			// Preserve native browser pinch/Ctrl+wheel zoom gestures
			if (e.ctrlKey || e.metaKey) return
			e.preventDefault()
			stopMotion()
			const unit =
				e.deltaMode === WheelEvent.DOM_DELTA_LINE
					? 16
					: e.deltaMode === WheelEvent.DOM_DELTA_PAGE
						? viewportRef.current.vh || window.innerHeight
						: 1
			wheelDeltaRef.current.dx += e.deltaX * unit
			wheelDeltaRef.current.dy += e.deltaY * unit
			if (!wheelRafId.current) {
				wheelRafId.current = requestAnimationFrame(flushWheel)
			}
			if (dockTimerRef.current !== null) {
				window.clearTimeout(dockTimerRef.current)
			}
			dockTimerRef.current = window.setTimeout(() => {
				dockTimerRef.current = null
				updateDockFromCamera()
			}, 120)
		}

		stage.addEventListener("wheel", onWheel, { passive: false })
		return () => {
			stage.removeEventListener("wheel", onWheel)
			if (wheelRafId.current) cancelAnimationFrame(wheelRafId.current)
			if (dockTimerRef.current !== null) {
				window.clearTimeout(dockTimerRef.current)
			}
		}
	}, [stopMotion, syncGrid, updateDockFromCamera])

	const handlePointerDown = (e: React.PointerEvent<HTMLElement>) => {
		if (dragRef.current.active) return
		const target = e.target as HTMLElement | null
		if (target?.closest("button, a, nav, [role='radiogroup']")) return
		stopMotion()
		dragRef.current = {
			active: true,
			pointerId: e.pointerId,
			lastX: e.clientX,
			lastY: e.clientY,
			lastTime: performance.now(),
		}
		stageRef.current?.classList.add("dragging")
		stageRef.current?.setPointerCapture(e.pointerId)
	}

	const handlePointerMove = (e: React.PointerEvent<HTMLElement>) => {
		const d = dragRef.current
		if (!d.active || e.pointerId !== d.pointerId) return
		const now = performance.now()
		const s = cam.current.scale
		const dx = (e.clientX - d.lastX) / s
		const dy = (e.clientY - d.lastY) / s
		const dt = Math.max(0.004, (now - d.lastTime) / 1000)

		cam.current.x -= dx
		cam.current.y -= dy

		const instVx = Math.max(-2800, Math.min(2800, -dx / dt))
		const instVy = Math.max(-2800, Math.min(2800, -dy / dt))
		cam.current.vx = cam.current.vx * 0.65 + instVx * 0.35
		cam.current.vy = cam.current.vy * 0.65 + instVy * 0.35

		d.lastX = e.clientX
		d.lastY = e.clientY
		d.lastTime = now
		syncGrid()
	}

	const handlePointerEnd = (e: React.PointerEvent<HTMLElement>) => {
		const d = dragRef.current
		if (!d.active || e.pointerId !== d.pointerId) return
		d.active = false
		d.pointerId = -1
		stageRef.current?.classList.remove("dragging")
		if (performance.now() - d.lastTime > 70) {
			cam.current.vx = 0
			cam.current.vy = 0
		}
		ensureLoop()
	}

	const handlePointerCancel = (e: React.PointerEvent<HTMLElement>) => {
		const d = dragRef.current
		if (!d.active || e.pointerId !== d.pointerId) return
		d.active = false
		d.pointerId = -1
		stageRef.current?.classList.remove("dragging")
		cam.current.vx = 0
		cam.current.vy = 0
		updateDockFromCamera()
	}

	const handleStageKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
		const target = e.target as HTMLElement | null
		if (target?.closest("button, a, input, [role='radiogroup']")) return
		const step = e.shiftKey ? 360 : 180
		let dx = 0
		let dy = 0
		if (e.key === "ArrowLeft") dx = -step
		else if (e.key === "ArrowRight") dx = step
		else if (e.key === "ArrowUp") dy = -step
		else if (e.key === "ArrowDown") dy = step
		else if (e.key === "Home") {
			e.preventDefault()
			jumpToCard("skins")
			return
		} else {
			return
		}
		e.preventDefault()
		stopMotion()
		cam.current.x += dx
		cam.current.y += dy
		syncGrid(true)
		updateDockFromCamera()
	}

	const handleSelectMascot = useCallback((id: string) => {
		setMascotId(id)
		if (!prefersReduced()) {
			brandAvRef.current?.animate(
				[
					{ transform: "scale(0.88)" },
					{ transform: "scale(1.07)", offset: 0.55 },
					{ transform: "scale(1)" },
				],
				{ duration: 280, easing: "cubic-bezier(0.23, 1, 0.32, 1)" },
			)
		}
	}, [])

	const handleCopySuccess = useCallback(
		(cmd: string) => {
			toaster.success("Copied install command", { description: cmd })
		},
		[toaster],
	)

	const handleCyclePrompt = useCallback(() => {
		setPromptIdx(i => (i + 1) % SCENARIOS.length)
		setShowTrace(false)
	}, [])

	const handlePrefetchInstall = useCallback(() => {
		if (prefetchedDialogRef.current) return
		prefetchedDialogRef.current = true
		loadInstallDialog().catch(() => {
			prefetchedDialogRef.current = false
		})
	}, [])

	const handleDialogLoadError = useCallback(() => {
		setInstallOpen(false)
		setInstallMounted(false)
		prefetchedDialogRef.current = false
		toaster.info("Run in your Linux terminal", {
			description: "curl -fsSL https://laddu.wtf/install.sh | sh",
		})
	}, [toaster])

	const handleOpenInstall = useCallback(() => {
		setInstallMounted(true)
		setInstallOpen(true)
	}, [])

	return (
		<>
			<main className="app" id="app">
				{/* Full-bleed infinite draggable canvas behind the panel (heydamir.design pattern) */}
				<section
					ref={stageRef}
					className="canvas-stage"
					id="stage"
					tabIndex={-1}
					aria-label="Interactive infinite product canvas"
					onPointerDown={handlePointerDown}
					onPointerMove={handlePointerMove}
					onPointerUp={handlePointerEnd}
					onPointerCancel={handlePointerCancel}
					onKeyDown={handleStageKeyDown}
					onDragStart={e => e.preventDefault()}
				>
					<div className="canvas-world" ref={worldRef}>
						{cards.map(card => (
							<article
								className="tile"
								data-tile={card.cardId}
								data-enter={
									card.enterDelay !== undefined
										? "true"
										: undefined
								}
								key={card.key}
								style={
									{
										left: card.left,
										top: card.top,
										width: card.width,
										height: card.height,
										"--enter-delay":
											card.enterDelay !== undefined
												? `${card.enterDelay}ms`
												: undefined,
									} as React.CSSProperties
								}
							>
								<ShowcaseCard
									id={card.cardId}
									mascot={mascot}
									promptIdx={promptIdx}
									showTrace={showTrace}
									takenOver={takenOver}
									reminderPaused={reminderPaused}
									activeModel={activeModel}
									stoppedMine={stoppedMine}
									teamInvited={teamInvited}
									onCyclePrompt={handleCyclePrompt}
									onShowTraceChange={setShowTrace}
									onTakenOverChange={setTakenOver}
									onReminderPausedChange={setReminderPaused}
									onStoppedMineChange={setStoppedMine}
									onTeamInvitedChange={setTeamInvited}
									onSelectModel={setActiveModel}
									onSelectMascot={handleSelectMascot}
									onOpenInstall={handleOpenInstall}
									onCopySuccess={handleCopySuccess}
								/>
							</article>
						))}
					</div>

					<div className="canvas-dock-wrap">
						<span className="drag-hint" aria-hidden="true">
							<svg className="ico ico-xs" viewBox="0 0 24 24">
								<path d="M5 9l-3 3 3 3M9 5l3-3 3 3M15 19l-3 3-3-3M19 9l3 3-3 3M2 12h20M12 2v20" />
							</svg>
							<span>Drag</span>
						</span>
						<SegmentedControl
							className="dock-segmented"
							aria-label="Jump to a product card"
							value={activeDock}
							onValueChange={val => {
								if (val) jumpToCard(val as CardId)
							}}
						>
							<SegmentedControlIndicator className="dock-indicator" />
							{DOCK_ITEMS.map(item => (
								<SegmentedControlItem
									className="dock-btn"
									key={item.id}
									value={item.id}
								>
									{item.label}
								</SegmentedControlItem>
							))}
						</SegmentedControl>
					</div>
				</section>

				{/* Pinned Left Rail on Desktop (>=1024px) / Pinned Bottom Sheet on Mobile (<1024px) */}
				<aside
					ref={panelRef}
					className="panel-wrap"
					aria-label="About laddu"
				>
					<div className="sidebar">
						<header className="side-top intro-fade">
							<div className="identity">
								<span className="brand-av" ref={brandAvRef}>
									<img
										src={mascot.thumb}
										alt={`${mascot.name} mascot`}
										width={36}
										height={36}
										decoding="async"
									/>
								</span>
								<div className="id-text">
									<TextMorph
										as="span"
										className="id-name"
										duration={340}
									>
										{mascot.name}
									</TextMorph>
									<span className="id-sub">
										Self-hosted in Slack
									</span>
								</div>
							</div>
							<a
								className="btn-quiet btn-sm"
								href="https://github.com/mohiwalla/laddu"
								target="_blank"
								rel="noreferrer"
							>
								<img
									src="/icons/github.svg"
									alt=""
									width={14}
									height={14}
									className="brand-ico"
								/>
								<span>GitHub</span>
							</a>
						</header>

						<div className="side-hero">
							<h1 className="intro-lead">
								Your team’s private AI teammate in{" "}
								<span className="glow-word">Slack</span>
							</h1>
							<p className="side-lead intro-sub">
								Runs on your own Linux box. Tag{" "}
								<TextMorph
									as="strong"
									className="lead-strong"
									duration={340}
								>
									{`@${mascot.name}`}
								</TextMorph>{" "}
								in any thread—it works inside your own sandboxed
								computer and replies right there.
							</p>

							<div className="cta-row intro-cta">
								<ShinyInstallButton
									onClick={handleOpenInstall}
									onPrefetch={handlePrefetchInstall}
								/>

								<Button
									ref={quietBtnRef}
									className="btn-quiet btn-md"
									onClick={() => {
										handleCyclePrompt()
										jumpToCard("slack")
									}}
									onPointerMove={e => {
										const el = quietBtnRef.current
										if (!el) return
										const r = el.getBoundingClientRect()
										el.style.setProperty(
											"--gx",
											`${(e.clientX - r.left).toFixed(1)}px`,
										)
										el.style.setProperty(
											"--gy",
											`${(e.clientY - r.top).toFixed(1)}px`,
										)
										el.style.setProperty("--glow", "1")
									}}
									onPointerLeave={() => {
										quietBtnRef.current?.style.setProperty(
											"--glow",
											"0",
										)
									}}
								>
									<span
										className="btn-quiet-spot"
										aria-hidden="true"
									/>
									<span className="btn-quiet-label">
										See it work
									</span>
								</Button>
							</div>
						</div>

						<footer className="side-foot intro-foot">
							<div className="foot-line">
								<img
									src="/icons/osi.svg"
									alt=""
									width={16}
									height={16}
									className="brand-ico"
								/>
								<span>MIT open source · Free forever</span>
							</div>
							<p className="foot-meta">
								BYO ChatGPT, Claude, Antigravity or OpenCode ·
								Zero vendor lock-in
							</p>
						</footer>
					</div>
				</aside>
			</main>

			{installMounted && (
				<DialogErrorBoundary onError={handleDialogLoadError}>
					<Suspense fallback={null}>
						<LazyInstallDialog
							open={installOpen}
							onOpenChange={setInstallOpen}
							onCopySuccess={handleCopySuccess}
						/>
					</Suspense>
				</DialogErrorBoundary>
			)}

			<ToastRegion toaster={toaster} className="laddu-toasts">
				{() => (
					<Toast className="laddu-toast">
						<svg
							className="ico"
							viewBox="0 0 24 24"
							aria-hidden="true"
							style={{ color: "var(--positive)" }}
						>
							<path d="M20 6 9 17l-5-5" />
						</svg>
						<div style={{ minWidth: 0 }}>
							<ToastTitle className="laddu-toast-title" />
							<ToastDescription className="laddu-toast-desc" />
						</div>
					</Toast>
				)}
			</ToastRegion>
		</>
	)
}
