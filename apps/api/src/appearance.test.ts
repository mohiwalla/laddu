import { expect, test } from "bun:test"
import {
	nameProblem,
	pictureFile,
	postAs,
	savePicture,
	servePicturesAt,
	setAppearance,
	UPLOAD_DIR,
} from "./appearance"

const person = { teamId: "T1", userId: "U1" }
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1])

test("a person's name and picture go on laddu's posts for them, and nobody else's", async () => {
	servePicturesAt("https://laddu.example.com")
	await setAppearance(person, { name: "Jalebi", picture: "jalebi.png" })
	expect(await postAs(person)).toEqual({
		username: "Jalebi",
		icon_url: "https://laddu.example.com/_laddu/pictures/jalebi.png?v=2",
	})
	expect(await postAs({ teamId: "T1", userId: "U2" })).toEqual({})
	await setAppearance(person, { name: undefined, picture: undefined })
	expect(await postAs(person)).toEqual({})
})

test("without a public HTTPS address only the name is used", async () => {
	servePicturesAt("http://localhost:6900")
	await setAppearance(person, { name: "Jalebi", picture: "jalebi.png" })
	expect(await postAs(person)).toEqual({ username: "Jalebi" })
	await setAppearance(person, { name: undefined, picture: undefined })
})

test("uploads are kept by content and removed once nobody wears them", async () => {
	const saved = await savePicture(PNG)
	if (!("picture" in saved)) throw new Error(saved.problem)
	expect(saved.picture).toMatch(/^[0-9a-f]{32}\.png$/)
	expect(pictureFile(saved.picture)).toBe(`${UPLOAD_DIR}/${saved.picture}`)
	await setAppearance(person, { picture: saved.picture })
	await setAppearance(person, { picture: "rasgulla.png" })
	expect(await Bun.file(`${UPLOAD_DIR}/${saved.picture}`).exists()).toBe(
		false,
	)
	await setAppearance(person, { picture: undefined })
	expect(await savePicture(new TextEncoder().encode("<svg/>"))).toEqual({
		problem: "Use a PNG, JPEG or GIF picture.",
	})
	expect(pictureFile("../appearance.json")).toBeNull()
})

test("names can't be a coworker's or carry formatting", async () => {
	const client = {
		users: {
			list: async () => ({
				members: [
					{ id: "U9", name: "kamal", real_name: "Kamal Singh" },
					{ id: "B1", name: "otherbot", is_bot: true },
				],
			}),
		},
	} as never
	expect(await nameProblem(client, "Kamal Singh")).toContain("someone's name")
	expect(await nameProblem(client, "otherbot")).toBeNull()
	expect(await nameProblem(client, "<@U9>")).toContain("plain text")
	expect(await nameProblem(client, "Jalebi")).toBeNull()
})
