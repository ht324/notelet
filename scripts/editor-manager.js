import { RESIZER_WIDTH, WRAP_STORAGE_KEY } from './constants.js';
import { detectModeFromText, generateSessionId, simplifyMode, isFormatSupported } from './utils/editor-utils.js';
import { formatContent } from './formatters.js';
import { SelectionMenuController } from './selection-menu.js';
import { registerSaveCommand, registerTimeCommands } from './editor-commands.js';

const isMobile = () => window.innerWidth <= 768;

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
        this.currentMode = modeSelect?.value || 'ace/mode/text';
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
        const useWrap = this.activeEditor.getSession().getUseWrapMode();
        const icon = this.wrapToggle.querySelector('.icon');
        if (icon) icon.className = `icon ${useWrap ? 'icon-wrap-on' : 'icon-wrap-off'}`;
    }

    setActiveEditor(editorInstance) {
        this.activeEditor = editorInstance;
        const modeId = editorInstance.session.$modeId || this.currentMode;
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
        const { row, column } = this.activeEditor.getCursorPosition();
        const totalChars = this.activeEditor.getValue().length;
        const encoder = new TextEncoder();
        const bytes = encoder.encode(this.activeEditor.getValue()).length;
        this.statusText.textContent = `Ln ${row + 1}, Col ${column + 1} | Chars ${totalChars} | Bytes ${bytes}`;
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
                this.statusText.textContent = 'Ln 1, Col 1 | Chars 0';
            }
        }
        this.persistPage();
    }

    attachEditorEvents(editorInstance) {
        editorInstance.selection.on('changeCursor', () => this.updateStatus());
        editorInstance.selection.on('changeSelection', () => {
            this.hideSelectionMenu();
        });
        editorInstance.session.on('change', () => {
            if (editorInstance.__suppressPersist) {
                editorInstance.__suppressPersist = false;
                this.updateStatus();
                if (editorInstance === this.activeEditor) this.updateDocumentTitle();
                return;
            }
            this.updateStatus();
            if (editorInstance === this.activeEditor) this.updateDocumentTitle();
            this.persistPage();
        });
        editorInstance.on('focus', () => this.setActiveEditor(editorInstance));
        editorInstance.on('paste', (pasted) => {
            if (editorInstance.getValue().trim().length > 0) return;
            let text = '';
            if (typeof pasted === 'string') {
                text = pasted;
            } else if (Array.isArray(pasted)) {
                text = pasted.join('\n');
            } else if (pasted && typeof pasted.text === 'string') {
                text = pasted.text;
            }
            const detected = detectModeFromText(text);
            if (detected && detected !== editorInstance.session.getMode()?.$id) {
                editorInstance.session.setMode(detected);
                this.currentMode = detected;
                if (this.modeSelect && this.modeSelect.value !== detected) this.modeSelect.value = detected;
                if (this.formatPrettyBtn) this.formatPrettyBtn.style.display = isFormatSupported(detected) ? 'inline-flex' : 'none';
                if (this.formatCompactBtn) this.formatCompactBtn.style.display = simplifyMode(detected) === 'json' ? 'inline-flex' : 'none';
            }
        });
        registerSaveCommand(editorInstance);
        registerTimeCommands(editorInstance);
        this.selectionController.attachToEditor(editorInstance);
    }

    createPane() {
        const pane = document.createElement('div');
        pane.className = 'pane';

        const closeBtn = document.createElement('button');
        closeBtn.className = 'pane-close';
        closeBtn.textContent = '×';
        pane.appendChild(closeBtn);

        const editorEl = document.createElement('div');
        editorEl.className = 'ace-host';
        pane.appendChild(editorEl);

        const editorInstance = ace.edit(editorEl);
        editorInstance.__sessionId = generateSessionId();
        editorInstance.__suppressPersist = false;
        editorInstance.__pane = pane;
        editorInstance.setTheme(this.themeController.getAceTheme());
        editorInstance.session.setMode(this.currentMode);
        editorInstance.session.setUseWrapMode(!!this.wrapPreference);
        this.attachEditorEvents(editorInstance);

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

        editorInstance.session.setMode(initialMode || this.currentMode);
        editorInstance.session.setUseWrapMode(!!initialWrap);
        if (initialContent !== undefined && initialContent !== null) {
            if (suppressPersist) editorInstance.__suppressPersist = true;
            editorInstance.setValue(initialContent, -1);
        }

        this.setActiveEditor(editorInstance);
        this.themeController.apply(this.themeController.preference, { skipPersist: true });
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
                mode: ed.session.$modeId,
                wrap: ed.session.getUseWrapMode()
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
        const useWrap = !this.activeEditor.getSession().getUseWrapMode();
        this.activeEditor.getSession().setUseWrapMode(useWrap);
        this.setWrapPreference(useWrap);
        this.updateWrapToggleUI();
        this.persistPage();
    }

    handleModeChange(nextMode) {
        this.currentMode = nextMode;
        if (this.activeEditor) {
            this.activeEditor.session.setMode(this.currentMode);
            this.persistPage();
            if (this.formatPrettyBtn) this.formatPrettyBtn.style.display = isFormatSupported(this.currentMode) ? 'inline-flex' : 'none';
            if (this.formatCompactBtn) this.formatCompactBtn.style.display = simplifyMode(this.currentMode) === 'json' ? 'inline-flex' : 'none';
        }
    }

    handleFormat(kind) {
        if (!this.activeEditor) return;
        const ed = this.activeEditor;
        const modeId = ed.session.$modeId || this.currentMode;
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
        ed.setValue(next, -1);
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
        return this.editors.map((ed, idx) => ({ index: idx, mode: ed.session.$modeId, value: ed.getValue() }));
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
