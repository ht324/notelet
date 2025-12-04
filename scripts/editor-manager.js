import { RESIZER_WIDTH, WRAP_STORAGE_KEY } from './constants.js';
import { detectModeFromText, generateSessionId, simplifyMode, isFormatSupported, normalizeModeIdForStore } from './utils/editor-utils.js';
import { formatContent } from './formatters.js';
import { SelectionMenuController } from './selection-menu.js';
import { registerSaveCommand, registerTimeCommands } from './editor-commands.js';
import { EditorState, Compartment, StateEffect } from '@codemirror/state';
import { EditorView, keymap, highlightSpecialChars, drawSelection, highlightActiveLine, highlightActiveLineGutter, dropCursor, rectangularSelection, crosshairCursor, lineNumbers } from '@codemirror/view';
import { defaultHighlightStyle, syntaxHighlighting, indentOnInput } from '@codemirror/language';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { javascript } from '@codemirror/lang-javascript';
import { json as jsonLang } from '@codemirror/lang-json';
import { xml } from '@codemirror/lang-xml';
import { css as cssLang } from '@codemirror/lang-css';
import { markdown as markdownLang } from '@codemirror/lang-markdown';
import { monokai } from "./theme/monokaiTheme";

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
    '&.cm-focused .cm-selectionBackground, ::selection': { backgroundColor: '#cce0ff' },
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

const typographyTheme = EditorView.theme({
    '.cm-content, .cm-gutters': {
        fontFamily: 'Monaco, Menlo, "Ubuntu Mono", Consolas, "Source Code Pro", source-code-pro, monospace',
        fontSize: '16px'
    }
});

class CMEditorWrapper {
    constructor({
        parent,
        content = '',
        modeId = 'text/plain',
        wrap = false,
        themeName = 'dark',
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

        const baseExtensions = [
            lineNumbers(),
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
            typographyTheme,
            keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
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
    }

    updateGutterShadow() {
        const gutters = this.view?.dom?.querySelector?.('.cm-gutters');
        const scroller = this.view?.scrollDOM;
        if (!gutters || !scroller) return;
        const scrolled = scroller.scrollLeft > 1;
        gutters.classList.toggle('cm-gutter-shadow', scrolled);
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
        this.view.dispatch({
            changes: ranges.map(r => ({
                from: r.from,
                to: r.to,
                insert: text
            })),
            selection: { anchor: ranges[0]?.from ?? 0, head: (ranges[0]?.from ?? 0) + text.length },
            scrollIntoView: true
        });
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

    createPane() {
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

    addEditorPane(initialContent = '', initialMode = this.currentMode, suppressPersist = false, initialWrap = this.wrapPreference) {
        const { pane, editorInstance } = this.createPane();
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
                wrap: ed.getOption('lineWrapping')
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
            this.addEditorPane(ed.content || '', ed.mode || this.currentMode, true, ed.wrap !== undefined ? ed.wrap : this.wrapPreference);
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
