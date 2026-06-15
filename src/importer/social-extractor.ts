export type SocialPlatform = "youtube" | "tiktok" | "instagram" | "unknown";

export function detectPlatform(url: string): SocialPlatform {
	try {
		const { hostname } = new URL(url);
		if (hostname.includes("youtube.com") || hostname.includes("youtu.be"))
			return "youtube";
		if (hostname.includes("tiktok.com")) return "tiktok";
		if (hostname.includes("instagram.com")) return "instagram";
	} catch {
		// invalid URL
	}
	return "unknown";
}

/**
 * Extract title and recipe text from a social media page's OpenGraph meta tags.
 * Works for YouTube (full description in og:description) and TikTok (may be truncated).
 */
export function extractSocialMeta(html: string): { title: string; text: string } {
	const ogTitle = html.match(
		/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i,
	)?.[1];
	const titleTag = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1];

	const ogDesc = html.match(
		/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i,
	)?.[1];
	const metaDesc = html.match(
		/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i,
	)?.[1];

	// Also try content-first attribute order (some sites write content before property)
	const ogTitleAlt = html.match(
		/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i,
	)?.[1];
	const ogDescAlt = html.match(
		/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:description["']/i,
	)?.[1];

	let title = decodeEntities(ogTitle ?? ogTitleAlt ?? titleTag ?? "");
	// Strip YouTube's " - YouTube" suffix
	title = title.replace(/\s*[-–]\s*YouTube\s*$/i, "").trim();

	const text = decodeEntities(ogDesc ?? ogDescAlt ?? metaDesc ?? "");

	return { title, text };
}

function decodeEntities(s: string): string {
	return s
		.replace(/&amp;/g, "&")
		.replace(/&nbsp;/g, " ")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&#x27;/g, "'")
		.replace(/&#x2F;/g, "/");
}
