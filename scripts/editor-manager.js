import { RESIZER_WIDTH, WRAP_STORAGE_KEY } from './constants.js';
import { detectModeFromText, generateSessionId, simplifyMode, isFormatSupported, normalizeModeIdForStore, hashString } from './utils/editor-utils.js';
import { formatContent } from './formatters.js';
import { SelectionMenuController } from './selection-menu.js';
import { registerSaveCommand, registerTimeCommands } from './editor-commands.js';
import { EditorState, Compartment, StateEffect } from '@codemirror/state';
import { EditorView, keymap, highlightSpecialChars, drawSelection, highlightActiveLine, highlightActiveLineGutter, dropCursor, rectangularSelection, crosshairCursor, lineNumbers, layer, RectangleMarker, Decoration, ViewPlugin, MatchDecorator, WidgetType } from '@codemirror/view';
import { defaultHighlightStyle, syntaxHighlighting, indentOnInput, foldGutter, foldKeymap } from '@codemirror/language';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { searchKeymap, search, highlightSelectionMatches } from '@codemirror/search';
import { javascript } from '@codemirror/lang-javascript';
import { json as jsonLang } from '@codemirror/lang-json';
import { xml } from '@codemirror/lang-xml';
import { css as cssLang } from '@codemirror/lang-css';
import { markdown as markdownLang } from '@codemirror/lang-markdown';
import { monokai } from './theme/monokaiTheme.js';
import { showLightbox } from './lightbox.js';
import { indentationMarkers } from '@replit/codemirror-indentation-markers';

const isMobile = () => window.innerWidth <= 768;

const languageForMode = (modeId) => {
    const key = simplifyMode(modeId);
    switch (key) {
        case 'json':
            return jsonLang();
        case 'javascript':
            return javascript();
        case 'xml':
            return xml();
        case 'css':
            return cssLang();
        case 'markdown':
            return markdownLang();
        default:
            return [];
    }
};

const lightTheme = EditorView.theme({
    '&': { backgroundColor: '#fdfdfd', color: '#1f1f1f' },
    '.cm-content': { caretColor: '#111111' },
    '&.cm-focused .cm-cursor': { borderLeftColor: '#111111' },
    '.cm-selectionBackground, .cm-content ::selection': {
        backgroundColor: '#dfe8ff',
        '--cm-selection-bg': '#dfe8ff'
    },
    '&.cm-focused .cm-selectionBackground, &.cm-focused .cm-content ::selection': {
        backgroundColor: '#cce0ff',
        '--cm-selection-bg': '#cce0ff'
    },
    '.cm-gutters': { backgroundColor: '#fdfdfd', color: '#5a5a5a', borderRight: '1px solid #dadada' }
}, { dark: false });

// const monokaiTheme = EditorView.theme({
//     '&': { backgroundColor: '#272822', color: '#f8f8f2' },
//     '.cm-content': { caretColor: '#f8f8f0' },
//     '.cm-cursor, .cm-dropCursor': { borderLeftColor: '#f8f8f0' },
//     '&.cm-focused .cm-selectionBackground, ::selection': { backgroundColor: '#49483e' },
//     '.cm-activeLine': { backgroundColor: '#3e3d32' },
//     '.cm-activeLineGutter': { backgroundColor: '#3e3d32' },
//     '.cm-gutters': { backgroundColor: '#272822', color: '#8f908a', borderRight: '1px solid #3e3d32' }
// }, { dark: true });

const themeByName = (name) => (name === 'light' ? lightTheme : monokai);

const fontSizeForMode = (modeId) => {
    const simple = simplifyMode(modeId);
    return (simple === 'text' || simple === 'markdown') ? '16px' : '14px';
};

const typographyThemeFor = (modeId) => EditorView.theme({
    '.cm-content, .cm-gutters': {
        fontFamily: 'Monaco, Menlo, "Ubuntu Mono", Consolas, "Source Code Pro", source-code-pro, monospace',
        fontSize: fontSizeForMode(modeId)
    }
});

const activeLineLayerTheme = EditorView.baseTheme({
    '.cm-activeLine-layer': {
        pointerEvents: 'none'
    },
    '.cm-activeLine-layer-marker': {
        backgroundColor: 'rgba(0, 0, 0, 0.06)'
    },
    '&dark .cm-activeLine-layer-marker': {
        backgroundColor: 'rgba(255, 255, 255, 0.06)'
    }
});

const cjkDecorator = new MatchDecorator({
    regexp: /[\u3400-\u9FFF]/g,
    decoration: Decoration.mark({ class: 'cm-cjk' })
});

class ImageWidget extends WidgetType {
    constructor(src, alt) {
        super();
        this.src = src;
        this.alt = alt;
    }
    eq(other) {
        return other.src === this.src && other.alt === this.alt;
    }
    toDOM() {
        const img = document.createElement('img');
        img.src = this.src;
        img.alt = this.alt || '';
        img.className = 'cm-inline-image';
        img.draggable = false;
        img.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            showLightbox(this.src, this.alt);
        });
        return img;
    }
    ignoreEvent() {
        return true;
    }
}

