import { App, TFile } from "obsidian";
import { readCookedCount, readLastMade } from "../parser/recipe-meta";
import { MiseFlowSettings, RECIPE_FRONTMATTER } from "../settings";

/**
 * Appends a new dated entry to the cook history section in the note body.
 * If the section doesn't exist it is created at the end of the note.
 * Entries are inserted newest-first, immediately after the heading line.
 * When `imageLink` is provided (e.g. `![[photo.jpg]]`) it is embedded on
 * the line below the entry text, indented so it renders inside the list item.
 */
export async function appendCookHistoryEntry(
	app: App,
	file: TFile,
	date: string,
	notes: string,
	headingName: string,
	imageLink: string | null,
): Promise<void> {
	let entryLine = notes ? `- **${date}** — ${notes}` : `- **${date}**`;
	if (imageLink) {
		entryLine += `\n  ${imageLink}`;
	}

	const headingPattern = new RegExp(
		`^#{1,6}\\s+${headingName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`,
		"im",
	);

	await app.vault.process(file, (content) => {
		const match = headingPattern.exec(content);
		if (match === null) {
			const trimmed = content.trimEnd();
			return `${trimmed}\n\n## ${headingName}\n\n${entryLine}\n`;
		}
		const headingEnd = match.index + match[0].length;
		return (
			content.slice(0, headingEnd) +
			"\n\n" +
			entryLine +
			content.slice(headingEnd)
		);
	});
}

/**
 * Stamps a recipe's "last made" date to the given date string and, when
 * `trackCookedCount` is enabled and the date differs from the previous
 * value, increments `cookedCount`. Does not touch the selection property.
 *
 * Returns the new cooked count when it was incremented, otherwise null.
 */
export async function stampRecipeCooked(
	app: App,
	file: TFile,
	date: string,
	settings: MiseFlowSettings,
): Promise<{ newCount: number | null }> {
	if (!settings.trackLastMade) return { newCount: null };
	let newCount: number | null = null;
	await app.fileManager.processFrontMatter(
		file,
		(fm: Record<string, unknown>) => {
			const key = settings.lastMadeProperty.trim() || "lastMade";
			const previous = readLastMade(fm, key);
			fm[key] = date;

			if (settings.trackCookedCount && previous !== date) {
				const current = readCookedCount(fm);
				newCount = current + 1;
				fm[RECIPE_FRONTMATTER.cookedCount] = newCount;
			}
		},
	);
	return { newCount };
}
