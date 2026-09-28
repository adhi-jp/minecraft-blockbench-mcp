// GeckoLib command handlers. Every command requires the third-party GeckoLib
// plugin ("GeckoLib Models & Animations", id `geckolib`) at call time: it owns
// the geckolib_model format, the Bedrock-codec compile hook that pins
// format_version to 1.12.0, and the Animator.buildFile patch that emits
// geckolib_format_version 2 with GeckoLib's {vector, easing} keyframes.
import { GECKOLIB_VALIDATION_PROFILE, GECKOLIB_EASING_NAMES } from '../../shared/protocol.js';
import {
  validateGeoJson,
  validateAnimationJson,
  validateAnimationBoneRefs,
  type GeckolibDiagnostic,
} from '../../shared/geckolib-validate.js';
import { CommandError, type PluginSession } from '../session.js';
import type { ScopeManager } from '../scope-manager.js';
import { readFileCommand, resolveSingleWriteDestination, writeSingleFile } from '../file-commands.js';
import {
  payloadClipToBlockbench,
  blockbenchClipToPayload,
  ANIMATION_CHANNELS,
  type AnimationChannel,
  type BlockbenchBoneData,
  type BlockbenchClipData,
  type BlockbenchKeyframeData,
  type BlockbenchLoopMode,
  type InvertValue,
  type KeyframeInterpolation,
  type MolangValue,
  type PayloadClip,
} from '../geckolib-animation-mapping.js';
import {
  register,
  projectCounts,
  requireGeckolibPlugin,
  requireGeckolibFormat,
  reloadProjectTextures,
  trackMcpProject,
  TEXTURE_SETTLE_TIMEOUT_MS,
} from './helpers.js';
import { captureScreenshotFromPreview, enqueueScreenshot } from './screenshot-helper.js';

// ---------------------------------------------------------------------------
// Blockbench animation surface (untyped at runtime; these are the shapes the
// handlers rely on, verified against Blockbench 5.1.4)
// ---------------------------------------------------------------------------

interface KeyframeLike {
  channel: string;
  time: number;
  interpolation?: string;
  easing?: string;
  easingArgs?: number[];
  data_points: Array<{ x?: unknown; y?: unknown; z?: unknown }>;
}

interface BoneAnimatorLike {
  name?: string;
  keyframes?: KeyframeLike[];
  addKeyframe(data: Record<string, unknown>): unknown;
}

interface AnimationLike {
  name: string;
  loop: BlockbenchLoopMode;
  length: number;
  override?: boolean;
  anim_time_update?: string;
  selected?: boolean;
  playing?: boolean;
  animators: Record<string, unknown>;
  add(undo: boolean): AnimationLike;
  remove(undo: boolean, removeFromFile?: boolean): unknown;
  getBoneAnimator(group: Group): BoneAnimatorLike;
  select(): unknown;
}

/** Blockbench renames its Animation global (it shadows the DOM's); handlers
 * reach it through the Blockbench namespace to stay type-safe. */
type AnimationClassLike = {
  all: AnimationLike[];
  selected?: AnimationLike | null;
  new (data: Record<string, unknown>): AnimationLike;
};

function blockbenchAnimationClass(): AnimationClassLike {
  const blockbench = Blockbench as unknown as {
    Animation?: { all?: AnimationLike[] } & (new (data: Record<string, unknown>) => AnimationLike);
  };
  const animationClass = blockbench.Animation;
  if (animationClass === undefined || !Array.isArray(animationClass.all)) {
    throw new CommandError('E_BLOCKBENCH_ERROR', 'This Blockbench build does not expose the Animation API.');
  }
  return animationClass as AnimationClassLike;
}

function projectAnimationNames(): string[] {
  const blockbench = Blockbench as unknown as { Animation?: { all?: Array<{ name: string }> } };
  const animations = blockbench.Animation?.all ?? [];
  return animations.map((animation) => animation.name);
}

/** Blockbench's window-global molang inverter, which the GeckoLib plugin's
 * own importer and exporter use for the axis convention. */
function requireInvertMolang(): InvertValue {
  const invert = (globalThis as Record<string, unknown>).invertMolang;
  if (typeof invert !== 'function') {
    throw new CommandError(
      'E_BLOCKBENCH_ERROR',
      'This Blockbench build does not expose invertMolang; animation values cannot be mapped.',
    );
  }
  return invert as InvertValue;
}