const cjkSpacingPlugin = ViewPlugin.fromClass(class {
    constructor(view) {
        this.decorations = cjkDecorator.createDeco(view);
    }
    update(update) {
        if (update.docChanged || update.viewportChanged) {
            this.decorations = cjkDecorator.updateDeco(update, this.decorations);
        }
    }
}, {
    decorations: (v) => v.decorations
});

class CMEditorWrapper {
    constructor({
        parent,
        content = '',
        modeId = 'text/plain',
        wrap = false,
        themeName = 'dark',
        images = [],
        onChange,
        onSelection,
        onCursor,
        onFocus,
        onPasteText
    }) {
        this.__modeId = normalizeModeIdForStore(modeId);
        this.__wrap = !!wrap;
        this.__themeName = themeName;
        this.modeCompartment = new Compartment();
        this.wrapCompartment = new Compartment();
        this.themeCompartment = new Compartment();
        this.keymapCompartment = new Compartment();
        this.selectionHighlightCompartment = new Compartment();
        this.customKeymapCompartment = new Compartment();
        this.typographyCompartment = new Compartment();
        this.customKeymaps = [];
        this.imageStore = new Map();
        this.imageHash = new Map();
        this.hashToId = new Map();
        this.removedImages = new Map();
        if (Array.isArray(images)) {
            images.forEach((item) => {
                if (Array.isArray(item)) {
                    const [id, data] = item;
                    if (id && data) {
                        const hash = hashString(data);
                        this.imageStore.set(id, data);
                        this.imageHash.set(id, hash);
                        this.hashToId.set(hash, id);
                    }
                } else if (item && item.id && item.data) {
                    const hash = item.hash || hashString(item.data);
                    this.imageStore.set(item.id, item.data);
                    this.imageHash.set(item.id, hash);
                    this.hashToId.set(hash, item.id);
                }
            });
        }
        this.removedImages = new Map();

        const imageDecorator = new MatchDecorator({
            regexp: /\[\[img:([^\]\s]+)\]\]/g,
            maxLength: 300000,
            decoration: (match) => {
                const id = match[1];
                const src = this.imageStore.get(id);
                if (!src) return null;
                return Decoration.replace({
                    widget: new ImageWidget(src, ''),
                    inclusive: false,
                    block: false
                });
            }
        });

        const owner = this;
        const imagePreviewPlugin = ViewPlugin.fromClass(class {
            constructor(view) {
                this.decorations = imageDecorator.createDeco(view);
            }
            update(update) {
                if (update.docChanged || update.viewportChanged) {
                    owner.restoreMissingImages();
                    this.decorations = imageDecorator.updateDeco(update, this.decorations);
                }
            }
        }, {
            decorations: v => v.decorations
        });

        const activeLineLayer = layer({
            above: false,
            class: 'cm-activeLine-layer',
            update: (update) => update.selectionSet || update.viewportChanged || update.docChanged,
            markers: (view) => {
                const selectionHasContent = view.state.selection.ranges.some(r => !r.empty);
                if (selectionHasContent) return [];
                const main = view.state.selection.main;
                const block = view.lineBlockAt(main.head);
                const scroll = view.scrollDOM;
                const left = 0;
                const width = scroll ? scroll.scrollWidth : null;
                return [
                    new RectangleMarker(
                        'cm-activeLine-layer-marker',
                        left,
                        block.top,
                        width,
                        block.height
                    )
                ];
            }
        });

