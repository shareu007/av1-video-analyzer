const PAN_THRESHOLD = 4;
const CONTROL_SELECTOR = "button, a, input, select, textarea, summary, [role=button], [data-preview-control]";

function isControl(target, viewport) {
  if (!target || target === viewport) return false;
  if (typeof target.closest === "function") return Boolean(target.closest(CONTROL_SELECTOR));
  return Boolean(target.isPreviewControl);
}

/** Pan/zoom the shared image and overlay stage without replacing its DOM. */
export function attachPreviewPan(viewport, { viewState = {}, zoom = null } = {}) {
  if (!viewport || typeof viewport.addEventListener !== "function") {
    throw new TypeError("attachPreviewPan requires an event target viewport");
  }

  let gesture = null;
  let suppressNextClick = false;
  const stage = viewport.querySelector?.(".preview-stage");
  const originalTranslate = stage?.style.translate;
  const originalWidth = stage?.style.width;
  let panX = 0;
  let panY = 0;
  const geometry = () => {
    if (!stage?.getBoundingClientRect || !viewport.getBoundingClientRect) return null;
    const picture = stage.getBoundingClientRect();
    const bounds = viewport.getBoundingClientRect();
    if (!(picture.width > 0 && picture.height > 0 && viewport.clientWidth > 0 && viewport.clientHeight > 0)) return null;
    return { picture, x: bounds.left + viewport.clientWidth / 2, y: bounds.top + viewport.clientHeight / 2 };
  };
  const rememberCenter = () => {
    const measured = geometry();
    if (measured) viewState.center = {
      x: (measured.x - measured.picture.left) / measured.picture.width,
      y: (measured.y - measured.picture.top) / measured.picture.height,
    };
  };
  const restoreCenter = () => {
    const measured = geometry();
    if (!measured) return;
    const center = viewState.center ?? { x: 0.5, y: 0.5 };
    panX += measured.x - measured.picture.left - measured.picture.width * center.x;
    panY += measured.y - measured.picture.top - measured.picture.height * center.y;
    stage.style.translate = `${panX}px ${panY}px`;
    viewState.center = center;
  };
  if (stage) {
    viewport.classList?.add("free-pan");
    stage.style.translate = "0px 0px";
    restoreCenter();
  }
  const observer = stage && typeof ResizeObserver !== "undefined" ? new ResizeObserver(restoreCenter) : null;
  observer?.observe(viewport);
  if (stage) observer?.observe(stage);

  const onPointerDown = (event) => {
    if (gesture || event.isPrimary === false || (event.button !== 0 && event.button !== 1)) return;
    if (isControl(event.target, viewport)) return;
    if (event.button === 1) event.preventDefault?.();
    gesture = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      scrollLeft: viewport.scrollLeft,
      scrollTop: viewport.scrollTop,
      panX,
      panY,
      moved: false,
      captured: false,
    };
    suppressNextClick = false;
  };

  const onPointerMove = (event) => {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    const dx = event.clientX - gesture.startX;
    const dy = event.clientY - gesture.startY;
    if (!gesture.moved && Math.hypot(dx, dy) < PAN_THRESHOLD) return;
    if (!gesture.moved) {
      gesture.moved = true;
      suppressNextClick = true;
      if (typeof viewport.setPointerCapture === "function") {
        viewport.setPointerCapture(gesture.pointerId);
        gesture.captured = true;
      }
      viewport.classList?.add("is-panning");
    }
    if (stage) {
      panX = gesture.panX + dx;
      panY = gesture.panY + dy;
      stage.style.translate = `${panX}px ${panY}px`;
      rememberCenter();
    } else {
      viewport.scrollLeft = gesture.scrollLeft - dx;
      viewport.scrollTop = gesture.scrollTop - dy;
    }
    event.preventDefault?.();
  };

  const finish = (event) => {
    if (!gesture || (event && event.pointerId !== gesture.pointerId)) return;
    const completed = gesture;
    gesture = null;
    if (completed.captured && typeof viewport.releasePointerCapture === "function"
      && (!viewport.hasPointerCapture || viewport.hasPointerCapture(completed.pointerId))) {
      viewport.releasePointerCapture(completed.pointerId);
    }
    viewport.classList?.remove("is-panning");
  };
  const onPointerLeave = (event) => { if (gesture && !gesture.moved) finish(event); };

  const onClick = (event) => {
    if (!suppressNextClick) return;
    suppressNextClick = false;
    event.preventDefault?.();
    event.stopImmediatePropagation?.();
  };

  const preventNativeDrag = (event) => event.preventDefault?.();
  const resetPan = () => {
    finish();
    panX = 0;
    panY = 0;
    if (stage) stage.style.translate = "0px 0px";
    else { viewport.scrollLeft = 0; viewport.scrollTop = 0; }
    viewState.center = { x: 0.5, y: 0.5 };
    restoreCenter();
  };
  const canZoom = Boolean(stage && Number.isFinite(zoom?.sourceWidth) && zoom.sourceWidth > 0);
  const setZoom = (value, anchor = null) => {
    if (!canZoom) return false;
    const measured = geometry();
    if (!measured) return false;
    const scale = value === "fit" ? null : Number(value);
    if (value !== "fit" && !(Number.isFinite(scale) && scale > 0)) return false;
    if (value === "fit" && !zoom.fitWidth) return false;
    finish();
    const x = Number.isFinite(anchor?.x) ? anchor.x : measured.x;
    const y = Number.isFinite(anchor?.y) ? anchor.y : measured.y;
    const point = { x: (x - measured.picture.left) / measured.picture.width,
      y: (y - measured.picture.top) / measured.picture.height };
    const next = scale === null ? "fit" : Math.max(zoom.minimum ?? 0.01, Math.min(zoom.maximum ?? 16, scale));
    stage.style.width = next === "fit" ? zoom.fitWidth : `${zoom.sourceWidth * next}px`;
    const resized = stage.getBoundingClientRect();
    // Width changes may also move auto margins. Compensate for both so the
    // same source pixel remains under the pointer, even after panning.
    panX += x - resized.left - point.x * resized.width;
    panY += y - resized.top - point.y * resized.height;
    stage.style.translate = `${panX}px ${panY}px`;
    rememberCenter();
    zoom.onChange?.(next);
    return true;
  };
  const zoomBy = (factor, anchor) => {
    const measured = geometry();
    if (!canZoom || !measured) return false;
    return setZoom(measured.picture.width / zoom.sourceWidth * factor, anchor);
  };
  const onWheel = (event) => {
    // Leave browser zoom shortcuts and controls alone; consume only vertical
    // wheel gestures inside the picture viewport, including at zoom limits.
    if (!canZoom || event.ctrlKey || event.metaKey || isControl(event.target, viewport)
      || !Number.isFinite(event.deltaY) || event.deltaY === 0) return;
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1;
    const pixels = Math.max(-240, Math.min(240, event.deltaY * unit));
    if (zoomBy(Math.exp(-pixels * 0.002), { x: event.clientX, y: event.clientY })) event.preventDefault();
  };
  const resetView = () => { if (canZoom) setZoom("fit"); resetPan(); };
  const onKeyDown = (event) => {
    if (event.target !== viewport || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === "Home") { event.preventDefault(); resetPan(); return; }
    if (canZoom && ["+", "=", "-", "0"].includes(event.key)) {
      event.preventDefault();
      if (event.key === "0") resetView();
      else zoomBy(event.key === "-" ? 1 / 1.25 : 1.25);
      return;
    }
    const delta = { ArrowLeft: [40, 0], ArrowRight: [-40, 0], ArrowUp: [0, 40], ArrowDown: [0, -40] }[event.key];
    if (!delta || !stage) return;
    event.preventDefault();
    finish();
    panX += delta[0]; panY += delta[1];
    stage.style.translate = `${panX}px ${panY}px`;
    rememberCenter();
  };

  viewport.addEventListener("pointerdown", onPointerDown);
  viewport.addEventListener("pointermove", onPointerMove);
  viewport.addEventListener("pointerup", finish);
  viewport.addEventListener("pointercancel", finish);
  viewport.addEventListener("pointerleave", onPointerLeave);
  viewport.addEventListener("lostpointercapture", finish);
  viewport.addEventListener("click", onClick, true);
  viewport.addEventListener("dragstart", preventNativeDrag);
  viewport.addEventListener("dblclick", resetView);
  viewport.addEventListener("keydown", onKeyDown);
  viewport.addEventListener("wheel", onWheel, { passive: false });

  const cleanup = () => {
    observer?.disconnect();
    viewport.removeEventListener("pointerdown", onPointerDown);
    viewport.removeEventListener("pointermove", onPointerMove);
    viewport.removeEventListener("pointerup", finish);
    viewport.removeEventListener("pointercancel", finish);
    viewport.removeEventListener("pointerleave", onPointerLeave);
    viewport.removeEventListener("lostpointercapture", finish);
    viewport.removeEventListener("click", onClick, true);
    viewport.removeEventListener("dragstart", preventNativeDrag);
    viewport.removeEventListener("dblclick", resetView);
    viewport.removeEventListener("keydown", onKeyDown);
    viewport.removeEventListener("wheel", onWheel);
    finish();
    if (stage) {
      stage.style.translate = originalTranslate ?? "";
      if (canZoom) stage.style.width = originalWidth ?? "";
      viewport.classList?.remove("free-pan");
    }
    viewport.classList?.remove("is-panning");
    gesture = null;
    suppressNextClick = false;
  };
  cleanup.reset = resetView;
  cleanup.zoomTo = setZoom;
  return cleanup;
}
