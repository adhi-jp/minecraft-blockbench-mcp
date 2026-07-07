// Fixture tests for the pure payload ⇄ Blockbench animation mapping. The
// injected inverter mimics Blockbench's invertMolang contract (numbers
// negate; molang strings are rewritten to their negation) with a reversible
// stand-in for strings, so axis policy and normalization are pinned without
// depending on Blockbench code.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  payloadClipToBlockbench,
  blockbenchClipToPayload,
  geckolibLoopToBlockbench,
  blockbenchLoopToGeckolib,
  type BlockbenchClipData,
  type MolangValue,
  type PayloadClip,
} from '../src/plugin/geckolib-animation-mapping.js';

/** Reversible stand-in for Blockbench's invertMolang: numbers negate; molang
 * strings toggle a leading `-(...)` wrapper. */
function fakeInvert(value: MolangValue): MolangValue {
  if (typeof value === 'number') return -value;
  const wrapped = /^-\((.*)\)$/.exec(value);
  return wrapped !== null ? wrapped[1] : `-(${value})`;
}

test('loop modes map between GeckoLib JSON terms and Blockbench terms', () => {
  assert.equal(geckolibLoopToBlockbench(undefined), 'once');
  assert.equal(geckolibLoopToBlockbench('once'), 'once');
  assert.equal(geckolibLoopToBlockbench('loop'), 'loop');
  assert.equal(geckolibLoopToBlockbench('hold_on_last_frame'), 'hold');
  assert.equal(blockbenchLoopToGeckolib('once'), 'once');
  assert.equal(blockbenchLoopToGeckolib('loop'), 'loop');
  assert.equal(blockbenchLoopToGeckolib('hold'), 'hold_on_last_frame');
});

test('payload values invert rotation X/Y and position X numerically, scale never', () => {
  const clip: PayloadClip = {
    name: 'animation.ghost.axes',
    length: 1,
    bones: {
      body: {
        rotation: [{ time: 0, value: [-10, -15, 20] }],
        position: [{ time: 0.5, value: [-2, 1, 3] }],
        scale: [{ time: 1, value: [2, 3, 4] }],
      },
    },
  };
  const mapped = payloadClipToBlockbench(clip, fakeInvert);
  const [rotation, position, scale] = mapped.bones[0].keyframes;
  assert.deepEqual(rotation.dataPoint, { x: 10, y: 15, z: 20 });
  assert.deepEqual(position.dataPoint, { x: 2, y: 1, z: 3 });
  assert.deepEqual(scale.dataPoint, { x: 2, y: 3, z: 4 });
});

test('molang strings pass through the injected inverter on the inverted axes only', () => {
  const clip: PayloadClip = {
    name: 'animation.ghost.molang',
    length: 2,
    bones: {
      body: {
        rotation: [{ time: 1, value: ['-(math.sin(query.anim_time * 90) * 5)', 'query.y', 7] }],
      },
    },
  };
  const mapped = payloadClipToBlockbench(clip, fakeInvert);
  assert.deepEqual(mapped.bones[0].keyframes[0].dataPoint, {
    x: 'math.sin(query.anim_time * 90) * 5',
    y: '-(query.y)',
    z: 7,
  });
});

test('scalar payload values expand to all three axes like the GeckoLib importer', () => {
  const clip: PayloadClip = {
    name: 'animation.ghost.scalar',
    length: 1,
    bones: { body: { scale: [{ time: 0, value: 2 }], position: [{ time: 0, value: 'query.x' }] } },
  };
  const mapped = payloadClipToBlockbench(clip, fakeInvert);
  const position = mapped.bones[0].keyframes.find((keyframe) => keyframe.channel === 'position');
  const scale = mapped.bones[0].keyframes.find((keyframe) => keyframe.channel === 'scale');
  assert.deepEqual(scale?.dataPoint, { x: 2, y: 2, z: 2 });
  // Position X is inverted, so the scalar molang string is inverted on X only.
  assert.deepEqual(position?.dataPoint, { x: '-(query.x)', y: 'query.x', z: 'query.x' });
});

test('rotation zero values stay plain zero instead of negative zero', () => {
  const clip: PayloadClip = {
    name: 'animation.ghost.zero',
    length: 1,
    bones: { body: { rotation: [{ time: 0, value: [0, 0, 0] }] } },
  };
  const mapped = payloadClipToBlockbench(clip, fakeInvert);
  const { x, y, z } = mapped.bones[0].keyframes[0].dataPoint;
  assert.ok(Object.is(x, 0) && Object.is(y, 0) && Object.is(z, 0), 'no -0 may leak into keyframe data');
});

test('clip properties map with defaults: loop once, override false, empty channels dropped', () => {
  const clip: PayloadClip = {
    name: 'animation.ghost.props',
    length: 1.25,
    bones: { body: { rotation: [] }, head: {} },
  };
  const mapped = payloadClipToBlockbench(clip, fakeInvert);
  assert.equal(mapped.loop, 'once');
  assert.equal(mapped.override, false);
  assert.equal(mapped.animTimeUpdate, undefined);
  assert.deepEqual(mapped.bones, [], 'bones without keyframes are dropped');
});