        const baseExtensions = [
            lineNumbers(),
            foldGutter({ openText: '▾', closedText: '▸' }),
            indentationMarkers(),
            highlightSpecialChars(),
            history(),
            drawSelection(),
            dropCursor(),
            indentOnInput(),
            syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
            highlightActiveLine(),
            highlightActiveLineGutter(),
            rectangularSelection(),
            crosshairCursor(),
            this.typographyCompartment.of(typographyThemeFor(this.__modeId)),
            search({ top: true }),
            cjkSpacingPlugin,
            imagePreviewPlugin,
            activeLineLayerTheme,
            activeLineLayer,
            this.selectionHighlightCompartment.of([]),
            keymap.of([
                { key: 'Backspace', preventDefault: true, run: () => this.deleteImageAtCursor('backward') },
                { key: 'Delete', preventDefault: true, run: () => this.deleteImageAtCursor('forward') },
                { key: 'ArrowLeft', preventDefault: false, run: () => this.moveAcrossImage('left') },
                { key: 'ArrowRight', preventDefault: false, run: () => this.moveAcrossImage('right') },
                {
                    key: 'Mod-Shift-\\',
                    preventDefault: true,
                    run: () => {
                        this.selectionController?.handleAction('bbs-table');
                        return true;
                    }
                },
                ...defaultKeymap,
                ...historyKeymap,
                ...foldKeymap,
                ...searchKeymap,
                indentWithTab
            ]),
            this.customKeymapCompartment.of(keymap.of([])),
            this.modeCompartment.of(languageForMode(this.__modeId)),
            this.wrapCompartment.of(this.__wrap ? EditorView.lineWrapping : []),
            this.themeCompartment.of(themeByName(this.__themeName)),
            this.keymapCompartment.of([]),
            EditorView.updateListener.of((update) => {
                if (update.focusChanged && update.view.hasFocus) {
                    onFocus?.(this);
                }
                if (update.selectionSet) {
                    onSelection?.(this);
                    onCursor?.(this);
                }
                if (update.docChanged) {
                    this.pruneImageStore();
                    this.restoreMissingImages();
                    onCursor?.(this);
                    onChange?.(this);
                }
                const pasted = update.transactions.some(tr => tr.isUserEvent?.('input.paste'));
                if (pasted && onPasteText) {
                    const parts = [];
                    update.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
                        parts.push(inserted.toString());
                    });
                    const text = parts.join('\n');
                    const hadContent = update.startState.doc.length > 0;
                    onPasteText(text, hadContent, this);
                }
                this.updateGutterShadow();
            })
        ];

        this.view = new EditorView({
            state: EditorState.create({
                doc: content || '',
                extensions: baseExtensions
            }),
            parent
        });

        this.scrollHandler = () => this.updateGutterShadow();
        this.view.scrollDOM?.addEventListener('scroll', this.scrollHandler, { passive: true });
        this.updateGutterShadow();
        this.pointerHandler = (e) => {
            this.setSelectionHighlight(!!e.metaKey);
        };
        this.pointerUpHandler = () => this.setSelectionHighlight(false);
        this.view.dom.addEventListener('mousedown', this.pointerHandler, { passive: true });
        window.addEventListener('mouseup', this.pointerUpHandler, { passive: true });
        this.dragOverHandler = (e) => {
            if (e.dataTransfer?.types?.includes('Files')) {
                e.preventDefault();
            }
        };
        this.dropHandler = (e) => this.handleDrop(e);
        this.view.dom.addEventListener('dragover', this.dragOverHandler);
        this.view.dom.addEventListener('drop', this.dropHandler);
        this.registerCustomCommands();
    }

    getView() {
        return this.view;
    }

    updateGutterShadow() {
        const gutters = this.view?.dom?.querySelector?.('.cm-gutters');
        const scroller = this.view?.scrollDOM;
        if (!gutters || !scroller) return;
        const scrolled = scroller.scrollLeft > 1;
        gutters.classList.toggle('cm-gutter-shadow', scrolled);
    }

    setSelectionHighlight(enable) {
        const ext = enable ? highlightSelectionMatches() : [];
        this.view.dispatch({ effects: this.selectionHighlightCompartment.reconfigure(ext) });
    }

    createImageId() {
        return `img-${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 8)}`;
    }

    registerImage(dataUrl) {
        const hash = hashString(dataUrl);
        const existing = this.hashToId.get(hash);
        if (existing) {
            this.removedImages.delete(existing);
            return existing;
        }
        const id = this.createImageId();
        this.imageStore.set(id, dataUrl);
        this.imageHash.set(id, hash);
        this.hashToId.set(hash, id);
        this.removedImages.delete(id);
        return id;
    }

    async handleDrop(event) {
        if (!event.dataTransfer?.files?.length) return;
        event.preventDefault();
        const files = Array.from(event.dataTransfer.files).filter(f => f.type && f.type.startsWith('image/'));
        if (!files.length) return;
        for (const file of files) {
            const dataUrl = await this.compressImage(file);
            const id = this.registerImage(dataUrl);
            const snippet = `[[img:${id}]]`;
            const tr = this.view.state.replaceSelection(snippet);
            this.view.dispatch(tr);
        }
        this.view.focus();
    }

    readFileAsDataURL(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
    }

    async compressImage(file, { maxWidth = 1600, maxHeight = 1600, quality = 0.8 } = {}) {
        const src = await this.readFileAsDataURL(file);
        return new Promise((resolve) => {
            const img = new Image();
            img.onload = () => {
                let { width, height } = img;
                const scale = Math.min(1, maxWidth / width, maxHeight / height);
                if (scale < 1) {
                    width = Math.floor(width * scale);
                    height = Math.floor(height * scale);
                }
                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);
                const dataUrl = canvas.toDataURL('image/jpeg', quality);
                resolve(dataUrl);
            };
            img.onerror = () => resolve(src);
            img.src = src;
        });
    }

    lineChToPos({ line = 0, ch = 0 }) {
        const lineInfo = this.view.state.doc.line(Math.max(1, line + 1));
        return Math.min(lineInfo.from + ch, lineInfo.to);
    }

    posToLineCh(pos = 0) {
        const lineInfo = this.view.state.doc.line(Math.max(1, Math.min(this.view.state.doc.lines, Math.floor(pos) + 1)));
        const ch = pos - lineInfo.from;
        return { line: lineInfo.number - 1, ch };
    }

    getCursor() {
        const pos = this.view.state.selection.main.head;
        return this.posToLineCh(pos);
    }

    getImageRangeAt(pos, { mode = 'default', direction = 'left' } = {}) {
        const text = this.getValue() || '';
        const re = /\[\[img:([^\]\s]+)\]\]/g;
        let m;
        while ((m = re.exec(text)) !== null) {
            const from = m.index;
            const to = from + m[0].length;
            if (pos < from) continue;
            if (pos > to) continue;
            const atStart = pos === from;
            const atEnd = pos === to;
            const inside = pos > from && pos < to;
            if (mode === 'delete') {
                if (inside) return { from, to };
                if (direction === 'forward' && atStart) return { from, to };
                // backward delete should not trigger when cursor is after the marker with extra char
                return null;
            }
            if (mode === 'arrow') {
                if (inside) return { from, to };
                if (direction === 'left' && atEnd) return { from, to };
                if (direction === 'right' && atStart) return { from, to };
                continue;
            }
            if (inside || atStart || atEnd) return { from, to };
        }
        return null;
    }

    deleteImageAtCursor(direction = 'backward') {
        const sel = this.view.state.selection.main;
        if (!sel.empty) return false;
        const pos = direction === 'backward' ? Math.max(0, sel.from - 1) : sel.from;
        const range = this.getImageRangeAt(pos, { mode: 'delete', direction });
        if (!range) return false;
        this.view.dispatch({ changes: { from: range.from, to: range.to, insert: '' } });
        this.pruneImageStore();
        return true;
    }

    moveAcrossImage(direction = 'left') {
        const sel = this.view.state.selection.main;
        if (!sel.empty) return false;
        const pos = sel.from;
        const range = this.getImageRangeAt(pos, { mode: 'arrow', direction });
        if (!range) return false;
        const target = direction === 'left' ? range.from : range.to;
        this.view.dispatch({ selection: { anchor: target, head: target }, scrollIntoView: true });
        return true;
    }

    getUsedImageIds() {
        const text = this.getValue() || '';
        const ids = new Set();
        const re = /\[\[img:([^\]\s]+)\]\]/g;
        let m;
        while ((m = re.exec(text)) !== null) {
            if (m[1]) ids.add(m[1]);
        }
        return ids;
    }

    pruneImageStore() {
        const used = this.getUsedImageIds();
        Array.from(this.imageStore.keys()).forEach((id) => {
            if (!used.has(id)) {
                const val = this.imageStore.get(id);
                const hash = this.imageHash.get(id);
                this.imageStore.delete(id);
                if (val) this.removedImages.set(id, val);
                if (hash) this.hashToId.delete(hash);
                this.imageHash.delete(id);
            }
        });
    }

    restoreMissingImages() {
        const used = this.getUsedImageIds();
        used.forEach((id) => {
            if (!this.imageStore.has(id) && this.removedImages.has(id)) {
                const data = this.removedImages.get(id);
                this.imageStore.set(id, data);
                const hash = hashString(data);
                this.imageHash.set(id, hash);
                this.hashToId.set(hash, id);
            }
        });
    }

    getValue() {
        return this.view.state.doc.toString();
    }

    setValue(val) {
        const doc = this.view.state.doc;
        this.view.dispatch({
            changes: { from: 0, to: doc.length, insert: val || '' },
            selection: { anchor: 0 }
        });
    }

    getMode() {
        return this.__modeId;
    }

    setMode(modeId) {
        this.__modeId = normalizeModeIdForStore(modeId);
        this.view.dispatch({
            effects: this.modeCompartment.reconfigure(languageForMode(this.__modeId))
        });
        this.view.dispatch({
            effects: this.typographyCompartment.reconfigure(typographyThemeFor(this.__modeId))
        });
    }

    getOption(key) {
        if (key === 'lineWrapping') return this.__wrap;
        return undefined;
    }

    setOption(key, value) {
        if (key === 'lineWrapping') {
            this.__wrap = !!value;
            this.view.dispatch({
                effects: this.wrapCompartment.reconfigure(this.__wrap ? EditorView.lineWrapping : [])
            });
        }
    }

    listSelections() {
        return this.view.state.selection.ranges.map(r => ({
            anchor: this.posToLineCh(r.anchor),
            head: this.posToLineCh(r.head)
        }));
    }

    getRange(from, to) {
        const a = this.lineChToPos(from);
        const b = this.lineChToPos(to);
        return this.view.state.doc.sliceString(Math.min(a, b), Math.max(a, b));
    }

    replaceRange(text, from, to) {
        const a = this.lineChToPos(from);
        const b = this.lineChToPos(to);
        this.view.dispatch({
            changes: { from: Math.min(a, b), to: Math.max(a, b), insert: text }
        });
    }

    setSelection(from, to) {
        const anchor = this.lineChToPos(from);
        const head = this.lineChToPos(to);
        this.view.dispatch({
            selection: { anchor, head },
            scrollIntoView: true
        });
    }

    replaceSelection(text) {
        const ranges = this.view.state.selection.ranges;
        const start = ranges[0]?.from ?? 0;
        const endPos = start + text.length;
        this.view.dispatch({
            changes: ranges.map(r => ({
                from: r.from,
                to: r.to,
                insert: text
            })),
            selection: { anchor: endPos, head: endPos },
            scrollIntoView: true
        });
    }

    addKeymap(bindings = []) {
        if (!bindings.length) return;
        this.customKeymaps = [...this.customKeymaps, ...bindings];
        this.view.dispatch({
            effects: this.customKeymapCompartment.reconfigure(keymap.of(this.customKeymaps))
        });
    }

    registerCustomCommands() {
        registerSaveCommand(this);
        registerTimeCommands(this);
    }

    cursorCoords(pos, _type) {
        const at = this.lineChToPos(pos);
        return this.view.coordsAtPos(at);
    }

    focus() {
        this.view.focus();
    }

    refresh() {
        this.view.requestMeasure();
    }

    getWrapperElement() {
        return this.view.dom;
    }

    addKeymap(bindings = []) {
        this.view.dispatch({
            effects: StateEffect.appendConfig.of(keymap.of(bindings))
        });
    }

    setTheme(themeName) {
        this.__themeName = themeName;
        this.view.dispatch({
            effects: this.themeCompartment.reconfigure(themeByName(this.__themeName))
        });
    }
}