/** Undo surface with the animations aspect (present at runtime; the generated
 * Blockbench types cover only a subset of the aspects). */
function undoSystem(): {
  initEdit(aspects: unknown): void;
  finishEdit(action: string, aspects?: unknown): void;
  cancelEdit(revertChanges: boolean): void;
} {
  return Undo as unknown as {
    initEdit(aspects: unknown): void;
    finishEdit(action: string, aspects?: unknown): void;
    cancelEdit(revertChanges: boolean): void;
  };
}

function findAnimationByName(name: string): AnimationLike | null {
  return blockbenchAnimationClass().all.find((animation) => animation.name === name) ?? null;
}


interface TimelineLike {
  time: number;
  playing?: boolean;
  setTime(seconds: number, editing?: boolean): void;
}

interface AnimatorLike {
  preview(inLoop?: boolean): void;
  showDefaultPose?(noMatrixUpdate?: boolean): void;
}

interface EffectMuteSnapshot {
  muted: Record<string, unknown>;
  values: Record<string, unknown>;
}

interface AnimationStateSnapshot {
  animationClass: AnimationClassLike;
  selectedAnimation: AnimationLike | null;
  selectedFlags: Array<[AnimationLike, boolean | undefined]>;
  playingFlags: Array<[AnimationLike, boolean | undefined]>;
  timelineTime: number;
  timelinePlaying: boolean | undefined;
  effectMutes: EffectMuteSnapshot[];
}

function timelineApi(): TimelineLike {
  const timeline = (globalThis as Record<string, unknown>).Timeline as TimelineLike | undefined;
  if (timeline === undefined || typeof timeline.setTime !== 'function' || typeof timeline.time !== 'number') {
    throw new CommandError('E_BLOCKBENCH_ERROR', 'This Blockbench build does not expose the Timeline API.');
  }
  return timeline;
}

function animatorApi(): AnimatorLike {
  const animator = (globalThis as Record<string, unknown>).Animator as AnimatorLike | undefined;
  if (animator === undefined || typeof animator.preview !== 'function') {
    throw new CommandError('E_BLOCKBENCH_ERROR', 'This Blockbench build does not expose the Animator preview API.');
  }
  return animator;
}

function effectMuteSnapshots(animations: AnimationLike[]): EffectMuteSnapshot[] {
  const snapshots: EffectMuteSnapshot[] = [];
  for (const animation of animations) {
    for (const animator of Object.values(animation.animators)) {
      if (animator === null || typeof animator !== 'object') continue;
      const muted = (animator as { muted?: unknown }).muted;
      if (muted === null || typeof muted !== 'object') continue;
      const mutedRecord = muted as Record<string, unknown>;
      const values: Record<string, unknown> = {};
      for (const channel of ['particle', 'timeline', 'sound']) {
        values[channel] = mutedRecord[channel];
      }
      snapshots.push({ muted: mutedRecord, values });
    }
  }
  return snapshots;
}

function setEffectMutes(snapshots: EffectMuteSnapshot[], muted: boolean): void {
  for (const snapshot of snapshots) {
    snapshot.muted.particle = muted;
    snapshot.muted.timeline = muted;
    snapshot.muted.sound = muted;
  }
}

function restoreEffectMutes(snapshots: EffectMuteSnapshot[]): void {
  for (const snapshot of snapshots) {
    for (const [channel, value] of Object.entries(snapshot.values)) {
      if (value === undefined) {
        delete snapshot.muted[channel];
      } else {
        snapshot.muted[channel] = value;
      }
    }
  }
}

function snapshotAnimationState(animationClass: AnimationClassLike, timeline: TimelineLike): AnimationStateSnapshot {
  const animations = animationClass.all;
  const selectedAnimation = animationClass.selected ?? animations.find((animation) => animation.selected === true) ?? null;
  return {
    animationClass,
    selectedAnimation,
    selectedFlags: animations.map((animation) => [animation, animation.selected]),
    playingFlags: animations.map((animation) => [animation, animation.playing]),
    timelineTime: timeline.time,
    timelinePlaying: timeline.playing,
    effectMutes: effectMuteSnapshots(animations),
  };
}

