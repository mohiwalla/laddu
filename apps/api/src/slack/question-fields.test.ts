import { expect, test } from "bun:test"
import {
	FIELD_TYPES,
	FieldError,
	fieldBlock,
	parseFields,
	readField,
} from "./question-fields"

test("every field type builds an input block", () => {
	const fields = parseFields(
		FIELD_TYPES.map(type => ({
			label: type,
			type,
			...(["select", "multiselect", "radio", "checkboxes"].includes(type)
				? { options: ["A", "B"] }
				: {}),
		})),
	)
	const elements = fields.map(
		field =>
			(fieldBlock(field) as { element: { type: string } }).element.type,
	)
	expect(elements).toEqual([
		"plain_text_input",
		"number_input",
		"email_text_input",
		"url_text_input",
		"static_select",
		"multi_static_select",
		"radio_buttons",
		"checkboxes",
		"datepicker",
		"timepicker",
		"datetimepicker",
		"users_select",
		"multi_users_select",
		"channels_select",
		"multi_channels_select",
		"conversations_select",
		"multi_conversations_select",
		"file_input",
		"rich_text_input",
	])
})

test("mistakes are caught before posting", () => {
	expect(() => parseFields([])).toThrow(FieldError)
	expect(() => parseFields([{ label: "x", type: "colour" }])).toThrow(
		FieldError,
	)
	expect(() =>
		parseFields([
			{
				label: "x",
				type: "radio",
				options: Array(11)
					.fill(0)
					.map((_, i) => `${i}`),
			},
		]),
	).toThrow(FieldError)
	expect(() =>
		parseFields([{ label: "x", type: "date", initial: "tomorrow" }]),
	).toThrow(FieldError)
	expect(() =>
		parseFields([
			{ label: "x", type: "select", options: ["A"], initial: "B" },
		]),
	).toThrow(FieldError)
})

test("initial values are filled in", () => {
	const [select, users] = parseFields([
		{ label: "Pick", type: "select", options: ["A", "B"], initial: "B" },
		{ label: "Who", type: "users", initial: ["U1"] },
	])
	expect(JSON.stringify(fieldBlock(select!))).toContain(
		'"initial_option":{"text":{"type":"plain_text","text":"B"},"value":"1"}',
	)
	expect(JSON.stringify(fieldBlock(users!))).toContain(
		'"initial_users":["U1"]',
	)
})

test("answers read back for Codex and for Slack", () => {
	const [pick, who, when, file, note] = parseFields([
		{ label: "Pick", type: "checkboxes", options: ["A", "B"] },
		{ label: "Who", type: "user" },
		{ label: "When", type: "datetime" },
		{ label: "File", type: "file" },
		{ label: "Note", type: "text", required: false },
	])
	expect(readField(pick!, { selected_options: [{ value: "1" }] })).toEqual({
		value: ["B"],
		shown: "B",
	})
	expect(readField(who!, { selected_user: "U9" })).toEqual({
		value: "U9",
		shown: "<@U9>",
	})
	expect(readField(when!, { selected_date_time: 0 }).value).toBeNull()
	expect(readField(when!, { selected_date_time: 1800000000 }).value).toBe(
		"2027-01-15T08:00:00.000Z",
	)
	expect(
		readField(file!, { files: [{ id: "F1", name: "a.pdf" }] }).value,
	).toEqual([{ id: "F1", name: "a.pdf" }])
	expect(readField(note!, { value: null }).value).toBeNull()
})