export class EditorManager {
    constructor({
        container,
        tabs,
        tabList,
        statusText,
        modeSelect,
        formatPrettyBtn,
        formatCompactBtn,
        wrapToggle,
        selectionMenu,
        addButton,
        showToast,
        askConfirm,
        sessionStore,
        setHistoryCount,
        themeController
    }) {
        this.container = container;
        this.tabs = tabs;
        this.tabList = tabList;
        this.statusText = statusText;
        this.modeSelect = modeSelect;
        this.formatPrettyBtn = formatPrettyBtn;
        this.formatCompactBtn = formatCompactBtn;
        this.wrapToggle = wrapToggle;
        this.selectionMenu = selectionMenu;
        this.addButton = addButton;
        this.showToast = showToast;
        this.askConfirm = askConfirm;
        this.sessionStore = sessionStore;
        this.setHistoryCount = setHistoryCount;
        this.themeController = themeController;

        this.activeEditor = null;
        this.currentMode = modeSelect?.value || 'text/plain';
        this.editors = [];
        this.pageId = generateSessionId();
        this.wrapPreference = this.loadWrapPreference();
        this.selectionController = new SelectionMenuController({
            menuEl: this.selectionMenu,
            showToast: this.showToast,
            getActiveEditor: () => this.activeEditor
        });

        this.bindControls();
        this.updateWrapToggleUI();
    }

