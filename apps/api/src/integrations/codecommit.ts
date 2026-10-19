/** AWS CodeCommit via explicitly assigned host AWS CLI profiles; no AWS credentials in containers. */
import type { BotConfig } from "../config"
import { relayGit } from "./git-http"

type Settings = NonNullable<BotConfig["codeCommit"]>
type Person = { teamId: string; userId: string }
export type Repo = { region: string; repository: string }
export type PullRequest = Repo & {
	source: string
	target: string
	title: string
	description: string
	id?: string
}

export class CodeCommitError extends Error {}

function profile(settings: Settings, person: Person): string {
	const value = settings.profiles[person.userId]
	if (!value)
		throw new CodeCommitError(
			"CodeCommit isn't connected for this Slack account. Ask the bot operator to assign your own AWS profile in CODECOMMIT_PROFILES.",
		)
	return value
}

function validate(repo: Repo): void {
	if (
		!/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(repo.region ?? "") ||
		!/^[A-Za-z0-9_.-]{1,100}$/.test(repo.repository ?? "") ||
		[".", ".."].includes(repo.repository)
	)
		throw new CodeCommitError(
			"Give a valid CodeCommit region and repository name.",
		)
}

async function cli(
	settings: Settings,
	person: Person,
	repo: Repo,
	args: string[],
	input?: string,
): Promise<string> {
	validate(repo)
	const name = profile(settings, person)
	const child = Bun.spawn(
		[
			settings.cli,
			"--profile",
			name,
			"--region",
			repo.region,
			"--output",
			"json",
			"codecommit",
			...args,
		],
		{
			env: { ...Bun.env, AWS_PAGER: "", AWS_CLI_AUTO_PROMPT: "off" },
			stdin: new TextEncoder().encode(input ?? ""),
			stdout: "pipe",
			stderr: "pipe",
		},
	)
	const [out, error, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	])
	if (code) {
		if (
			/expired|reauthenticate|sso login|Error loading SSO Token/i.test(
				error,
			)
		)
			throw new CodeCommitError(
				`The AWS profile "${name}" needs to sign in again on the bot host (aws login --profile ${name}, or aws sso login for an SSO profile). No AWS credentials should be sent in Slack.`,
			)
		throw new CodeCommitError(
			`CodeCommit ${args[0]} failed: ${error.trim().slice(0, 600)}`,
		)
	}
	return out
}

async function json<T>(
	settings: Settings,
	person: Person,
	repo: Repo,
	args: string[],
): Promise<T> {
	return JSON.parse(await cli(settings, person, repo, args)) as T
}

export async function repository(
	settings: Settings,
	person: Person,
	repo: Repo,
): Promise<{ id: string; defaultBranch: string }> {
	const result = await json<{
		repositoryMetadata: { repositoryId: string; defaultBranch: string }
	}>(settings, person, repo, [
		"get-repository",
		"--repository-name",
		repo.repository,
	])
	return {
		id: result.repositoryMetadata.repositoryId,
		defaultBranch: result.repositoryMetadata.defaultBranch,
	}
}

export async function gitRequest(
	settings: Settings,
	person: Person,
	request: Request,
): Promise<Response> {
	const url = new URL(request.url)
	const match =
		/^\/codecommit\/git\/([^/]+)\/([^/]+)\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(
			url.pathname,
		)
	if (!match)
		return new Response("Not a CodeCommit Git endpoint.", { status: 404 })
	const repo = {
		region: match[1]!,
		repository: decodeURIComponent(match[2]!),
	}
	validate(repo)
	const base = `https://git-codecommit.${repo.region}.amazonaws.com/v1/repos/${encodeURIComponent(repo.repository)}`
	const credentials = await cli(
		settings,
		person,
		repo,
		["credential-helper", "get"],
		`protocol=https\nhost=git-codecommit.${repo.region}.amazonaws.com\npath=/v1/repos/${repo.repository}\n\n`,
	)
	const values = Object.fromEntries(
		credentials
			.trim()
			.split("\n")
			.map(line => {
				const at = line.indexOf("=")
				return [line.slice(0, at), line.slice(at + 1)]
			}),
	)
	if (!values.username || !values.password)
		throw new CodeCommitError(
			"AWS didn't produce Git credentials; check the assigned profile on the host.",
		)
	return relayGit(
		request,
		new URL(`${base}/${match[3]}`),
		person.userId,
		`Basic ${btoa(`${values.username}:${values.password}`)}`,
	)
}

