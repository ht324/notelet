import { RESIZER_WIDTH, WRAP_STORAGE_KEY } from './constants.js';
import { detectModeFromText, generateSessionId, simplifyMode, isFormatSupported, normalizeModeIdForStore, hashString } from './utils/editor-utils.js';
import { formatContent } from './formatters.js';
import { SelectionMenuController } from './selection-menu.js';
import { registerSaveCommand, registerTimeCommands } from './editor-commands.js';
import { EditorState, Compartment, StateEffect } from '@codemirror/state';
import { EditorView, keymap, highlightSpecialChars, drawSelection, highlightActiveLine, highlightActiveLineGutter, dropCursor, rectangularSelection, crosshairCursor, lineNumbers, layer, RectangleMarker, Decoration, ViewPlugin, MatchDecorator, WidgetType } from '@codemirror/view';
import { defaultHighlightStyle, syntaxHighlighting, indentOnInput, indentUnit, foldGutter, foldKeymap } from '@codemirror/language';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
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
            indentUnit.of('\t'),
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
                { key: 'Tab', preventDefault: true, run: () => { this.replaceSelection('\t'); return true; } },
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
                ...searchKeymap
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

    getPaneEditors(pane) {
        return this.editors.filter(ed => ed.__pane === pane);
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
        const clamped = Math.max(0, Math.min(this.view.state.doc.length, Math.floor(pos)));
        const lineInfo = this.view.state.doc.lineAt(clamped);
        const ch = clamped - lineInfo.from;
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
        addTabButton,
        addSplitButton,
        showToast,
        askConfirm,
        sessionStore,
        setHistoryCount,
        themeController,
        previewManager
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
        this.addTabButton = addTabButton;
        this.addSplitButton = addSplitButton;
        this.showToast = showToast;
        this.askConfirm = askConfirm;
        this.sessionStore = sessionStore;
        this.setHistoryCount = setHistoryCount;
        this.themeController = themeController;
        this.previewManager = previewManager;

        this.activeEditor = null;
        this.currentMode = modeSelect?.value || 'text/plain';
        this.editors = [];
        this.draggedEditor = null;
        this.containerDropHint = null;
        this.lastContainerHint = null;
        this.dragAnchorEditor = null;
        this.tabDropTarget = null;
        this.tabDropMarker = null;
        this.pageId = generateSessionId();
        this.activePaneId = null;
        this.paneTree = null; // { type: 'leaf' | 'split', id?, dir?, children? }
        this.paneDom = new Map();
        this.desktopLayoutBackup = null;
        this.isMobileCollapsed = false;
        this.wrapPreference = this.loadWrapPreference();
        this.selectionController = new SelectionMenuController({
            menuEl: this.selectionMenu,
            showToast: this.showToast,
            getActiveEditor: () => this.activeEditor
        });
        this.blockNativeDrop = (e) => {
            if (!this.draggedEditor) return;
            if (e.target && e.target.closest && !e.target.closest('.pane')) return;
            if (e.target && e.target.closest && e.target.closest('.cm-editor')) {
                e.preventDefault();
                return;
            }
            e.preventDefault();
        };

        this.bindControls();
        this.updateWrapToggleUI();
    }

    bindControls() {
        this.addTabButton?.addEventListener('click', () => this.addEditorPane());
        this.addSplitButton?.addEventListener('click', () => this.addEditorPane({ asSplit: true }));
        if (this.modeSelect) {
            this.modeSelect.addEventListener('change', (e) => this.handleModeChange(e.target.value));
        }
        this.formatPrettyBtn?.addEventListener('click', () => this.handleFormat('pretty'));
        this.formatCompactBtn?.addEventListener('click', () => this.handleFormat('compact'));
        this.wrapToggle?.addEventListener('click', () => this.toggleWrap());
        window.addEventListener('resize', () => {
            this.syncLayout(true);
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
        this.container?.addEventListener('dragover', (e) => this.handleContainerDragOver(e));
        this.container?.addEventListener('drop', (e) => this.handleContainerDrop(e));
        this.container?.addEventListener('dragleave', () => this.clearDropIndicators());
        this.container?.addEventListener('dragover', this.blockNativeDrop, true);
        this.container?.addEventListener('drop', this.blockNativeDrop, true);
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
        const tooltipText = useWrap ? '取消換行' : '自動換行';
        this.wrapToggle.dataset.tooltip = tooltipText;
        this.wrapToggle.setAttribute('aria-label', tooltipText);
    }

    ensureTree() {
        if (!this.paneTree) {
            const paneId = this.createPaneId();
            this.paneTree = { type: 'leaf', id: paneId };
            this.activePaneId = paneId;
        }
        if (!this.activePaneId) {
            const leaf = this.getFirstLeaf(this.paneTree);
            this.activePaneId = leaf?.id || null;
        }
    }

    cloneTree(node) {
        return node ? JSON.parse(JSON.stringify(node)) : null;
    }

    collapseToMobilePane() {
        const targetPane = this.ensurePaneElement(this.activePaneId || this.getFirstLeaf(this.paneTree)?.id || this.createPaneId());
        // move all editors into target pane
        this.editors.forEach(ed => this.moveEditorToPane(ed, targetPane));
        // reset tree to single leaf
        const paneId = targetPane.dataset.paneId || this.createPaneId();
        targetPane.dataset.paneId = paneId;
        this.paneTree = { type: 'leaf', id: paneId };
        this.activePaneId = paneId;
        // remove other cached panes
        Array.from(this.paneDom.keys()).forEach(id => {
            if (id !== paneId) this.paneDom.delete(id);
        });
        return targetPane;
    }

    normalizeTree(node) {
        if (!node) return null;
        if (node.type === 'leaf') return node;
        if (node.type === 'split') {
            if (node.dir !== 'row' && node.dir !== 'col') node.dir = 'row';
            const kids = Array.isArray(node.children) ? node.children : [];
            node.children = kids.map(child => this.normalizeTree(child)).filter(Boolean);
            if (!Array.isArray(node.sizes) || node.sizes.length !== node.children.length) {
                const len = Math.max(1, node.children.length);
                node.sizes = new Array(len).fill(1 / len);
            }
            return node;
        }
        return null;
    }

    getFirstLeaf(node) {
        if (!node) return null;
        if (node.type === 'leaf') return node;
        for (const child of node.children || []) {
            const found = this.getFirstLeaf(child);
            if (found) return found;
        }
        return null;
    }

    findLeaf(node, paneId, parent = null, index = 0) {
        if (!node) return null;
        if (node.type === 'leaf' && node.id === paneId) {
            return { node, parent, index };
        }
        if (node.type === 'split') {
            for (let i = 0; i < (node.children || []).length; i++) {
                const child = node.children[i];
                const found = this.findLeaf(child, paneId, node, i);
                if (found) return found;
            }
        }
        return null;
    }

    replaceChild(parent, index, nextNode) {
        if (!parent || parent.type !== 'split') return;
        parent.children.splice(index, 1, nextNode);
    }

    removeLeaf(paneId) {
        if (!this.paneTree) return;
        const info = this.findLeaf(this.paneTree, paneId);
        if (!info) return;
        const { parent, index } = info;
        if (!parent) {
            this.paneTree = null;
            return;
        }
        parent.children.splice(index, 1);
        if (parent.children.length === 1) {
            const lone = parent.children[0];
            const upper = this.findNodeParent(this.paneTree, parent);
            if (!upper) {
                this.paneTree = lone;
            } else {
                upper.parent.children.splice(upper.index, 1, lone);
            }
        }
    }

    findParent(root, target, parent = null) {
        if (!root) return null;
        if (root === target) return { node: target, parent };
        if (root.type === 'split') {
            for (const child of root.children || []) {
                const found = this.findParent(child, target, root);
                if (found) return found;
            }
        }
        return null;
    }

    findNodeParent(root, target) {
        if (!root || !target || root === target) return null;
        if (root.type === 'split') {
            for (let i = 0; i < (root.children || []).length; i++) {
                const child = root.children[i];
                if (child === target) {
                    return { parent: root, index: i };
                }
                const deeper = this.findNodeParent(child, target);
                if (deeper) return deeper;
            }
        }
        return null;
    }

    splitPane(paneId, direction = 'right', newPaneId = null) {
        this.ensureTree();
        const info = this.findLeaf(this.paneTree, paneId);
        if (!info) return null;
        const { node, parent, index } = info;
        const dir = (direction === 'left' || direction === 'right') ? 'col' : 'row';
        const freshId = newPaneId || this.createPaneId();
        const first = (direction === 'left' || direction === 'top') ? { type: 'leaf', id: freshId } : node;
        const second = (direction === 'left' || direction === 'top') ? node : { type: 'leaf', id: freshId };
        const splitNode = { type: 'split', dir: dir || 'row', children: [first, second], sizes: [0.5, 0.5] };
        if (parent) {
            parent.children[index] = splitNode;
        } else {
            this.paneTree = splitNode;
        }
        return freshId;
    }

    getPaneEditors(pane) {
        return this.editors.filter(ed => ed.__pane === pane);
    }

    getPaneList() {
        this.ensureTree();
        const panes = [];
        const visit = (node) => {
            if (!node) return;
            if (node.type === 'leaf') {
                const el = this.ensurePaneElement(node.id);
                panes.push(el);
                return;
            }
            (node.children || []).forEach(visit);
        };
        visit(this.paneTree);
        return panes;
    }

    createPaneId() {
        return `pane-${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 5)}`;
    }

    ensurePaneElement(paneId) {
        if (!paneId) paneId = this.createPaneId();
        let el = this.paneDom.get(paneId);
        if (!el) {
            el = document.createElement('div');
            el.className = 'pane';
            el.dataset.paneId = paneId;
            el.dataset.paneId = paneId;
            this.attachPaneChrome(el);
            this.paneDom.set(paneId, el);
        }
        el.dataset.paneId = paneId;
        return el;
    }

    ensurePaneBody(pane) {
        if (!pane) return null;
        let body = pane.querySelector('.pane-body');
        if (!body) {
            body = document.createElement('div');
            body.className = 'pane-body';
            const tabs = pane.querySelector('.pane-tabs');
            if (tabs && tabs.nextSibling) {
                pane.insertBefore(body, tabs.nextSibling);
            } else {
                pane.appendChild(body);
            }
        }
        return body;
    }

    getPrimaryEditorForPane(pane) {
        const editors = this.getPaneEditors(pane);
        return editors.find(ed => ed === this.activeEditor) || editors[0] || null;
    }

    moveEditorToPane(editorInstance, targetPane) {
        if (!editorInstance || !targetPane) return;
        const oldPane = editorInstance.__pane;
        if (oldPane === targetPane) return;
        this.attachPaneChrome(targetPane);
        const host = editorInstance.__host;
        if (host) host.remove();
        const body = this.ensurePaneBody(targetPane);
        if (body) body.appendChild(host);
        editorInstance.__pane = targetPane;
        editorInstance.__paneId = targetPane.dataset.paneId;
        const removed = this.cleanupPane(oldPane);
        this.ensurePaneTabs(targetPane);
        this.refreshPinnedEditors();
        return removed;
    }

    mergeAllEditorsToPane(targetPane) {
        if (!targetPane) return;
        this.editors.forEach(ed => {
            this.moveEditorToPane(ed, targetPane);
        });
    }

    collapseToMobilePane() {
        if (this.isMobileCollapsed) return this.ensurePaneElement(this.activePaneId);
        // backup current layout
        const editorPaneMap = {};
        this.editors.forEach(ed => {
            if (ed.__sessionId) editorPaneMap[ed.__sessionId] = ed.__pane?.dataset?.paneId;
        });
        this.desktopLayoutBackup = {
            tree: this.cloneTree(this.paneTree),
            activePaneId: this.activePaneId,
            editorPaneMap
        };

        const targetPane = this.ensurePaneElement(this.activePaneId || this.getFirstLeaf(this.paneTree)?.id || this.createPaneId());
        this.mergeAllEditorsToPane(targetPane);
        const paneId = targetPane.dataset.paneId || this.createPaneId();
        targetPane.dataset.paneId = paneId;
        this.paneTree = { type: 'leaf', id: paneId };
        this.activePaneId = paneId;
        Array.from(this.paneDom.keys()).forEach(id => {
            if (id !== paneId) this.paneDom.delete(id);
        });
        this.isMobileCollapsed = true;
        return targetPane;
    }

    restoreFromMobileCollapse() {
        if (!this.isMobileCollapsed || !this.desktopLayoutBackup) return;
        const backup = this.desktopLayoutBackup;
        const tree = this.normalizeTree(this.cloneTree(backup.tree));
        if (tree) this.paneTree = tree;
        this.activePaneId = backup.activePaneId || this.getFirstLeaf(this.paneTree)?.id || null;
        // move editors back to their pane if known
        this.editors.forEach(ed => {
            const targetId = backup.editorPaneMap?.[ed.__sessionId];
            const pane = this.ensurePaneElement(targetId || this.activePaneId || this.createPaneId());
            this.moveEditorToPane(ed, pane);
        });
        this.isMobileCollapsed = false;
        this.desktopLayoutBackup = null;
    }

    cleanupPane(pane) {
        if (!pane) return;
        const remaining = this.getPaneEditors(pane);
        if (remaining.length === 0) {
            if (pane.parentNode) pane.parentNode.removeChild(pane);
            const paneId = pane.dataset.paneId;
            this.paneDom.delete(paneId);
            this.removeLeaf(paneId);
            if (this.activePaneId === paneId) {
                this.activePaneId = this.getFirstLeaf(this.paneTree)?.id || null;
            }
            return true;
        }
        return false;
    }

    ensureEditorOwnPane(editorInstance) {
        if (!editorInstance || !editorInstance.__pane || !editorInstance.__host) return editorInstance?.__pane;
        const currentPane = editorInstance.__pane;
        const peers = this.getPaneEditors(currentPane);
        if (peers.length <= 1) return currentPane;
        const newPane = document.createElement('div');
        this.attachPaneChrome(newPane);
        this.ensurePaneBody(newPane);
        const host = editorInstance.__host;
        host.remove();
        this.ensurePaneBody(newPane)?.appendChild(host);
        editorInstance.__pane = newPane;
        const parent = this.container || currentPane.parentNode;
        if (parent) {
            if (currentPane.nextSibling) {
                parent.insertBefore(newPane, currentPane.nextSibling);
            } else {
                parent.appendChild(newPane);
            }
        }
        const remaining = this.getPaneEditors(currentPane);
        if (!remaining.length && currentPane.parentNode) {
            currentPane.parentNode.removeChild(currentPane);
        }
        this.ensurePaneTabs(currentPane);
        this.ensurePaneTabs(newPane);
        this.refreshPinnedEditors();
        return newPane;
    }

    refreshPinnedEditors() {
        // no-op placeholder after tree refactor
    }

    getEditorModeId(editorInstance = this.activeEditor) {
        const raw = editorInstance?.getMode?.() || this.currentMode || 'text/plain';
        return normalizeModeIdForStore(raw);
    }

    setActiveEditor(editorInstance) {
        this.activeEditor = editorInstance;
        this.refreshPinnedEditors();
        if (editorInstance?.__pane) {
            this.activePaneId = editorInstance.__pane.dataset.paneId || this.activePaneId;
        }
        const modeId = this.getEditorModeId(editorInstance);
        this.currentMode = modeId;
        if (this.modeSelect && this.modeSelect.value !== modeId) {
            this.modeSelect.value = modeId;
            this.modeSelect.dispatchEvent(new CustomEvent('notelet:mode-sync', { bubbles: true }));
        }
        const pane = editorInstance?.__pane;
        const needLayout = pane && this.container && !this.container.contains(pane);
        this.renderTabs();
        if (needLayout) {
            this.syncLayout();
        } else {
            this.updatePaneVisibility();
            this.renderTabs();
        }
        this.updateStatus();
        this.updateDocumentTitle();
        this.updateWrapToggleUI();
        if (this.formatPrettyBtn) this.formatPrettyBtn.style.display = isFormatSupported(modeId) ? 'inline-flex' : 'none';
        if (this.formatCompactBtn) this.formatCompactBtn.style.display = simplifyMode(modeId) === 'json' ? 'inline-flex' : 'none';
        this.previewManager?.handleActiveEditorChange?.(editorInstance);
    }

    updateStatus() {
        if (!this.activeEditor) return;
        const { line, ch } = this.activeEditor.getCursor();
        const totalChars = this.activeEditor.getValue().length;
        const encoder = new TextEncoder();
        const bytes = encoder.encode(this.activeEditor.getValue()).length;
        if (this.statusText) {
            this.statusText.textContent = `Ln ${line + 1}, Col ${ch + 1}\nChars ${totalChars} | Bytes ${bytes}`;
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

    getTabLabel(editorInstance, idx = 0) {
        if (!editorInstance) return `Editor ${idx + 1}`;
        const firstLine = (editorInstance.getValue() || '').split(/\r?\n/)[0].trim();
        if (firstLine) return firstLine.slice(0, 24);
        return `Editor ${idx + 1}`;
    }

    updateTabTitle(editorInstance) {
        if (!editorInstance) return;
        this.renderTabs();
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
        const show = !isMobile() && this.getPaneList().length > 1;
        this.editors.forEach(ed => {
            const pane = ed.__pane;
            const btn = pane?.querySelector('.pane-close');
            if (btn) btn.style.display = show ? 'block' : 'none';
        });
    }

    ensurePaneTabs(pane) {
        if (!pane) return null;
        let tabs = pane.querySelector('.pane-tabs');
        if (!tabs) {
            tabs = document.createElement('div');
            tabs.className = 'pane-tabs';
            const list = document.createElement('div');
            list.className = 'pane-tab-list';
            tabs.appendChild(list);
            pane.insertBefore(tabs, pane.firstChild || null);
        }
        if (tabs && !tabs.__tabDnD) {
            const handler = (e) => this.handleTabsAreaDragOver(pane, tabs, e);
            tabs.addEventListener('dragover', handler);
            tabs.addEventListener('dragenter', handler);
            tabs.addEventListener('drop', (e) => this.handleTabsAreaDrop(pane, tabs, e));
            tabs.__tabDnD = true;
        }
        const list = tabs.querySelector('.pane-tab-list');
        return { tabs, list };
    }

    getTabSide(event, tabEl) {
        const rect = tabEl.getBoundingClientRect();
        const x = event.clientX - rect.left;
        return x < rect.width / 2 ? 'before' : 'after';
    }

    findTabInsertTarget(listEl, event) {
        if (!listEl) return { editor: null, position: 'after', left: 0 };
        const tabs = Array.from(listEl.querySelectorAll('.tab-btn'));
        if (!tabs.length) return { editor: null, position: 'after', left: 0 };
        const x = event.clientX;
        for (let i = 0; i < tabs.length; i++) {
            const tab = tabs[i];
            const rect = tab.getBoundingClientRect();
            const mid = rect.left + rect.width / 2;
            if (x < mid) {
                const prevTab = tabs[i - 1];
                if (prevTab) {
                    const prevEditor = this.editors.find(ed => ed.__tabEl === prevTab);
                    const left = (prevTab.offsetLeft + prevTab.offsetWidth + tab.offsetLeft) / 2;
                    return { editor: prevEditor, position: 'after', left };
                }
                const editor = this.editors.find(ed => ed.__tabEl === tab);
                return { editor, position: 'before', left: tab.offsetLeft };
            }
        }
        const lastTab = tabs[tabs.length - 1];
        const editor = this.editors.find(ed => ed.__tabEl === lastTab);
        const left = lastTab.offsetLeft + lastTab.offsetWidth;
        return { editor, position: 'after', left };
    }

    ensureTabDropMarker() {
        if (!this.tabDropMarker) {
            const marker = document.createElement('div');
            marker.className = 'tab-drop-marker';
            this.tabDropMarker = marker;
        }
        return this.tabDropMarker;
    }

    setTabDropHint(tabEl, position, listEl = null, absoluteLeft = null) {
        const parent = (tabEl && tabEl.parentNode) || listEl;
        if (!parent) return;
        const marker = this.ensureTabDropMarker();
        if (!marker.parentNode) parent.appendChild(marker);
        const baseLeft = absoluteLeft !== null ? absoluteLeft : (tabEl ? (position === 'before' ? tabEl.offsetLeft : tabEl.offsetLeft + tabEl.offsetWidth) : parent.scrollWidth);
        marker.style.left = `${baseLeft}px`;
        this.tabDropTarget = this.tabDropTarget || {};
    }

    clearTabDropHint() {
        if (this.tabDropMarker && this.tabDropMarker.parentNode) {
            this.tabDropMarker.parentNode.removeChild(this.tabDropMarker);
        }
    }

    renderTabs() {
        const panes = new Map();
        this.editors.forEach((ed) => {
            if (!ed.__pane) return;
            if (!panes.has(ed.__pane)) panes.set(ed.__pane, []);
            panes.get(ed.__pane).push(ed);
        });

        const paneCount = panes.size;
        panes.forEach((eds, pane) => {
            const wrap = this.ensurePaneTabs(pane);
            if (!wrap) return;
            const { tabs, list } = wrap;
            const showTabs = eds.length > 1 || paneCount > 1;
            tabs.style.display = showTabs ? 'flex' : 'none';
            list.innerHTML = '';
            eds.forEach((ed) => {
                const wrapper = document.createElement('div');
                wrapper.className = 'tab-btn' + (ed === this.activeEditor ? ' active' : '');
                wrapper.draggable = true;
                wrapper.dataset.editorId = ed.__sessionId;

                const label = document.createElement('span');
                label.className = 'tab-label';
                label.textContent = this.getTabLabel(ed, this.editors.indexOf(ed));
                wrapper.appendChild(label);

                const close = document.createElement('button');
                close.className = 'tab-close';
                close.textContent = '×';
                close.style.display = showTabs ? 'inline-flex' : 'none';
                close.addEventListener('click', async (ev) => {
                    ev.stopPropagation();
                    const ok = await this.askConfirm('要關閉這個編輯器嗎？');
                    if (!ok) return;
                    this.removePane(ed.__pane, ed);
                });
                wrapper.appendChild(close);

                wrapper.addEventListener('click', () => this.setActiveEditor(ed));
                wrapper.addEventListener('dragstart', (e) => this.handleTabDragStart(ed, e));
                wrapper.addEventListener('dragover', (e) => this.handleTabDragOverTarget(ed, e));
                wrapper.addEventListener('dragenter', (e) => this.handleTabDragOverTarget(ed, e));
                wrapper.addEventListener('drop', (e) => this.handleTabDropOnTarget(ed, e));
                wrapper.addEventListener('dragend', () => this.handleTabDragEnd());
                ed.__tabEl = wrapper;
                list.appendChild(wrapper);
            });
        });
    }

    updatePaneVisibility() {
        const mobile = isMobile();
        const panes = new Set(this.getPaneList());
        panes.forEach((pane) => {
            const editorsInPane = this.getPaneEditors(pane);
            const activeInPane = editorsInPane.find(ed => ed === this.activeEditor) || editorsInPane[0];
            if (!activeInPane) {
                pane.classList.add('hidden');
                return;
            }
            editorsInPane.forEach((ed) => {
                const host = ed.__host;
                if (host) host.classList.toggle('hidden', ed !== activeInPane);
            });
            const shouldShowPane = mobile ? activeInPane === this.activeEditor : true;
            pane.classList.toggle('hidden', !shouldShowPane);
        });
    }

    syncLayout(force = false) {
        if (this.draggedEditor && !force) return;
        this.refreshPinnedEditors();
        const panes = this.getPaneList();
        this.layoutPanes(panes);
    }

    layoutPanes() {
        if (!this.container) return;
        this.container.innerHTML = '';
        this.ensureTree();
        const mobile = isMobile();
        if (mobile) {
            const targetPane = this.collapseToMobilePane();
            targetPane.style.flex = '1 1 auto';
            targetPane.style.width = '100%';
            targetPane.style.height = '100%';
            this.container.appendChild(targetPane);
            const editorsInPane = this.getPaneEditors(targetPane);
            const activeInPane = this.activeEditor && editorsInPane.includes(this.activeEditor) ? this.activeEditor : editorsInPane[0];
            editorsInPane.forEach(ed => {
                const host = ed.__host;
                if (host) host.classList.toggle('hidden', ed !== activeInPane);
            });
            this.renderTabs();
            this.editors.forEach(ed => ed.refresh?.());
            return;
        }
        this.restoreFromMobileCollapse();
        const renderNode = (node, parent) => {
            if (!node) return;
            if (node.type === 'leaf') {
                const pane = this.ensurePaneElement(node.id);
                this.ensurePaneBody(pane);
                pane.style.flex = '1 1 0';
                parent.appendChild(pane);
                return pane;
            }
            if (node.type === 'split') {
                const wrap = document.createElement('div');
                wrap.className = `split-${node.dir === 'row' ? 'row' : 'col'}`;
                wrap.style.display = 'flex';
                wrap.style.flexDirection = node.dir === 'row' ? 'column' : 'row';
                wrap.style.flex = '1 1 0';
                parent.appendChild(wrap);
                const children = node.children || [];
                const sizes = (node.sizes && node.sizes.length === children.length) ? node.sizes.slice() : new Array(children.length).fill(1 / Math.max(1, children.length));
                const rendered = children.map((child, idx) => {
                    const el = renderNode(child, wrap);
                    if (el) {
                        el.style.flexGrow = sizes[idx];
                        el.style.flexShrink = 1;
                        el.style.flexBasis = '0px';
                    }
                    return el;
                });
                rendered.forEach((childEl, idx) => {
                    if (!childEl) return;
                    if (idx > 0) {
                        const prevEl = rendered[idx - 1];
                        const resizer = this.makeResizerFlexible(node, idx - 1, prevEl, childEl);
                        wrap.insertBefore(resizer, childEl);
                    }
                });
                return wrap;
            }
            return null;
        };
        renderNode(this.paneTree, this.container);
        this.updatePaneVisibility();
        this.renderTabs();
        this.editors.forEach(ed => ed.refresh?.());
        this.previewManager?.refreshAll?.();
    }

    getDropDirection(event, element) {
        const rect = element?.getBoundingClientRect?.();
        if (!rect) return 'center';
        const ratio = (event.clientX - rect.left) / Math.max(rect.width, 1);
        const vr = (event.clientY - rect.top) / Math.max(rect.height, 1);
        if (ratio < 0.25) return 'left';
        if (ratio > 0.75) return 'right';
        if (vr < 0.25) return 'top';
        if (vr > 0.75) return 'bottom';
        return 'center';
    }

    setContainerDropHint(direction) {
        this.containerDropHint = direction;
        this.lastContainerHint = direction;
        if (!this.container) return;
        this.container.classList.remove('drop-left', 'drop-right', 'drop-center', 'drop-top', 'drop-bottom');
        if (direction) {
            this.container.classList.add(`drop-${direction}`);
        }
    }

    clearPaneHints() {
        Array.from(this.container?.querySelectorAll?.('.pane') || []).forEach(p => {
            p.classList.remove('drop-left', 'drop-right', 'drop-center', 'drop-top', 'drop-bottom');
            p.__lastDropDir = null;
        });
    }

    setPaneDropHint(pane, direction) {
        if (!pane) return;
        this.clearPaneHints();
        this.setContainerDropHint(null);
        pane.classList.remove('drop-left', 'drop-right', 'drop-center', 'drop-top', 'drop-bottom');
        if (direction) {
            pane.classList.add(`drop-${direction}`);
        }
        pane.__lastDropDir = direction;
    }

    clearDropIndicators() {
        this.setContainerDropHint(null);
        this.clearPaneHints();
        if (this.clearTabDropHint) this.clearTabDropHint();
        this.tabDropTarget = null;
        this.lastContainerHint = null;
    }

    handleTabDragStart(editorInstance, event) {
        this.draggedEditor = editorInstance;
        this.lastContainerHint = null;
        this.dragAnchorEditor = this.activeEditor;
        if (event?.dataTransfer) {
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', '');
            event.dataTransfer.setData('application/x-notelet-tab', editorInstance.__sessionId);
        }
        this.container?.classList.add('dragging-tab');
        this.tabs?.classList.add('dragging-tab');
    }

    handleTabDragEnd() {
        this.draggedEditor = null;
        this.dragAnchorEditor = null;
        this.tabDropTarget = null;
        this.container?.classList.remove('dragging-tab');
        this.tabs?.classList.remove('dragging-tab');
        this.clearDropIndicators();
        this.clearTabDropHint();
    }

    handleContainerDragOver(event) {
        if (!this.draggedEditor) return;
        event.preventDefault();
        const direction = this.getDropDirection(event, this.container);
        if (direction === this.lastContainerHint) return;
        this.setContainerDropHint(direction);
    }

    handleContainerDrop(event) {
        if (!this.draggedEditor) return;
        event.preventDefault();
        event.stopPropagation();
        const direction = this.containerDropHint || this.getDropDirection(event, this.container);
        this.applyDrop(direction, this.activeEditor);
    }

    handlePaneDragOver(pane, event) {
        if (!this.draggedEditor) return;
        event.preventDefault();
        const direction = this.getDropDirection(event, pane);
        if (pane?.__lastDropDir === direction) return;
        this.setPaneDropHint(pane, direction);
    }

    handlePaneDrop(pane, event) {
        if (!this.draggedEditor) return;
        event.preventDefault();
        event.stopPropagation();
        const direction = this.getDropDirection(event, pane);
        const ref = this.getPrimaryEditorForPane(pane);
        this.applyDrop(direction, ref);
    }

    handleTabDragOverTarget(targetEditor, event) {
        if (!this.draggedEditor) return;
        event.preventDefault();
        event.stopPropagation();
        const tabEl = targetEditor.__tabEl;
        if (!tabEl) return;
        const side = this.getTabSide(event, tabEl);
        const listEl = tabEl.parentNode;
        const { left } = this.findTabInsertTarget(listEl, event);
        this.setTabDropHint(tabEl, side, listEl, left);
        this.tabDropTarget = { editor: targetEditor, pane: targetEditor.__pane, position: side, listEl, left };
    }

    handleTabDropOnTarget(targetEditor, event) {
        if (!this.draggedEditor) return;
        event.preventDefault();
        event.stopPropagation();
        const tabEl = targetEditor.__tabEl;
        const side = tabEl ? this.getTabSide(event, tabEl) : 'after';
        const targetPane = targetEditor.__pane;
        let treeChanged = false;
        if (targetPane && targetPane !== this.draggedEditor.__pane) {
            const removed = this.moveEditorToPane(this.draggedEditor, targetPane);
            treeChanged = treeChanged || removed;
        }
        this.reorderEditorsForTabDrop(this.draggedEditor, targetEditor, side, targetPane);
        this.clearTabDropHint();
        this.setActiveEditor(this.draggedEditor);
        if (treeChanged) {
            this.syncLayout(true);
            this.persistPage();
        } else {
            this.updatePaneVisibility();
            this.renderTabs();
            this.editors.forEach(ed => ed.refresh?.());
            this.persistPage();
        }
        this.draggedEditor = null;
        this.dragAnchorEditor = null;
        this.clearDropIndicators();
    }

    handleTabsAreaDragOver(pane, tabsEl, event) {
        if (!this.draggedEditor) return;
        event.preventDefault();
        event.stopPropagation();
        const list = tabsEl.querySelector('.pane-tab-list');
        const { editor: targetEditor, position, left } = this.findTabInsertTarget(list, event);
        this.tabDropTarget = { editor: targetEditor, pane, position: position || 'after', listEl: list, left };
        const tabEl = targetEditor?.__tabEl;
        this.setTabDropHint(tabEl, position || 'after', list, left);
    }

    handleTabsAreaDrop(pane, tabsEl, event) {
        if (!this.draggedEditor) return;
        event.preventDefault();
        event.stopPropagation();
        const list = tabsEl.querySelector('.pane-tab-list');
        const { editor: targetEditor, position } = this.tabDropTarget || this.findTabInsertTarget(list, event);
        const targetPane = pane;
        let treeChanged = false;
        if (targetPane && targetPane !== this.draggedEditor.__pane) {
            const removed = this.moveEditorToPane(this.draggedEditor, targetPane);
            treeChanged = treeChanged || removed;
        }
        const targetEd = targetEditor || this.getPrimaryEditorForPane(targetPane) || this.draggedEditor;
        const pos = position || 'after';
        this.reorderEditorsForTabDrop(this.draggedEditor, targetEd, pos, targetPane);
        this.clearTabDropHint();
        this.setActiveEditor(this.draggedEditor);
        if (treeChanged) {
            this.syncLayout(true);
            this.persistPage();
        } else {
            this.updatePaneVisibility();
            this.renderTabs();
            this.editors.forEach(ed => ed.refresh?.());
            this.persistPage();
        }
        this.draggedEditor = null;
        this.dragAnchorEditor = null;
        this.clearDropIndicators();
    }

    applyDrop(direction, referenceEditor) {
        const editor = this.draggedEditor;
        if (!editor) return;
        let ref = referenceEditor;
        if (ref === editor) {
            const fallback = (this.dragAnchorEditor && this.dragAnchorEditor !== editor) ? this.dragAnchorEditor : this.editors.find(ed => ed !== editor) || null;
            ref = fallback || editor;
        }
        let treeChanged = false;
        const targetPane = ref?.__pane || this.activeEditor?.__pane;
        if (direction === 'center' && targetPane && targetPane !== editor.__pane) {
            const removed = this.moveEditorToPane(editor, targetPane);
            treeChanged = treeChanged || removed;
            this.activePaneId = targetPane.dataset.paneId || this.activePaneId;
        } else if (direction === 'center') {
            // no split, keep within pane
        } else {
            const dir = direction === 'left' || direction === 'right' ? direction : (direction === 'top' ? 'top' : 'bottom');
            const paneId = targetPane?.dataset?.paneId || this.activePaneId || this.getFirstLeaf(this.paneTree)?.id;
            const newPaneId = this.splitPane(paneId, dir) || this.createPaneId();
            const newPaneEl = this.ensurePaneElement(newPaneId);
            const removed = this.moveEditorToPane(editor, newPaneEl);
            treeChanged = true;
            this.activePaneId = newPaneId;
        }
        this.setActiveEditor(editor);
        if (treeChanged) {
            this.syncLayout(true);
            this.persistPage();
        } else {
            this.updatePaneVisibility();
            this.renderTabs();
            this.editors.forEach(ed => ed.refresh?.());
            this.persistPage();
        }
        this.draggedEditor = null;
        this.dragAnchorEditor = null;
        this.clearDropIndicators();
    }

    reorderEditorsForTabDrop(editor, targetEditor, position, paneForAppend = null) {
        if (!editor) return;
        this.editors = this.editors.filter(ed => ed !== editor);
        if (!targetEditor) {
            this.editors.push(editor);
            return;
        }
        const targetIdx = this.editors.indexOf(targetEditor);
        let insertAt = position === 'before' ? targetIdx : targetIdx + 1;
        if (targetIdx === -1 && paneForAppend) {
            const peers = this.getPaneEditors(paneForAppend);
            const lastPeer = peers[peers.length - 1];
            const lastIdx = this.editors.indexOf(lastPeer);
            insertAt = lastIdx >= 0 ? lastIdx + 1 : this.editors.length;
        }
        this.editors.splice(Math.max(0, insertAt), 0, editor);
    }

    makeResizerFlexible(node, idx, prevEl, nextEl) {
        const dir = node.dir === 'row' ? 'row' : 'col';
        const resizer = document.createElement('div');
        resizer.className = `resizer ${dir === 'row' ? 'resizer-row' : 'resizer-col'}`;
        let startX = 0;
        let startY = 0;
        let prevStart = 0;
        let nextStart = 0;

        const onMouseMove = (e) => {
            if (dir === 'col') {
                const dx = e.clientX - startX;
                const total = prevStart + nextStart;
                let newPrev = prevStart + dx;
                newPrev = Math.max(80, Math.min(total - 80, newPrev));
                const newNext = Math.max(80, total - newPrev);
                const ratioPrev = newPrev / (newPrev + newNext);
                const ratioNext = nextEl ? newNext / (newPrev + newNext) : 0;
                prevEl.style.flexGrow = ratioPrev;
                prevEl.style.flexBasis = '0px';
                if (nextEl) {
                    nextEl.style.flexGrow = ratioNext;
                    nextEl.style.flexBasis = '0px';
                }
                if (!node.sizes) node.sizes = new Array((node.children || []).length).fill(1 / Math.max(1, (node.children || []).length));
                node.sizes[idx] = ratioPrev;
                if (node.sizes[idx + 1] !== undefined) node.sizes[idx + 1] = ratioNext;
            } else {
                const dy = e.clientY - startY;
                const total = prevStart + nextStart;
                let newPrev = prevStart + dy;
                newPrev = Math.max(80, Math.min(total - 80, newPrev));
                const newNext = Math.max(80, total - newPrev);
                const ratioPrev = newPrev / (newPrev + newNext);
                const ratioNext = nextEl ? newNext / (newPrev + newNext) : 0;
                prevEl.style.flexGrow = ratioPrev;
                prevEl.style.flexBasis = '0px';
                if (nextEl) {
                    nextEl.style.flexGrow = ratioNext;
                    nextEl.style.flexBasis = '0px';
                }
                if (!node.sizes) node.sizes = new Array((node.children || []).length).fill(1 / Math.max(1, (node.children || []).length));
                node.sizes[idx] = ratioPrev;
                if (node.sizes[idx + 1] !== undefined) node.sizes[idx + 1] = ratioNext;
            }
        };

        const onMouseUp = () => {
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
            document.body.style.userSelect = '';
            this.persistPage();
        };

        resizer.addEventListener('mousedown', (e) => {
            startX = e.clientX;
            startY = e.clientY;
            if (dir === 'col') {
                prevStart = prevEl.getBoundingClientRect().width;
                nextStart = nextEl?.getBoundingClientRect().width || prevStart;
                resizer.style.height = '100%';
            } else {
                prevStart = prevEl.getBoundingClientRect().height;
                nextStart = nextEl?.getBoundingClientRect().height || prevStart;
                resizer.style.width = '100%';
            }
            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
            document.body.style.userSelect = 'none';
        });

        return resizer;
    }

    removePane(_pane, editorInstance) {
        const pane = editorInstance.__pane;
        const host = editorInstance.__host;
        if (host && host.parentNode) host.parentNode.removeChild(host);
        this.editors = this.editors.filter(ed => ed !== editorInstance);
        const remainingInPane = pane ? this.getPaneEditors(pane) : [];
        if (remainingInPane.length === 0 && pane) {
            if (pane.parentNode) pane.parentNode.removeChild(pane);
            const paneId = pane.dataset.paneId;
            this.paneDom.delete(paneId);
            this.removeLeaf(paneId);
        }
        this.refreshPinnedEditors();
        if (this.activeEditor === editorInstance) {
            const nextEditor = remainingInPane[0] || this.editors[0] || null;
            this.activeEditor = null;
            if (nextEditor) {
                this.setActiveEditor(nextEditor);
            } else if (this.statusText) {
                this.statusText.textContent = 'Ln 1, Col 1 | Chars 0 | Bytes 0';
            }
        }
        this.syncLayout();
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

    attachPaneChrome(pane) {
        if (!pane) return;
        if (!pane.classList.contains('pane')) pane.classList.add('pane');
        if (!pane.__dragListenersAttached) {
            pane.addEventListener('dragover', (e) => this.handlePaneDragOver(pane, e));
            pane.addEventListener('drop', (e) => this.handlePaneDrop(pane, e));
            pane.addEventListener('dragleave', () => this.clearDropIndicators());
            pane.__dragListenersAttached = true;
        }
    }

    createPane(images = [], paneId = null) {
        this.ensureTree();
        const targetId = paneId || this.activePaneId || this.createPaneId();
        const pane = this.ensurePaneElement(targetId);
        const body = this.ensurePaneBody(pane);

        const editorEl = document.createElement('div');
        editorEl.className = 'editor-host';
        if (body) body.appendChild(editorEl);

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
                    this.updateTabTitle(ed);
                    return;
                }
                this.updateStatus();
                if (ed === this.activeEditor) this.updateDocumentTitle();
                this.updateTabTitle(ed);
                this.previewManager?.handleEditorChange?.(ed);
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
        editorInstance.__paneId = pane.dataset.paneId || this.createPaneId();
        editorInstance.__host = editorEl;
        this.selectionController.attachToEditor(editorInstance);

        if (!this.activeEditor) this.setActiveEditor(editorInstance);
        return { pane, editorInstance };
    }

    addEditorPane({
        initialContent = '',
        initialMode = this.currentMode,
        suppressPersist = false,
        initialWrap = this.wrapPreference,
        images = [],
        asSplit = false,
        reusePane = true,
        splitDirection = 'right',
        targetPaneId = null
    } = {}) {
        this.ensureTree();
        let paneId = targetPaneId || this.activePaneId;
        if (asSplit || !paneId) {
            paneId = this.splitPane(this.activePaneId || this.getFirstLeaf(this.paneTree)?.id, splitDirection) || paneId || this.createPaneId();
            this.activePaneId = paneId;
        }
        const { pane, editorInstance } = this.createPane(images, paneId);
        this.editors.push(editorInstance);

        editorInstance.setMode(initialMode || this.currentMode);
        editorInstance.setOption('lineWrapping', !!initialWrap);
        if (initialContent !== undefined && initialContent !== null) {
            if (suppressPersist) editorInstance.__suppressPersist = true;
            editorInstance.setValue(initialContent);
        }

        this.setActiveEditor(editorInstance);
        this.syncLayout();
        this.themeController.apply(this.themeController.preference, { skipPersist: true });
        editorInstance.refresh?.();
        return editorInstance;
    }

    async persistPage() {
        if (!this.sessionStore) return;
        const snapshot = this.getSnapshot();
        const hasContent = snapshot.editors.some(e => e.content.trim().length > 0);
        if (!hasContent) return;
        const updatedAt = Date.now();
        await this.sessionStore.put({ ...snapshot, updatedAt });
        await this.sessionStore.prune();
        await this.updateHistoryCount();
    }

    async updateHistoryCount() {
        if (!this.sessionStore || !this.setHistoryCount) return;
        const sessions = await this.sessionStore.list();
        this.setHistoryCount((sessions || []).length);
    }

    getSnapshot() {
        this.ensureTree();
        return {
            id: this.pageId,
            layout: {
                tree: this.paneTree,
                activeId: this.activeEditor?.__sessionId || null,
                activePaneId: this.activePaneId
            },
            editors: this.editors.map(ed => ({
                id: ed.__sessionId,
                content: ed.getValue(),
                mode: this.getEditorModeId(ed),
                wrap: ed.getOption('lineWrapping'),
                paneId: ed.__pane?.dataset?.paneId,
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
            this.activeEditor = null;
            this.paneDom.clear();
            this.paneTree = null;
        }
        const layout = snapshot.layout || {};
        if (layout.tree) {
            this.paneTree = this.normalizeTree(layout.tree);
        } else if (!this.paneTree) {
            const baseId = editorsData[0]?.paneId || this.createPaneId();
            this.paneTree = { type: 'leaf', id: baseId };
            editorsData = editorsData.map(ed => ({ ...ed, paneId: ed.paneId || baseId }));
        }
        editorsData.forEach(ed => {
            const instance = this.addEditorPane({
                initialContent: ed.content || '',
                initialMode: ed.mode || this.currentMode,
                suppressPersist: true,
                initialWrap: ed.wrap !== undefined ? ed.wrap : this.wrapPreference,
                images: ed.images || [],
                asSplit: false,
                reusePane: !replace,
                targetPaneId: ed.paneId
            });
            if (instance && ed.id) {
                instance.__sessionId = ed.id;
            }
        });
        this.activePaneId = layout.activePaneId || this.activePaneId || this.getFirstLeaf(this.paneTree)?.id || null;
        const preferred = layout.activeId ? this.editors.find(ed => ed.__sessionId === layout.activeId) : null;
        const nextActive = preferred || this.editors[this.editors.length - 1];
        if (nextActive) this.setActiveEditor(nextActive);
        this.syncLayout();
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
        this.previewManager?.handleModeChange?.(this.activeEditor);
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
