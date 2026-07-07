// GeckoLib command handlers. Every command requires the third-party GeckoLib
// plugin ("GeckoLib Models & Animations", id `geckolib`) at call time: it owns
// the geckolib_model format, the Bedrock-codec compile hook that pins
// format_version to 1.12.0, and the Animator.buildFile patch that emits
// geckolib_format_version 2 with GeckoLib's {vector, easing} keyframes.
import { GECKOLIB_VALIDATION_PROFILE } from '../../shared/protocol.js';
import {
  validateGeoJson,
  validateAnimationJson,
  validateAnimationBoneRefs,
  type GeckolibDiagnostic,
} from '../../shared/geckolib-validate.js';
import { CommandError, type PluginSession } from '../session.js';
import type { ScopeManager } from '../scope-manager.js';
import { readFileCommand, writeSingleFile } from '../file-commands.js';
import { register, projectCounts, requireGeckolibPlugin, requireGeckolibFormat } from './helpers.js';

/** Blockbench renames its Animation global (it shadows the DOM's); handlers
 * reach it through the Blockbench namespace to stay type-safe. */
function projectAnimationNames(): string[] {
  const blockbench = Blockbench as unknown as { Animation?: { all?: Array<{ name: string }> } };
  const animations = blockbench.Animation?.all ?? [];
  return animations.map((animation) => animation.name);
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

export function registerGeckolibCommands(session: PluginSession, scope: ScopeManager): void {
  register(session, 'create_geckolib_project', (params) => {
    requireGeckolibPlugin();
    if (Project && !Project.saved && params.force !== true) {
      throw new CommandError(
        'E_INVALID_PARAMS',
        'An unsaved project is already open in another tab. Set force:true to open a new project tab anyway.',
      );
    }
    const created = newProject(Formats.geckolib_model);
    if (!created) {
      throw new CommandError('E_BLOCKBENCH_ERROR', 'Blockbench refused to create a new geckolib_model project.');
    }
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

  register(session, 'open_geckolib_model', (params) => {
    requireGeckolibPlugin();
    if (Project && !Project.saved && params.force !== true) {
      throw new CommandError(
        'E_INVALID_PARAMS',
        'An unsaved project is already open in another tab. Set force:true to open the model in a new tab anyway.',
      );
    }
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
    try {
      Codecs.project.parse!(parsed, normalizedPath);
    } catch (error) {
      throw new CommandError('E_BLOCKBENCH_ERROR', 'The project codec failed to parse the .bbmodel file.', {
        path: normalizedPath,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    Canvas.updateAll();
    return {
      opened: true,
      format: 'geckolib_model',
      name: Project ? Project.name : undefined,
      counts: projectCounts(),
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
}
