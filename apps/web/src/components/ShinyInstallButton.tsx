import { Button } from "@ui-sdk/react/button"
import { useEffect, useRef } from "react"

export interface ShinyInstallButtonProps {
	onClick: () => void
	onPrefetch?: () => void
}

interface Spark {
	x: number
	y: number
	vx: number
	vy: number
	size: number
	alpha: number
	life: number
	maxLife: number
	hue: string
}

const SPARK_COLORS = ["#fff4e4", "#ffb470", "#ff7d38", "#f7dcb8"]

export function ShinyInstallButton({
	onClick,
	onPrefetch,
}: ShinyInstallButtonProps) {
	const wrapRef = useRef<HTMLDivElement>(null)
	const btnRef = useRef<HTMLButtonElement>(null)
	const canvasRef = useRef<HTMLCanvasElement>(null)
	const rectRef = useRef<DOMRect | null>(null)
	const hoveredRef = useRef(false)
	const sparksRef = useRef<Spark[]>([])
	const rafRef = useRef(0)

	useEffect(() => {
		return () => {
			if (rafRef.current) cancelAnimationFrame(rafRef.current)
		}
	}, [])

	const startSparkLoop = () => {
		if (rafRef.current) return
		if (
			typeof window === "undefined" ||
			window.matchMedia("(prefers-reduced-motion: reduce)").matches
		) {
			return
		}

		let last = performance.now()
		let spawnAcc = 0

		const tick = (now: number) => {
			rafRef.current = 0
			const canvas = canvasRef.current
			const wrap = wrapRef.current
			if (!canvas || !wrap) return

			const dt = Math.min(0.05, Math.max(0.004, (now - last) / 1000))
			last = now

			const dpr = Math.min(window.devicePixelRatio || 1, 2)
			const w = wrap.offsetWidth + 80
			const h = wrap.offsetHeight + 80
			if (
				canvas.width !== Math.round(w * dpr) ||
				canvas.height !== Math.round(h * dpr)
			) {
				canvas.width = Math.round(w * dpr)
				canvas.height = Math.round(h * dpr)
			}

			const ctx = canvas.getContext("2d")
			if (!ctx) return

			ctx.save()
			ctx.scale(dpr, dpr)
			ctx.clearRect(0, 0, w, h)

			if (hoveredRef.current) {
				spawnAcc += dt * 26
				while (spawnAcc >= 1) {
					spawnAcc -= 1
					// Spawn along the pill perimeter
					const pad = 40
					const bw = wrap.offsetWidth
					const bh = wrap.offsetHeight
					const angle = Math.random() * Math.PI * 2
					const rx = bw * 0.5
					const ry = bh * 0.5
					const sx =
						pad +
						rx +
						Math.cos(angle) * (rx * (0.85 + Math.random() * 0.2))
					const sy =
						pad +
						ry +
						Math.sin(angle) * (ry * (0.85 + Math.random() * 0.2))
					const speed = 14 + Math.random() * 26
					sparksRef.current.push({
						x: sx,
						y: sy,
						vx:
							Math.cos(angle) * speed +
							(Math.random() - 0.5) * 10,
						vy: Math.sin(angle) * speed - 10 - Math.random() * 14,
						size: 0.9 + Math.random() * 1.5,
						alpha: 0.8 + Math.random() * 0.2,
						life: 0,
						maxLife: 0.55 + Math.random() * 0.55,
						hue: SPARK_COLORS[
							Math.floor(Math.random() * SPARK_COLORS.length)
						]!,
					})
				}
			}

			const alive: Spark[] = []
			for (const s of sparksRef.current) {
				s.life += dt
				if (s.life >= s.maxLife) continue
				s.x += s.vx * dt
				s.y += s.vy * dt
				s.vx *= 0.96
				s.vy *= 0.97
				const t = s.life / s.maxLife
				const fade = t < 0.2 ? t / 0.2 : 1 - (t - 0.2) / 0.8
				ctx.globalAlpha = Math.max(0, s.alpha * fade)
				ctx.fillStyle = s.hue
				ctx.beginPath()
				ctx.arc(s.x, s.y, s.size * (1 - t * 0.35), 0, Math.PI * 2)
				ctx.fill()
				alive.push(s)
			}
			sparksRef.current = alive
			ctx.restore()

			if (hoveredRef.current || alive.length > 0) {
				rafRef.current = requestAnimationFrame(tick)
			}
		}

		rafRef.current = requestAnimationFrame(tick)
	}

	const handlePointerEnter = () => {
		onPrefetch?.()
		if (btnRef.current) {
			rectRef.current = btnRef.current.getBoundingClientRect()
		}
	}

	const handlePointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
		const el = btnRef.current
		const wrap = wrapRef.current
		if (!el || !wrap) return
		const r = rectRef.current ?? el.getBoundingClientRect()
		rectRef.current = r
		const gx = `${(e.clientX - r.left).toFixed(1)}px`
		const gy = `${(e.clientY - r.top).toFixed(1)}px`
		el.style.setProperty("--gx", gx)
		el.style.setProperty("--gy", gy)
		el.style.setProperty("--glow", "1")
		wrap.dataset.hover = "true"
		if (!hoveredRef.current) {
			hoveredRef.current = true
			startSparkLoop()
		}
	}

	const handlePointerLeave = () => {
		hoveredRef.current = false
		rectRef.current = null
		btnRef.current?.style.setProperty("--glow", "0")
		if (wrapRef.current) {
			wrapRef.current.dataset.hover = "false"
		}
	}

	return (
		<div className="cta-rim" ref={wrapRef} data-hover="false">
			<Button
				ref={btnRef}
				className="btn-primary"
				onClick={onClick}
				onPointerEnter={handlePointerEnter}
				onFocus={onPrefetch}
				onPointerMove={handlePointerMove}
				onPointerLeave={handlePointerLeave}
			>
				<span className="btn-glow-layer" aria-hidden="true">
					<span className="btn-outer-halo">
						<span className="btn-ember-blur" />
						<span className="btn-flame-blur" />
					</span>
					<span className="btn-core-spot" />
					<span className="btn-sheen" />
				</span>
				<span className="btn-primary-label">
					<span>Install laddu</span>
					<svg
						className="ico ico-bold btn-arrow"
						viewBox="0 0 20 20"
						aria-hidden="true"
					>
						<path d="M4 10h11.5M11 5.5l4.5 4.5-4.5 4.5" />
					</svg>
				</span>
			</Button>

			{/* Thick 4px spinning metallic liquid-gold bevel rim */}
			<div className="cta-rim-ring" aria-hidden="true">
				<div className="cta-rim-spin" />
				<div className="cta-rim-bevel" />
			</div>

			{/* Outer ambient plus-lighter bloom (static GPU layer, zero per-frame blur) */}
			<div className="cta-rim-aura" aria-hidden="true" />

			{/* Floating warm spark particles on hover */}
			<canvas ref={canvasRef} className="cta-sparks" aria-hidden="true" />
		</div>
	)
}