type AwsPr = {
	pullRequestId: string
	pullRequestStatus: string
	pullRequestTargets: {
		repositoryName: string
		sourceReference: string
		destinationReference: string
	}[]
}
const branch = (value: string) => value.replace(/^refs\/heads\//, "")

/** Check ownership/target and look up a retry before any push or PR mutation. */
export async function check(
	settings: Settings,
	person: Person,
	input: PullRequest,
): Promise<AwsPr | null> {
	validate(input)
	profile(settings, person)
	if (
		!input.source?.startsWith(`dot/${person.userId.toLowerCase()}/`) ||
		!input.target ||
		input.source === input.target
	)
		throw new CodeCommitError(
			"Use your own dot task branch and a different target branch.",
		)
	let ids: string[]
	if (input.id) ids = [input.id]
	else
		ids = (
			await json<{ pullRequestIds: string[] }>(settings, person, input, [
				"list-pull-requests",
				"--repository-name",
				input.repository,
				"--pull-request-status",
				"OPEN",
			])
		).pullRequestIds
	for (const id of ids) {
		const result = await json<{ pullRequest: AwsPr }>(
			settings,
			person,
			input,
			["get-pull-request", "--pull-request-id", id],
		)
		const found = result.pullRequest
		const matches = found.pullRequestTargets.some(
			target =>
				target.repositoryName === input.repository &&
				branch(target.sourceReference) === input.source &&
				branch(target.destinationReference) === input.target,
		)
		if (!matches) {
			if (input.id)
				throw new CodeCommitError(
					"That PR doesn't belong to this task and target.",
				)
			continue
		}
		if (found.pullRequestStatus !== "OPEN")
			throw new CodeCommitError(
				"This task's PR is closed. Start a fresh checkout for new work.",
			)
		return found
	}
	return null
}

export async function pullRequest(
	settings: Settings,
	person: Person,
	input: PullRequest,
): Promise<{ id: string; url: string }> {
	if (
		!input.title?.trim() ||
		input.title.length > 150 ||
		!input.description?.trim() ||
		input.description.length > 4000
	)
		throw new CodeCommitError(
			"Give a title under 150 characters and a description under 4000 characters with the change and validation.",
		)
	const existing = await check(settings, person, input)
	let id: string
	if (existing) {
		id = existing.pullRequestId
		await cli(settings, person, input, [
			"update-pull-request-title",
			"--pull-request-id",
			id,
			"--title",
			input.title,
		])
		await cli(settings, person, input, [
			"update-pull-request-description",
			"--pull-request-id",
			id,
			"--description",
			input.description,
		])
	} else {
		// Stable idempotency token protects a retry when AWS created the PR but its response was lost.
		const token = new Bun.CryptoHasher("sha256")
			.update(
				`${person.teamId}/${person.userId}/${input.region}/${input.repository}/${input.source}/${input.target}`,
			)
			.digest("hex")
		const result = await json<{ pullRequest: AwsPr }>(
			settings,
			person,
			input,
			[
				"create-pull-request",
				"--title",
				input.title,
				"--description",
				input.description,
				"--client-request-token",
				token,
				"--targets",
				JSON.stringify([
					{
						repositoryName: input.repository,
						sourceReference: input.source,
						destinationReference: input.target,
					},
				]),
			],
		)
		id = result.pullRequest.pullRequestId
	}
	console.info(
		`[codecommit] ${person.teamId}-${person.userId}: ${existing ? "updated" : "created"} PR ${id} in ${input.repository}`,
	)
	return {
		id,
		url: `https://${input.region}.console.aws.amazon.com/codesuite/codecommit/repositories/${encodeURIComponent(input.repository)}/pull-requests/${id}?region=${input.region}`,
	}
}