    bindControls() {
        this.addButton?.addEventListener('click', () => this.addEditorPane());
        if (this.modeSelect) {
            this.modeSelect.addEventListener('change', (e) => this.handleModeChange(e.target.value));
        }
        this.formatPrettyBtn?.addEventListener('click', () => this.handleFormat('pretty'));
        this.formatCompactBtn?.addEventListener('click', () => this.handleFormat('compact'));
        this.wrapToggle?.addEventListener('click', () => this.toggleWrap());
        window.addEventListener('resize', () => {
            const panes = this.editors.map(ed => ed.__pane).filter(Boolean);
            this.layoutPanes(panes);
        });
        const bbsHotkeyHandler = (e) => {
            const isMod = e.metaKey || e.ctrlKey;
            if (!isMod || !e.shiftKey) return;
            if (e.key !== '\\') return;
            const handled = this.selectionController?.handleAction('bbs-table');
            if (handled !== false) {
                e.preventDefault();
                e.stopImmediatePropagation();
                return true;
            }
            return false;
        };
        window.addEventListener('keydown', bbsHotkeyHandler, { capture: true });
        window.addEventListener('keyup', bbsHotkeyHandler, { capture: true });
        this.renderTabs();
        this.updatePaneVisibility();
    }

    loadWrapPreference() {
        try {
            const v = localStorage.getItem(WRAP_STORAGE_KEY);
            return v === '1';
        } catch (_) {
            return false;
        }
    }

    setWrapPreference(useWrap) {
        this.wrapPreference = !!useWrap;
        try {
            localStorage.setItem(WRAP_STORAGE_KEY, this.wrapPreference ? '1' : '0');
        } catch (_) {}
    }

