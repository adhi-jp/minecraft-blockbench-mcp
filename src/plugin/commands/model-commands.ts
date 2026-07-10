// Blockbench command handlers: every Blockbench mutation or inspection the
// adapter can request runs here, inside the plugin, through Blockbench APIs.
// Mutations create undo entries and refresh the viewport.
import { DEFAULTS, type CubeReadback, type GroupReadback } from '../../shared/protocol.js';
import {
  validateGeckolibProject,
  validateAnimationJson,
  validateAnimationBoneNames,
  type GeckolibDiagnostic,
} from '../../shared/geckolib-validate.js';
import { blockbenchLoopToGeckolib, type BlockbenchLoopMode } from '../geckolib-animation-mapping.js';
import { CommandError, type PluginSession } from '../session.js';
import type { ScopeManager } from '../scope-manager.js';
import { normalizePath } from '../../shared/scope.js';
import {
  readFileCommand,
  writeFilesCommand,
  writeSingleFile,
  resolveForIo,
  resolveSingleWriteDestination,
} from '../file-commands.js';
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

/** Parent group UUID for a cube or group, or null at the outliner root
 * (Blockbench stores the literal 'root' there). */
function parentUuidOf(node: Cube | Group): string | null {
  const parent: unknown = node.parent;
  return parent instanceof Group ? parent.uuid : null;
}

type FaceReadback = NonNullable<CubeReadback['faces'][keyof CubeReadback['faces']]>;

function faceReadback(face: CubeFace): FaceReadback {
  // The generated CubeFace ambient type declares `texture: boolean`; at
  // runtime it stores a texture UUID string, false (no texture), or null
  // (face disabled). The stored reference is reported as-is: resolving it
  // through getTexture() would follow the current texture selection in
  // single-texture formats and make read-back non-deterministic.
  const stored = (face as unknown as { texture: unknown }).texture;
  return {
    uv: [face.uv[0], face.uv[1], face.uv[2], face.uv[3]],
    rotation: face.rotation ?? 0,
    texture_uuid: typeof stored === 'string' ? stored : null,
  };
}

function cubeReadback(cube: Cube): CubeReadback {
  const faces: CubeReadback['faces'] = {};
  for (const [direction, face] of Object.entries(cube.faces)) {
    faces[direction as keyof CubeReadback['faces']] = faceReadback(face);
  }
  return {
    uuid: cube.uuid,
    name: cube.name,
    from: [cube.from[0], cube.from[1], cube.from[2]],
    to: [cube.to[0], cube.to[1], cube.to[2]],
    origin: [cube.origin[0], cube.origin[1], cube.origin[2]],
    rotation: [cube.rotation[0], cube.rotation[1], cube.rotation[2]],
    visibility: cube.visibility,
    box_uv: cube.box_uv,
    uv_offset: [cube.uv_offset[0], cube.uv_offset[1]],
    mirror_uv: cube.mirror_uv,
    faces,
    parent_uuid: parentUuidOf(cube),
  };
}

