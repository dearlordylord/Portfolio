/**
 * Project case-study manifest and the small DOM adapter that renders it.
 *
 * The page shell owns the overlay styles/markup contract; this module owns
 * the data, event lifecycle, and safe content construction.  In particular,
 * project copy and image paths never pass through `innerHTML`.
 */

export type CaseProject = Readonly<{
  name: string;
  desc: string;
  tags: readonly string[];
  images: readonly string[];
}>;

export const CASE_PROJECTS = {
  fridj: {
    name: "Fridgie",
    desc: "Smart food tracker & recipe generator",
    tags: ["Mobile App", "UX/UI", "iOS"],
    images: [
      "Проекты/Fridj/Slice_1.png",
      "Проекты/Fridj/Slice_2.png",
      "Проекты/Fridj/Slice_3.png",
      "Проекты/Fridj/Slice_4.png",
      "Проекты/Fridj/Slice_5.png",
      "Проекты/Fridj/Slise_06.png",
      "Проекты/Fridj/Slise_07.png",
      "Проекты/Fridj/Slise_08.png",
      "Проекты/Fridj/Slise_09.png",
      "Проекты/Fridj/Slise_10.png",
      "Проекты/Fridj/Slise_11.png",
      "Проекты/Fridj/Slise_12.png",
      "Проекты/Fridj/Slise_13.png",
      "Проекты/Fridj/Slice_14.png",
      "Проекты/Fridj/Slice_15.png",
      "Проекты/Fridj/Slice_17.png",
    ],
  },
  beehive: {
    name: "BeeHive",
    desc: "Community support platform for beekeepers",
    tags: ["Mobile App", "UX/UI", "iOS"],
    images: [
      "Проекты/пчелы/01.png",
      "Проекты/пчелы/02.png",
      "Проекты/пчелы/03.png",
      "Проекты/пчелы/04.png",
      "Проекты/пчелы/05.png",
      "Проекты/пчелы/05_1.png",
      "Проекты/пчелы/05_2.png",
      "Проекты/пчелы/06.png",
      "Проекты/пчелы/07.png",
      "Проекты/пчелы/08.png",
      "Проекты/пчелы/09.png",
      "Проекты/пчелы/10.png",
      "Проекты/пчелы/11.png",
      "Проекты/пчелы/12.png",
      "Проекты/пчелы/13.png",
      "Проекты/пчелы/14.png",
      "Проекты/пчелы/15.png",
      "Проекты/пчелы/16.png",
    ],
  },
  unno: {
    name: "UNNO",
    desc: "DNA of the clothing brand",
    tags: ["Branding", "Identity", "Fashion"],
    images: [
      "Проекты/UNNO_eng/screen_1.jpg",
      "Проекты/UNNO_eng/screen_2.jpg",
      "Проекты/UNNO_eng/screen_3.jpg",
    ],
  },
  restfood: {
    name: "RestFood",
    desc: "Mobile app for prepared meal delivery services",
    tags: ["Mobile App", "UX/UI"],
    images: [
      "Проекты/RestFood/screen_01.png",
      "Проекты/RestFood/screen_02.png",
      "Проекты/RestFood/screen_04.png",
      "Проекты/RestFood/screen_05.png",
      "Проекты/RestFood/screen_06.png",
      "Проекты/RestFood/screen_07.png",
      "Проекты/RestFood/screen_08.png",
    ],
  },
} as const satisfies Readonly<Record<string, CaseProject>>;

export type CaseProjectId = keyof typeof CASE_PROJECTS;
export type CaseProjectManifest = Readonly<Record<string, CaseProject>>;

export type CaseOverlayOptions = Readonly<{
  document?: Document;
  window?: Window;
  manifest?: CaseProjectManifest;
  /** Existing root; defaults to `#case-overlay`, creating the shell if absent. */
  root?: HTMLElement | null;
  /** Project trigger selector. Cards should carry `data-case-id`. */
  triggerSelector?: string;
}>;

export type CaseOverlayHandle = Readonly<{
  readonly root: HTMLElement;
  readonly manifest: CaseProjectManifest;
  open(id: string): boolean;
  close(): void;
  isOpen(): boolean;
  destroy(): void;
}>;