    updateWrapToggleUI() {
        if (!this.wrapToggle || !this.activeEditor) return;
        const useWrap = this.activeEditor.getOption('lineWrapping');
        const icon = this.wrapToggle.querySelector('.icon');
        if (icon) icon.className = `icon ${useWrap ? 'icon-wrap-on' : 'icon-wrap-off'}`;
    }

    getEditorModeId(editorInstance = this.activeEditor) {
        const raw = editorInstance?.getMode?.() || this.currentMode || 'text/plain';
        return normalizeModeIdForStore(raw);
    }

    setActiveEditor(editorInstance) {
        this.activeEditor = editorInstance;
        const modeId = this.getEditorModeId(editorInstance);
        this.currentMode = modeId;
        if (this.modeSelect && this.modeSelect.value !== modeId) {
            this.modeSelect.value = modeId;
        }
        this.renderTabs();
        this.updatePaneVisibility();
        this.updateStatus();
        this.updateDocumentTitle();
        this.updateWrapToggleUI();
        if (this.formatPrettyBtn) this.formatPrettyBtn.style.display = isFormatSupported(modeId) ? 'inline-flex' : 'none';
        if (this.formatCompactBtn) this.formatCompactBtn.style.display = simplifyMode(modeId) === 'json' ? 'inline-flex' : 'none';
    }

    updateStatus() {
        if (!this.activeEditor) return;
        const { line, ch } = this.activeEditor.getCursor();
        const totalChars = this.activeEditor.getValue().length;
        const encoder = new TextEncoder();
        const bytes = encoder.encode(this.activeEditor.getValue()).length;
        if (this.statusText) {
            this.statusText.textContent = `Ln ${line + 1}, Col ${ch + 1} | Chars ${totalChars} | Bytes ${bytes}`;
        }
    }

    updateDocumentTitle() {
        if (!this.activeEditor) {
            document.title = 'Notelet';
            return;
        }
        const firstLine = (this.activeEditor.getValue() || '').split(/\r?\n/)[0].trim();
        const display = firstLine.slice(0, 20);
        document.title = display ? `${display} - Notelet` : 'Notelet';
    }

    scheduleSelectionMenu(pageX, pageY, delay = 1000) {
        this.selectionController?.schedule(pageX, pageY, delay);
    }

    hideSelectionMenu() {
        this.selectionController?.hide();
    }

    handleSelectionAction(action) {
        this.selectionController?.handleAction(action);
    }

    attachSelectionMenu() {
        // handled by SelectionMenuController
    }

    updateCloseButtons() {
        const show = !isMobile() && this.editors.length > 1;
        this.editors.forEach(ed => {
            const pane = ed.__pane;
            const btn = pane?.querySelector('.pane-close');
            if (btn) btn.style.display = show ? 'block' : 'none';
        });
    }

    renderTabs() {
        if (!this.tabList) return;
        if (!isMobile()) {
            this.tabList.innerHTML = '';
            return;
        }
        this.tabList.innerHTML = '';
        const showClose = this.editors.length > 1;
        this.editors.forEach((ed, idx) => {
            const wrapper = document.createElement('div');
            wrapper.className = 'tab-btn' + (ed === this.activeEditor ? ' active' : '');

            const label = document.createElement('span');
            label.textContent = `Ed ${idx + 1}`;
            wrapper.appendChild(label);

            const close = document.createElement('button');
            close.className = 'tab-close';
            close.textContent = '×';
            close.style.display = showClose ? 'inline-flex' : 'none';
            close.addEventListener('click', async (ev) => {
                ev.stopPropagation();
                const ok = await this.askConfirm('要關閉這個編輯器嗎？');
                if (!ok) return;
                this.removePane(ed.__pane, ed);
            });
            wrapper.appendChild(close);

            wrapper.addEventListener('click', () => this.setActiveEditor(ed));
            this.tabList.appendChild(wrapper);
        });
    }

    updatePaneVisibility() {
        const mobile = isMobile();
        this.editors.forEach(ed => {
            const pane = ed.__pane;
            if (!pane) return;
            if (mobile) {
                pane.classList.toggle('hidden', ed !== this.activeEditor);
            } else {
                pane.classList.remove('hidden');
            }
        });
    }

    layoutPanes(panes) {
        const mobile = isMobile();
        const resizerCount = Math.max(0, panes.length - 1);
        const width = this.container.clientWidth || this.container.getBoundingClientRect().width;
        const available = Math.max(0, width - resizerCount * RESIZER_WIDTH);
        const basis = panes.length ? available / panes.length : 0;
        this.container.innerHTML = '';
        panes.forEach((pane, index) => {
            if (mobile) {
                pane.style.flex = '1 1 auto';
                pane.style.width = '100%';
                this.container.appendChild(pane);
            } else {
                if (basis > 0) {
                    pane.style.flex = `0 0 ${basis}px`;
                } else {
                    pane.style.flex = '1 1 0';
                }
                this.container.appendChild(pane);
                if (index < panes.length - 1) {
                    const resizer = this.makeResizer(pane, panes[index + 1]);
                    this.container.appendChild(resizer);
                }
            }
        });
        this.updateCloseButtons();
        this.updatePaneVisibility();
        this.renderTabs();
        this.editors.forEach(ed => ed.refresh?.());
    }

