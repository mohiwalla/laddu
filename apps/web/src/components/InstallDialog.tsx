import {
	Dialog,
	DialogBackdrop,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from "@ui-sdk/react/dialog"
import { INSTALL_COMMAND } from "../data/showcase"
import { CopyButton } from "./CopyButton"

interface InstallDialogProps {
	open: boolean
	onOpenChange: (open: boolean) => void
	onCopySuccess: (text: string) => void
}

export function InstallDialog({
	open,
	onOpenChange,
	onCopySuccess,
}: InstallDialogProps) {
	return (
		<Dialog open={open} onOpenChange={next => onOpenChange(next)}>
			<DialogBackdrop className="install-backdrop" />
			<DialogContent className="install-dialog">
				<div className="sheet-card">
					<div className="sheet-top">
						<DialogTitle className="sheet-title">
							Install laddu on your Linux server
						</DialogTitle>
						<DialogClose
							className="sheet-close"
							aria-label="Close install dialog"
						>
							<svg
								className="ico"
								viewBox="0 0 24 24"
								aria-hidden="true"
							>
								<path d="M18 6 6 18M6 6l12 12" />
							</svg>
						</DialogClose>
					</div>

					<DialogDescription className="sheet-desc">
						One command sets up the service on your own Linux server
						with systemd.
					</DialogDescription>

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

					<ol className="sheet-steps">
						<li>
							<span className="step-num">01</span>
							<span>
								Installs Docker and Bun automatically if they
								aren’t on the server yet.
							</span>
						</li>
						<li>
							<span className="step-num">02</span>
							<span>
								Creates your Slack app, connects your AI
								provider (ChatGPT, Claude, Antigravity, or
								OpenCode), and starts as a systemd service.
							</span>
						</li>
						<li>
							<span className="step-num">03</span>
							<span>
								DMs only you at first so you can verify
								everything privately before inviting your team.
							</span>
						</li>
					</ol>

					<div className="sheet-foot">
						<p className="sheet-note">
							MIT licensed and free forever. Each person’s login
							lives only inside their own internet-only
							container—zero vendor lock-in.
						</p>
						<a
							className="btn-quiet btn-sm"
							href="https://github.com/mohiwalla/laddu"
							target="_blank"
							rel="noreferrer"
						>
							<span>Inspect source</span>
							<svg
								className="ico"
								viewBox="0 0 20 20"
								aria-hidden="true"
							>
								<path d="M6 14 14 6M8 6h6v6" />
							</svg>
						</a>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	)
}

export default InstallDialog
