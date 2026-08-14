import assert from "node:assert/strict";
import test from "node:test";

import {
  clampSplitRatio,
  splitRatioBounds,
  splitRatioFromPointer
} from "../public/host/split-pane.js";

test("split-pane ratios preserve the minimum width of both frames", () => {
  assert.deepEqual(splitRatioBounds(1_000, 280), {
    minimum: 0.28,
    maximum: 0.72
  });
  assert.equal(clampSplitRatio(0.1, 1_000, 280), 0.28);
  assert.equal(clampSplitRatio(0.9, 1_000, 280), 0.72);
  assert.equal(clampSplitRatio(0.6, 1_000, 280), 0.6);
});

test("pointer position maps to the divider center and clamps at either edge", () => {
  const geometry = {
    containerLeft: 100,
    containerWidth: 1_040,
    dividerWidth: 40,
    minimumPaneWidth: 280
  };
  assert.equal(splitRatioFromPointer({ ...geometry, clientX: 620 }), 0.5);
  assert.equal(splitRatioFromPointer({ ...geometry, clientX: 100 }), 0.28);
  assert.equal(splitRatioFromPointer({ ...geometry, clientX: 1_140 }), 0.72);
});