    makeResizer(leftPane, rightPane) {
        const resizer = document.createElement('div');
        resizer.className = 'resizer';
        let startX = 0;
        let leftStart = 0;
        let rightStart = 0;

        const onMouseMove = (e) => {
            const dx = e.clientX - startX;
            const total = leftStart + rightStart;
            let newLeft = leftStart + dx;
            newLeft = Math.max(80, Math.min(total - 80, newLeft));
            const newRight = total - newLeft;
            leftPane.style.flex = `0 0 ${newLeft}px`;
            rightPane.style.flex = `0 0 ${newRight}px`;
        };

        const onMouseUp = () => {
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
            document.body.style.userSelect = '';
        };

        resizer.addEventListener('mousedown', (e) => {
            startX = e.clientX;
            leftStart = leftPane.getBoundingClientRect().width;
            rightStart = rightPane.getBoundingClientRect().width;
            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
            document.body.style.userSelect = 'none';
        });

        return resizer;
    }

    removePane(pane, editorInstance) {
        this.editors = this.editors.filter(ed => ed !== editorInstance);
        const panes = this.editors.map(ed => ed.__pane).filter(Boolean);
        this.layoutPanes(panes);

        if (this.activeEditor === editorInstance) {
            const nextEditor = this.editors[0] || null;
            if (nextEditor) {
                this.setActiveEditor(nextEditor);
            } else {
                this.activeEditor = null;
                if (this.statusText) this.statusText.textContent = 'Ln 1, Col 1 | Chars 0 | Bytes 0';
            }
        }
        this.persistPage();
    }

    handlePastedText(text, hadContent, editorInstance) {
        if (hadContent) return;
        if (typeof text !== 'string') return;
        const detected = detectModeFromText(text);
        if (detected && detected !== this.getEditorModeId(editorInstance)) {
            editorInstance.setMode(detected);
            this.currentMode = detected;
            if (this.modeSelect && this.modeSelect.value !== detected) this.modeSelect.value = detected;
            if (this.formatPrettyBtn) this.formatPrettyBtn.style.display = isFormatSupported(detected) ? 'inline-flex' : 'none';
            if (this.formatCompactBtn) this.formatCompactBtn.style.display = simplifyMode(detected) === 'json' ? 'inline-flex' : 'none';
        }
    }

