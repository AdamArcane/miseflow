<div align="center">
	<img width="250" alt="miseflow-final" src="https://github.com/user-attachments/assets/1bd14075-406d-42af-b005-9a245a714811" />


<a href="https://github.com/AdamArcane/miseflow/releases/latest">![Obsidian release version badge](https://img.shields.io/github/v/release/AdamArcane/miseflow?logo=obsidian&color=rgb(125%2C58%2C237))</a>
![GitHub License](https://img.shields.io/github/license/AdamArcane/miseflow)
![GitHub Actions Workflow Status](https://img.shields.io/github/actions/workflow/status/AdamArcane/miseflow/lint.yml)

[!["Buy Me A Coffee"](https://www.buymeacoffee.com/assets/img/custom_images/yellow_img.png)](https://www.buymeacoffee.com/atommasi)
</div>



> [!WARNING]
> MiseFlow has been archived and completely rewritten from the ground up. It is now called **Recipe Box** and can be found at https://github.com/AdamArcane/obsidian-recipebox



# MiseFlow 🍳

> *Mise en place* - the culinary practice of preparing everything before you cook.

MiseFlow is an [Obsidian](https://obsidian.md) plugin that transforms your recipes from simple markdown into a complete meal planning, grocery shopping, and recipe management system.



### Core Features
- Import recipes from a URL
- Create a meal plans and generate grocery lists
- Shopping assistant with item groupings
- Pure markdown files for recipes, meal plans and grocery lists
- Recipe view - desktop and mobile optimized
- Kitchen timers
- Track last cooked and cooked count
- Recipe suggestor
- Auto add ingredients to shopping list when recipes are added to the meal plan
- Easily scale recipes up and down
- Health & safty warnings for meat temperature, allergens and high glycemic index ingredients

<div align="center">
<img width="600" alt="Miseflow Recipe View" src="https://github.com/user-attachments/assets/35534d8b-bcb2-43f6-819e-276b195a42e8" />
</div>

## 🗓️ Plan Your Meals

Build your weekly meal plan directly from your recipe collection.

* Add recipes to the meal plan with a button click
* Schedule meals by day of the week
* Automatically track recipes you've cooked
* Edit your meal plan manually or through the plugin
* Store everything in a normal Markdown note

No hidden database. No proprietary format.


## 🛒 Build Smarter Grocery Lists

Turn your meal plan into a grocery list in seconds.

* Automatically combine duplicate ingredients
* Merge quantities across recipes
* Add one-off shopping items
* Organize by category, recipe, source, or flat list
* Export as plain text or Markdown
* Edit directly inside the grocery list note
* Auto add ingredients from meal plan


## 📚 Build Your Personal Cookbook

MiseFlow helps you maintain a living recipe collection.

* Favorite recipes
* Most-cooked statistics
* Last-made tracking
* Meal suggestions
* Recently neglected recipes

## ✨ Everything Lives In Markdown

MiseFlow uses regular Obsidian notes.

That means:

* Your data remains future-proof
* Your recipes are searchable
* You can query and display your recipes with Dataview or Obsidian bases
* Your recipes work with backlinks
* Your recipes work with your existing vault structure
* You can always access your data without the plugin

Your recipes belong to you.


## Installation

1. Open Obsidian Settings
2. Navigate to Community Plugins
3. Browse for "MiseFlow"
4. Install and enable the plugin
5. Configure your recipe folders and note locations

You're ready to cook.


## Frontmatter Reference

| Property | Description |
|----------|-------------|
| `type` | Set to your configured recipe type value (default `recipe`) to enable recipe view auto-open |
| `image` | Hero image - vault file path, wikilink, or URL |
| `multiplier` | Portion scale factor (default `1`) |
| `servings` | Number of servings |
| `calories` / `protein` / `fat` / `carbs` | Nutrition values |
| `prepTime` / `cookTime` / `totalTime` | Times in minutes |
| `diet` | Diet tags - string or list (e.g. `vegan`, `[vegan, gluten-free]`) |
| `allergens` | Allergen list - CSV text or YAML list (property name configurable in settings) |
| `favorite` | `true` to mark as favourite |
| `lastMade` | Auto-stamped date (YYYY-MM-DD) when added to meal plan |
| `cookedCount` | Auto-incremented cook count |
---


## Credits

MiseFlow is a fork of [Pantry](https://github.com/Ekrizdis367/obsidian-pantry) by TheEkrizdis, significantly extended and rewritten by [Adam Tommasi](https://github.com/AdamArcane).
