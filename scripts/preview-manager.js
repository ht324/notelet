import { simplifyMode } from './utils/editor-utils.js';

const DEFAULT_RATIO = 0.45;
const MIN_RATIO = 0.2;
const MAX_RATIO = 0.8;
const DEFAULT_FLOAT = { width: 360, height: 260, x: 24, y: 24 };
const MIN_FLOAT_WIDTH = 280;
const MIN_FLOAT_HEIGHT = 200;
const DOCK_THRESHOLD = 26;
const FLOAT_BOUNDARY = 20;
const SNAP_GUIDE_THRESHOLD = DOCK_THRESHOLD;
const SNAP_GUIDE_SIZE = 3;
const DRAG_THRESHOLD = 8;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const isMobile = () => window.innerWidth <= 768;
const isCoarsePointer = () => window.matchMedia && window.matchMedia('(pointer: coarse)').matches;

const escapeHtml = (input) => String(input || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const escapeRtf = (input) => String(input || '')
    .replace(/\\/g, '\\\\')
    .replace(/{/g, '\\{')
    .replace(/}/g, '\\}')
    .replace(/\r?\n/g, '\\par\n');

const applyInlineMarkdown = (input) => {
    let safe = escapeHtml(input);
    safe = safe
        .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" />')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>')
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    return safe;
};

const renderMarkdown = (input) => {
    const lines = String(input || '').split(/\r?\n/);
    let html = '';
    let inCode = false;
    let codeLang = '';
    let inList = false;

    const closeList = () => {
        if (inList) {
            html += '</ul>';
            inList = false;
        }
    };

    for (const rawLine of lines) {
        const line = rawLine.replace(/\s+$/, '');
        if (line.startsWith('```')) {
            if (!inCode) {
                closeList();
                inCode = true;
                codeLang = line.slice(3).trim();
                html += `<pre class="md-code"><code data-lang="${escapeHtml(codeLang)}">`;
            } else {
                inCode = false;
                html += '</code></pre>';
            }
            continue;
        }

        if (inCode) {
            html += `${escapeHtml(line)}\n`;
            continue;
        }

        if (!line.trim()) {
            closeList();
            html += '<div class="md-spacer"></div>';
            continue;
        }

        const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
        if (headingMatch) {
            closeList();
            const level = headingMatch[1].length;
            const content = escapeHtml(headingMatch[2]);
            html += `<h${level}>${content}</h${level}>`;
            continue;
        }

        const quoteMatch = line.match(/^>\s+(.+)$/);
        if (quoteMatch) {
            closeList();
            html += `<blockquote>${applyInlineMarkdown(quoteMatch[1])}</blockquote>`;
            continue;
        }

        const listMatch = line.match(/^\s*[-*]\s+(.+)$/);
        if (listMatch) {
            if (!inList) {
                html += '<ul>';
                inList = true;
            }
            html += `<li>${applyInlineMarkdown(listMatch[1])}</li>`;
            continue;
        }

        closeList();
        html += `<p>${applyInlineMarkdown(line)}</p>`;
    }

    if (inList) html += '</ul>';
    if (inCode) html += '</code></pre>';
    return html || '<div class="preview-placeholder">（空白內容）</div>';
};

const detectRendererFromContent = (modeId, content) => {
    const mode = simplifyMode(modeId);
    const trimmed = String(content || '').trim();
    if (!trimmed) return 'none';
    if (mode === 'markdown') return 'markdown';
    if (mode === 'xml') {
        if (/^<svg[\s>]/i.test(trimmed)) return 'svg';
        if (/^<gpx[\s>]/i.test(trimmed)) return 'gpx';
        return 'none';
    }
    if (mode === 'text') {
        if (/^\s*(graph|digraph)\s+\w*/i.test(trimmed)) return 'graphviz';
        if (/^\s*(graph|sequenceDiagram|classDiagram|erDiagram|stateDiagram)/m.test(trimmed)) return 'mermaid';
        return 'none';
    }
    return 'none';
};

const parseSvg = (text) => {
    try {
        const parser = new DOMParser();
        const doc = parser.parseFromString(text, 'image/svg+xml');
        const svg = doc.querySelector('svg');
        return svg || null;
    } catch (_) {
        return null;
    }
};

export class PreviewManager {
    constructor({ container, toggleButton, showToast }) {
        this.container = container;
        this.toggleButton = toggleButton;
        this.showToast = showToast;
        this.editorManager = null;
        this.stateByPane = new Map();
        this.isDragging = false;
        this.dragInfo = null;
        this.fullscreenPaneId = null;
        this.snapGuides = new Map();
        this.zIndexCounter = 0;
        this.bind();
        this.observeTheme();
        window.addEventListener('resize', () => this.handleResize());
        window.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') this.exitFullscreen();
        });
    }

    setEditorManager(manager) {
        this.editorManager = manager;
    }

    bind() {
        if (!this.toggleButton) return;
        this.toggleButton.addEventListener('click', () => this.togglePreview());
    }

    observeTheme() {
        const observer = new MutationObserver(() => this.applyThemes());
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    }

    getActivePane() {
        const active = this.editorManager?.getActiveEditor?.();
        return active?.__pane || null;
    }

    ensureState(pane) {
        if (!pane) return null;
        const paneId = pane.dataset.paneId || pane.__paneId || '';
        let state = this.stateByPane.get(paneId);
        if (!state) {
            state = {
                paneId,
                state: 'closed',
                dockSide: 'right',
                ratio: DEFAULT_RATIO,
                floatRect: { ...DEFAULT_FLOAT },
                renderer: 'auto',
                userOverrideRenderer: false,
                theme: 'follow-app',
                lastState: 'docked',
                panelEl: null,
                headerEl: null,
                bodyEl: null,
                toolbarEl: null,
                resizerEl: null
            };
            this.stateByPane.set(paneId, state);
        }
        return state;
    }

    togglePreview() {
        const pane = this.getActivePane();
        if (!pane) return;
        const state = this.ensureState(pane);
        if (state.state === 'closed') {
            this.openPreview(pane, state);
        } else {
            this.closePreview(pane, state);
        }
        this.updateToggleButton();
    }

    openPreview(pane, state) {
        const editor = this.editorManager?.getPrimaryEditorForPane?.(pane);
        if (!editor) return;
        const renderer = this.resolveRenderer(state, editor);
        if (renderer === 'none') {
            this.showToast?.('此模式不支援 preview', 3000);
            return;
        }
        const defaultState = state.lastState || 'docked';
        const nextState = defaultState === 'floating' && !isMobile() ? 'floating' : 'docked';
        state.state = nextState;
        state.dockSide = this.defaultDockSide();
        this.attachPanel(pane, state);
        this.renderForPane(pane, state);
    }

    closePreview(pane, state) {
        state.lastState = state.state === 'fullscreen' ? (state.prevState || 'docked') : state.state;
        this.detachPanel(pane, state);
        state.state = 'closed';
    }

    defaultDockSide() {
        if (!isMobile()) return 'right';
        return window.innerWidth > window.innerHeight ? 'right' : 'bottom';
    }

    resolveRenderer(state, editor) {
        if (state.userOverrideRenderer && state.renderer && state.renderer !== 'auto') return state.renderer;
        const mode = editor?.getMode?.() || 'text/plain';
        return detectRendererFromContent(mode, editor?.getValue?.() || '');
    }

    attachPanel(pane, state) {
        const panel = this.ensurePanel(pane, state);
        if (state.state === 'fullscreen') {
            this.enterFullscreen(pane, state);
            return;
        }
        if (state.state === 'floating') {
            this.attachFloating(pane, state);
            return;
        }
        this.attachDocked(pane, state);
    }

    detachPanel(_pane, state) {
        if (state.panelEl?.parentNode) state.panelEl.parentNode.removeChild(state.panelEl);
        if (state.resizerEl?.parentNode) state.resizerEl.parentNode.removeChild(state.resizerEl);
        this.clearDockClasses(state);
    }

    ensurePanel(_pane, state) {
        if (state.panelEl) return state.panelEl;
        const panel = document.createElement('div');
        panel.className = 'preview-panel';
        if (isMobile() || isCoarsePointer()) panel.classList.add('preview-touch');

        const header = document.createElement('div');
        header.className = 'preview-header';

        const title = document.createElement('div');
        title.className = 'preview-title';
        title.textContent = 'Preview';

        const toolbar = document.createElement('div');
        toolbar.className = 'preview-toolbar';

        const typeSelect = document.createElement('select');
        typeSelect.className = 'preview-select';
        [
            { value: 'auto', label: '自動' },
            { value: 'graphviz', label: 'Graphviz' },
            { value: 'mermaid', label: 'Mermaid' },
            { value: 'markdown', label: 'Markdown' },
            { value: 'slides', label: '簡報' },
            { value: 'svg', label: 'SVG' },
            { value: 'gpx', label: 'GPX' }
        ].forEach(({ value, label }) => {
            const opt = document.createElement('option');
            opt.value = value;
            opt.textContent = label;
            typeSelect.appendChild(opt);
        });
        typeSelect.addEventListener('change', () => {
            state.renderer = typeSelect.value;
            state.userOverrideRenderer = typeSelect.value !== 'auto';
            this.renderForPane(this.findPane(state), state);
        });

        const themeBtn = document.createElement('button');
        themeBtn.className = 'preview-btn';
        themeBtn.type = 'button';
        themeBtn.textContent = 'Theme';
        themeBtn.addEventListener('click', () => {
            state.theme = state.theme === 'follow-app' ? 'light' : state.theme === 'light' ? 'dark' : 'follow-app';
            this.applyTheme(state);
        });

        const copyBtn = document.createElement('button');
        copyBtn.className = 'preview-btn';
        copyBtn.type = 'button';
        copyBtn.textContent = 'Copy';
        copyBtn.addEventListener('click', () => this.copyPreview(state));

        const saveBtn = document.createElement('button');
        saveBtn.className = 'preview-btn';
        saveBtn.type = 'button';
        saveBtn.textContent = 'Save';
        saveBtn.addEventListener('click', () => this.savePreview(state));

        const fullBtn = document.createElement('button');
        fullBtn.className = 'preview-btn';
        fullBtn.type = 'button';
        fullBtn.textContent = 'Full';
        fullBtn.addEventListener('click', () => this.toggleFullscreen(state));

        const closeBtn = document.createElement('button');
        closeBtn.className = 'preview-btn';
        closeBtn.type = 'button';
        closeBtn.textContent = 'Close';
        closeBtn.addEventListener('click', () => this.closePreview(this.findPane(state), state));

        toolbar.appendChild(typeSelect);
        toolbar.appendChild(themeBtn);
        toolbar.appendChild(copyBtn);
        toolbar.appendChild(saveBtn);
        toolbar.appendChild(fullBtn);
        toolbar.appendChild(closeBtn);

        header.appendChild(title);
        header.appendChild(toolbar);

        const body = document.createElement('div');
        body.className = 'preview-body';

        panel.appendChild(header);
        panel.appendChild(body);
        this.addResizeHandles(panel, state);

        panel.addEventListener('mousedown', () => this.activatePaneFromPanel(state));
        header.addEventListener('mousedown', (e) => this.handleHeaderDragStart(e, state));

        state.panelEl = panel;
        state.headerEl = header;
        state.bodyEl = body;
        state.toolbarEl = toolbar;
        state.typeSelect = typeSelect;
        this.applyTheme(state);
        return panel;
    }

    findPane(state) {
        if (!this.editorManager) return null;
        const panes = this.editorManager.getPaneList?.() || [];
        return panes.find(p => p.dataset.paneId === state.paneId) || null;
    }

    attachDocked(pane, state) {
        const body = this.editorManager?.ensurePaneBody?.(pane) || pane;
        this.clearDockClasses(state);
        body.classList.add('has-preview', `preview-dock-${state.dockSide}`);
        const panel = state.panelEl;
        panel.style.transform = '';
        panel.style.width = '';
        panel.style.height = '';
        const resizer = this.ensureResizer(state);
        const before = state.dockSide === 'left' || state.dockSide === 'top';
        if (before) {
            body.insertBefore(panel, body.firstChild || null);
            body.insertBefore(resizer, panel.nextSibling);
        } else {
            body.appendChild(resizer);
            body.appendChild(panel);
        }
        panel.classList.remove('preview-floating', 'preview-fullscreen');
        panel.classList.add('preview-docked');
        this.applyDockedSize(pane, state);
        this.hideSnapGuides(pane);
    }

    attachFloating(pane, state) {
        this.clearDockClasses(state);
        const panel = state.panelEl;
        if (state.resizerEl?.parentNode) state.resizerEl.parentNode.removeChild(state.resizerEl);
        const base = this.container;
        if (panel.parentNode !== base) base.appendChild(panel);
        panel.classList.remove('preview-docked', 'preview-fullscreen');
        panel.classList.add('preview-floating');
        this.raiseFloating(state);
        this.applyFloatingPosition(base, state);
    }

    ensureResizer(state) {
        if (state.resizerEl) return state.resizerEl;
        const resizer = document.createElement('div');
        resizer.className = 'preview-resizer';
        resizer.addEventListener('mousedown', (e) => this.handleResizerDragStart(e, state));
        state.resizerEl = resizer;
        return resizer;
    }

    applyDockedSize(pane, state) {
        const panel = state.panelEl;
        if (!panel) return;
        const ratio = clamp(state.ratio, MIN_RATIO, MAX_RATIO);
        state.ratio = ratio;
        const isRow = state.dockSide === 'left' || state.dockSide === 'right';
        panel.style.flex = `0 0 ${ratio * 100}%`;
        panel.style.width = isRow ? '' : '100%';
        panel.style.height = isRow ? '100%' : '';
        if (state.resizerEl) {
            state.resizerEl.classList.toggle('preview-resizer-col', isRow);
            state.resizerEl.classList.toggle('preview-resizer-row', !isRow);
        }
    }

    applyFloatingPosition(baseEl, state) {
        const rect = state.floatRect;
        rect.width = Math.max(rect.width, MIN_FLOAT_WIDTH);
        rect.height = Math.max(rect.height, MIN_FLOAT_HEIGHT);
        const baseRect = baseEl.getBoundingClientRect();
        const minX = -(rect.width - FLOAT_BOUNDARY);
        const minY = -(rect.height - FLOAT_BOUNDARY);
        const maxX = baseRect.width - FLOAT_BOUNDARY;
        const maxY = baseRect.height - FLOAT_BOUNDARY;
        rect.x = clamp(rect.x, minX, maxX);
        rect.y = clamp(rect.y, minY, maxY);
        const panel = state.panelEl;
        panel.style.width = `${rect.width}px`;
        panel.style.height = `${rect.height}px`;
        panel.style.transform = `translate(${rect.x}px, ${rect.y}px)`;
    }

    clearDockClasses(state) {
        const pane = this.findPane(state);
        const body = pane ? this.editorManager?.ensurePaneBody?.(pane) : null;
        if (body) {
            body.classList.remove('has-preview', 'preview-dock-left', 'preview-dock-right', 'preview-dock-top', 'preview-dock-bottom');
        }
    }

    handleResizerDragStart(event, state) {
        if (state.state !== 'docked') return;
        event.preventDefault();
        const pane = this.findPane(state);
        if (!pane) return;
        const body = this.editorManager?.ensurePaneBody?.(pane) || pane;
        const start = {
            x: event.clientX,
            y: event.clientY,
            rect: body.getBoundingClientRect(),
            ratio: state.ratio
        };
        const isRow = state.dockSide === 'left' || state.dockSide === 'right';
        const onMove = (e) => {
            const delta = isRow ? (e.clientX - start.x) : (e.clientY - start.y);
            const size = isRow ? start.rect.width : start.rect.height;
            const direction = (state.dockSide === 'left' || state.dockSide === 'top') ? 1 : -1;
            const next = start.ratio + (delta / Math.max(size, 1)) * direction;
            state.ratio = clamp(next, MIN_RATIO, MAX_RATIO);
            this.applyDockedSize(pane, state);
        };
        const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            document.body.style.userSelect = '';
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
        document.body.style.userSelect = 'none';
    }

    handleHeaderDragStart(event, state) {
        if (isMobile()) return;
        if (state.state === 'fullscreen') return;
        event.preventDefault();
        const pane = this.findPane(state);
        if (!pane) return;
        const start = {
            x: event.clientX,
            y: event.clientY,
            state: state.state,
            rect: { ...state.floatRect }
        };
        const panelRect = state.panelEl.getBoundingClientRect();
        const paneRect = pane.getBoundingClientRect();
        const baseRect = this.container.getBoundingClientRect();
        const offsetX = panelRect.left - baseRect.left;
        const offsetY = panelRect.top - baseRect.top;
        const onMove = (e) => {
            const dx = e.clientX - start.x;
            const dy = e.clientY - start.y;
            if (start.state === 'docked' && Math.hypot(dx, dy) > DRAG_THRESHOLD) {
                state.state = 'floating';
                const targetWidth = baseRect.width * 0.45;
                const targetHeight = baseRect.height * 0.45;
                state.floatRect = {
                    width: Math.max(MIN_FLOAT_WIDTH, targetWidth),
                    height: Math.max(MIN_FLOAT_HEIGHT, targetHeight),
                    x: offsetX,
                    y: offsetY
                };
                start.rect = { ...state.floatRect };
                this.attachFloating(pane, state);
            }
            if (state.state === 'floating') {
                const activePane = this.findPane(state) || pane;
                state.lastPointer = { x: e.clientX, y: e.clientY };
                state.floatRect.x = start.rect.x + dx;
                state.floatRect.y = start.rect.y + dy;
                this.applyFloatingPosition(this.container, state);
                this.updateSnapGuides(activePane, state);
            }
        };
        const onUp = (e) => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            document.body.style.userSelect = '';
            const activePane = this.findPane(state) || pane;
            this.hideSnapGuides(activePane);
            state.lastPointer = null;
            if (state.state === 'floating' && !isMobile()) {
                const side = this.getDockSideFromEvent(activePane, e);
                if (side) {
                    state.state = 'docked';
                    state.dockSide = side;
                    this.attachDocked(activePane, state);
                }
            }
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
        document.body.style.userSelect = 'none';
    }

    addResizeHandles(panel, state) {
        const handles = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
        state.resizeHandles = handles.map((dir) => {
            const handle = document.createElement('div');
            handle.className = `preview-resize-handle preview-resize-${dir}`;
            handle.dataset.resizeDir = dir;
            handle.addEventListener('mousedown', (e) => this.handleResizeStart(e, state, dir));
            panel.appendChild(handle);
            return handle;
        });
    }

    handleResizeStart(event, state, dir = 'se') {
        if (state.state !== 'floating') return;
        event.preventDefault();
        event.stopPropagation();
        const start = {
            x: event.clientX,
            y: event.clientY,
            width: state.floatRect.width,
            height: state.floatRect.height,
            rectX: state.floatRect.x,
            rectY: state.floatRect.y
        };
        const hasW = dir.includes('w');
        const hasE = dir.includes('e');
        const hasN = dir.includes('n');
        const hasS = dir.includes('s');
        const onMove = (e) => {
            const dx = e.clientX - start.x;
            const dy = e.clientY - start.y;
            let nextWidth = start.width + (hasE ? dx : 0) - (hasW ? dx : 0);
            let nextHeight = start.height + (hasS ? dy : 0) - (hasN ? dy : 0);
            let nextX = start.rectX + (hasW ? dx : 0);
            let nextY = start.rectY + (hasN ? dy : 0);

            if (nextWidth < MIN_FLOAT_WIDTH) {
                if (hasW) nextX += nextWidth - MIN_FLOAT_WIDTH;
                nextWidth = MIN_FLOAT_WIDTH;
            }
            if (nextHeight < MIN_FLOAT_HEIGHT) {
                if (hasN) nextY += nextHeight - MIN_FLOAT_HEIGHT;
                nextHeight = MIN_FLOAT_HEIGHT;
            }

            state.floatRect.width = nextWidth;
            state.floatRect.height = nextHeight;
            state.floatRect.x = nextX;
            state.floatRect.y = nextY;
            if (this.container) this.applyFloatingPosition(this.container, state);
        };
        const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            document.body.style.userSelect = '';
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
        document.body.style.userSelect = 'none';
    }

    getDockSideFromEvent(pane, event) {
        const body = this.editorManager?.ensurePaneBody?.(pane) || pane;
        const rect = body.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;
        if (x < -DOCK_THRESHOLD || x > rect.width + DOCK_THRESHOLD) return null;
        if (y < -DOCK_THRESHOLD || y > rect.height + DOCK_THRESHOLD) return null;
        if (x < DOCK_THRESHOLD) return 'left';
        if (x > rect.width - DOCK_THRESHOLD) return 'right';
        if (y < DOCK_THRESHOLD) return 'top';
        if (y > rect.height - DOCK_THRESHOLD) return 'bottom';
        return null;
    }


    toggleFullscreen(state) {
        if (state.state === 'fullscreen') {
            this.exitFullscreen();
        } else {
            const pane = this.findPane(state);
            if (pane) this.enterFullscreen(pane, state);
        }
    }

    enterFullscreen(pane, state) {
        state.prevState = state.state === 'fullscreen' ? state.prevState : state.state;
        state.state = 'fullscreen';
        state.prevPaneId = state.paneId;
        state.panelEl.classList.remove('preview-docked', 'preview-floating');
        state.panelEl.classList.add('preview-fullscreen');
        state.panelEl.style.zIndex = '80';
        if (state.panelEl.parentNode !== this.container) {
            this.container.appendChild(state.panelEl);
        }
        if (state.resizerEl?.parentNode) state.resizerEl.parentNode.removeChild(state.resizerEl);
        this.fullscreenPaneId = state.paneId;
        this.applyTheme(state);
    }

    exitFullscreen() {
        if (!this.fullscreenPaneId) return;
        const state = this.stateByPane.get(this.fullscreenPaneId);
        if (!state) return;
        const pane = this.findPane(state);
        const next = state.prevState || 'docked';
        state.state = next;
        state.panelEl.classList.remove('preview-fullscreen');
        state.panelEl.style.zIndex = '';
        if (pane) {
            if (next === 'floating') {
                this.attachFloating(pane, state);
            } else {
                this.attachDocked(pane, state);
            }
        }
        this.fullscreenPaneId = null;
    }

    applyTheme(state) {
        const panel = state.panelEl;
        if (!panel) return;
        const appTheme = document.documentElement.getAttribute('data-theme') || 'dark';
        let theme = state.theme;
        if (theme === 'follow-app') {
            theme = appTheme === 'dark' ? 'light' : 'dark';
        }
        panel.dataset.previewTheme = theme;
    }

    applyThemes() {
        this.stateByPane.forEach((state) => {
            if (state.state !== 'closed') this.applyTheme(state);
        });
    }

    raiseFloating(state) {
        if (!state?.panelEl) return;
        this.zIndexCounter += 1;
        state.panelEl.style.zIndex = String(40 + this.zIndexCounter);
    }

    handleResize() {
        this.stateByPane.forEach((state) => {
            if (state.state === 'closed') return;
            const pane = this.findPane(state);
            if (!pane) return;
            if (state.state === 'docked') {
                if (isMobile()) state.dockSide = this.defaultDockSide();
                this.attachDocked(pane, state);
            } else if (state.state === 'floating') {
                if (isMobile()) {
                    state.state = 'docked';
                    state.dockSide = this.defaultDockSide();
                    this.attachDocked(pane, state);
                } else {
                    this.applyFloatingPosition(this.container, state);
                }
            }
        });
        this.updateToggleButton();
    }

    handleActiveEditorChange(editor) {
        if (!editor) return;
        const pane = editor.__pane;
        if (pane) {
            const state = this.ensureState(pane);
            if (state?.state === 'floating') this.raiseFloating(state);
        }
        this.updateToggleButton();
        this.refreshAll();
    }

    handleModeChange(editor) {
        if (!editor) return;
        this.refreshAll();
    }

    handleEditorChange(editor) {
        if (!editor) return;
        this.scheduleRender(editor);
    }

    scheduleRender(editor) {
        if (!editor) return;
        clearTimeout(editor.__previewTimer);
        editor.__previewTimer = setTimeout(() => {
            const pane = editor.__pane;
            const state = this.ensureState(pane);
            if (!state || state.state === 'closed') return;
            const primary = this.editorManager?.getPrimaryEditorForPane?.(pane);
            if (primary !== editor) return;
            this.renderForPane(pane, state);
        }, 300);
    }

    renderForPane(pane, state) {
        const editor = this.editorManager?.getPrimaryEditorForPane?.(pane);
        if (!editor || !state.bodyEl) return;
        const modeId = editor.getMode?.() || 'text/plain';
        const content = editor.getValue?.() || '';
        const renderer = state.userOverrideRenderer ? state.renderer : detectRendererFromContent(modeId, content);
        if (state.typeSelect) state.typeSelect.value = state.userOverrideRenderer ? state.renderer : 'auto';

        state.bodyEl.innerHTML = '';
        state.bodyEl.classList.remove('preview-svg');

        if (renderer === 'markdown') {
            state.bodyEl.innerHTML = renderMarkdown(content);
            return;
        }
        if (renderer === 'none') {
            state.bodyEl.innerHTML = '<div class="preview-placeholder">此內容未支援預覽</div>';
            return;
        }
        if (renderer === 'svg') {
            const svg = parseSvg(content);
            if (svg) {
                svg.classList.add('preview-svg-el');
                state.bodyEl.classList.add('preview-svg');
                state.bodyEl.appendChild(svg);
            } else {
                state.bodyEl.innerHTML = '<div class="preview-placeholder">SVG 解析失敗</div>';
            }
            return;
        }
        if (renderer === 'graphviz' || renderer === 'mermaid') {
            state.bodyEl.innerHTML = `<div class="preview-placeholder">${renderer} 預覽尚未整合</div>`;
            return;
        }
        if (renderer === 'gpx') {
            state.bodyEl.innerHTML = '<div class="preview-placeholder">GPX 預覽尚未整合</div>';
            return;
        }
        if (renderer === 'slides') {
            state.bodyEl.innerHTML = '<div class="preview-placeholder">簡報預覽尚未整合</div>';
            return;
        }
        state.bodyEl.innerHTML = '<pre class="preview-raw"></pre>';
        state.bodyEl.querySelector('.preview-raw').textContent = content || '（空白內容）';
    }

    refreshAll() {
        const panes = this.editorManager?.getPaneList?.() || [];
        const liveIds = new Set(panes.map(p => p.dataset.paneId));
        this.stateByPane.forEach((state, paneId) => {
            if (!liveIds.has(paneId)) {
                if (state.panelEl?.parentNode) state.panelEl.parentNode.removeChild(state.panelEl);
                if (state.resizerEl?.parentNode) state.resizerEl.parentNode.removeChild(state.resizerEl);
                this.stateByPane.delete(paneId);
            }
        });
        panes.forEach((pane) => {
            const state = this.ensureState(pane);
            if (!state || state.state === 'closed') return;
            if (state.state === 'floating' && state.panelEl?.parentNode !== this.container) {
                this.container.appendChild(state.panelEl);
            }
            this.renderForPane(pane, state);
        });
        this.applyThemes();
        this.updateToggleButton();
    }

    updateToggleButton() {
        if (!this.toggleButton) return;
        const pane = this.getActivePane();
        const state = this.ensureState(pane);
        const isOpen = state && state.state !== 'closed';
        this.toggleButton.classList.toggle('active', !!isOpen);
        const label = isOpen ? '關閉 Preview' : '開啟 Preview';
        this.toggleButton.setAttribute('aria-label', label);
        this.toggleButton.dataset.tooltip = label;
    }

    activatePaneFromPanel(state) {
        const pane = this.findPane(state);
        if (!pane) return;
        const editor = this.editorManager?.getPrimaryEditorForPane?.(pane);
        if (editor) this.editorManager?.setActiveEditor?.(editor);
        if (state?.state === 'floating') this.raiseFloating(state);
    }

    ensureSnapGuides(pane) {
        if (!pane) return null;
        const body = this.editorManager?.ensurePaneBody?.(pane) || pane;
        let guides = this.snapGuides.get(body);
        if (guides) return guides;
        const h = document.createElement('div');
        h.className = 'preview-snap-guide preview-snap-guide-h';
        const v = document.createElement('div');
        v.className = 'preview-snap-guide preview-snap-guide-v';
        body.appendChild(h);
        body.appendChild(v);
        guides = { h, v };
        this.snapGuides.set(body, guides);
        return guides;
    }

    updateSnapGuides(pane, state) {
        const guides = this.ensureSnapGuides(pane);
        if (!guides) return;
        if (!pane) {
            guides.v.style.display = 'none';
            guides.h.style.display = 'none';
            return;
        }
        const body = this.editorManager?.ensurePaneBody?.(pane) || pane;
        const paneRect = body.getBoundingClientRect();
        const maxX = paneRect.width;
        const maxY = paneRect.height;
        const mouse = state.lastPointer;
        if (!mouse) {
            guides.v.style.display = 'none';
            guides.h.style.display = 'none';
            return;
        }
        const side = this.getDockSideFromEvent(pane, { clientX: mouse.x, clientY: mouse.y });
        const nearLeft = side === 'left';
        const nearRight = side === 'right';
        const nearTop = side === 'top';
        const nearBottom = side === 'bottom';

        const showV = nearLeft || nearRight;
        const showH = nearTop || nearBottom;

        guides.v.style.display = showV ? 'block' : 'none';
        guides.h.style.display = showH ? 'block' : 'none';

        if (showV) {
            const x = nearLeft ? 0 : maxX - SNAP_GUIDE_SIZE;
            guides.v.style.left = `${x}px`;
        }
        if (showH) {
            const y = nearTop ? 0 : maxY - SNAP_GUIDE_SIZE;
            guides.h.style.top = `${y}px`;
        }
    }

    hideSnapGuides(pane) {
        if (!pane) return;
        const body = this.editorManager?.ensurePaneBody?.(pane) || pane;
        const guides = this.snapGuides.get(body);
        if (!guides) return;
        guides.h.style.display = 'none';
        guides.v.style.display = 'none';
    }

    copyPreview(state) {
        const pane = this.findPane(state);
        const editor = pane ? this.editorManager?.getPrimaryEditorForPane?.(pane) : null;
        const content = editor?.getValue?.() || '';
        const renderer = state.userOverrideRenderer ? state.renderer : detectRendererFromContent(editor?.getMode?.() || '', content);
        if (renderer !== 'markdown') {
            this.showToast?.('僅支援 Markdown 複製', 3000);
            return;
        }
        const html = renderMarkdown(content);
        const text = content || '';
        const rtf = `{\\rtf1\\ansi\\deff0 {\\fonttbl {\\f0 Arial;}}\n${escapeRtf(text)}\n}`;
        if (navigator.clipboard && window.ClipboardItem) {
            const data = {
                'text/plain': new Blob([text], { type: 'text/plain' }),
                'text/html': new Blob([html], { type: 'text/html' }),
                'text/rtf': new Blob([rtf], { type: 'text/rtf' })
            };
            navigator.clipboard.write([new ClipboardItem(data)])
                .then(() => this.showToast?.('已複製為 RTF', 3000))
                .catch(() => this.fallbackCopy(text));
        } else {
            this.fallbackCopy(text);
        }
    }

    fallbackCopy(text) {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
        this.showToast?.('已複製', 3000);
    }

    savePreview(_state) {
        this.showToast?.('此類型尚未提供匯出', 3000);
    }
}
