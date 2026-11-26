/* Touch-first viewer; no dependencies and no third-party requests. */
(() => {
  "use strict";

  const stage = document.getElementById("image-stage");
  const image = document.getElementById("spread-image");
  if (!stage || !image) return;

  const previous = document.getElementById("previous-spread");
  const next = document.getElementById("next-spread");
  const close = document.getElementById("close-viewer");
  const pointers = new Map();
  let zoom = 1;
  let offsetX = 0;
  let offsetY = 0;
  let gestureStart = null;
  let pinchStart = null;
  let wasPinching = false;
  let lastTap = 0;

  function fittedDimensions() {
    const iw = image.naturalWidth || 1;
    const ih = image.naturalHeight || 1;
    const factor = Math.min(1, stage.clientWidth / iw, stage.clientHeight / ih);
    return { width: iw * factor, height: ih * factor };
  }

  function render() {
    const fitted = fittedDimensions();
    const maxX = Math.max(0, (fitted.width * zoom - stage.clientWidth) / 2);
    const maxY = Math.max(0, (fitted.height * zoom - stage.clientHeight) / 2);
    offsetX = Math.max(-maxX, Math.min(maxX, offsetX));
    offsetY = Math.max(-maxY, Math.min(maxY, offsetY));
    image.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${zoom})`;
    stage.setAttribute("aria-label",
      zoom > 1 ? "Zoomed spread. Drag to move; pinch to zoom out." :
        "Album spread. Swipe left or right to change spreads; pinch to zoom.");
  }

  function reset() {
    zoom = 1;
    offsetX = 0;
    offsetY = 0;
    render();
  }

  function distance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function point(e) { return { x: e.clientX, y: e.clientY }; }

  function navigate(link) {
    if (link) window.location.assign(link.href);
  }

  stage.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    stage.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, point(event));
    if (pointers.size === 1) {
      wasPinching = false;
      gestureStart = { x: event.clientX, y: event.clientY, ox: offsetX, oy: offsetY };
      pinchStart = null;
    } else if (pointers.size === 2) {
      wasPinching = true;
      const [a, b] = [...pointers.values()];
      pinchStart = { distance: Math.max(distance(a, b), 1), zoom };
    }
  });

  stage.addEventListener("pointermove", (event) => {
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, point(event));
    if (pointers.size === 2 && pinchStart) {
      const [a, b] = [...pointers.values()];
      zoom = Math.max(1, Math.min(5, pinchStart.zoom * distance(a, b) / pinchStart.distance));
      render();
    } else if (pointers.size === 1 && zoom > 1 && gestureStart && !wasPinching) {
      offsetX = gestureStart.ox + event.clientX - gestureStart.x;
      offsetY = gestureStart.oy + event.clientY - gestureStart.y;
      render();
    }
  });

  function finish(event, cancelled = false) {
    if (!pointers.has(event.pointerId)) return;
    const lastPoint = pointers.get(event.pointerId);
    const wasSingle = pointers.size === 1;
    pointers.delete(event.pointerId);
    if (wasSingle && gestureStart && !wasPinching && !cancelled) {
      const dx = lastPoint.x - gestureStart.x;
      const dy = lastPoint.y - gestureStart.y;
      if (zoom <= 1.05 && Math.abs(dx) > 65 && Math.abs(dx) > Math.abs(dy) * 1.25) {
        navigate(dx < 0 ? next : previous);
        return;
      }
      if (Math.hypot(dx, dy) < 18) {
        const now = Date.now();
        if (now - lastTap < 330) {
          zoom = zoom > 1 ? 1 : 2;
          offsetX = offsetY = 0;
          render();
          lastTap = 0;
        } else {
          lastTap = now;
        }
      }
    }
    if (pointers.size === 1) {
      const only = [...pointers.values()][0];
      gestureStart = { x: only.x, y: only.y, ox: offsetX, oy: offsetY };
      pinchStart = null;
    }
    if (pointers.size === 0) {
      gestureStart = null;
      pinchStart = null;
      if (zoom < 1.02) reset();
    }
  }

  stage.addEventListener("pointerup", (event) => finish(event));
  stage.addEventListener("pointercancel", (event) => finish(event, true));
  stage.addEventListener("lostpointercapture", (event) => finish(event, true));

  stage.addEventListener("wheel", (event) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    zoom = Math.max(1, Math.min(5, zoom * (event.deltaY > 0 ? 0.9 : 1.1)));
    if (zoom === 1) offsetX = offsetY = 0;
    render();
  }, { passive: false });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && close) navigate(close);
    if (event.key === "ArrowRight") navigate(next);
    if (event.key === "ArrowLeft") navigate(previous);
    if (event.key === "0") reset();
  });
  window.addEventListener("resize", render);
  image.addEventListener("load", render);
  render();
})();
