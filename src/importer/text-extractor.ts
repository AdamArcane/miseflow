import { ImportedRecipe, RecipeGroup } from "./schema-extractor";

/**
 * Heuristically parse plain text into a structured ImportedRecipe.
 *
 * Designed to accept any format: copy-pasted recipe text, social media
 * descriptions, OCR output, etc. Falls back gracefully — if structure
 * can't be detected the full text goes into `description` and
 * ingredients/instructions are left empty.
 *
 * The function signature is intentionally identical to what an AI-powered
 * replacement would expose, so the implementation can be swapped later.
 */
export function extractRecipeFromText(
	rawText: string,
	titleOverride?: string,
): ImportedRecipe {
	const text = clean(rawText);
	const lines = text.split("\n");

	// --- Title ---
	let titleLine = -1;
	let title = (titleOverride ?? "").trim();
	if (!title) {
		const headingIdx = lines.findIndex((l) => /^#+\s+\S/.test(l));
		if (headingIdx !== -1) {
			title = lines[headingIdx]!.replace(/^#+\s+/, "").trim();
			titleLine = headingIdx;
		} else {
			const firstIdx = lines.findIndex((l) => l.trim());
			if (firstIdx !== -1) {
				const firstLine = lines[firstIdx]!.replace(/^[#*]+/, "").trim();
				// Don't consume a section keyword — leave it for section detection
				if (!SECTION_HEADING_RE.test(firstLine)) {
					title = firstLine;
					titleLine = firstIdx;
				}
			}
		}
	}

	// Build working line array without the title line
	const body = lines.filter((_, i) => i !== titleLine);

	// --- Metadata ---
	const fullText = body.join("\n");
	const servings = matchFirst(fullText, /(?:serves|yield|servings|makes)\s*:?\s*(\d+)/i);
	const prepTime = matchMinutes(
		fullText,
		/prep(?:aration)?(?:\s*time)?\s*:?\s*(\d+(?:\.\d+)?)\s*(min(?:utes?)?|hr?s?|hours?)/i,
	);
	const cookTime = matchMinutes(
		fullText,
		/(?:cook|bake|roast|fry)(?:\s*time)?\s*:?\s*(\d+(?:\.\d+)?)\s*(min(?:utes?)?|hr?s?|hours?)/i,
	);
	const totalTime = matchMinutes(
		fullText,
		/total(?:\s*time)?\s*:?\s*(\d+(?:\.\d+)?)\s*(min(?:utes?)?|hr?s?|hours?)/i,
	);
	const calories = matchInt(fullText, /(?:calories?|cal|kcal)\s*:?\s*(\d+)/i);
	const protein = matchInt(fullText, /protein\s*:?\s*(\d+)/i);
	const fat = matchInt(fullText, /(?:total\s+)?fat\s*:?\s*(\d+)/i);
	const carbs = matchInt(fullText, /(?:carbs?|carbohydrates?)\s*:?\s*(\d+)/i);

	// --- Section detection ---
	type Section = "before" | "ingredients" | "instructions";
	let section: Section = "before";

	const descriptionLines: string[] = [];
	const ingredientLines: string[] = [];
	const instructionLines: string[] = [];

	for (const line of body) {
		if (INGREDIENTS_RE.test(line.trim())) {
			section = "ingredients";
			continue;
		}
		if (INSTRUCTIONS_RE.test(line.trim())) {
			section = "instructions";
			continue;
		}

		if (section === "before") descriptionLines.push(line);
		else if (section === "ingredients") ingredientLines.push(line);
		else instructionLines.push(line);
	}

	// If no sections were detected, treat everything as description
	const noSections = section === "before";
	const description = (noSections ? body : descriptionLines)
		.join("\n")
		.trim();

	const ingredientGroups = noSections ? [] : parseIngredientLines(ingredientLines);
	const instructionGroups = noSections ? [] : parseInstructionLines(instructionLines);

	return {
		title,
		description,
		image: "",
		servings: servings !== null ? `${servings} servings` : "",
		prepTime,
		cookTime,
		totalTime,
		ingredientGroups,
		instructionGroups,
		url: "",
		calories,
		protein,
		fat,
		carbs,
	};
}

/** Convert RecipeGroup[] to a flat textarea string (## Group Name headings). */
export function groupsToTextarea(groups: RecipeGroup[]): string {
	return groups
		.flatMap((g) => [
			...(g.name ? [`## ${g.name}`] : []),
			...g.items,
		])
		.join("\n");
}

/** Parse a textarea string (## Group headings + items) back into RecipeGroup[]. */
export function textareaToGroups(text: string): RecipeGroup[] {
	const groups: RecipeGroup[] = [{ name: null, items: [] }];
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const heading = trimmed.match(/^#{1,6}\s+(.+)$/);
		if (heading) {
			groups.push({ name: heading[1]!.trim(), items: [] });
		} else {
			groups[groups.length - 1]!.items.push(
				trimmed.replace(/^[-*•]\s*/, ""),
			);
		}
	}
	// Drop any empty unnamed leading group
	return groups.filter((g) => g.name !== null || g.items.length > 0);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const INGREDIENTS_RE = /^#*\s*(ingredients?|what you(?:'ll)? need)/i;
const INSTRUCTIONS_RE =
	/^#*\s*(instructions?|directions?|method|steps?|how to make|preparation)/i;
const SECTION_HEADING_RE = new RegExp(
	`${INGREDIENTS_RE.source}|${INSTRUCTIONS_RE.source}`,
	"i",
);

function clean(raw: string): string {
	return raw
		.replace(/<[^>]+>/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&nbsp;/g, " ")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&#x27;/g, "'")
		.replace(/&#x2F;/g, "/")
		.replace(/\r\n?/g, "\n")
		.replace(/\n{3,}/g, "\n\n");
}

function matchFirst(text: string, re: RegExp): number | null {
	const m = text.match(re);
	if (!m) return null;
	const n = parseInt(m[1] ?? "", 10);
	return Number.isFinite(n) ? n : null;
}

function matchInt(text: string, re: RegExp): number | null {
	return matchFirst(text, re);
}

function matchMinutes(text: string, re: RegExp): number | null {
	const m = text.match(re);
	if (!m) return null;
	const n = parseFloat(m[1] ?? "");
	if (!Number.isFinite(n)) return null;
	const unit = (m[2] ?? "").toLowerCase();
	return unit.startsWith("h") ? Math.round(n * 60) : Math.round(n);
}

const LEADING_QUANTITY_RE = /^\s*[\d¼½¾⅓⅔⅛⅜⅝⅞]/;

function parseIngredientLines(lines: string[]): RecipeGroup[] {
	const groups: RecipeGroup[] = [{ name: null, items: [] }];

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;

		// Sub-group heading: ends with ":" or is ALL CAPS (and not a list item)
		const isListItem = /^[-*•]/.test(trimmed) || LEADING_QUANTITY_RE.test(trimmed);
		const isHeading =
			!isListItem &&
			(trimmed.endsWith(":") || trimmed === trimmed.toUpperCase());

		if (isHeading) {
			groups.push({ name: trimmed.replace(/:$/, ""), items: [] });
			continue;
		}

		// Accept list items and lines that look like they have a quantity
		if (isListItem || /\w/.test(trimmed)) {
			groups[groups.length - 1]!.items.push(
				trimmed.replace(/^[-*•]\s*/, ""),
			);
		}
	}

	return groups.filter((g) => g.name !== null || g.items.length > 0);
}

function parseInstructionLines(lines: string[]): RecipeGroup[] {
	const groups: RecipeGroup[] = [{ name: null, items: [] }];

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;

		// Sub-group heading
		if (/^#{1,6}\s+/.test(trimmed) || (/^\S/.test(trimmed) && trimmed.endsWith(":"))) {
			groups.push({
				name: trimmed.replace(/^#{1,6}\s+/, "").replace(/:$/, ""),
				items: [],
			});
			continue;
		}

		// Strip leading number (e.g., "1. " or "1) ")
		const step = trimmed
			.replace(/^\d+[.)]\s+/, "")
			.replace(/^[-*•]\s+/, "");
		groups[groups.length - 1]!.items.push(step);
	}

	return groups.filter((g) => g.name !== null || g.items.length > 0);
}
