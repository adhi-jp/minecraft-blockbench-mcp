// Pure mapping between the GeckoLib animation clip payload (the
// upsert_geckolib_animation / get_geckolib_animation wire shape, which uses
// the .animation.json value convention) and plain Blockbench keyframe data.
// No Blockbench globals: value inversion is injected because Blockbench owns
// the molang-expression inverter (the window-global invertMolang that the
// GeckoLib plugin's own importer and exporter call). Axis policy per the
// GeckoLib plugin 4.2.5 import/export code: rotation inverts X and Y,
// position inverts X, scale is uninverted.

export type MolangValue = number | string;

/** Inverts one axis value; numbers negate, molang strings are rewritten.
 * At runtime this is Blockbench's window-global invertMolang. */
export type InvertValue = (value: MolangValue) => MolangValue;

export const ANIMATION_CHANNELS = ['rotation', 'position', 'scale'] as const;
export type AnimationChannel = (typeof ANIMATION_CHANNELS)[number];

export type KeyframeInterpolation = 'linear' | 'catmullrom' | 'step';
export type GeckolibLoopMode = 'once' | 'loop' | 'hold_on_last_frame';
export type BlockbenchLoopMode = 'once' | 'loop' | 'hold';

export interface PayloadKeyframe {
  time: number;
  value: MolangValue | [MolangValue, MolangValue, MolangValue];
  interpolation?: KeyframeInterpolation;
  easing?: string;
  easingArgs?: number[];
}

export type PayloadChannels = Partial<Record<AnimationChannel, PayloadKeyframe[]>>;

export interface PayloadClip {
  name: string;
  loop?: GeckolibLoopMode;
  length: number;
  override?: boolean;
  anim_time_update?: string;
  bones: Record<string, PayloadChannels>;
}

export interface BlockbenchKeyframeData {
  channel: AnimationChannel;
  time: number;
  interpolation: KeyframeInterpolation;
  easing?: string;
  easingArgs?: number[];
  dataPoint: { x: MolangValue; y: MolangValue; z: MolangValue };
}

export interface BlockbenchBoneData {
  name: string;
  keyframes: BlockbenchKeyframeData[];
}

export interface BlockbenchClipData {
  name: string;
  loop: BlockbenchLoopMode;
  length: number;
  override: boolean;
  animTimeUpdate?: string;
  bones: BlockbenchBoneData[];
}

export function geckolibLoopToBlockbench(loop: GeckolibLoopMode | undefined): BlockbenchLoopMode {
  if (loop === 'hold_on_last_frame') return 'hold';
  return loop ?? 'once';
}

export function blockbenchLoopToGeckolib(loop: BlockbenchLoopMode): GeckolibLoopMode {
  if (loop === 'hold') return 'hold_on_last_frame';
  return loop;
}

/** invertMolang(0) is -0; keep payloads and stored values on plain 0. */
function normalizeZero(value: MolangValue): MolangValue {
  return Object.is(value, -0) ? 0 : value;
}

/** Apply the channel's axis inversion to one (x, y, z) triple. Used in both
 * directions: the inversion is its own inverse. */
function invertAxes(
  channel: AnimationChannel,
  axes: { x: MolangValue; y: MolangValue; z: MolangValue },
  invert: InvertValue,
): { x: MolangValue; y: MolangValue; z: MolangValue } {
  if (channel === 'scale') return { ...axes };
  return {
    x: normalizeZero(invert(axes.x)),
    y: channel === 'rotation' ? normalizeZero(invert(axes.y)) : axes.y,
    z: axes.z,
  };
}

/** Expand a payload keyframe value to an axis triple; scalars apply to all
 * three axes, matching the GeckoLib plugin importer and GL4's own scalar
 * expansion. */
function payloadValueToAxes(value: PayloadKeyframe['value']): { x: MolangValue; y: MolangValue; z: MolangValue } {
  if (Array.isArray(value)) {
    return { x: value[0], y: value[1], z: value[2] };
  }
  return { x: value, y: value, z: value };
}

/** Map the payload clip onto plain Blockbench animation data (times in
 * seconds; values in Blockbench keyframe space). */
