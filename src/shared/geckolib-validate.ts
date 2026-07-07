// GeckoLib validation rules (GL4 baseline profile).
// Pure logic shared by the plugin's validate_geckolib_file / validate_project
// handlers and the node:test fixture suites. Like protocol.ts, this module
// must stay free of Node builtins: callers read files and pass parsed JSON.
//
// Rule provenance: GeckoLib runtime source (GeckoLibCache, GeometryTree,
// AnimationProcessor across the 1.19-1.21 branches), the GeckoLib Blockbench
// plugin 4.2.5 source (compile hook, property regexes, armorTemplate.json),
// and Blockbench 5.1.4 bone-rig naming rules, surveyed 2026-07-07. No official
// schema exists; every diagnostic carries a stable geckolib_* check id so a
// rule can be traced and re-verified against a newer GeckoLib release.

import { GECKOLIB_VALIDATION_PROFILE, GECKOLIB_EASING_NAMES } from './protocol.js';

export { GECKOLIB_VALIDATION_PROFILE, GECKOLIB_EASING_NAMES };

/** GeckoLib Blockbench plugin version the rules were surveyed against. */
export const TESTED_GECKOLIB_PLUGIN_VERSION = '4.2.5';

export interface GeckolibDiagnostic {
  severity: 'error' | 'warning';
  message: string;
  check_id: string;
  target?: string;
}

/** Geometry format_version accepted by GeckoLib 4 (strict) — GeckoLib 5 also
 * accepts these, so the gl4 profile is the portable baseline. */
const GL4_FORMAT_VERSIONS = ['1.12.0'];
/** Versions GeckoLib 5 additionally accepts; flagged as errors under the gl4
 * profile with a portability note instead of a generic message. */
const GL5_ONLY_FORMAT_VERSIONS = ['1.14.0', '1.21.0'];

/** Matches the GeckoLib plugin's modid validation (also applied to the model
 * identifier because it feeds `geometry.<identifier>` and file names). */
export const GECKOLIB_NAME_PATTERN = /^[_\-.a-z0-9]+$/;

/** Blockbench's own bone-name charset in bone_rig formats. */
const BONE_NAME_PATTERN = /^[a-zA-Z0-9_]+$/;

/** Bone names the GeckoLib plugin's armor template requires. Armor models
 * must keep this rig; custom bones/cubes belong inside the armor* bones. */