function restoreAnimationState(snapshot: AnimationStateSnapshot, timeline: TimelineLike, animator: AnimatorLike): void {
  let restoreError: unknown;
  try {
    for (const [animation, selected] of snapshot.selectedFlags) {
      if (selected === undefined) {
        delete animation.selected;
      } else {
        animation.selected = selected;
      }
    }
    for (const [animation, playing] of snapshot.playingFlags) {
      if (playing === undefined) {
        delete animation.playing;
      } else {
        animation.playing = playing;
      }
    }
    snapshot.animationClass.selected = snapshot.selectedAnimation;
    timeline.playing = snapshot.timelinePlaying;
    timeline.setTime(snapshot.timelineTime);
    setEffectMutes(snapshot.effectMutes, true);
    if (snapshot.playingFlags.some(([, playing]) => playing === true)) {
      animator.preview(false);
    } else if (typeof animator.showDefaultPose === 'function') {
      animator.showDefaultPose(true);
    } else {
      animator.preview(false);
    }
  } catch (error) {
    restoreError = error;
  } finally {
    restoreEffectMutes(snapshot.effectMutes);
  }
  if (restoreError !== undefined) {
    throw new CommandError('E_BLOCKBENCH_ERROR', 'Failed to restore the previous animation preview state.', {
      reason: restoreError instanceof Error ? restoreError.message : String(restoreError),
    });
  }
}

function renderedAnimationTime(animation: AnimationLike, requestedTime: number): number {
  const length = Math.max(0, Number.isFinite(animation.length) ? animation.length : 0);
  if (animation.loop === 'loop') {
    return length > 0 ? requestedTime % length : 0;
  }
  if (animation.loop === 'hold') {
    return Math.min(requestedTime, length);
  }
  if (requestedTime > length) {
    throw new CommandError(
      'E_INVALID_PARAMS',
      `Animation "${animation.name}" uses once loop mode and cannot be captured past its ${length}s length.`,
      { animation: animation.name, time: requestedTime, length },
    );
  }
  return requestedTime;
}

/** Resolve payload bone names against current groups, case-insensitively like
 * the GeckoLib plugin's importer. Unknown and ambiguous names abort the
 * command before any project mutation. */
function resolvePayloadBones(boneNames: string[]): Map<string, Group> {
  const unknownBones: string[] = [];
  const ambiguousBones: string[] = [];
  const resolved = new Map<string, Group>();
  // Two payload bone names that fold to the same group (e.g. "body"/"Body")
  // would both target one animator and silently merge keyframes, defeating
  // the per-channel duplicate-time check; reject the collision.
  const groupToPayloadNames = new Map<string, string[]>();
  for (const boneName of boneNames) {
    const folded = boneName.toLowerCase();
    const matches = Group.all.filter((group) => group.name.toLowerCase() === folded);
    if (matches.length === 0) {
      unknownBones.push(boneName);
    } else if (matches.length > 1) {
      ambiguousBones.push(boneName);
    } else {
      resolved.set(boneName, matches[0]);
      const names = groupToPayloadNames.get(matches[0].uuid) ?? [];
      names.push(boneName);
      groupToPayloadNames.set(matches[0].uuid, names);
    }
  }
  const collidingBones = [...groupToPayloadNames.values()].filter((names) => names.length > 1).flat();
  if (unknownBones.length > 0 || ambiguousBones.length > 0 || collidingBones.length > 0) {
    const parts: string[] = [];
    if (unknownBones.length > 0) parts.push(`unknown bones: ${unknownBones.join(', ')}`);
    if (ambiguousBones.length > 0) {
      parts.push(`bone names matching more than one group: ${ambiguousBones.join(', ')}`);
    }
    if (collidingBones.length > 0) {
      parts.push(`multiple bone names resolving to one group: ${collidingBones.join(', ')}`);
    }
    throw new CommandError('E_INVALID_PARAMS', `The payload references ${parts.join('; ')}.`, {
      unknown_bones: unknownBones,
      ambiguous_bones: ambiguousBones,
      colliding_bones: collidingBones,
    });
  }
  return resolved;
}