    createPane(images = []) {
        const pane = document.createElement('div');
        pane.className = 'pane';

        const closeBtn = document.createElement('button');
        closeBtn.className = 'pane-close';
        closeBtn.textContent = '×';
        pane.appendChild(closeBtn);

        const editorEl = document.createElement('div');
        editorEl.className = 'editor-host';
        pane.appendChild(editorEl);

        const editorInstance = new CMEditorWrapper({
            parent: editorEl,
            content: '',
            modeId: this.currentMode,
            wrap: this.wrapPreference,
            themeName: this.themeController?.resolved || 'dark',
            images,
            onChange: (ed) => {
                if (ed.__suppressPersist) {
                    ed.__suppressPersist = false;
                    this.updateStatus();
                    if (ed === this.activeEditor) this.updateDocumentTitle();
                    return;
                }
                this.updateStatus();
                if (ed === this.activeEditor) this.updateDocumentTitle();
                this.persistPage();
            },
            onSelection: () => {
                this.hideSelectionMenu();
            },
            onCursor: () => {
                this.updateStatus();
            },
            onFocus: (ed) => this.setActiveEditor(ed),
            onPasteText: (text, hadContent, ed) => this.handlePastedText(text, hadContent, ed)
        });
        editorInstance.__sessionId = generateSessionId();
        editorInstance.__suppressPersist = false;
        editorInstance.__pane = pane;
        this.selectionController.attachToEditor(editorInstance);

        closeBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const ok = await this.askConfirm('要關閉這個編輯器嗎？');
            if (!ok) return;
            this.removePane(pane, editorInstance);
        });

        if (!this.activeEditor) this.setActiveEditor(editorInstance);
        return { pane, editorInstance };
    }

    addEditorPane(initialContent = '', initialMode = this.currentMode, suppressPersist = false, initialWrap = this.wrapPreference, images = []) {
        const { pane, editorInstance } = this.createPane(images);
        this.editors.push(editorInstance);
        const panes = Array.from(this.container.querySelectorAll('.pane'));
        panes.push(pane);
        this.layoutPanes(panes);

        editorInstance.setMode(initialMode || this.currentMode);
        editorInstance.setOption('lineWrapping', !!initialWrap);
        if (initialContent !== undefined && initialContent !== null) {
            if (suppressPersist) editorInstance.__suppressPersist = true;
            editorInstance.setValue(initialContent);
        }

        this.setActiveEditor(editorInstance);
        this.themeController.apply(this.themeController.preference, { skipPersist: true });
        editorInstance.refresh?.();
    }

    async persistPage() {
        if (!this.sessionStore) return;
        const snapshot = this.getSnapshot();
        const hasContent = snapshot.editors.some(e => e.content.trim().length > 0);
        if (!hasContent) return;
        const updatedAt = Date.now();
        await this.sessionStore.put({ id: this.pageId, editors: snapshot.editors, updatedAt });
        await this.sessionStore.prune();
        await this.updateHistoryCount();
    }

    async updateHistoryCount() {
        if (!this.sessionStore || !this.setHistoryCount) return;
        const sessions = await this.sessionStore.list();
        this.setHistoryCount((sessions || []).length);
    }

    getSnapshot() {
        return {
            id: this.pageId,
            editors: this.editors.map(ed => ({
                content: ed.getValue(),
                mode: this.getEditorModeId(ed),
                wrap: ed.getOption('lineWrapping'),
                images: ed.imageStore ? Array.from(ed.imageStore.entries()).map(([id, data]) => ({
                    id,
                    data,
                    hash: ed.imageHash?.get(id) || hashString(data)
                })) : []
            }))
        };
    }

    applySnapshot(snapshot, replace = false) {
        if (!snapshot) return;
        let editorsData = snapshot.editors;
        if (!Array.isArray(editorsData)) {
            editorsData = [{ content: snapshot.content || '', mode: snapshot.mode || this.currentMode }];
        }
        if (replace) {
            this.editors = [];
            this.container.innerHTML = '';
        }
        editorsData.forEach(ed => {
            this.addEditorPane(ed.content || '', ed.mode || this.currentMode, true, ed.wrap !== undefined ? ed.wrap : this.wrapPreference, ed.images || []);
        });
        this.setActiveEditor(this.editors[this.editors.length - 1]);
        this.pageId = generateSessionId();
    }

    toggleWrap() {
        if (!this.activeEditor) return;
        const useWrap = !this.activeEditor.getOption('lineWrapping');
        this.activeEditor.setOption('lineWrapping', useWrap);
        this.setWrapPreference(useWrap);
        this.updateWrapToggleUI();
        this.persistPage();
    }

    handleModeChange(nextMode) {
        this.currentMode = nextMode;
        if (this.activeEditor) {
            this.activeEditor.setMode(this.currentMode);
            this.persistPage();
            if (this.formatPrettyBtn) this.formatPrettyBtn.style.display = isFormatSupported(this.currentMode) ? 'inline-flex' : 'none';
            if (this.formatCompactBtn) this.formatCompactBtn.style.display = simplifyMode(this.currentMode) === 'json' ? 'inline-flex' : 'none';
        }
    }

    handleFormat(kind) {
        if (!this.activeEditor) return;
        const ed = this.activeEditor;
        const modeId = this.getEditorModeId(ed);
        const val = ed.getValue();
        let next = val;
        try {
            next = formatContent(kind, val, modeId);
        } catch (e) {
            const msg = e && e.message ? e.message : '格式化失敗';
            this.showToast(`格式化失敗：${msg}`);
            return;
        }
        ed.__suppressPersist = false;
        ed.setValue(next);
        ed.setSelection({ line: 0, ch: 0 }, { line: 0, ch: 0 });
        this.persistPage();
    }

    hasAnyContent() {
        return this.editors.some(ed => ed.getValue().trim().length > 0);
    }

    getEditors() {
        return this.editors.slice();
    }

    getActiveEditor() {
        return this.activeEditor;
    }

    getActiveIndex() {
        return this.editors.indexOf(this.activeEditor);
    }

    getValues() {
        return this.editors.map((ed, idx) => ({ index: idx, mode: this.getEditorModeId(ed), value: ed.getValue() }));
    }

    getPageId() {
        return this.pageId;
    }

    setPageId(id) {
        this.pageId = id;
    }

    clearSelectionMenu() {
        this.hideSelectionMenu();
    }

    buildPublicApi() {
        return Object.freeze({
            getEditors: () => this.getEditors(),
            getActiveEditor: () => this.getActiveEditor(),
            getActiveIndex: () => this.getActiveIndex(),
            getValue: (index = this.getActiveIndex()) => this.editors[index]?.getValue() ?? '',
            getValues: () => this.getValues(),
            focus: (index = 0) => {
                const ed = this.editors[index];
                if (ed) {
                    ed.focus();
                    this.setActiveEditor(ed);
                }
                return ed;
            }
        });
    }

    handleSelectionMenuBinding() {
        this.attachSelectionMenu();
    }
}
