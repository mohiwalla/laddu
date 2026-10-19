/**
 * The fields of a `slack ask` form: every Block Kit input a modal can hold. Each is checked against
 * Slack's limits up front (so the command fails, not the click), built into an input block, and its
 * submitted value read back twice: plainly for Codex (IDs, ISO times) and as Slack text for the
 * question's message once answered.
 */
import type { types } from "@slack/bolt"

export const FIELD_TYPES = [
	"text",
	"number",
	"email",
	"url",
	"select",
	"multiselect",
	"radio",
	"checkboxes",
	"date",
	"time",
	"datetime",
	"user",
	"users",
	"channel",
	"channels",
	"conversation",
	"conversations",
	"file",
	"richtext",
] as const
type FieldType = (typeof FIELD_TYPES)[number]

export type Field = {
	name: string
	label: string
	type: FieldType
	required: boolean
	hint?: string
	placeholder?: string
	/** For select, multiselect, radio and checkboxes. */
	options?: string[]
	/** text: several lines. */
	multiline?: boolean
	/** number: decimals allowed. */
	decimal?: boolean
	/** number: bounds. text: length bounds. file: most files. */
	min?: number
	max?: number
	/** file: extensions allowed, e.g. ["pdf", "png"]. */
	filetypes?: string[]
	/**
	 * Filled in already: text for text-like fields; an option (or options) for choices; YYYY-MM-DD,
	 * HH:MM or ISO date-time for dates; Slack IDs for people and channels.
	 */
	initial?: string | number | string[]
}

export class FieldError extends Error {}

const plain = (text: string) => ({ type: "plain_text" as const, text })
const CHOICES: FieldType[] = ["select", "multiselect", "radio", "checkboxes"]
const MULTIPLE: FieldType[] = [
	"multiselect",
	"checkboxes",
	"users",
	"channels",
	"conversations",
]
const isText = (value: unknown, max: number) =>
	typeof value === "string" && value.trim().length > 0 && value.length <= max

/** The fields as given to `slack ask`, checked; throws FieldError saying what's wrong. */
export function parseFields(input: unknown): Field[] {
	if (!Array.isArray(input) || input.length < 1 || input.length > 20)
		throw new FieldError("Give 1–20 fields.")
	const fields: Field[] = []
	input.forEach((raw, index) => {
		const where = `Field ${index + 1}`
		if (typeof raw !== "object" || raw === null)
			throw new FieldError(`${where} must be an object.`)
		const field = raw as Record<string, unknown>
		const type = field.type ?? "text"
		if (!FIELD_TYPES.includes(type as FieldType))
			throw new FieldError(
				`${where}: type must be one of ${FIELD_TYPES.join(", ")}.`,
			)
		if (!isText(field.label, 100))
			throw new FieldError(
				`${where}: give a label (at most 100 characters).`,
			)
		const name =
			typeof field.name === "string" &&
			/^[a-zA-Z0-9_-]{1,40}$/.test(field.name)
				? field.name
				: `field${index + 1}`
		if (fields.some(existing => existing.name === name))
			throw new FieldError(`${where}: name "${name}" is used twice.`)
		const parsed: Field = {
			name,
			label: (field.label as string).trim(),
			type: type as FieldType,
			required: field.required !== false,
		}
		if (field.hint !== undefined) {
			if (!isText(field.hint, 150))
				throw new FieldError(
					`${where}: hint is at most 150 characters.`,
				)
			parsed.hint = field.hint as string
		}
		if (field.placeholder !== undefined) {
			if (!isText(field.placeholder, 150))
				throw new FieldError(
					`${where}: placeholder is at most 150 characters.`,
				)
			parsed.placeholder = field.placeholder as string
		}
		if (CHOICES.includes(parsed.type)) {
			const limit =
				parsed.type === "radio" || parsed.type === "checkboxes"
					? 10
					: 100
			const options = field.options
			if (
				!Array.isArray(options) ||
				options.length < 1 ||
				options.length > limit ||
				options.some(option => !isText(option, 75)) ||
				new Set(options).size !== options.length
			)
				throw new FieldError(
					`${where}: ${parsed.type} needs 1–${limit} different options of at most 75 characters.`,
				)
			parsed.options = (options as string[]).map(option => option.trim())
		}
		for (const key of ["min", "max"] as const)
			if (field[key] !== undefined) {
				if (
					typeof field[key] !== "number" ||
					!Number.isFinite(field[key])
				)
					throw new FieldError(`${where}: ${key} must be a number.`)
				parsed[key] = field[key] as number
			}
		if (
			parsed.min !== undefined &&
			parsed.max !== undefined &&
			parsed.min > parsed.max
		)
			throw new FieldError(`${where}: min is above max.`)
		if (field.multiline === true) parsed.multiline = true
		if (field.decimal === true) parsed.decimal = true
		if (field.filetypes !== undefined) {
			if (
				!Array.isArray(field.filetypes) ||
				field.filetypes.some(type => !isText(type, 20))
			)
				throw new FieldError(
					`${where}: filetypes is a list of extensions.`,
				)
			parsed.filetypes = (field.filetypes as string[]).map(type =>
				type.replace(/^\./, "").toLowerCase(),
			)
		}
		if (field.initial !== undefined) {
			parsed.initial = initialValue(parsed, field.initial, where)
		}
		fields.push(parsed)
	})
	return fields
}

