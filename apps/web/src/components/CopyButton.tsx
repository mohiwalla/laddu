import { Button } from "@ui-sdk/react/button"
import { useEffect, useRef, useState } from "react"
import { TextMorph } from "torph/react"

export interface CopyButtonProps {
	text: string
	onCopied: (text: string) => void
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

	function handleCopy() {
		navigator.clipboard?.writeText(text).catch(() => {})
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
				handleCopy()
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