const numericStringPattern = /^-?\d+(\.\d+)?$/;

/** Keyframe axis values come back from Blockbench as numbers or molang-typed
 * strings; canonicalize plain numeric strings to numbers. */
function axisValue(value: unknown): MolangValue {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    return numericStringPattern.test(value.trim()) ? Number(value) : value;
  }
  return 0;
}

function isAnimationChannel(channel: string): channel is AnimationChannel {
  return (ANIMATION_CHANNELS as readonly string[]).includes(channel);
}

const PAYLOAD_INTERPOLATIONS: KeyframeInterpolation[] = ['linear', 'catmullrom', 'step'];

/** Interpolation the get payload can represent; a UI-authored keyframe using
 * a mode outside the authoring scope (e.g. bezier) reads back as linear so
 * the returned clip stays re-upsertable (bezier is a dropped construct). */
function payloadInterpolation(value: string | undefined): KeyframeInterpolation {
  return value !== undefined && (PAYLOAD_INTERPOLATIONS as string[]).includes(value)
    ? (value as KeyframeInterpolation)
    : 'linear';
}

/** Easing the get payload can represent (the closed plugin whitelist); an
 * out-of-whitelist easing is dropped so the returned clip stays re-upsertable
 * (GL4 treats an unknown or absent easing as linear anyway). */
function payloadEasing(value: unknown): string | undefined {
  return typeof value === 'string' && (GECKOLIB_EASING_NAMES as readonly string[]).includes(value) ? value : undefined;
}

/** Snapshot a live Blockbench animation into plain mapping data. Only bone
 * rotation/position/scale keyframes are captured; effect keyframes have no
 * payload representation. */
function snapshotBlockbenchClip(animation: AnimationLike): BlockbenchClipData {
  const bones: BlockbenchBoneData[] = [];
  for (const animator of Object.values(animation.animators)) {
    if (animator === null || typeof animator !== 'object') continue;
    const boneAnimator = animator as BoneAnimatorLike;
    if (typeof boneAnimator.name !== 'string' || !Array.isArray(boneAnimator.keyframes)) continue;
    const keyframes: BlockbenchKeyframeData[] = [];
    for (const keyframe of boneAnimator.keyframes) {
      if (!isAnimationChannel(keyframe.channel)) continue;
      // The authoring payload has one value per keyframe, so only the first
      // data point is read; a second data point (a GL4 pre/post
      // discontinuity, not authorable here) is intentionally not surfaced.
      const dataPoint = keyframe.data_points[0];
      if (dataPoint === undefined) continue;
      const easing = payloadEasing(keyframe.easing);
      keyframes.push({
        channel: keyframe.channel,
        time: keyframe.time,
        interpolation: payloadInterpolation(keyframe.interpolation),
        ...(easing !== undefined ? { easing } : {}),
        ...(easing !== undefined && Array.isArray(keyframe.easingArgs) ? { easingArgs: keyframe.easingArgs } : {}),
        dataPoint: { x: axisValue(dataPoint.x), y: axisValue(dataPoint.y), z: axisValue(dataPoint.z) },
      });
    }
    if (keyframes.length > 0) {
      bones.push({ name: boneAnimator.name, keyframes });
    }
  }
  return {
    name: animation.name,
    loop: animation.loop,
    length: animation.length,
    override: animation.override === true,
    ...(typeof animation.anim_time_update === 'string' && animation.anim_time_update !== ''
      ? { animTimeUpdate: animation.anim_time_update }
      : {}),
    bones,
  };
}

/** Serialize with Blockbench's compileJSON when available (it understands
 * Blockbench's custom serialization markers); plain JSON otherwise (tests). */
function serializeBlockbenchJson(value: unknown): string {
  const stringify = (globalThis as Record<string, unknown>).compileJSON as ((value: unknown) => string) | undefined;
  return stringify !== undefined ? stringify(value) : JSON.stringify(value, null, '\t');
}

function readScopedJson(scope: ScopeManager, path: string): { parsed: unknown; normalizedPath: string } {
  const file = readFileCommand(scope, { path, encoding: 'utf8' });
  try {
    return { parsed: JSON.parse(file.content), normalizedPath: file.path };
  } catch {
    throw new CommandError('E_INVALID_PARAMS', 'The file is not valid JSON.', { path: file.path });
  }
}