function initialValue(
	field: Field,
	value: unknown,
	where: string,
): Field["initial"] {
	const fail = (what: string) => {
		throw new FieldError(`${where}: initial must be ${what}.`)
	}
	const many = MULTIPLE.includes(field.type)
	const values = many
		? Array.isArray(value)
			? value
			: fail("a list")
		: [value]
	for (const item of values as unknown[]) {
		if (field.type === "number") {
			if (
				typeof item !== "number" &&
				!(typeof item === "string" && Number.isFinite(Number(item)))
			)
				fail("a number")
			continue
		}
		if (typeof item !== "string" || !item) fail("text")
		const text = item as string
		if (field.options && !field.options.includes(text))
			fail("one of its options")
		if (field.type === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(text))
			fail("YYYY-MM-DD")
		if (field.type === "time" && !/^\d{2}:\d{2}$/.test(text)) fail("HH:MM")
		if (field.type === "datetime" && Number.isNaN(Date.parse(text)))
			fail("an ISO date-time")
		if (
			["user", "users"].includes(field.type) &&
			!/^[UW][A-Z0-9]+$/.test(text)
		)
			fail("Slack user IDs")
		if (
			["channel", "channels", "conversation", "conversations"].includes(
				field.type,
			) &&
			!/^[CGD][A-Z0-9]+$/.test(text)
		)
			fail("Slack channel IDs")
		if (field.type === "file" || field.type === "richtext")
			fail("absent for this type")
	}
	return many
		? (values as string[])
		: field.type === "number"
			? Number(value)
			: (value as string)
}

/** The modal's input block for a field. */
export function fieldBlock(field: Field): types.KnownBlock {
	const options = (field.options ?? []).map((option, index) => ({
		text: plain(option),
		value: String(index),
	}))
	const option = (text: unknown) =>
		options[field.options!.indexOf(text as string)]!
	const initial = field.initial
	const placeholder = field.placeholder
		? { placeholder: plain(field.placeholder) }
		: {}
	const text = (
		type: "plain_text_input" | "email_text_input" | "url_text_input",
	) => ({
		type,
		action_id: "value",
		...placeholder,
		...(initial !== undefined ? { initial_value: String(initial) } : {}),
		...(type === "plain_text_input"
			? {
					multiline: field.multiline === true,
					...(field.min !== undefined
						? { min_length: Math.max(0, Math.floor(field.min)) }
						: {}),
					max_length: Math.min(3000, Math.floor(field.max ?? 3000)),
				}
			: {}),
	})
	let element: Record<string, unknown>
	switch (field.type) {
		case "text":
			element = text("plain_text_input")
			break
		case "email":
			element = text("email_text_input")
			break
		case "url":
			element = text("url_text_input")
			break
		case "number":
			element = {
				type: "number_input",
				action_id: "value",
				is_decimal_allowed: field.decimal === true,
				...placeholder,
				...(initial !== undefined
					? { initial_value: String(initial) }
					: {}),
				...(field.min !== undefined
					? { min_value: String(field.min) }
					: {}),
				...(field.max !== undefined
					? { max_value: String(field.max) }
					: {}),
			}
			break
		case "select":
		case "radio":
			element = {
				type:
					field.type === "select" ? "static_select" : "radio_buttons",
				action_id: "value",
				options,
				...(field.type === "select" ? placeholder : {}),
				...(initial !== undefined
					? { initial_option: option(initial) }
					: {}),
			}
			break
		case "multiselect":
		case "checkboxes":
			element = {
				type:
					field.type === "multiselect"
						? "multi_static_select"
						: "checkboxes",
				action_id: "value",
				options,
				...(field.type === "multiselect" ? placeholder : {}),
				...(field.type === "multiselect" && field.max !== undefined
					? { max_selected_items: Math.floor(field.max) }
					: {}),
				...(initial !== undefined
					? { initial_options: (initial as string[]).map(option) }
					: {}),
			}
			break
		case "date":
			element = {
				type: "datepicker",
				action_id: "value",
				...placeholder,
				...(initial !== undefined ? { initial_date: initial } : {}),
			}
			break
		case "time":
			element = {
				type: "timepicker",
				action_id: "value",
				...placeholder,
				...(initial !== undefined ? { initial_time: initial } : {}),
			}
			break
		case "datetime":
			element = {
				type: "datetimepicker",
				action_id: "value",
				...(initial !== undefined
					? {
							initial_date_time: Math.floor(
								Date.parse(initial as string) / 1000,
							),
						}
					: {}),
			}
			break
		case "user":
		case "channel":
		case "conversation":
			element = {
				type: `${field.type}s_select`,
				action_id: "value",
				...placeholder,
				...(initial !== undefined
					? { [`initial_${field.type}`]: initial }
					: {}),
			}
			break
		case "users":
		case "channels":
		case "conversations":
			element = {
				type: `multi_${field.type}_select`,
				action_id: "value",
				...placeholder,
				...(field.max !== undefined
					? { max_selected_items: Math.floor(field.max) }
					: {}),
				...(initial !== undefined
					? { [`initial_${field.type}`]: initial }
					: {}),
			}
			break
		case "file":
			element = {
				type: "file_input",
				action_id: "value",
				max_files: Math.min(
					10,
					Math.max(1, Math.floor(field.max ?? 1)),
				),
				...(field.filetypes ? { filetypes: field.filetypes } : {}),
			}
			break
		case "richtext":
			element = {
				type: "rich_text_input",
				action_id: "value",
				...placeholder,
			}
	}
	return {
		type: "input",
		block_id: field.name,
		label: plain(field.label),
		optional: !field.required,
		...(field.hint ? { hint: plain(field.hint) } : {}),
		element,
	} as unknown as types.KnownBlock
}

