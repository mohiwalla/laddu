import { Button } from "@ui-sdk/react/button"
import { useEffect, useRef, useState } from "react"
import { TextMorph } from "torph/react"

export interface CopyButtonProps {
	text: string
	onCopied: (text: string) => void
}

async function copyText(text: string): Promise<boolean> {
	try {
		if (navigator.clipboard?.writeText) {
			await navigator.clipboard.writeText(text)
			return true
		}
	} catch {
		// Fall through to legacy selection copy fallback
	}
	try {
		const ta = document.createElement("textarea")
		ta.value = text
		ta.setAttribute("readonly", "")
		ta.style.position = "fixed"
		ta.style.opacity = "0"
		document.body.appendChild(ta)
		ta.select()
		const ok = document.execCommand("copy")
		ta.remove()
		return ok
	} catch {
		return false
	}
}

export function CopyButton({ text, onCopied }: CopyButtonProps) {
	const [copied, setCopied] = useState(false)
	const timerRef = useRef<number | null>(null)

	useEffect(
		() => () => {
			if (timerRef.current !== null) window.clearTimeout(timerRef.current)
		},
		[],
	)

	async function handleCopy() {
		const ok = await copyText(text)
		if (!ok) return
		onCopied(text)
		if (timerRef.current !== null) window.clearTimeout(timerRef.current)

		setCopied(true)
		timerRef.current = window.setTimeout(() => {
			setCopied(false)
			timerRef.current = null
		}, 1600)
	}

	return (
		<Button
			className="copy-mini"
			data-copied={copied ? "true" : "false"}
			onClick={e => {
				e.stopPropagation()
				void handleCopy()
			}}
		>
			<span className="copy-label">
				{copied ? (
					<svg
						className="ico ico-xs"
						viewBox="0 0 24 24"
						aria-hidden="true"
					>
						<path d="M20 6 9 17l-5-5" />
					</svg>
				) : (
					<svg
						className="ico ico-xs"
						viewBox="0 0 24 24"
						aria-hidden="true"
					>
						<rect width="13" height="13" x="9" y="9" rx="2" />
						<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
					</svg>
				)}
				<TextMorph as="span" duration={280}>
					{copied ? "Copied" : "Copy"}
				</TextMorph>
			</span>
		</Button>
	)
}