export interface GeckolibCommandOptions {
  /** Bound for the post-open texture reload wait. */
  textureSettleTimeoutMs?: number;
}

export function registerGeckolibCommands(
  session: PluginSession,
  scope: ScopeManager,
  options: GeckolibCommandOptions = {},
): void {
  const textureSettleTimeoutMs = options.textureSettleTimeoutMs ?? TEXTURE_SETTLE_TIMEOUT_MS;
  register(session, 'create_geckolib_project', (params) => {
    requireGeckolibPlugin();
    // newProject opens a separate tab, so an unsaved project elsewhere needs
    // no guard; `force` is accepted and ignored for compatibility.
    const created = newProject(Formats.geckolib_model);
    if (!created) {
      throw new CommandError('E_BLOCKBENCH_ERROR', 'Blockbench refused to create a new geckolib_model project.');
    }
    trackMcpProject();
    const project = Project as unknown as Record<string, unknown>;
    project.geckolib_modid = params.modid;
    project.geckolib_model_type = params.model_type;
    project.model_identifier = params.identifier;
    if (params.name !== undefined && Project) {
      Project.name = params.name;
    }
    return {
      created: true,
      format: 'geckolib_model',
      name: params.name,
      modid: params.modid,
      model_type: params.model_type,
      identifier: params.identifier,
    };
  });

  register(session, 'open_geckolib_model', async (params) => {
    requireGeckolibPlugin();
    const { parsed, normalizedPath } = readScopedJson(scope, params.path);
    const meta = (parsed as { meta?: { model_format?: unknown } } | null)?.meta;
    const modelFormat = typeof meta?.model_format === 'string' ? meta.model_format : undefined;
    if (modelFormat !== 'geckolib_model') {
      throw new CommandError(
        'E_FORMAT_UNSUPPORTED',
        `The .bbmodel file's format is "${modelFormat ?? 'unknown'}"; this command opens geckolib_model projects only.`,
        { path: normalizedPath, model_format: modelFormat },
      );
    }
    const created = newProject(Formats.geckolib_model);
    if (!created) {
      throw new CommandError('E_BLOCKBENCH_ERROR', 'Blockbench refused to create a project for the opened model.');
    }
    trackMcpProject();
    try {
      Codecs.project.parse!(parsed, normalizedPath);
    } catch (error) {
      throw new CommandError('E_BLOCKBENCH_ERROR', 'The project codec failed to parse the .bbmodel file.', {
        path: normalizedPath,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    Canvas.updateAll();
    // The texture wait yields, and the user may switch tabs meanwhile; the
    // result describes the opened project as it was before the wait.
    const project = Project;
    const name = project ? project.name : undefined;
    const counts = projectCounts();
    const textures = await reloadProjectTextures(textureSettleTimeoutMs);
    return {
      opened: true,
      format: 'geckolib_model',
      name,
      path: normalizedPath,
      counts,
      textures,
    };
  });

  register(session, 'export_geckolib_model', (params) => {
    requireGeckolibPlugin();
    requireGeckolibFormat();
    let content: string;
    try {
      // The GeckoLib compile hook runs inside the Bedrock codec's compile
      // event; on the surveyed versions compile() returns the finished string
      // (format_version pinned to 1.12.0, item_display_transforms stripped).
      // Normalize an object return instead of coercing it to "[object Object]".
      const compiled = Codecs.bedrock.compile() as unknown;
      content = typeof compiled === 'string' ? compiled : serializeBlockbenchJson(compiled);
    } catch (error) {
      throw new CommandError('E_BLOCKBENCH_ERROR', 'The bedrock codec failed to compile the model.', {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    return writeSingleFile(scope, params.path, content, params.overwrite);
  });

  register(session, 'export_geckolib_animations', (params) => {
    requireGeckolibPlugin();
    requireGeckolibFormat();
    const names = projectAnimationNames();
    if (names.length === 0) {
      throw new CommandError('E_NOT_FOUND', 'The project contains no animations; nothing to export.');
    }
    let content: string;
    try {
      // The GeckoLib patch on Animator.buildFile dereferences the name filter
      // unconditionally, so the filter array must always be passed. buildFile
      // is deprecated (absent from the generated types) but is the surface the
      // GeckoLib plugin patches, so it must be called rather than the codec.
      const animator = Animator as unknown as {
        buildFile(pathFilter: string | undefined, nameFilter: string[]): unknown;
      };
      content = serializeBlockbenchJson(animator.buildFile(undefined, names));
    } catch (error) {
      throw new CommandError('E_BLOCKBENCH_ERROR', 'The animation codec failed to compile the animations.', {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    return writeSingleFile(scope, params.path, content, params.overwrite);
  });

  register(session, 'validate_geckolib_file', (params) => {
    requireGeckolibPlugin();
    // The params schema guarantees at least one path is present.
    const diagnostics: GeckolibDiagnostic[] = [];
    const geo = params.geo_path !== undefined ? readScopedJson(scope, params.geo_path) : null;
    if (geo !== null) {
      diagnostics.push(...validateGeoJson(geo.parsed));
    }
    if (params.animation_path !== undefined) {
      const animation = readScopedJson(scope, params.animation_path);
      const contentDiagnostics = validateAnimationJson(animation.parsed);
      diagnostics.push(...contentDiagnostics);
      if (geo !== null) {
        // The content pass and the bone cross-check report broken animation
        // envelopes identically; drop only cross-check diagnostics that
        // duplicate a content diagnostic, never within-pass repeats.
        const diagnosticKey = (diagnostic: GeckolibDiagnostic): string =>
          `${diagnostic.severity}|${diagnostic.check_id}|${diagnostic.target ?? ''}|${diagnostic.message}`;
        const reported = new Set(contentDiagnostics.map(diagnosticKey));
        diagnostics.push(
          ...validateAnimationBoneRefs(animation.parsed, geo.parsed).filter(
            (diagnostic) => !reported.has(diagnosticKey(diagnostic)),
          ),
        );
      }
    }
    return { diagnostics, profile: GECKOLIB_VALIDATION_PROFILE };
  });

  register(session, 'upsert_geckolib_animation', (params) => {
    requireGeckolibPlugin();
    requireGeckolibFormat();
    const { replace, ...clip } = params;
    const invert = requireInvertMolang();
    const animationClass = blockbenchAnimationClass();
    const undo = undoSystem();

    // Everything that can fail is resolved before the first mutation.
    const resolvedGroups = resolvePayloadBones(Object.keys(clip.bones));
    const mapped = payloadClipToBlockbench(clip as PayloadClip, invert);
    const existing = findAnimationByName(clip.name);
    if (existing !== null && replace !== true) {
      throw new CommandError(
        'E_FILE_EXISTS',
        `An animation named "${clip.name}" already exists. Set replace:true to overwrite it.`,
        { animation: clip.name },
      );
    }

    const wasSelected = existing !== null && existing.selected === true;
    undo.initEdit({ animations: existing !== null ? [existing] : [] });
    let created: AnimationLike | null = null;
    try {
      // Remove-before-add: Animation.add always runs createUniqueName, so
      // adding first would silently rename the new clip.
      if (existing !== null) existing.remove(false);
      created = new animationClass({
        name: mapped.name,
        loop: mapped.loop,
        length: mapped.length,
        override: mapped.override,
        ...(mapped.animTimeUpdate !== undefined ? { anim_time_update: mapped.animTimeUpdate } : {}),
      }).add(false);
      if (created.name !== clip.name) {
        throw new Error(`Blockbench renamed the animation to "${created.name}" while adding it.`);
      }
      for (const bone of mapped.bones) {
        const group = resolvedGroups.get(bone.name);
        if (group === undefined) continue;
        const animator = created.getBoneAnimator(group);
        for (const keyframe of bone.keyframes) {
          const added = animator.addKeyframe({
            time: keyframe.time,
            channel: keyframe.channel,
            interpolation: keyframe.interpolation,
            ...(keyframe.easing !== undefined ? { easing: keyframe.easing } : {}),
            ...(keyframe.easingArgs !== undefined ? { easingArgs: keyframe.easingArgs } : {}),
            data_points: [keyframe.dataPoint],
          });
          if (added === undefined) {
            throw new Error(`Blockbench rejected a ${keyframe.channel} keyframe at ${keyframe.time}s.`);
          }
        }
      }
      undo.finishEdit('Upsert GeckoLib animation', { animations: [created] });
    } catch (error) {
      // cancelEdit(true) restores the animations captured by initEdit but
      // does not remove clips created during the edit, so drop the new clip
      // explicitly before reverting.
      try {
        created?.remove(false);
      } catch {
        // The revert below still restores the captured state.
      }
      undo.cancelEdit(true);
      throw new CommandError(
        'E_BLOCKBENCH_ERROR',
        'Blockbench failed to apply the animation; the previous animation state was restored.',
        { animation: clip.name, reason: error instanceof Error ? error.message : String(error) },
      );
    }
    if (wasSelected) {
      // Re-selecting the replacement clip is cosmetic UI restoration; the
      // animation is already committed, so a failure here must not turn a
      // successful upsert into an error.
      try {
        created.select();
      } catch {
        // Leaving the selection unchanged is acceptable.
      }
    }
    return { name: clip.name, status: existing !== null ? ('replaced' as const) : ('created' as const) };
  });


  register(session, 'capture_geckolib_animation_frame', (params) => {
    // Call-time guards keep an already-invalid request from waiting behind the
    // screenshot queue, while the queued critical section rechecks current
    // state before touching global animation/timeline objects.
    requireGeckolibPlugin();
    requireGeckolibFormat();
    return enqueueScreenshot(async () => {
      requireGeckolibPlugin();
      requireGeckolibFormat();
      // The output preflight runs in the queue so a file an earlier queued
      // capture wrote counts as a conflict before this one poses or renders.
      const outputPath = params.output_path === undefined
        ? undefined
        : resolveSingleWriteDestination(scope, params.output_path, params.overwrite);
      const animationClass = blockbenchAnimationClass();
      const timeline = timelineApi();
      const animator = animatorApi();
      const animation = findAnimationByName(params.animation);
      if (animation === null) {
        throw new CommandError('E_NOT_FOUND', `No animation named "${params.animation}" exists in the project.`, {
          animation: params.animation,
        });
      }
      if (timeline.playing === true) {
        throw new CommandError(
          'E_BLOCKBENCH_ERROR',
          'Timeline playback is active; stop playback before capturing a still animation frame.',
        );
      }
      const renderedTime = renderedAnimationTime(animation, params.time);
      const snapshot = snapshotAnimationState(animationClass, timeline);
      try {
        for (const candidate of animationClass.all) {
          candidate.playing = candidate === animation;
          candidate.selected = candidate === animation;
        }
        animationClass.selected = animation;
        timeline.setTime(renderedTime);
        setEffectMutes(snapshot.effectMutes, true);
        animator.preview(false);
        const screenshot = await captureScreenshotFromPreview({ ...params, output_path: outputPath }, scope);
        return {
          ...screenshot,
          animation: params.animation,
          time: params.time,
          rendered_time: renderedTime,
        };
      } finally {
        restoreAnimationState(snapshot, timeline, animator);
      }
    });
  });

  register(session, 'delete_geckolib_animation', (params) => {
    requireGeckolibPlugin();
    requireGeckolibFormat();
    const animation = findAnimationByName(params.name);
    if (animation === null) {
      throw new CommandError('E_NOT_FOUND', `No animation named "${params.name}" exists in the project.`, {
        animation: params.name,
      });
    }
    const undo = undoSystem();
    undo.initEdit({ animations: [animation] });
    try {
      animation.remove(false);
    } catch (error) {
      undo.cancelEdit(true);
      throw new CommandError('E_BLOCKBENCH_ERROR', 'Blockbench failed to delete the animation.', {
        animation: params.name,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    undo.finishEdit('Delete GeckoLib animation', { animations: [] });
    return { deleted: true as const };
  });

  register(session, 'get_geckolib_animation', (params) => {
    requireGeckolibPlugin();
    requireGeckolibFormat();
    const animation = findAnimationByName(params.name);
    if (animation === null) {
      throw new CommandError('E_NOT_FOUND', `No animation named "${params.name}" exists in the project.`, {
        animation: params.name,
      });
    }
    return blockbenchClipToPayload(snapshotBlockbenchClip(animation), requireInvertMolang());
  });
}