type Submitted = {
	value?: string | null
	selected_option?: { value: string } | null
	selected_options?: { value: string }[]
	selected_date?: string | null
	selected_time?: string | null
	selected_date_time?: number | null
	selected_user?: string | null
	selected_users?: string[]
	selected_channel?: string | null
	selected_channels?: string[]
	selected_conversation?: string | null
	selected_conversations?: string[]
	files?: { id: string; name?: string; title?: string }[]
	rich_text_value?: unknown
}

/** A rich text value as plain text (mrkdwn-ish), for Codex and the message alike. */
function richText(value: unknown): string {
	const walk = (node: unknown): string => {
		if (typeof node !== "object" || node === null) return ""
		const item = node as Record<string, unknown>
		const children = Array.isArray(item.elements)
			? item.elements.map(walk)
			: []
		switch (item.type) {
			case "text":
				return String(item.text ?? "")
			case "link":
				return String(item.text ?? item.url ?? "")
			case "user":
				return `<@${item.user_id}>`
			case "channel":
				return `<#${item.channel_id}>`
			case "emoji":
				return `:${item.name}:`
			case "rich_text_list":
				return `${children.map(child => `• ${child}`).join("\n")}\n`
			case "rich_text_preformatted":
				return `\`\`\`${children.join("")}\`\`\`\n`
			case "rich_text_quote":
				return `> ${children.join("")}\n`
			case "rich_text_section":
				return children.join("")
			default:
				return children.join(item.type === "rich_text" ? "\n" : "")
		}
	}
	return walk(value).trim()
}

/**
 * One field's submitted value: for Codex (null when left empty) and for the message (Slack text).
 */
export function readField(
	field: Field,
	submitted: Submitted | undefined,
): { value: unknown; shown: string } {
	const empty = { value: null, shown: "_(left empty)_" }
	if (!submitted) return empty
	const picked = (value: string) => field.options![Number(value)] ?? value
	const list = (
		values: string[] | undefined,
		show: (value: string) => string,
	) =>
		values?.length
			? { value: values, shown: values.map(show).join(", ") }
			: empty
	const one = (
		value: string | null | undefined,
		show: (value: string) => string = escape,
	) => (value ? { value, shown: show(value) } : empty)
	switch (field.type) {
		case "number":
			return submitted.value
				? { value: Number(submitted.value), shown: submitted.value }
				: empty
		case "select":
		case "radio":
			return one(
				submitted.selected_option &&
					picked(submitted.selected_option.value),
			)
		case "multiselect":
		case "checkboxes":
			return list(
				submitted.selected_options?.map(option => picked(option.value)),
				escape,
			)
		case "date":
			return one(submitted.selected_date)
		case "time":
			return one(submitted.selected_time)
		case "datetime":
			return submitted.selected_date_time
				? {
						value: new Date(
							submitted.selected_date_time * 1000,
						).toISOString(),
						shown: `<!date^${submitted.selected_date_time}^{date_short_pretty} at {time}|${new Date(submitted.selected_date_time * 1000).toISOString()}>`,
					}
				: empty
		case "user":
			return one(submitted.selected_user, id => `<@${id}>`)
		case "users":
			return list(submitted.selected_users, id => `<@${id}>`)
		case "channel":
			return one(submitted.selected_channel, id => `<#${id}>`)
		case "channels":
			return list(submitted.selected_channels, id => `<#${id}>`)
		case "conversation":
			return one(submitted.selected_conversation, id => `<#${id}>`)
		case "conversations":
			return list(submitted.selected_conversations, id => `<#${id}>`)
		case "file":
			return submitted.files?.length
				? {
						value: submitted.files.map(file => ({
							id: file.id,
							name: file.name ?? file.title ?? file.id,
						})),
						shown: submitted.files
							.map(file =>
								escape(file.name ?? file.title ?? file.id),
							)
							.join(", "),
					}
				: empty
		case "richtext": {
			const text = richText(submitted.rich_text_value)
			return text ? { value: text, shown: text } : empty
		}
		default:
			return one(submitted.value?.trim())
	}
}

const escape = (text: string) =>
	text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
