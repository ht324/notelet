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

    hasImageInTransfer(dataTransfer) {
        if (!dataTransfer) return false;
        const files = Array.from(dataTransfer.files || []);
        if (files.some(file => file && file.type.startsWith('image/'))) return true;
        const items = Array.from(dataTransfer.items || []);
        return items.some(item => item.kind === 'file' && item.type.startsWith('image/'));
    }

    readFileAsDataURL(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(new Error('讀取圖片失敗'));
            reader.readAsDataURL(file);
        });
    }

    loadImageFromDataURL(dataUrl) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error('讀取圖片失敗'));
            img.src = dataUrl;
        });
    }

    async compressImageFile(file, { maxWidth = 1280, maxHeight = 1280, quality = 0.82 } = {}) {
        const originalDataUrl = await this.readFileAsDataURL(file);
        let image;
        try {
            image = await this.loadImageFromDataURL(originalDataUrl);
        } catch (_) {
            return { dataUrl: originalDataUrl, width: 0, height: 0 };
        }
        const { width, height } = image;
        if (!width || !height) return { dataUrl: originalDataUrl, width, height };

        const ratio = Math.min(maxWidth / width, maxHeight / height, 1);
        if (ratio >= 1) return { dataUrl: originalDataUrl, width, height };

        const targetW = Math.round(width * ratio);
        const targetH = Math.round(height * ratio);
        const canvas = document.createElement('canvas');
        canvas.width = targetW;
        canvas.height = targetH;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(image, 0, 0, targetW, targetH);
        const outputType = file.type && file.type.startsWith('image/') ? file.type : 'image/jpeg';
        const dataUrl = canvas.toDataURL(outputType, quality);
        return { dataUrl, width: targetW, height: targetH };
    }

    buildImageSnippet(fileName, dataUrl) {
        const base = (fileName || 'image').split('.').slice(0, -1).join('.') || fileName || 'image';
        const alt = (base || 'image').slice(0, 50);
        return `![${alt}](${dataUrl})`;
    }

    async insertImagesFromDrop(editorInstance, files) {
        if (!files || !files.length) return;
        for (const file of files) {
            try {
                const { dataUrl } = await this.compressImageFile(file);
                const cursorPos = editorInstance.getCursorPosition();
                const prefix = cursorPos.column === 0 ? '' : '\n';
                const snippet = `${prefix}${this.buildImageSnippet(file?.name, dataUrl)}\n`;
                editorInstance.insert(snippet);
                const markdownRow = cursorPos.column === 0 ? cursorPos.row : cursorPos.row + 1;
                this.addImageOverlay(editorInstance, dataUrl, { row: markdownRow });
            } catch (e) {
                this.showToast?.('插入圖片失敗');
                return;
            }
        }
        await this.persistPage();
        this.showToast?.('已插入圖片');
    }

    setupDropTarget(pane, editorInstance, editorEl) {
        const highlight = () => pane.classList.add('pane-drop-active');
        const clearHighlight = () => pane.classList.remove('pane-drop-active');
        const dragCounter = { count: 0 };
        const targets = [pane, editorEl].filter(Boolean);

        const handleDragEnter = (e) => {
            if (!this.hasImageInTransfer(e.dataTransfer)) return;
            e.preventDefault();
            e.stopPropagation();
            dragCounter.count += 1;
            highlight();
        };

        const handleDragOver = (e) => {
            if (!this.hasImageInTransfer(e.dataTransfer)) return;
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = 'copy';
            highlight();
        };

        const handleDragLeave = (e) => {
            if (!this.hasImageInTransfer(e.dataTransfer)) return;
            dragCounter.count = Math.max(0, dragCounter.count - 1);
            if (dragCounter.count === 0) clearHighlight();
        };

        const handleDrop = async (e) => {
            if (!this.hasImageInTransfer(e.dataTransfer)) return;
            e.preventDefault();
            e.stopPropagation();
            clearHighlight();
            dragCounter.count = 0;
            this.setActiveEditor(editorInstance);
            let files = Array.from(e.dataTransfer.files || []).filter(file => file.type.startsWith('image/'));
            if (!files.length && e.dataTransfer.items) {
                files = Array.from(e.dataTransfer.items || [])
                    .map(item => (item.kind === 'file' ? item.getAsFile() : null))
                    .filter(file => file && file.type.startsWith('image/'));
            }
            await this.insertImagesFromDrop(editorInstance, files);
        };

        targets.forEach(el => {
            el.addEventListener('dragenter', handleDragEnter);
            el.addEventListener('dragover', handleDragOver);
            el.addEventListener('dragleave', handleDragLeave);
            el.addEventListener('drop', handleDrop);
        });
    }

    setupImageOverlay(editorInstance, pane) {
        const overlayLayer = document.createElement('div');
        overlayLayer.className = 'image-overlay-layer';
        pane.appendChild(overlayLayer);
        editorInstance.__imageOverlays = [];
        editorInstance.__overlayLayer = overlayLayer;

        const render = () => this.updateImageOverlayPositions(editorInstance);
        const schedule = () => {
            if (editorInstance.__overlayRaf) cancelAnimationFrame(editorInstance.__overlayRaf);
            editorInstance.__overlayRaf = requestAnimationFrame(render);
        };
        const handleChange = (delta) => {
            if (!editorInstance.__imageOverlays?.length || !delta) return;
            const startRow = delta.start.row;
            const endRow = delta.end.row;
            let rowDelta = 0;
            if (delta.action === 'insert') {
                rowDelta = (delta.lines?.length || 1) - 1;
            } else if (delta.action === 'remove') {
                rowDelta = -(endRow - startRow);
            }
            if (!rowDelta) return;
            editorInstance.__imageOverlays.forEach(overlay => {
                if (overlay.row === undefined || overlay.row === null) return;
                if (delta.action === 'insert') {
                    if (overlay.row >= startRow) overlay.row += rowDelta;
                } else if (delta.action === 'remove') {
                    if (overlay.row > endRow) {
                        overlay.row += rowDelta;
                    } else if (overlay.row >= startRow && overlay.row <= endRow) {
                        overlay.row = startRow;
                    }
                }
            });
        };

        editorInstance.renderer.on('afterRender', render);
        editorInstance.session.on('change', (delta) => {
            handleChange(delta);
            schedule();
        });
        editorInstance.session.on('changeScrollTop', schedule);
        editorInstance.session.on('changeScrollLeft', schedule);
    }

    ensureLineWidgets(editorInstance) {
        if (editorInstance.__hasLineWidgets) return;
        try {
            const LineWidgets = ace.require('ace/line_widgets').LineWidgets;
            const manager = new LineWidgets(editorInstance.session);
            manager.attach(editorInstance);
            editorInstance.__lineWidgets = manager;
            editorInstance.__hasLineWidgets = true;
        } catch (_) {
            // line widgets unavailable; skip
        }
    }

    updateImageWidget(editorInstance, overlay, pixelHeight) {
        const manager = editorInstance.__lineWidgets;
        if (!manager) return;
        const row = overlay.row ?? overlay.widget?.row ?? 0;
        if (overlay.widget) {
            manager.removeLineWidget(overlay.widget);
            overlay.widget = null;
        }
        const spacer = document.createElement('div');
        spacer.className = 'image-line-spacer';
        spacer.style.height = `${pixelHeight}px`;
        overlay.widget = { row, el: spacer, pixelHeight, coverGutter: false, fullWidth: true, fixedWidth: true, inFront: false };
        manager.addLineWidget(overlay.widget);
    }

    removeImageWidget(editorInstance, overlay) {
        const manager = editorInstance.__lineWidgets;
        if (overlay.widget && manager) {
            manager.removeLineWidget(overlay.widget);
        }
        overlay.widget = null;
    }

    addImageOverlay(editorInstance, src, pos = null) {
        if (!editorInstance.__overlayLayer) return;
        const anchorPos = pos || editorInstance.getCursorPosition();
        const container = editorInstance.__overlayLayer;
        const el = document.createElement('img');
        el.className = 'image-overlay';
        el.style.display = 'none';
        el.src = src;
        container.appendChild(el);

        const overlay = {
            el,
            row: Math.max(0, anchorPos.row || 0),
            ready: false,
            naturalWidth: 0,
            naturalHeight: 0,
            widget: null
        };
        editorInstance.__imageOverlays.push(overlay);

        el.onload = () => {
            overlay.naturalWidth = el.naturalWidth;
            overlay.naturalHeight = el.naturalHeight;
            overlay.ready = true;
            el.style.display = 'block';
            this.updateImageOverlayPositions(editorInstance);
        };
        el.onerror = () => {
            el.remove();
            this.removeImageWidget(editorInstance, overlay);
            editorInstance.__imageOverlays = (editorInstance.__imageOverlays || []).filter(o => o !== overlay);
        };
    }

    updateImageOverlayPositions(editorInstance) {
        if (!editorInstance.__overlayLayer || !editorInstance.__imageOverlays) return;
        const paneRect = editorInstance.__pane?.getBoundingClientRect();
        if (!paneRect) return;
        const renderer = editorInstance.renderer;
        const config = renderer.layerConfig;
        const lineHeight = config?.lineHeight || 18;
        const maxWidth = Math.max(120, Math.min(480, (editorInstance.__pane?.clientWidth || 600) * 0.6));

        editorInstance.__imageOverlays.forEach(overlay => {
            if (!overlay.ready) return;
            const posRow = overlay.row ?? 0;
            const screen = renderer.textToScreenCoordinates(posRow, 0);
            const left = screen.pageX - paneRect.left + 6;
            const top = screen.pageY - paneRect.top + lineHeight;
            if (top < -500 || top > paneRect.height + 500) {
                overlay.el.style.display = 'none';
                return;
            }
            const ratio = overlay.naturalWidth ? overlay.naturalHeight / overlay.naturalWidth : 1;
            const width = maxWidth;
            const height = Math.min(width * ratio, 360);
            const widgetHeight = height + lineHeight;

            overlay.el.style.display = 'block';
            overlay.el.style.width = `${width}px`;
            overlay.el.style.height = `${height}px`;
            overlay.el.style.transform = `translate(${left}px, ${top}px)`;
            this.updateImageWidget(editorInstance, overlay, widgetHeight);
        });
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
        this.ensureLineWidgets(editorInstance);
        this.setupImageOverlay(editorInstance, pane);
        this.setupDropTarget(pane, editorInstance, editorEl);

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