export function payloadClipToBlockbench(clip: PayloadClip, invert: InvertValue): BlockbenchClipData {
  const bones: BlockbenchBoneData[] = [];
  for (const [boneName, channels] of Object.entries(clip.bones)) {
    const keyframes: BlockbenchKeyframeData[] = [];
    for (const channel of ANIMATION_CHANNELS) {
      for (const keyframe of channels[channel] ?? []) {
        keyframes.push({
          channel,
          time: keyframe.time,
          interpolation: keyframe.interpolation ?? 'linear',
          ...(keyframe.easing !== undefined ? { easing: keyframe.easing } : {}),
          ...(keyframe.easingArgs !== undefined ? { easingArgs: keyframe.easingArgs } : {}),
          dataPoint: invertAxes(channel, payloadValueToAxes(keyframe.value), invert),
        });
      }
    }
    if (keyframes.length > 0) {
      bones.push({ name: boneName, keyframes });
    }
  }
  return {
    name: clip.name,
    loop: geckolibLoopToBlockbench(clip.loop),
    length: clip.length,
    override: clip.override ?? false,
    ...(clip.anim_time_update !== undefined && clip.anim_time_update !== ''
      ? { animTimeUpdate: clip.anim_time_update }
      : {}),
    bones,
  };
}

/** Collapse an axis triple back to the payload value form: a scalar when all
 * three axes are identical, else a 3-entry array. */
function axesToPayloadValue(axes: { x: MolangValue; y: MolangValue; z: MolangValue }): PayloadKeyframe['value'] {
  if (axes.x === axes.y && axes.y === axes.z) return axes.x;
  return [axes.x, axes.y, axes.z];
}

/**
 * Map plain Blockbench animation data back to the canonical payload form.
 * Normalization (the get_geckolib_animation output contract): bones sorted by
 * name; channels in rotation/position/scale order; keyframes sorted by time
 * ascending; `interpolation` omitted when linear; `easing` omitted when
 * absent (and `easingArgs` only ever emitted next to an easing); values
 * collapse to a scalar when all three axes are identical; `loop` and `length`
 * always present; `override` only when true; `anim_time_update` only when
 * non-empty; empty channels and bones without keyframes are dropped.
 */
export function blockbenchClipToPayload(clip: BlockbenchClipData, invert: InvertValue): PayloadClip {
  const bones: Record<string, PayloadChannels> = {};
  const sortedBones = [...clip.bones].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const bone of sortedBones) {
    const channels: PayloadChannels = {};
    for (const channel of ANIMATION_CHANNELS) {
      const frames = bone.keyframes
        .filter((keyframe) => keyframe.channel === channel)
        .sort((a, b) => a.time - b.time)
        .map((keyframe): PayloadKeyframe => {
          const value = axesToPayloadValue(invertAxes(channel, keyframe.dataPoint, invert));
          // GeckoLib keyframes default easing to 'linear', which GL4 treats
          // the same as absent, so omit it to keep the canonical form and
          // exporter parity (matches the interpolation:'linear' omission).
          const hasEasing = keyframe.easing !== undefined && keyframe.easing !== 'linear';
          return {
            time: keyframe.time,
            value,
            ...(keyframe.interpolation !== 'linear' ? { interpolation: keyframe.interpolation } : {}),
            ...(hasEasing ? { easing: keyframe.easing } : {}),
            ...(hasEasing && keyframe.easingArgs !== undefined && keyframe.easingArgs.length > 0
              ? { easingArgs: keyframe.easingArgs }
              : {}),
          };
        });
      if (frames.length > 0) {
        channels[channel] = frames;
      }
    }
    if (Object.keys(channels).length > 0) {
      bones[bone.name] = channels;
    }
  }
  return {
    name: clip.name,
    loop: blockbenchLoopToGeckolib(clip.loop),
    length: clip.length,
    ...(clip.override ? { override: true } : {}),
    ...(clip.animTimeUpdate !== undefined && clip.animTimeUpdate !== ''
      ? { anim_time_update: clip.animTimeUpdate }
      : {}),
    bones,
  };
}
