let overlay = null;
const ensureOverlay = () => {
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.className = 'img-lightbox-overlay';
    const img = document.createElement('img');
    overlay.appendChild(img);
    overlay.addEventListener('click', () => {
        overlay.classList.remove('visible');
    });
    document.body.appendChild(overlay);
    return overlay;
};

export const showLightbox = (src, alt = '') => {
    const ov = ensureOverlay();
    const img = ov.querySelector('img');
    if (img) {
        img.src = src;
        img.alt = alt;
    }
    ov.classList.add('visible');
};
