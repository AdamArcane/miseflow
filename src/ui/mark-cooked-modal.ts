import { App, ButtonComponent, Modal, Platform, Setting, TFile } from "obsidian";
import { VaultImageSuggestModal } from "./vault-image-suggest";

export interface MarkCookedOptions {
	showNotes: boolean;
	showImage: boolean;
}

export type SelectedImage =
	| { type: "vault"; file: TFile }
	| { type: "upload"; name: string; data: ArrayBuffer };

/**
 * Modal for marking a recipe as cooked. Shows a date picker and, based on
 * options, a notes textarea and/or an image picker. On mobile the image
 * section includes a dedicated "Take photo" button alongside the file picker.
 */
export class MarkCookedModal extends Modal {
	private objectUrls: string[] = [];

	constructor(
		app: App,
		private readonly options: MarkCookedOptions,
		private readonly onConfirm: (
			date: string,
			notes: string,
			image: SelectedImage | null,
		) => void | Promise<void>,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl, titleEl } = this;
		titleEl.setText("Mark as cooked");
		contentEl.empty();

		// ── Date ────────────────────────────────────────────────────────────
		let dateInput!: HTMLInputElement;
		new Setting(contentEl)
			.setName("Date")
			.addText((text) => {
				text.inputEl.type = "date";
				text.inputEl.value = todayLocalISO();
				dateInput = text.inputEl;
			});

		// ── Notes ───────────────────────────────────────────────────────────
		let notesInput: HTMLTextAreaElement | null = null;
		if (this.options.showNotes) {
			new Setting(contentEl)
				.setName("Notes")
				.addTextArea((ta) => {
					ta.setPlaceholder("How did it turn out?");
					ta.inputEl.addClass("mise-mark-cooked-notes");
					notesInput = ta.inputEl;
				});
		}

		// ── Image ────────────────────────────────────────────────────────────
		let selectedImage: SelectedImage | null = null;

		if (this.options.showImage) {
			new Setting(contentEl).setName("Include a photo").setHeading();

			const imageSection = contentEl.createDiv({
				cls: "mise-mark-cooked-image-section",
			});

			const previewImg = imageSection.createEl("img", {
				cls: "mise-mark-cooked-preview-img",
				attr: { hidden: true },
			});

			const setPreview = (src: string): void => {
				previewImg.src = src;
				previewImg.removeAttribute("hidden");
			};
			const clearSelection = (): void => {
				selectedImage = null;
				previewImg.src = "";
				previewImg.setAttribute("hidden", "");
			};

			const imgButtonRow = imageSection.createDiv({
				cls: "mise-mark-cooked-image-buttons",
			});

			// From vault
			new ButtonComponent(imgButtonRow)
				.setButtonText("From vault")
				.onClick(() => {
					new VaultImageSuggestModal(this.app, (file) => {
						selectedImage = { type: "vault", file };
						setPreview(this.app.vault.getResourcePath(file));
					}).open();
				});

			// Browse (system file picker — also offers camera/gallery on mobile)
			const fileInput = imageSection.createEl("input", {
				type: "file",
				attr: { accept: "image/*", hidden: true },
			});

			new ButtonComponent(imgButtonRow)
				.setButtonText("Browse")
				.onClick(() => fileInput.click());

			fileInput.addEventListener("change", () => {
				const f = fileInput.files?.[0];
				if (f) this.handleFileUpload(f, (img, previewUrl) => {
					selectedImage = img;
					setPreview(previewUrl);
				});
			});

			// Take photo (mobile — opens camera directly)
			if (Platform.isMobile) {
				const cameraInput = imageSection.createEl("input", {
					type: "file",
					attr: { accept: "image/*", capture: "environment", hidden: true },
				});

				new ButtonComponent(imgButtonRow)
					.setButtonText("Take photo")
					.onClick(() => cameraInput.click());

				cameraInput.addEventListener("change", () => {
					const f = cameraInput.files?.[0];
					if (f) this.handleFileUpload(f, (img, previewUrl) => {
						selectedImage = img;
						setPreview(previewUrl);
					});
				});
			}

			// Remove
			new ButtonComponent(imgButtonRow)
				.setButtonText("Remove")
				.onClick(clearSelection);
		}

		// ── Action buttons ───────────────────────────────────────────────────
		const buttonRow = contentEl.createDiv({ cls: "modal-button-container" });

		new ButtonComponent(buttonRow)
			.setButtonText("Cancel")
			.onClick(() => this.close());

		new ButtonComponent(buttonRow)
			.setButtonText("Mark as cooked")
			.setCta()
			.onClick(() => {
				const date = dateInput.value.trim() || todayLocalISO();
				const notes = notesInput?.value.trim() ?? "";
				this.close();
				void Promise.resolve(this.onConfirm(date, notes, selectedImage));
			});
	}

	onClose(): void {
		for (const url of this.objectUrls) {
			URL.revokeObjectURL(url);
		}
		this.objectUrls = [];
		this.contentEl.empty();
	}

	private handleFileUpload(
		file: File,
		onReady: (image: SelectedImage, previewUrl: string) => void,
	): void {
		const reader = new FileReader();
		reader.onload = (e) => {
			const data = e.target?.result;
			if (!(data instanceof ArrayBuffer)) return;
			const url = URL.createObjectURL(new Blob([data], { type: file.type }));
			this.objectUrls.push(url);
			onReady({ type: "upload", name: file.name, data }, url);
		};
		reader.readAsArrayBuffer(file);
	}
}

function todayLocalISO(): string {
	const d = new Date();
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${y}-${m}-${day}`;
}