test('blockbench data normalizes to the canonical payload form', () => {
  const blockbench: BlockbenchClipData = {
    name: 'animation.ghost.normalize',
    loop: 'hold',
    length: 2,
    override: true,
    animTimeUpdate: 'query.anim_time + query.delta_time',
    bones: [
      {
        name: 'head',
        keyframes: [
          // Out of time order on purpose; linear interpolation must be omitted.
          { channel: 'rotation', time: 1, interpolation: 'catmullrom', dataPoint: { x: -10, y: -15, z: 20 } },
          { channel: 'rotation', time: 0, interpolation: 'linear', dataPoint: { x: 0, y: 0, z: 0 } },
          {
            channel: 'scale',
            time: 0.5,
            interpolation: 'linear',
            easing: 'easeInBack',
            easingArgs: [1.7],
            dataPoint: { x: 1, y: 1, z: 1 },
          },
        ],
      },
      { name: 'body', keyframes: [{ channel: 'position', time: 0, interpolation: 'linear', dataPoint: { x: 2, y: 1, z: 3 } }] },
    ],
  };
  const payload = blockbenchClipToPayload(blockbench, fakeInvert);
  assert.deepEqual(payload, {
    name: 'animation.ghost.normalize',
    loop: 'hold_on_last_frame',
    length: 2,
    override: true,
    anim_time_update: 'query.anim_time + query.delta_time',
    bones: {
      body: { position: [{ time: 0, value: [-2, 1, 3] }] },
      head: {
        rotation: [
          { time: 0, value: 0 },
          { time: 1, value: [10, 15, 20], interpolation: 'catmullrom' },
        ],
        scale: [{ time: 0.5, value: 1, easing: 'easeInBack', easingArgs: [1.7] }],
      },
    },
  });
  assert.deepEqual(Object.keys(payload.bones), ['body', 'head'], 'bones are sorted by name');
});

test("a keyframe's linear easing is omitted like linear interpolation", () => {
  const blockbench: BlockbenchClipData = {
    name: 'animation.ghost.linear',
    loop: 'once',
    length: 1,
    override: false,
    bones: [
      {
        name: 'body',
        keyframes: [
          { channel: 'scale', time: 0, interpolation: 'linear', easing: 'linear', dataPoint: { x: 1, y: 1, z: 1 } },
          { channel: 'scale', time: 1, interpolation: 'linear', easing: 'easeOutBounce', dataPoint: { x: 2, y: 2, z: 2 } },
        ],
      },
    ],
  };
  const payload = blockbenchClipToPayload(blockbench, fakeInvert);
  assert.deepEqual(payload.bones.body.scale, [
    { time: 0, value: 1 },
    { time: 1, value: 2, easing: 'easeOutBounce' },
  ]);
});

test('easingArgs are only emitted next to an easing name', () => {
  const blockbench: BlockbenchClipData = {
    name: 'animation.ghost.easing',
    loop: 'once',
    length: 1,
    override: false,
    bones: [
      {
        name: 'body',
        keyframes: [
          { channel: 'scale', time: 0, interpolation: 'linear', easingArgs: [4], dataPoint: { x: 1, y: 1, z: 1 } },
          { channel: 'scale', time: 1, interpolation: 'linear', easing: 'easeOutBounce', easingArgs: [], dataPoint: { x: 2, y: 2, z: 2 } },
        ],
      },
    ],
  };
  const payload = blockbenchClipToPayload(blockbench, fakeInvert);
  assert.deepEqual(payload.bones.body.scale, [
    { time: 0, value: 1 },
    { time: 1, value: 2, easing: 'easeOutBounce' },
  ]);
});

test('payload → blockbench → payload round-trips to the normalized payload', () => {
  const authored: PayloadClip = {
    name: 'animation.ghost.roundtrip',
    loop: 'hold_on_last_frame',
    length: 2,
    anim_time_update: 'query.anim_time + query.delta_time',
    bones: {
      body: {
        rotation: [
          { time: 0, value: 0 },
          { time: 0.5, value: [-10, -15, 20], easing: 'easeInOutSine' },
          { time: 1, value: ['-(math.sin(query.anim_time * 90) * 5)', 0, 0] },
        ],
        position: [{ time: 1.5, value: [-2, 1, 3], interpolation: 'catmullrom' }],
        scale: [{ time: 2, value: 1, easing: 'easeInBack', easingArgs: [1.7] }],
      },
    },
  };
  const roundTripped = blockbenchClipToPayload(payloadClipToBlockbench(authored, fakeInvert), fakeInvert);
  assert.deepEqual(roundTripped, {
    ...authored,
    bones: {
      body: {
        ...authored.bones.body,
        // Documented normalization: an [x, 0, 0] molang keyframe keeps its
        // array form only while the axes differ; nothing else changes here.
        rotation: [
          { time: 0, value: 0 },
          { time: 0.5, value: [-10, -15, 20], easing: 'easeInOutSine' },
          { time: 1, value: ['-(math.sin(query.anim_time * 90) * 5)', 0, 0] },
        ],
      },
    },
  });
});

test('a non-normalized payload converges to the normalized form through the mapping', () => {
  // Unsorted times, an explicit linear interpolation, an orphan easingArgs,
  // an omitted default loop, and a scalar authored as three equal axes: all
  // collapse to the canonical output on the way back.
  const denormalized: PayloadClip = {
    name: 'animation.ghost.denorm',
    length: 1,
    bones: {
      body: {
        rotation: [
          { time: 1, value: [0, 0, 0], interpolation: 'linear' },
          { time: 0, value: [5, 5, 5], easingArgs: [4] },
        ],
      },
    },
  };
  const normalized = blockbenchClipToPayload(payloadClipToBlockbench(denormalized, fakeInvert), fakeInvert);
  assert.deepEqual(normalized, {
    name: 'animation.ghost.denorm',
    loop: 'once',
    length: 1,
    bones: {
      body: {
        rotation: [
          { time: 0, value: 5 },
          { time: 1, value: 0 },
        ],
      },
    },
  });
  // A second pass is a fixed point.
  assert.deepEqual(blockbenchClipToPayload(payloadClipToBlockbench(normalized, fakeInvert), fakeInvert), normalized);
});