type OverlayElements = {
  root: HTMLElement;
  close: HTMLButtonElement;
  title: HTMLElement;
  subtitle: HTMLElement;
  tags: HTMLElement;
  images: HTMLElement;
};

const DEFAULT_ROOT_ID = "case-overlay";
const DEFAULT_TRIGGER_SELECTOR = ".case-card[data-case-id]";

/** Encode each path segment while preserving `/` as a path separator. */
export function encodeCaseImagePath(path: string): string {
  return path.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

function createElement<K extends keyof HTMLElementTagNameMap>(
  ownerDocument: Document,
  tagName: K,
  id?: string,
): HTMLElementTagNameMap[K] {
  const element = ownerDocument.createElement(tagName);
  if (id) element.id = id;
  return element;
}

function ensureOverlayElements(ownerDocument: Document, suppliedRoot?: HTMLElement | null): OverlayElements {
  let root = suppliedRoot ?? ownerDocument.getElementById(DEFAULT_ROOT_ID);
  let createdRoot = false;

  if (!root) {
    root = createElement(ownerDocument, "div", DEFAULT_ROOT_ID);
    ownerDocument.body.append(root);
    createdRoot = true;
  }

  root.id = root.id || DEFAULT_ROOT_ID;
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-labelledby", "case-title");
  root.setAttribute("aria-describedby", "case-subtitle");
  root.setAttribute("aria-hidden", root.classList.contains("open") ? "false" : "true");

  let close = root.querySelector<HTMLButtonElement>("#case-close");
  if (!close) {
    close = createElement(ownerDocument, "button", "case-close");
    root.append(close);
  }
  close.type = "button";
  close.setAttribute("aria-label", "Close case study");
  if (!close.textContent) close.textContent = "✕";

  let inner = root.querySelector<HTMLElement>("#case-overlay-inner");
  if (!inner) {
    inner = createElement(ownerDocument, "div", "case-overlay-inner");
    root.append(inner);
  }

  let header = inner.querySelector<HTMLElement>("#case-overlay-header");
  if (!header) {
    header = createElement(ownerDocument, "div", "case-overlay-header");
    inner.append(header);
  }

  let title = header.querySelector<HTMLElement>("#case-title");
  if (!title) {
    title = createElement(ownerDocument, "h2", "case-title");
    header.append(title);
  }

  let subtitle = header.querySelector<HTMLElement>("#case-subtitle");
  if (!subtitle) {
    subtitle = createElement(ownerDocument, "p", "case-subtitle");
    header.append(subtitle);
  }

  let tags = header.querySelector<HTMLElement>("#case-overlay-tags");
  if (!tags) {
    tags = createElement(ownerDocument, "div", "case-overlay-tags");
    header.append(tags);
  }

  let images = inner.querySelector<HTMLElement>("#case-images");
  if (!images) {
    images = createElement(ownerDocument, "div", "case-images");
    inner.append(images);
  }

  // The return value is intentionally not a public detail, but it is useful
  // to mark generated roots for `destroy()` without an extra WeakMap.
  if (createdRoot) root.dataset.caseOverlayGenerated = "true";

  return { root, close, title, subtitle, tags, images };
}

function readTriggerId(target: EventTarget | null, selector: string): string | null {
  if (!(target instanceof Element)) return null;
  const trigger = target.closest<HTMLElement>(selector);
  return trigger?.dataset.caseId ?? null;
}

function restoreFocus(element: HTMLElement | null): void {
  if (!element || !element.isConnected || typeof element.focus !== "function") return;
  element.focus();
}

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "area[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type=hidden])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[contenteditable=\"true\"]",
  "[tabindex]:not([tabindex=\"-1\"])",
].join(",");

function focusableElements(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((element) => {
    if (element.hasAttribute("hidden") || element.getAttribute("aria-hidden") === "true") return false;
    return element.getAttribute("tabindex") !== "-1";
  });
}

/**
 * Mount case-card interaction and return a disposable controller.
 *
 * The controller uses delegated native listeners, so cards added later still
 * work and teardown is one operation.  Existing inline `onclick` attributes
 * on the overlay controls are removed as a compatibility measure; callers do
 * not need to retain global `openCase`/`closeCase` functions.
 */
