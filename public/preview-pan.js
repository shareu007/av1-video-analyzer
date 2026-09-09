const PAN_THRESHOLD = 4;
const CONTROL_SELECTOR = "button, a, input, select, textarea, summary, [role=button], [data-preview-control]";

function isControl(target, viewport) {
  if (!target || target === viewport) return false;
  if (typeof target.closest === "function") return Boolean(target.closest(CONTROL_SELECTOR));
  return Boolean(target.isPreviewControl);
}

/** Attach drag-to-pan behavior to a scrollable preview viewport. */
export function attachPreviewPan(viewport) {
  if (!viewport || typeof viewport.addEventListener !== "function") {
    throw new TypeError("attachPreviewPan requires an event target viewport");
  }

  let gesture = null;
  let suppressNextClick = false;

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
    viewport.scrollLeft = gesture.scrollLeft - dx;
    viewport.scrollTop = gesture.scrollTop - dy;
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

  viewport.addEventListener("pointerdown", onPointerDown);
  viewport.addEventListener("pointermove", onPointerMove);
  viewport.addEventListener("pointerup", finish);
  viewport.addEventListener("pointercancel", finish);
  viewport.addEventListener("pointerleave", onPointerLeave);
  viewport.addEventListener("lostpointercapture", finish);
  viewport.addEventListener("click", onClick, true);
  viewport.addEventListener("dragstart", preventNativeDrag);

  return () => {
    viewport.removeEventListener("pointerdown", onPointerDown);
    viewport.removeEventListener("pointermove", onPointerMove);
    viewport.removeEventListener("pointerup", finish);
    viewport.removeEventListener("pointercancel", finish);
    viewport.removeEventListener("pointerleave", onPointerLeave);
    viewport.removeEventListener("lostpointercapture", finish);
    viewport.removeEventListener("click", onClick, true);
    viewport.removeEventListener("dragstart", preventNativeDrag);
    finish();
    viewport.classList?.remove("is-panning");
    gesture = null;
    suppressNextClick = false;
  };
}
