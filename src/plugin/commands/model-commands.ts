// Blockbench command handlers: every Blockbench mutation or inspection the
// adapter can request runs here, inside the plugin, through Blockbench APIs.
// Mutations create undo entries and refresh the viewport.
import { DEFAULTS } from '../../shared/protocol.js';
import {
  validateGeckolibProject,
  validateAnimationJson,
  validateAnimationBoneNames,
  type GeckolibDiagnostic,
} from '../../shared/geckolib-validate.js';
import { blockbenchLoopToGeckolib, type BlockbenchLoopMode } from '../geckolib-animation-mapping.js';
import { CommandError, type PluginSession } from '../session.js';
import type { ScopeManager } from '../scope-manager.js';
import { readFileCommand, writeFilesCommand, writeSingleFile, resolveForIo } from '../file-commands.js';
import { register, requireProject, projectCounts, detectGeckolibPluginVersion } from './helpers.js';

/** Blockbench renames its Animation global (it shadows the DOM's); read the
 * project's animation list through the Blockbench namespace. */
function projectAnimations(): Array<{ name: string; loop: BlockbenchLoopMode; length: number }> {
  const blockbench = Blockbench as unknown as {
    Animation?: { all?: Array<{ name: string; loop: BlockbenchLoopMode; length: number }> };
  };
  return blockbench.Animation?.all ?? [];
}

function requireJavaBlockFormat(): void {
  requireProject();
  if (Format?.id !== 'java_block') {
    throw new CommandError(
      'E_FORMAT_UNSUPPORTED',
      `The current project format is "${Format?.id ?? 'unknown'}"; this command needs the java_block format.`,
    );
  }
}

function findCube(uuid: string): Cube {
  const cube = Cube.all.find((candidate) => candidate.uuid === uuid);
  if (cube === undefined) {
    throw new CommandError('E_NOT_FOUND', 'No cube exists with the given UUID.', { uuid });
  }
  return cube;
}

function findGroup(uuid: string): Group {
  const group = Group.all.find((candidate) => candidate.uuid === uuid);
  if (group === undefined) {
    throw new CommandError('E_NOT_FOUND', 'No group exists with the given UUID.', { uuid });
  }
  return group;
}

type RotationParam = { axis: 'x' | 'y' | 'z'; angle: number; origin?: [number, number, number] | undefined };

function rotationToVector(rotation: RotationParam): [number, number, number] {
  switch (rotation.axis) {
    case 'x':
      return [rotation.angle, 0, 0];
    case 'y':
      return [0, rotation.angle, 0];
    default:
      return [0, 0, rotation.angle];
  }
}