export const ARMOR_TEMPLATE_BONES = [
  'bipedHead',
  'bipedBody',
  'bipedRightArm',
  'bipedLeftArm',
  'bipedRightLeg',
  'bipedLeftLeg',
  'armorHead',
  'armorBody',
  'armorRightArm',
  'armorLeftArm',
  'armorRightLeg',
  'armorLeftLeg',
  'armorRightBoot',
  'armorLeftBoot',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function error(check_id: string, message: string, target?: string): GeckolibDiagnostic {
  return target === undefined ? { severity: 'error', message, check_id } : { severity: 'error', message, check_id, target };
}

function warning(check_id: string, message: string, target?: string): GeckolibDiagnostic {
  return target === undefined
    ? { severity: 'warning', message, check_id }
    : { severity: 'warning', message, check_id, target };
}

/** Extract the bone list of `minecraft:geometry`[0], or null when the
 * envelope is too broken to inspect bones. */
function geometryBones(parsed: unknown): Array<Record<string, unknown>> | null {
  if (!isRecord(parsed)) return null;
  const geometries = parsed['minecraft:geometry'];
  if (!Array.isArray(geometries) || geometries.length === 0 || !isRecord(geometries[0])) return null;
  const bones = geometries[0].bones;
  if (!Array.isArray(bones)) return null;
  return bones.filter(isRecord);
}

/** Bone names of a geometry JSON (for animation cross-checks). Returns null
 * when the geometry envelope cannot be inspected. */
export function geometryBoneNames(parsed: unknown): string[] | null {
  const bones = geometryBones(parsed);
  if (bones === null) return null;
  return bones.map((bone) => bone.name).filter((name): name is string => typeof name === 'string');
}

/**
 * Validate a parsed Bedrock geometry JSON against the GeckoLib GL4 baseline:
 * format_version 1.12.0, a sound `minecraft:geometry`[0] envelope, unique
 * case-insensitive bone names, resolvable bone parents, and sane declared
 * texture dimensions. GeckoLib reads only the first geometry entry and stores
 * bones in a name-keyed map, so duplicates silently overwrite and a missing
 * parent throws at resource load.
 */
export function validateGeoJson(
  parsed: unknown,
  profile: typeof GECKOLIB_VALIDATION_PROFILE = GECKOLIB_VALIDATION_PROFILE,
): GeckolibDiagnostic[] {
  void profile; // Single supported profile; the parameter pins the contract for later GL5 rules.
  const diagnostics: GeckolibDiagnostic[] = [];

  if (!isRecord(parsed)) {
    diagnostics.push(error('geckolib_geometry_envelope', 'The geometry file is not a JSON object.'));
    return diagnostics;
  }

  const formatVersion = parsed.format_version;
  if (typeof formatVersion !== 'string') {
    diagnostics.push(error('geckolib_geometry_envelope', 'The geometry JSON has no string format_version.'));
  } else if (GL5_ONLY_FORMAT_VERSIONS.includes(formatVersion)) {
    diagnostics.push(
      error(
        'geckolib_format_version',
        `format_version ${formatVersion} is rejected by GeckoLib 4 (only 1.12.0 loads); GeckoLib 5 accepts it, so re-export with format_version 1.12.0 for portability.`,
      ),
    );
  } else if (!GL4_FORMAT_VERSIONS.includes(formatVersion)) {
    diagnostics.push(
      error('geckolib_format_version', `format_version ${formatVersion} is not accepted by GeckoLib (expected 1.12.0).`),
    );
  }

  const geometries = parsed['minecraft:geometry'];
  if (!Array.isArray(geometries) || geometries.length === 0) {
    diagnostics.push(error('geckolib_geometry_envelope', 'The geometry JSON has no minecraft:geometry array entries.'));
    return diagnostics;
  }
  if (geometries.length > 1) {
    diagnostics.push(
      warning('geckolib_geometry_envelope', 'GeckoLib reads only the first minecraft:geometry entry; extra entries are ignored.'),
    );
  }
  const geometry = geometries[0];
  if (!isRecord(geometry)) {
    diagnostics.push(error('geckolib_geometry_envelope', 'The first minecraft:geometry entry is not a JSON object.'));
    return diagnostics;
  }

  const description = geometry.description;
  if (isRecord(description)) {
    for (const key of ['texture_width', 'texture_height'] as const) {
      if (key in description && !isPositiveInteger(description[key])) {
        diagnostics.push(error('geckolib_texture_size', `description.${key} must be a positive integer.`, key));
      }
    }
  }

  const bones = geometry.bones;
  if (bones === undefined) {
    diagnostics.push(error('geckolib_geometry_envelope', 'The geometry has no bones field.'));
    return diagnostics;
  }
  if (!Array.isArray(bones)) {
    diagnostics.push(error('geckolib_geometry_envelope', 'The geometry bones field is not an array.'));
    return diagnostics;
  }
  if (bones.length === 0) {
    diagnostics.push(warning('geckolib_geometry_envelope', 'The geometry contains no bones.'));
    return diagnostics;
  }

  const boneRecords = bones.filter(isRecord);
  if (boneRecords.length !== bones.length) {
    diagnostics.push(error('geckolib_geometry_envelope', 'The geometry bones array contains non-object entries.'));
  }

  const seenNames = new Map<string, string>();
  const exactNames = new Set<string>();
  for (const bone of boneRecords) {
    const name = bone.name;
    if (typeof name !== 'string' || name.length === 0) {
      diagnostics.push(
        error(
          'geckolib_geometry_envelope',
          typeof name === 'string' ? 'A bone has an empty name.' : 'A bone has no string name.',
        ),
      );
      continue;
    }
    exactNames.add(name);
    const folded = name.toLowerCase();
    const existing = seenNames.get(folded);
    if (existing !== undefined) {
      diagnostics.push(
        error(
          'geckolib_duplicate_bone_names',
          `Bone name "${name}" duplicates "${existing}" (GeckoLib keys bones by name; the last one silently wins).`,
          name,
        ),
      );
    } else {
      seenNames.set(folded, name);
    }
  }
  for (const bone of boneRecords) {
    const name = typeof bone.name === 'string' && bone.name.length > 0 ? bone.name : '(unnamed)';
    const parent = bone.parent;
    if (parent === undefined) continue;
    if (typeof parent !== 'string') {
      diagnostics.push(error('geckolib_geometry_envelope', `Bone "${name}" has a non-string parent.`, name));
      continue;
    }
    if (parent === name) {
      diagnostics.push(
        error('geckolib_missing_bone_parent', `Bone "${name}" is its own parent (GeckoLib throws at resource load).`, name),
      );
    } else if (!exactNames.has(parent)) {
      diagnostics.push(
        error(
          'geckolib_missing_bone_parent',
          `Bone "${name}" references missing parent "${parent}" (GeckoLib throws at resource load).`,
          name,
        ),
      );
    }
  }

  return diagnostics;
}

// ---------------------------------------------------------------------------
// Animation content rules (no geometry required)
// ---------------------------------------------------------------------------

/** Loop values GL4's LoopType.fromJson resolves without falling back:
 * booleans, their string forms, and the two registered names. Anything else
 * silently becomes PLAY_ONCE (the registry is extensible, so unknown values
 * are a warning, not an error). */
const GL4_LOOP_VALUES = new Set<unknown>([true, false, 'loop', 'true', 'false', 'play_once', 'hold_on_last_frame']);

/** GL4's EasingType registry matches names case-insensitively and registers
 * these aliases beyond the GeckoLib plugin's authoring whitelist
 * (GECKOLIB_EASING_NAMES); unknown names silently fall back to LINEAR
 * (extensible registry, so unknown names are a warning). */
const GL4_EASING_ALIASES = ['none', 'catmullrom', 'single_step'] as const;

const ACCEPTED_EASING_NAMES_FOLDED = new Set<string>(
  [...GECKOLIB_EASING_NAMES, ...GL4_EASING_ALIASES].map((name) => name.toLowerCase()),
);

const ANIMATION_CHANNELS = ['rotation', 'position', 'scale'] as const;

/** Molang posture: expressions are never evaluated or parsed here. The only
 * shape check is parenthesis balance, because GL4's MathParser drops the whole
 * animation at load when an expression fails to compile. */
function molangParenthesesBalanced(expression: string): boolean {
  let depth = 0;
  for (const character of expression) {
    if (character === '(') depth += 1;
    else if (character === ')') {
      depth -= 1;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

function checkMolangString(expression: string, target: string, diagnostics: GeckolibDiagnostic[]): void {
  if (!molangParenthesesBalanced(expression)) {
    diagnostics.push(
      warning(
        'geckolib_animation_molang_parentheses',
        `The molang expression "${expression}" has unbalanced parentheses, which typically fails to compile in GL4's MathParser and drops the whole animation at load. Molang is not otherwise evaluated.`,
        target,
      ),
    );
  }
}

/** True for keys JavaScript treats as array indices. JSON.parse moves them
 * ahead of other keys in iteration order, so their position in the source
 * file cannot be recovered here; textual-order checks must skip them. */
function isArrayIndexKey(key: string): boolean {
  return /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < 4294967295;
}

/** Plain decimal numbers (optional sign and exponent). Number() alone would
 * also accept JS-only literal forms like hex/binary/octal that GL4's
 * Java-side number parsing rejects. */
const DECIMAL_NUMBER_PATTERN = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

function parseDecimalNumber(text: string): number | null {
  const trimmed = text.trim();
  if (!DECIMAL_NUMBER_PATTERN.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

/**
 * Validate the timestamp keys of one keyframe map and return the largest
 * valid time. GL4 coerces non-numeric keys to 0 and computes per-keyframe
 * time deltas in file order, so a negative, duplicated, or out-of-order key
 * corrupts the whole channel. Ordering is only checked across keys that
 * survive JSON.parse in source order (non-array-index keys); numeric
 * duplicates are always detected.
 */
function validateTimestampKeys(map: Record<string, unknown>, target: string, diagnostics: GeckolibDiagnostic[]): number {
  let maxTime = 0;
  let previousOrdered: number | null = null;
  const seen = new Map<number, string>();
  for (const key of Object.keys(map)) {
    const time = parseDecimalNumber(key);
    if (time === null) {
      diagnostics.push(
        error(
          'geckolib_animation_timestamp',
          `Keyframe timestamp "${key}" is not a decimal number; GL4 does not parse it as a time (non-numeric keys collapse to 0 and reorder the channel).`,
          target,
        ),
      );
      continue;
    }
    if (time < 0) {
      diagnostics.push(
        error('geckolib_animation_timestamp', `Keyframe timestamp "${key}" is negative.`, target),
      );
      continue;
    }
    const duplicate = seen.get(time);
    if (duplicate !== undefined) {
      diagnostics.push(
        error(
          'geckolib_animation_timestamp',
          `Keyframe timestamp "${key}" duplicates "${duplicate}"; keyframe times must be strictly increasing.`,
          target,
        ),
      );
      continue;
    }
    seen.set(time, key);
    if (time > maxTime) maxTime = time;
    if (!isArrayIndexKey(key)) {
      if (previousOrdered !== null && time < previousOrdered) {
        diagnostics.push(
          error(
            'geckolib_animation_timestamp',
            `Keyframe timestamp "${key}" is out of order; GL4 reads keyframes in file order and a backwards step produces a negative time delta.`,
            target,
          ),
        );
      }
      previousOrdered = time;
    }
  }
  return maxTime;
}

function isVectorEntry(value: unknown): value is number | string {
  return typeof value === 'number' || typeof value === 'string';
}

/** Validate a scalar/vector keyframe payload (a number, a molang string, or a
 * 3-entry array of number|string — GL4's getTripletObj shapes). */
function validateVectorValue(value: unknown, target: string, diagnostics: GeckolibDiagnostic[]): void {
  if (typeof value === 'number') return;
  if (typeof value === 'string') {
    checkMolangString(value, target, diagnostics);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length !== 3 || !value.every(isVectorEntry)) {
      diagnostics.push(
        error(
          'geckolib_animation_value_shape',
          'A vector keyframe value must be an array of exactly 3 numbers or molang strings; GL4 fails to load the animation otherwise.',
          target,
        ),
      );
      return;
    }
    for (const entry of value) {
      if (typeof entry === 'string') checkMolangString(entry, target, diagnostics);
    }
    return;
  }
  diagnostics.push(
    error(
      'geckolib_animation_value_shape',
      'A keyframe value must be a number, a molang string, or a 3-entry array of number|string.',
      target,
    ),
  );
}

/** True when a key is present with a value JSON serialization would keep. An
 * `undefined` value is dropped by JSON.stringify, so GL4 never sees it in the
 * loaded file; the in-memory Animator.buildFile object carries such keys
 * (e.g. easing/easingArgs on keyframes that have none), and treating them as
 * present would flag clips that export and load cleanly. */
function hasDefinedValue(record: Record<string, unknown>, key: string): boolean {
  return key in record && record[key] !== undefined;
}

function validateEasingProperties(keyframe: Record<string, unknown>, target: string, diagnostics: GeckolibDiagnostic[]): void {
  if (hasDefinedValue(keyframe, 'easing')) {
    const easing = keyframe.easing;
    if (typeof easing !== 'string' || !ACCEPTED_EASING_NAMES_FOLDED.has(easing.toLowerCase())) {
      diagnostics.push(
        warning(
          'geckolib_animation_easing_name',
          `Easing ${typeof easing === 'string' ? `"${easing}"` : 'value'} is not one of the GeckoLib plugin 4.2.5 easing names or GL4 registry aliases; GL4 silently falls back to linear.`,
          target,
        ),
      );
    }
  }
  if (hasDefinedValue(keyframe, 'easingArgs')) {
    const easingArgs = keyframe.easingArgs;
    if (!Array.isArray(easingArgs) || !easingArgs.every((entry) => typeof entry === 'number')) {
      diagnostics.push(
        error(
          'geckolib_animation_easing_args',
          'easingArgs must be an array of numbers; GL4 drops the whole animation at load otherwise.',
          target,
        ),
      );
    }
  }
}

/** Validate one keyframe entry of a bone channel: a plain vector payload or
 * the object form ({vector} from the GeckoLib plugin export, {pre}/{post}
 * from Bedrock-style files) with optional easing metadata. */
function validateKeyframeValue(value: unknown, target: string, diagnostics: GeckolibDiagnostic[]): void {
  if (isRecord(value)) {
    validateEasingProperties(value, target, diagnostics);
    if (!hasDefinedValue(value, 'vector') && !hasDefinedValue(value, 'post')) {
      diagnostics.push(
        error(
          'geckolib_animation_value_shape',
          'An object-form keyframe must carry a "vector" or "post" value; GL4 fails to load the animation otherwise.',
          target,
        ),
      );
      return;
    }
    for (const key of ['vector', 'pre', 'post'] as const) {
      if (hasDefinedValue(value, key)) validateVectorValue(value[key], target, diagnostics);
    }
    return;
  }
  validateVectorValue(value, target, diagnostics);
}

function validateEffectMap(
  animationName: string,
  container: 'sound_effects' | 'particle_effects' | 'timeline',
  value: unknown,
  diagnostics: GeckolibDiagnostic[],
): void {
  const containerTarget = `${animationName}/${container}`;
  if (!isRecord(value)) {
    diagnostics.push(
      error('geckolib_animation_effect_keyframe', `${container} must be a map of timestamps to entries.`, containerTarget),
    );
    return;
  }
  validateTimestampKeys(value, containerTarget, diagnostics);
  for (const [timestamp, entry] of Object.entries(value)) {
    const target = `${containerTarget}/${timestamp}`;
    if (container === 'timeline') {
      if (typeof entry !== 'string' && !Array.isArray(entry)) {
        diagnostics.push(
          error('geckolib_animation_effect_keyframe', 'A timeline entry must be a string or an array.', target),
        );
      }
      continue;
    }
    if (Array.isArray(entry)) {
      diagnostics.push(
        error(
          'geckolib_animation_effect_keyframe',
          `An array-valued ${container} entry (two keyframes at one timestamp) makes GL4 fail to load the whole animation.`,
          target,
        ),
      );
      continue;
    }
    if (!isRecord(entry)) {
      diagnostics.push(
        error('geckolib_animation_effect_keyframe', `A ${container} entry must be a single JSON object.`, target),
      );
      continue;
    }
    if (container === 'sound_effects' && typeof entry.effect !== 'string') {
      diagnostics.push(
        error('geckolib_animation_effect_keyframe', 'A sound_effects entry needs a string "effect" field.', target),
      );
    }
  }
}

/**
 * Validate the content of a parsed GeckoLib animation JSON against GL4 load
 * behavior: loop values, per-keyframe easing names and easingArgs, timestamp
 * keys, keyframe value shapes, animation_length consistency, and effect
 * keyframe structure. Needs no geometry; bone existence is
 * validateAnimationBoneRefs' job. Molang expressions are never evaluated.
 */
export function validateAnimationJson(parsed: unknown): GeckolibDiagnostic[] {
  const diagnostics: GeckolibDiagnostic[] = [];

  if (!isRecord(parsed) || !isRecord(parsed.animations)) {
    diagnostics.push(
      error('geckolib_animation_envelope', 'The animation file is not a JSON object with an animations map.'),
    );
    return diagnostics;
  }

  for (const [animationName, animation] of Object.entries(parsed.animations)) {
    if (!isRecord(animation)) {
      diagnostics.push(
        error('geckolib_animation_envelope', `Animation "${animationName}" is not a JSON object.`, animationName),
      );
      continue;
    }

    if ('loop' in animation && !GL4_LOOP_VALUES.has(animation.loop)) {
      diagnostics.push(
        warning(
          'geckolib_animation_loop_value',
          `Animation "${animationName}" has loop value ${JSON.stringify(animation.loop)}; GL4 only resolves true/false ("true"/"false"), "loop", "play_once", and "hold_on_last_frame", and silently plays anything else once.`,
          animationName,
        ),
      );
    }

    if (typeof animation.anim_time_update === 'string') {
      checkMolangString(animation.anim_time_update, `${animationName}/anim_time_update`, diagnostics);
    }

    let lastKeyframeTime = 0;
    const bones = animation.bones;
    if (bones !== undefined) {
      if (!isRecord(bones)) {
        diagnostics.push(
          error('geckolib_animation_envelope', `Animation "${animationName}" has a non-object bones map.`, animationName),
        );
      } else {
        for (const [boneName, bone] of Object.entries(bones)) {
          const boneTarget = `${animationName}/${boneName}`;
          if (!isRecord(bone)) {
            diagnostics.push(
              error('geckolib_animation_envelope', `Animated bone "${boneName}" is not a JSON object.`, boneTarget),
            );
            continue;
          }
          for (const channel of ANIMATION_CHANNELS) {
            if (!(channel in bone)) continue;
            const channelValue = bone[channel];
            const channelTarget = `${boneTarget}/${channel}`;
            if (isRecord(channelValue)) {
              // GL4's channel walk skips easing/easingArgs/lerp_mode keys and
              // reads a "vector" key as the keyframe value at time 0 — the
              // single-keyframe shape the GeckoLib plugin exports. Validate
              // the easing metadata once, then the remaining timestamp map.
              validateEasingProperties(channelValue, channelTarget, diagnostics);
              const timestampMap: Record<string, unknown> = {};
              for (const [key, entry] of Object.entries(channelValue)) {
                if (key === 'easing' || key === 'easingArgs' || key === 'lerp_mode') continue;
                if (entry === undefined) continue; // JSON drops undefined-valued keys.
                if (key === 'vector') {
                  validateVectorValue(entry, channelTarget, diagnostics);
                  continue;
                }
                timestampMap[key] = entry;
              }
              if (hasDefinedValue(channelValue, 'vector') && Object.keys(timestampMap).length > 0) {
                diagnostics.push(
                  error(
                    'geckolib_animation_timestamp',
                    'A channel cannot mix a single-keyframe "vector" form with timestamped keyframes; GL4 reads the vector as a keyframe at time 0 in file order, corrupting the channel.',
                    channelTarget,
                  ),
                );
              }
              const channelMax = validateTimestampKeys(timestampMap, channelTarget, diagnostics);
              if (channelMax > lastKeyframeTime) lastKeyframeTime = channelMax;
              for (const [timestamp, keyframe] of Object.entries(timestampMap)) {
                validateKeyframeValue(keyframe, `${channelTarget}/${timestamp}`, diagnostics);
              }
            } else {
              // A bare value is a single keyframe at time 0.
              validateKeyframeValue(channelValue, channelTarget, diagnostics);
            }
          }
        }
      }
    }

    // Gson coerces numeric-string primitives, so a string animation_length
    // still truncates GL4 playback like a number does.
    const declaredLength = animation.animation_length;
    const animationLength =
      typeof declaredLength === 'number'
        ? declaredLength
        : typeof declaredLength === 'string'
          ? parseDecimalNumber(declaredLength)
          : null;
    if (animationLength !== null && lastKeyframeTime > animationLength) {
      diagnostics.push(
        warning(
          'geckolib_animation_length_mismatch',
          `Animation "${animationName}" declares animation_length ${animationLength} but its last bone keyframe is at ${lastKeyframeTime}; GL4 truncates playback at animation_length.`,
          animationName,
        ),
      );
    }

    for (const container of ['sound_effects', 'particle_effects', 'timeline'] as const) {
      if (container in animation) {
        validateEffectMap(animationName, container, animation[container], diagnostics);
      }
    }
  }

  return diagnostics;
}

/**
 * Cross-check a parsed animation JSON against the geometry's bone names.
 * At runtime GeckoLib skips animation entries for bones it cannot find (or
 * crashes when the controller sets crashWhenCantFindBone), so missing
 * references are warnings, not errors.
 */
export function validateAnimationBoneRefs(animationParsed: unknown, geoParsed: unknown): GeckolibDiagnostic[] {
  const boneNames = geometryBoneNames(geoParsed);
  if (boneNames === null && isRecord(animationParsed) && isRecord(animationParsed.animations)) {
    return [
      warning(
        'geckolib_animation_envelope',
        'Bone references were not cross-checked because the geometry envelope could not be inspected.',
      ),
    ];
  }
  return validateAnimationBoneNames(animationParsed, boneNames ?? []);
}

/**
 * Cross-check a parsed animation JSON against a list of known bone names —
 * the geometry's bones for file validation, or the open project's group
 * names for validate_project (where a stale animator after a group rename or
 * delete shows up as a missing bone).
 */
export function validateAnimationBoneNames(animationParsed: unknown, boneNames: string[]): GeckolibDiagnostic[] {
  const diagnostics: GeckolibDiagnostic[] = [];

  if (!isRecord(animationParsed) || !isRecord(animationParsed.animations)) {
    diagnostics.push(
      error('geckolib_animation_envelope', 'The animation file is not a JSON object with an animations map.'),
    );
    return diagnostics;
  }

  const known = new Set(boneNames);

  for (const [animationName, animation] of Object.entries(animationParsed.animations)) {
    if (!isRecord(animation)) {
      diagnostics.push(
        error('geckolib_animation_envelope', `Animation "${animationName}" is not a JSON object.`, animationName),
      );
      continue;
    }
    const bones = animation.bones;
    if (bones === undefined) continue;
    if (!isRecord(bones)) {
      diagnostics.push(
        error('geckolib_animation_envelope', `Animation "${animationName}" has a non-object bones map.`, animationName),
      );
      continue;
    }
    for (const boneName of Object.keys(bones)) {
      if (!known.has(boneName)) {
        diagnostics.push(
          warning(
            'geckolib_animation_missing_bone',
            `Animation "${animationName}" animates bone "${boneName}" which no model bone defines; GeckoLib skips it at runtime (or crashes when crashWhenCantFindBone is set).`,
            `${animationName}/${boneName}`,
          ),
        );
      }
    }
  }

  return diagnostics;
}

export interface GeckolibProjectInput {
  boneNames: string[];
  modid?: string;
  identifier?: string;
  modelType?: string;
  /** Actual pixel size of the assigned texture, when one exists. */
  textureSize?: { width: number; height: number };
  /** Project texture resolution the UVs are laid out against. */
  declaredTextureSize?: { width: number; height: number };
  detectedPluginVersion?: string;
}

/**
 * Project-level GeckoLib rules for the currently open Blockbench project,
 * consumed by the plugin's validate_project extension. Bone-parent integrity
 * is intentionally not checked here: outliner parents are live object
 * references inside Blockbench and cannot dangle; the file-level validator
 * owns that rule.
 */
export function validateGeckolibProject(input: GeckolibProjectInput): GeckolibDiagnostic[] {
  const diagnostics: GeckolibDiagnostic[] = [];

  const seen = new Map<string, string>();
  for (const name of input.boneNames) {
    if (!BONE_NAME_PATTERN.test(name)) {
      diagnostics.push(
        error(
          'geckolib_bone_name_charset',
          `Bone name "${name}" uses characters outside a-z, A-Z, 0-9, and _ (Blockbench bone-rig naming rules).`,
          name,
        ),
      );
    }
    const folded = name.toLowerCase();
    const existing = seen.get(folded);
    if (existing !== undefined) {
      diagnostics.push(
        error(
          'geckolib_duplicate_bone_names',
          `Bone name "${name}" duplicates "${existing}" (GeckoLib keys bones by name; the last one silently wins).`,
          name,
        ),
      );
    } else {
      seen.set(folded, name);
    }
  }

  if (input.modid === undefined || input.modid.length === 0) {
    diagnostics.push(error('geckolib_modid', 'The project has no geckolib_modid; exports need a mod namespace.'));
  } else if (!GECKOLIB_NAME_PATTERN.test(input.modid)) {
    diagnostics.push(
      error('geckolib_modid', `geckolib_modid "${input.modid}" must match ${GECKOLIB_NAME_PATTERN}.`, input.modid),
    );
  }

  if (input.identifier === undefined || input.identifier.length === 0) {
    diagnostics.push(
      error('geckolib_identifier', 'The project has no model identifier; the geometry would export as geometry.unknown.'),
    );
  } else if (!GECKOLIB_NAME_PATTERN.test(input.identifier)) {
    diagnostics.push(
      error(
        'geckolib_identifier',
        `Model identifier "${input.identifier}" must match ${GECKOLIB_NAME_PATTERN}.`,
        input.identifier,
      ),
    );
  }

  if (input.modelType === 'Armor') {
    const present = new Set(input.boneNames);
    for (const required of ARMOR_TEMPLATE_BONES) {
      if (!present.has(required)) {
        diagnostics.push(
          warning(
            'geckolib_armor_template',
            `Armor models need the template bone "${required}"; GeckoLib's armor renderer binds to the template rig.`,
            required,
          ),
        );
      }
    }
  }

  if (input.textureSize !== undefined && input.declaredTextureSize !== undefined) {
    const { textureSize, declaredTextureSize } = input;
    if (textureSize.width !== declaredTextureSize.width || textureSize.height !== declaredTextureSize.height) {
      diagnostics.push(
        warning(
          'geckolib_texture_size_mismatch',
          `The assigned texture is ${textureSize.width}x${textureSize.height} but the project UV base is ${declaredTextureSize.width}x${declaredTextureSize.height}; UVs will not line up in game.`,
        ),
      );
    }
  }

  if (input.detectedPluginVersion !== undefined && input.detectedPluginVersion !== TESTED_GECKOLIB_PLUGIN_VERSION) {
    diagnostics.push(
      warning(
        'geckolib_plugin_version_untested',
        `The installed GeckoLib plugin is ${input.detectedPluginVersion}; these checks were verified against ${TESTED_GECKOLIB_PLUGIN_VERSION} and may not match that version's behavior.`,
      ),
    );
  }

  return diagnostics;
}
