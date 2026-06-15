# Changelog

All notable changes to this project will be documented in this file.

## [1.0.16] - 2026-06-15

### Features

- **Generalized recipe import** — Import modal now supports two modes via tabs: *From URL* and *From Text*
  - URL mode auto-detects YouTube/TikTok and extracts recipes from video descriptions via OpenGraph meta tags; Instagram shows a clear unsupported error
  - Text mode accepts pasted recipe text in any format and heuristically extracts title, ingredients, instructions, times, and nutrition
  - A review step after parsing lets you edit all fields (title, servings, times, description, ingredients, instructions, nutrition) before the note is written; ingredients and instructions are editable as plain text with `## Heading` syntax for groups
  - `FolderSuggest` is now shared; `FileSuggest` added for note path fields and wired into settings (meal plan note, grocery list note, import folder, template note) and the import modal
  - Command renamed from "Import recipe from URL" to "Import recipe"

- **Cook history tracking** — Mark Cooked modal now supports notes and image attachments per cook session, building a history of past cooks on each recipe

### Fixes

- Treat `createEl` as an Obsidian global for lint and build
- Update `@codemirror` dependencies to specific pinned versions for consistency
- Add trailing newline to `package.json`
