import assert from "node:assert/strict";
import test from "node:test";

import { nextNavigationIndex } from "../public/keyboard-navigation.js";

test("roving keyboard navigation wraps and supports Home/End", () => {
  assert.equal(nextNavigationIndex({
    key: "ArrowRight", currentIndex: 2, itemCount: 3, orientation: "horizontal",
  }), 0);
  assert.equal(nextNavigationIndex({
    key: "ArrowLeft", currentIndex: 0, itemCount: 3, orientation: "horizontal",
  }), 2);
  assert.equal(nextNavigationIndex({
    key: "Home", currentIndex: 2, itemCount: 3, orientation: "vertical",
  }), 0);
  assert.equal(nextNavigationIndex({
    key: "End", currentIndex: 0, itemCount: 3, orientation: "vertical",
  }), 2);
});

test("roving keyboard navigation respects orientation and boundaries", () => {
  assert.equal(nextNavigationIndex({
    key: "ArrowDown", currentIndex: 0, itemCount: 3, orientation: "horizontal",
  }), null);
  assert.equal(nextNavigationIndex({
    key: "ArrowDown", currentIndex: 2, itemCount: 3, orientation: "vertical", wrap: false,
  }), 2);
  assert.equal(nextNavigationIndex({
    key: "PageDown", currentIndex: 0, itemCount: 3,
  }), null);
  assert.equal(nextNavigationIndex({
    key: "ArrowRight", currentIndex: 0, itemCount: 0,
  }), null);
});
