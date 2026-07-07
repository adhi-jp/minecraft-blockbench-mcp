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

import { GECKOLIB_VALIDATION_PROFILE } from './protocol.js';

export { GECKOLIB_VALIDATION_PROFILE };

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

/**
 * Cross-check a parsed animation JSON against the geometry's bone names.
 * At runtime GeckoLib skips animation entries for bones it cannot find (or
 * crashes when the controller sets crashWhenCantFindBone), so missing
 * references are warnings, not errors.
 */
export function validateAnimationBoneRefs(animationParsed: unknown, geoParsed: unknown): GeckolibDiagnostic[] {
  const diagnostics: GeckolibDiagnostic[] = [];

  if (!isRecord(animationParsed) || !isRecord(animationParsed.animations)) {
    diagnostics.push(
      error('geckolib_animation_envelope', 'The animation file is not a JSON object with an animations map.'),
    );
    return diagnostics;
  }

  const boneNames = geometryBoneNames(geoParsed);
  if (boneNames === null) {
    diagnostics.push(
      warning(
        'geckolib_animation_envelope',
        'Bone references were not cross-checked because the geometry envelope could not be inspected.',
      ),
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
            `Animation "${animationName}" animates bone "${boneName}" which the geometry does not define; GeckoLib skips it at runtime (or crashes when crashWhenCantFindBone is set).`,
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