export function registerModelCommands(session: PluginSession, scope: ScopeManager): void {
  register(session, 'get_project_state', (params) => {
    if (!Project) return { open: false };
    const includeObjects = params.include_objects ?? true;
    const animations = projectAnimations();
    const base = {
      open: true,
      format: Format?.id,
      name: Project.name,
      saved: Project.saved,
      counts: projectCounts(),
      ...(animations.length > 0
        ? {
            animations: animations.map((animation) => ({
              name: animation.name,
              loop: blockbenchLoopToGeckolib(animation.loop),
              length: animation.length,
            })),
          }
        : {}),
    };
    if (!includeObjects) return base;
    return {
      ...base,
      cubes: Cube.all.map((cube) => ({ uuid: cube.uuid, name: cube.name })),
      groups: Group.all.map((group) => ({ uuid: group.uuid, name: group.name })),
      textures: Texture.all.map((texture) => ({ uuid: texture.uuid, name: texture.name, id: texture.id })),
    };
  });

  register(session, 'create_project', (params) => {
    if (Project && !Project.saved && params.force !== true) {
      throw new CommandError(
        'E_INVALID_PARAMS',
        'An unsaved project is already open in another tab. Set force:true to open a new project tab anyway.',
      );
    }
    const created = newProject(Formats.java_block);
    if (!created) {
      throw new CommandError('E_BLOCKBENCH_ERROR', 'Blockbench refused to create a new java_block project.');
    }
    if (params.name !== undefined && Project) {
      Project.name = params.name;
    }
    return { created: true, format: 'java_block', name: params.name };
  });

  register(session, 'open_model', (params) => {
    if (Project && !Project.saved && params.force !== true) {
      throw new CommandError(
        'E_INVALID_PARAMS',
        'An unsaved project is already open in another tab. Set force:true to open the model in a new tab anyway.',
      );
    }
    const file = readFileCommand(scope, { path: params.path, encoding: 'utf8' });
    let model: unknown;
    try {
      model = JSON.parse(file.content);
    } catch {
      throw new CommandError('E_INVALID_PARAMS', 'The file is not valid JSON.', { path: file.path });
    }
    // The java_block codec does not throw on non-model JSON; it shows a
    // dialog and returns. Reject obviously wrong input before opening a tab.
    const looksLikeModel =
      model !== null &&
      typeof model === 'object' &&
      ['elements', 'parent', 'textures', 'display'].some((key) => key in (model as Record<string, unknown>));
    if (!looksLikeModel) {
      throw new CommandError(
        'E_INVALID_PARAMS',
        'The file is valid JSON but does not look like a Java block/item model (no elements, parent, textures, or display key).',
        { path: file.path },
      );
    }
    const created = newProject(Formats.java_block);
    if (!created) {
      throw new CommandError('E_BLOCKBENCH_ERROR', 'Blockbench refused to create a project for the opened model.');
    }
    try {
      Codecs.java_block.parse!(model, file.path);
    } catch (error) {
      throw new CommandError('E_BLOCKBENCH_ERROR', 'The java_block codec failed to parse the model.', {
        path: file.path,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    Canvas.updateAll();
    return { opened: true, format: 'java_block', name: Project ? Project.name : undefined, counts: projectCounts() };
  });

  register(session, 'create_cubes', (params) => {
    requireProject();
    // Resolve group references before starting the undoable edit.
    const groups = params.cubes.map((cube) => (cube.group_uuid !== undefined ? findGroup(cube.group_uuid) : null));
    Undo.initEdit({ elements: [], outliner: true });
    const created = params.cubes.map((cubeSpec, index) => {
      const cube = new Cube({
        name: cubeSpec.name ?? 'cube',
        from: cubeSpec.from,
        to: cubeSpec.to,
        origin: cubeSpec.origin,
        rotation: cubeSpec.rotation !== undefined ? rotationToVector(cubeSpec.rotation) : undefined,
        autouv: 1,
      }).init();
      if (cubeSpec.rotation?.origin !== undefined) {
        cube.extend({ origin: cubeSpec.rotation.origin });
      }
      const group = groups[index];
      if (group !== null) cube.addTo(group);
      return cube;
    });
    // The post-edit save must carry the created elements, or undo cannot
    // remove them again (matches Blockbench's own add_cube action).
    Undo.finishEdit('Create cubes', { elements: created, outliner: true });
    Canvas.updateAll();
    return { cubes: created.map((cube) => ({ uuid: cube.uuid, name: cube.name })) };
  });

  register(session, 'update_cube', (params) => {
    requireProject();
    const cube = findCube(params.uuid);
    Undo.initEdit({ elements: [cube] });
    const changes: Record<string, unknown> = {};
    if (params.set.name !== undefined) changes.name = params.set.name;
    if (params.set.from !== undefined) changes.from = params.set.from;
    if (params.set.to !== undefined) changes.to = params.set.to;
    if (params.set.origin !== undefined) changes.origin = params.set.origin;
    if (params.set.visibility !== undefined) changes.visibility = params.set.visibility;
    if (params.set.rotation !== undefined) {
      changes.rotation = params.set.rotation === null ? [0, 0, 0] : rotationToVector(params.set.rotation);
      if (params.set.rotation !== null && params.set.rotation.origin !== undefined) {
        changes.origin = params.set.rotation.origin;
      }
    }
    cube.extend(changes);
    Undo.finishEdit('Edit cube');
    Canvas.updateAll();
    return { uuid: cube.uuid, updated: true as const };
  });

  register(session, 'delete_cubes', (params) => {
    requireProject();
    const cubes = params.uuids.map(findCube);
    Undo.initEdit({ elements: cubes, outliner: true });
    for (const cube of cubes) cube.remove();
    // The post-edit save must contain no elements, or redo would resurrect
    // the deleted cubes (matches Blockbench's own delete action).
    Undo.finishEdit('Delete cubes', { elements: [], outliner: true });
    Canvas.updateAll();
    return { deleted: cubes.length };
  });

  register(session, 'create_group', (params) => {
    requireProject();
    const parent = params.parent_uuid !== undefined ? findGroup(params.parent_uuid) : null;
    Undo.initEdit({ outliner: true });
    const group = new Group({ name: params.name, origin: params.origin }).init();
    if (parent !== null) group.addTo(parent);
    Undo.finishEdit('Create group', { outliner: true, groups: [group] });
    return { uuid: group.uuid, name: group.name };
  });

  register(session, 'update_group', (params) => {
    requireProject();
    const group = findGroup(params.uuid);
    const parent = params.set.parent_uuid !== undefined ? findGroup(params.set.parent_uuid) : null;
    if (parent !== null) {
      // addTo has no cycle guard; a group reparented under itself or one of
      // its descendants would make the outliner traversal recurse forever.
      let ancestor: unknown = parent;
      while (ancestor instanceof Group) {
        if (ancestor.uuid === group.uuid) {
          throw new CommandError('E_INVALID_PARAMS', 'A group cannot become a child of itself or of its descendants.', {
            uuid: params.uuid,
            parent_uuid: params.set.parent_uuid,
          });
        }
        ancestor = ancestor.parent;
      }
    }
    // The groups aspect captures name/origin; outliner captures hierarchy.
    Undo.initEdit({ outliner: true, groups: [group] });
    if (params.set.name !== undefined) group.name = params.set.name;
    if (params.set.origin !== undefined) group.extend({ origin: params.set.origin });
    if (parent !== null) group.addTo(parent);
    Undo.finishEdit('Edit group');
    Canvas.updateAll();
    return { uuid: group.uuid, updated: true as const };
  });

  register(session, 'delete_group', (params) => {
    requireProject();
    const group = findGroup(params.uuid);
    // Blockbench's own remove/resolve manage complete undo entries (including
    // all descendants); wrapping them in another initEdit would clobber the
    // save state and make the deletion unrecoverable.
    if (params.keep_children === true) {
      group.resolve();
    } else {
      group.remove(true);
    }
    Canvas.updateAll();
    return { deleted: true as const };
  });

  register(session, 'assign_texture', (params) => {
    requireProject();
    let texture: Texture;
    if (params.source.kind === 'path') {
      const resolved = resolveForIo(scope, params.source.path);
      if (!scope.fs.existsSync(resolved)) {
        throw new CommandError('E_NOT_FOUND', 'The texture file does not exist inside the scoped directory.', {
          path: resolved,
        });
      }
      texture = new Texture({ name: params.name }).fromPath(resolved);
    } else {
      if (params.source.data_url.length > DEFAULTS.maxTextureDataUrlBytes) {
        throw new CommandError(
          'E_INVALID_PARAMS',
          `The texture data URL exceeds the ${DEFAULTS.maxTextureDataUrlBytes}-byte limit.`,
        );
      }
      texture = new Texture({ name: params.name ?? 'texture' }).fromDataURL(params.source.data_url);
    }
    texture.add(true);

    let appliedTo: 'all' | string[];
    if (params.apply_to === 'all') {
      Undo.initEdit({ elements: Cube.all });
      for (const cube of Cube.all) cube.applyTexture(texture, true);
      Undo.finishEdit('Apply texture');
      appliedTo = 'all';
    } else {
      const cubes = params.apply_to.cube_uuids.map(findCube);
      Undo.initEdit({ elements: cubes });
      for (const cube of cubes) {
        cube.applyTexture(texture, params.apply_to.faces !== undefined ? params.apply_to.faces : true);
      }
      Undo.finishEdit('Apply texture');
      appliedTo = cubes.map((cube) => cube.uuid);
    }
    Canvas.updateAll();
    return { texture_uuid: texture.uuid, name: texture.name, applied_to: appliedTo };
  });

  register(session, 'set_display_transform', (params) => {
    requireJavaBlockFormat();
    if (!Format.display_mode) {
      throw new CommandError('E_FORMAT_UNSUPPORTED', 'The current format does not support display transforms.');
    }
    const slot = params.slot;
    Undo.initEdit({ display_slots: [slot] });
    let displaySlot = Project!.display_settings[slot] as DisplaySlot | undefined;
    if (displaySlot === undefined) {
      displaySlot = new DisplaySlot(slot, {});
      (Project!.display_settings as Record<string, DisplaySlot>)[slot] = displaySlot;
    }
    const changes: Record<string, unknown> = {};
    if (params.translation !== undefined) changes.translation = params.translation;
    if (params.rotation !== undefined) changes.rotation = params.rotation;
    if (params.scale !== undefined) changes.scale = params.scale;
    displaySlot.extend(changes);
    Undo.finishEdit('Edit display transform');
    return { slot, updated: true as const };
  });

  register(session, 'export_model', (params) => {
    requireJavaBlockFormat();
    let content: string;
    try {
      content = String(Codecs.java_block.compile());
    } catch (error) {
      throw new CommandError('E_BLOCKBENCH_ERROR', 'The java_block codec failed to compile the model.', {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    return writeSingleFile(scope, params.path, content, params.overwrite);
  });

  register(session, 'read_file', (params) => readFileCommand(scope, params));

  register(session, 'write_files', (params) => writeFilesCommand(scope, params.files));

  register(session, 'capture_screenshot', async (params) => {
    requireProject();
    const width = params.width ?? DEFAULTS.screenshotDefaultSize;
    const height = params.height ?? DEFAULTS.screenshotDefaultSize;
    const preview = Preview.selected ?? Screencam.NoAAPreview;
    const dataUrl = await new Promise<string>((resolve, reject) => {
      try {
        Screencam.screenshotPreview(preview, { width, height, crop: false }, (result) => resolve(result));
      } catch (error) {
        reject(error);
      }
    });
    return { data_url: dataUrl, width, height };
  });

  register(session, 'validate_project', () => {
    requireProject();
    const diagnostics: Array<{ severity: 'error' | 'warning'; message: string; check_id?: string; target?: string }> =
      [];
    // ValidatorCheck is implemented in still-untyped Blockbench JavaScript;
    // this is the shape js/validator.js actually exposes.
    interface ValidatorCheckLike {
      id: string;
      condition?: ConditionResolvable;
      update(): void;
      errors: Array<{ message: string }>;
      warnings: Array<{ message: string }>;
    }
    for (const check of Validator.checks as unknown as ValidatorCheckLike[]) {
      try {
        if (!Condition(check.condition)) continue;
        check.update();
        for (const problem of check.errors) {
          diagnostics.push({ severity: 'error', message: problem.message, check_id: check.id });
        }
        for (const problem of check.warnings) {
          diagnostics.push({ severity: 'warning', message: problem.message, check_id: check.id });
        }
      } catch (error) {
        diagnostics.push({
          severity: 'warning',
          message: `Validation check failed to run: ${error instanceof Error ? error.message : String(error)}`,
          check_id: check.id,
        });
      }
    }
    if (Format?.id === 'geckolib_model') {
      const project = Project as unknown as Record<string, unknown>;
      const texture = Texture.all[0] as { width?: number; height?: number } | undefined;
      const textureSize =
        texture !== undefined && typeof texture.width === 'number' && typeof texture.height === 'number'
          ? { width: texture.width, height: texture.height }
          : undefined;
      const declaredTextureSize =
        Project !== null && typeof Project.texture_width === 'number' && typeof Project.texture_height === 'number'
          ? { width: Project.texture_width, height: Project.texture_height }
          : undefined;
      diagnostics.push(
        ...validateGeckolibProject({
          boneNames: Group.all.map((group) => group.name),
          modid: typeof project.geckolib_modid === 'string' && project.geckolib_modid !== '' ? project.geckolib_modid : undefined,
          identifier:
            typeof project.model_identifier === 'string' && project.model_identifier !== ''
              ? project.model_identifier
              : undefined,
          modelType: typeof project.geckolib_model_type === 'string' ? project.geckolib_model_type : undefined,
          textureSize,
          declaredTextureSize,
          detectedPluginVersion: detectGeckolibPluginVersion(),
        }),
      );
      const animationNames = projectAnimations().map((animation) => animation.name);
      if (animationNames.length > 0) {
        // Validate the in-memory animation build with the same shared GL4
        // checks the file validator uses; cross-checking against current
        // group names also surfaces animators orphaned by a group rename or
        // delete. Skipped entirely when the project has no animations (the
        // GeckoLib-patched Animator.buildFile needs a non-empty name filter).
        try {
          const animator = Animator as unknown as {
            buildFile(pathFilter: string | undefined, nameFilter: string[]): unknown;
          };
          const built = animator.buildFile(undefined, animationNames);
          const contentDiagnostics = validateAnimationJson(built);
          diagnostics.push(...contentDiagnostics);
          const diagnosticKey = (diagnostic: GeckolibDiagnostic): string =>
            `${diagnostic.severity}|${diagnostic.check_id}|${diagnostic.target ?? ''}|${diagnostic.message}`;
          const reported = new Set(contentDiagnostics.map(diagnosticKey));
          diagnostics.push(
            ...validateAnimationBoneNames(built, Group.all.map((group) => group.name)).filter(
              (diagnostic) => !reported.has(diagnosticKey(diagnostic)),
            ),
          );
        } catch (error) {
          diagnostics.push({
            severity: 'warning',
            message: `GeckoLib animation validation failed to run: ${error instanceof Error ? error.message : String(error)}`,
            check_id: 'geckolib_animation_build',
          });
        }
      }
    }
    return { diagnostics };
  });
}