export function mountCaseOverlay(options: CaseOverlayOptions = {}): CaseOverlayHandle {
  const ownerWindow = options.window ?? window;
  const ownerDocument = options.document ?? ownerWindow.document;
  const manifest: CaseProjectManifest = options.manifest ?? CASE_PROJECTS;
  const triggerSelector = options.triggerSelector ?? DEFAULT_TRIGGER_SELECTOR;
  const elements = ensureOverlayElements(ownerDocument, options.root);
  const { root, close: closeButton, title, subtitle, tags, images } = elements;

  root.removeAttribute("onclick");
  closeButton.removeAttribute("onclick");

  let openState = root.classList.contains("open");
  let previousBodyOverflow: string | null = null;
  let previouslyFocused: HTMLElement | null = null;
  let destroyed = false;

  function close(): void {
    if (destroyed) return;
    root.classList.remove("open");
    root.setAttribute("aria-hidden", "true");
    if (openState) {
      ownerDocument.body.style.overflow = previousBodyOverflow ?? "";
      previousBodyOverflow = null;
      restoreFocus(previouslyFocused);
      previouslyFocused = null;
    }
    openState = false;
  }

  function open(id: string): boolean {
    if (destroyed) return false;
    const project = manifest[id];
    if (!project) return false;

    if (!openState) {
      previousBodyOverflow = ownerDocument.body.style.overflow;
      previouslyFocused = ownerDocument.activeElement instanceof HTMLElement ? ownerDocument.activeElement : null;
    }

    title.textContent = project.name;
    subtitle.textContent = project.desc;
    tags.replaceChildren();
    project.tags.forEach((tag) => {
      const tagElement = createElement(ownerDocument, "span");
      tagElement.textContent = tag;
      tags.append(tagElement);
    });

    images.replaceChildren();
    project.images.forEach((path) => {
      const image = createElement(ownerDocument, "img");
      image.src = encodeCaseImagePath(path);
      image.loading = "lazy";
      image.alt = "";
      images.append(image);
    });

    root.classList.add("open");
    root.setAttribute("aria-hidden", "false");
    root.scrollTop = 0;
    ownerDocument.body.style.overflow = "hidden";
    openState = true;
    closeButton.focus();
    return true;
  }

  function onDocumentClick(event: MouseEvent): void {
    const id = readTriggerId(event.target, triggerSelector);
    if (id) {
      event.preventDefault();
      open(id);
    }
  }

  function onDocumentKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape" && openState) {
      event.preventDefault();
      close();
      return;
    }

    if (event.key === "Tab" && openState) {
      const focusable = focusableElements(root);
      if (focusable.length === 0) {
        event.preventDefault();
        closeButton.focus();
        return;
      }

      const activeElement = ownerDocument.activeElement;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey) {
        if (activeElement === first || !root.contains(activeElement)) {
          event.preventDefault();
          last.focus();
        }
      } else if (activeElement === last || !root.contains(activeElement)) {
        event.preventDefault();
        first.focus();
      }
      return;
    }

    if (event.key !== "Enter" && event.key !== " ") return;
    const id = readTriggerId(event.target, triggerSelector);
    if (!id) return;
    event.preventDefault();
    open(id);
  }

  function onOverlayClick(event: MouseEvent): void {
    if (event.target === root) close();
  }

  ownerDocument.addEventListener("click", onDocumentClick);
  ownerDocument.addEventListener("keydown", onDocumentKeydown);
  root.addEventListener("click", onOverlayClick);
  closeButton.addEventListener("click", close);

  return {
    root,
    manifest,
    open,
    close,
    isOpen: () => openState,
    destroy() {
      if (destroyed) return;
      close();
      destroyed = true;
      ownerDocument.removeEventListener("click", onDocumentClick);
      ownerDocument.removeEventListener("keydown", onDocumentKeydown);
      root.removeEventListener("click", onOverlayClick);
      closeButton.removeEventListener("click", close);
      if (root.dataset.caseOverlayGenerated === "true") root.remove();
    },
  };
}