function groupReadback(group: Group): GroupReadback {
  return {
    uuid: group.uuid,
    name: group.name,
    origin: [group.origin[0], group.origin[1], group.origin[2]],
    parent_uuid: parentUuidOf(group),
    // Non-cube/non-group children (meshes, locators, ...) are outside the
    // read-back surface; their UUIDs must not leak into the hierarchy, or
    // the uuids filter would reject values this command itself returned.
    children: group.children
      .filter((child): child is Cube | Group => child instanceof Cube || child instanceof Group)
      .map((child) => child.uuid),
  };
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
    // The animations summary reports GeckoLib loop terms, so it is scoped to
    // geckolib_model projects; other formats keep the prior result shape.
    const animations = Format?.id === 'geckolib_model' ? projectAnimations() : [];
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

  register(session, 'get_elements', (params) => {
    requireProject();
    let cubes = Cube.all;
    let groups = Group.all;
    if (params.uuids !== undefined) {
      const wanted = new Set(params.uuids);
      cubes = cubes.filter((cube) => wanted.has(cube.uuid));
      groups = groups.filter((group) => wanted.has(group.uuid));
      const found = new Set<string>([...cubes.map((cube) => cube.uuid), ...groups.map((group) => group.uuid)]);
      const missing = params.uuids.filter((uuid) => !found.has(uuid));
      if (missing.length > 0) {
        throw new CommandError('E_NOT_FOUND', 'No cube or group exists for some of the requested UUIDs.', {
          uuids: missing,
        });
      }
    }
    return { cubes: cubes.map(cubeReadback), groups: groups.map(groupReadback) };
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
    // Validate UV fields before starting the undoable edit. The Cube
    // constructor would silently drop a box_uv the format forbids
    // (merge_validation), so the gate must live here.
    for (const cubeSpec of params.cubes) {
      if (cubeSpec.box_uv !== undefined && cubeSpec.box_uv !== Format?.box_uv && Format?.optional_box_uv !== true) {
        throw new CommandError(
          'E_FORMAT_UNSUPPORTED',
          `The "${Format?.id ?? 'unknown'}" format fixes cubes to ${Format?.box_uv ? 'box' : 'per-face'} UV and does not support per-cube UV modes.`,
        );
      }
      const effectiveBoxUv = cubeSpec.box_uv ?? Project!.box_uv === true;
      if (cubeSpec.uv_offset !== undefined && !effectiveBoxUv) {
        throw new CommandError(
          'E_INVALID_PARAMS',
          'uv_offset applies to box UV mode, but this cube would be created in per-face UV mode. Pass box_uv:true for the cube.',
          { cube: cubeSpec.name ?? 'cube' },
        );
      }
    }
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
        ...(cubeSpec.box_uv !== undefined ? { box_uv: cubeSpec.box_uv } : {}),
        ...(cubeSpec.uv_offset !== undefined ? { uv_offset: cubeSpec.uv_offset } : {}),
        // Explicit UV data must survive later geometry edits, which auto-UV
        // would otherwise recompute; a bare mode choice keeps auto-UV on.
        autouv: cubeSpec.uv_offset !== undefined ? 0 : 1,
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

  register(session, 'set_cube_uv', (params) => {
    requireProject();
    const cube = findCube(params.uuid);
    // Mode-specific fields validate against the mode the cube will be in
    // after an included box_uv switch, so switch + fields work in one call.
    const targetBoxUv = params.box_uv ?? cube.box_uv;
    if (params.faces !== undefined && targetBoxUv) {
      throw new CommandError(
        'E_INVALID_PARAMS',
        'faces set per-face UVs, but the cube is in box UV mode. Pass box_uv:false in the same call to switch modes.',
        { uuid: cube.uuid },
      );
    }
    if ((params.uv_offset !== undefined || params.mirror_uv !== undefined) && !targetBoxUv) {
      throw new CommandError(
        'E_INVALID_PARAMS',
        'uv_offset and mirror_uv apply to box UV mode, but the cube is in per-face UV mode. Pass box_uv:true in the same call to switch modes.',
        { uuid: cube.uuid },
      );
    }
    const switchMode = params.box_uv !== undefined && params.box_uv !== cube.box_uv;
    // A per-cube mode may diverge from the format default only when the
    // format opts into optional box UV; switching back to the default is
    // always allowed.
    if (switchMode && Format?.optional_box_uv !== true && params.box_uv !== Format?.box_uv) {
      throw new CommandError(
        'E_FORMAT_UNSUPPORTED',
        `The "${Format?.id ?? 'unknown'}" format fixes cubes to ${Format?.box_uv ? 'box' : 'per-face'} UV and does not support per-cube UV modes.`,
      );
    }
    // Formats without per-face rotation would preview it but lose it at
    // export, so a non-zero rotation is rejected like the mode switch above.
    if (
      params.faces !== undefined &&
      Format?.uv_rotation !== true &&
      Object.values(params.faces).some((entry) => entry !== undefined && (entry.rotation ?? 0) !== 0)
    ) {
      throw new CommandError(
        'E_FORMAT_UNSUPPORTED',
        `The "${Format?.id ?? 'unknown'}" format does not support per-face UV rotation.`,
      );
    }
    Undo.initEdit({ elements: [cube], uv_only: true });
    if (switchMode) cube.setUVMode(params.box_uv === true);
    if (params.uv_offset !== undefined) cube.uv_offset = [params.uv_offset[0], params.uv_offset[1]];
    if (params.mirror_uv !== undefined) cube.mirror_uv = params.mirror_uv;
    if (params.faces !== undefined) {
      for (const [direction, entry] of Object.entries(params.faces)) {
        if (entry === undefined) continue;
        const face = cube.faces[direction];
        face.uv = [entry.uv[0], entry.uv[1], entry.uv[2], entry.uv[3]];
        if (entry.rotation !== undefined) face.rotation = entry.rotation;
      }
    }
    // Explicit UV state must survive later geometry edits, which auto-UV
    // would otherwise recompute.
    cube.autouv = 0;
    Undo.finishEdit('Edit cube UV');
    Canvas.updateAllUVs();
    // The 2D UV panel loads from the selection; refresh it only when it is
    // actually showing the edited cube.
    if (Cube.selected.includes(cube)) {
      UVEditor.loadData();
    }
    return { uuid: cube.uuid, updated: true as const };
  });

  register(session, 'set_texture_resolution', (params) => {
    requireProject();
    const project = Project!;
    if (params.rescale_existing_uv === true) {
      // A non-positive current size would rescale by width/0 = Infinity and
      // corrupt every UV in the project (areMultiples treats 0 as a
      // multiple of anything).
      if (!(project.texture_width > 0) || !(project.texture_height > 0)) {
        throw new CommandError(
          'E_INVALID_PARAMS',
          'The current project resolution is not a positive size, so existing UVs cannot be rescaled. Set the resolution once without rescale_existing_uv first.',
          { current: [project.texture_width, project.texture_height] },
        );
      }
      // Blockbench extends Math with areMultiples; the extension is absent
      // from the ambient types.
      const blockbenchMath = Math as unknown as { areMultiples(a: number, b: number): boolean };
      // adjustProjectResolution silently skips the UV rescale unless the new
      // size is square, the width actually changes, and the old and new
      // widths are integer multiples of one another; a request it would skip
      // fails here instead, before any mutation.
      if (
        params.width !== params.height ||
        project.texture_width === params.width ||
        !blockbenchMath.areMultiples(project.texture_width, params.width)
      ) {
        throw new CommandError(
          'E_INVALID_PARAMS',
          'rescale_existing_uv needs a square target size whose width differs from the current width and is an integer multiple (or divisor) of it.',
          {
            current: [project.texture_width, project.texture_height],
            requested: [params.width, params.height],
          },
        );
      }
    }
    // The native utility owns the whole undo-wrapped sequence, including the
    // per-texture UV size sync on formats that use it.
    UVSizeUtil.adjustProjectResolution(params.width, params.height, params.rescale_existing_uv === true);
    return { width: params.width, height: params.height, updated: true as const };
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

  register(session, 'save_project', (params) => {
    requireProject();
    // The full write preflight (containment, symlinks, overwrite conflict)
    // runs before any Project state change so a blocked save leaves the
    // project untouched.
    const destination = resolveSingleWriteDestination(scope, params.path, params.overwrite);
    const project = Project!;
    const originalSavePath = project.save_path;
    // A fresh project adopts the destination as its save path; a re-save to
    // the current save path keeps it. Blockbench stores save_path with
    // OS-native separators, so the comparison goes through the shared path
    // normalizer or a Windows re-save would misread as divergent. A divergent
    // destination must not move the user's own save target (Ctrl+S) or clear
    // the dirty flag, so its swap is temporary.
    const adoptDestination = !originalSavePath || normalizePath(originalSavePath) === destination;
    let succeeded = false;
    // Relative texture paths in the compiled model are computed against
    // Project.save_path (the codec's handleAssetPath), so the swap must
    // happen before compile. Never afterSave(): it would also rewrite
    // Project.name and the recent-projects list.
    project.save_path = destination;
    try {
      let content: string;
      try {
        const compiled: unknown = Codecs.project.compile();
        if (typeof compiled !== 'string') {
          throw new Error(`the compile result is ${typeof compiled}, expected a string`);
        }
        content = compiled;
      } catch (error) {
        // The codec sets the compiling_bbmodel flag and only clears it after
        // its compile hooks ran; a throwing hook would otherwise leave the
        // flag stuck and corrupt every later face-texture serialization.
        Blockbench.removeFlag('compiling_bbmodel');
        throw new CommandError('E_BLOCKBENCH_ERROR', 'The project codec failed to compile the project.', {
          reason: error instanceof Error ? error.message : String(error),
        });
      }
      const result = writeSingleFile(scope, params.path, content, params.overwrite);
      succeeded = true;
      return result;
    } finally {
      if (succeeded && adoptDestination) {
        try {
          project.saved = true;
        } catch {
          // The saved setter dispatches saved_state_changed to third-party
          // listeners; a throwing listener must not turn the already
          // completed save into an error response.
        }
      } else {
        project.save_path = originalSavePath;
      }
    }
  });

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
