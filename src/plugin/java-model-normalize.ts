// Java block/item model normalization applied before Blockbench's java_block
// codec parses a model. Pure and browser-safe: no Node builtins and no
// Blockbench globals; parent model files are read through an injected reader.
//
// The codec (Blockbench 5.1.4, js/formats/java/java_block.js) reads only
// string texture values, expands `#alias` values a single hop, shows a
// "child model only" dialog for element-less models with a parent, and shows
// an "invalid model" dialog when elements, parent, display and textures are
// all absent. The functions here turn real mod models into input the codec
// renders without dialogs, and report every adjustment as a warning.

export type JavaModel = Record<string, unknown>;

/** Parents the codec renders as a flat sprite when `textures.layer0` is a
 * string (the codec's own `item_parents` list, matched exactly). */
export const ITEM_PARENTS: ReadonlySet<string> = new Set([
  'item/generated',
  'minecraft:item/generated',
  'item/handheld',
  'minecraft:item/handheld',
  'item/handheld_rod',
  'minecraft:item/handheld_rod',
  'builtin/generated',
  'minecraft:builtin/generated',
]);

export interface NormalizeResult {
  model: JavaModel;
  warnings: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** True for `builtin/...` parent ids, with or without a namespace. */
export function isBuiltinParent(parent: string): boolean {
  return parent.replace(/^[^:/]*:/, '').startsWith('builtin/');
}

/** True when the codec would build its flat item sprite for this model. */
function takesFlatSpriteBranch(model: JavaModel): boolean {
  return (
    !model.elements &&
    typeof model.parent === 'string' &&
    ITEM_PARENTS.has(model.parent) &&
    isPlainObject(model.textures) &&
    typeof model.textures.layer0 === 'string'
  );
}

/** Follow `#alias` references to a final value. Returns the final value, or
 * a warning when the chain hits a missing variable or loops. */
function resolveAlias(
  key: string,
  textures: Record<string, unknown>,
): { ok: true; value: string } | { ok: false; warning: string } {
  const seen = [key];
  let current = textures[key] as string;
  while (current.startsWith('#')) {
    const target = current.slice(1);
    if (seen.includes(target)) {
      return {
        ok: false,
        warning: `Texture "${key}" is part of an alias cycle (${[...seen, target].map((name) => `#${name}`).join(' -> ')}); left unresolved.`,
      };
    }
    const next = textures[target];
    if (typeof next !== 'string') {
      return {
        ok: false,
        warning: `Texture "${key}" refers to "#${target}", which is not defined; left unresolved.`,
      };
    }
    seen.push(target);
    current = next;
  }
  return { ok: true, value: current };
}

export interface NormalizeOptions {
  /** The parent chain was already walked; an unresolved parent was reported
   * by that walk, so no separate hint is added here. */
  parentsResolved?: boolean;
}

/**
 * Normalize a model for the java_block codec:
 * - a texture value `{ "sprite": "..." }` becomes its sprite string;
 * - `#alias` texture values resolve through every hop against the final
 *   texture map (including `particle`); missing targets and cycles stay as
 *   written and are reported;
 * - an element-less model with a parent that would not become the flat item
 *   sprite gets `elements: []`, so the codec shows no dialog and keeps the
 *   parent for export.
 * The input is not modified.
 */
export function normalizeJavaModel(input: JavaModel, options: NormalizeOptions = {}): NormalizeResult {
  const warnings: string[] = [];
  const model: JavaModel = { ...input };

  if (isPlainObject(model.textures)) {
    const textures: Record<string, unknown> = { ...model.textures };
    for (const [key, value] of Object.entries(textures)) {
      if (isPlainObject(value) && typeof value.sprite === 'string') {
        textures[key] = value.sprite;
        warnings.push(`Texture "${key}" was a sprite object; opened its sprite "${value.sprite}".`);
      }
    }
    const resolved: Record<string, unknown> = { ...textures };
    for (const [key, value] of Object.entries(textures)) {
      if (typeof value !== 'string' || !value.startsWith('#')) continue;
      const outcome = resolveAlias(key, textures);
      if (outcome.ok) {
        resolved[key] = outcome.value;
      } else {
        warnings.push(outcome.warning);
      }
    }
    model.textures = resolved;
  }

  if (!model.elements && model.parent && !takesFlatSpriteBranch(model)) {
    model.elements = [];
    const parent = String(model.parent);
    if (typeof model.parent === 'string' && isBuiltinParent(model.parent)) {
      warnings.push(`Parent "${parent}" is built into the game and has no model file; opened without elements.`);
    } else if (typeof model.parent === 'string' && ITEM_PARENTS.has(model.parent)) {
      warnings.push(
        `Parent "${parent}" draws a flat sprite only from a string "layer0" texture, which this model lacks; opened without elements.`,
      );
    } else if (options.parentsResolved !== true) {
      warnings.push(
        `Parent "${parent}" was not resolved, so the model opened without inherited elements; pass resolve_parents: true to inline the parent chain.`,
      );
    }
  }

  return { model, warnings };
}

/** Absolute path of the `assets` directory that holds a model file, or null
 * when the path has no `<namespace>/models` segment. The nearest
 * `assets/<namespace>/models` structure wins, so an ancestor directory named
 * `models` does not move the root; without that structure the path up to the
 * segment before the first `models` is used. */
export function assetsRootOf(modelPath: string): string | null {
  const segments = modelPath.replace(/\\/g, '/').split('/');
  let modelsIndex = -1;
  for (let i = segments.length - 1; i >= 2; i--) {
    if (segments[i] === 'models' && segments[i - 2] === 'assets') {
      modelsIndex = i;
      break;
    }
  }
  if (modelsIndex < 0) modelsIndex = segments.indexOf('models');
  if (modelsIndex < 2) return null;
  return segments.slice(0, modelsIndex - 1).join('/');
}

/** Map a parent id `namespace:path` (default namespace `minecraft`) to its
 * model file under an `assets` root. */
export function parentModelPath(assetsRoot: string, parentId: string): string {
  const colon = parentId.indexOf(':');
  const namespace = colon >= 0 ? parentId.slice(0, colon) : 'minecraft';
  const path = colon >= 0 ? parentId.slice(colon + 1) : parentId;
  const root = assetsRoot.endsWith('/') ? assetsRoot.slice(0, -1) : assetsRoot;
  return `${root}/${namespace}/models/${path}.json`;
}

/** Reads a model file; returns null when the file does not exist. Scope
 * violations are thrown, not reported as missing. */
export type ModelFileReader = (absolutePath: string) => string | null;

export interface ResolveParentsOptions {
  /** Path of the opened model file; guards against cycles through it. */
  modelPath: string;
  /** `assets` roots searched in order for each parent. */
  assetRoots: readonly string[];
  read: ModelFileReader;
}

/**
 * Inline a model's parent chain: textures merge child-first, the nearest
 * model with non-empty `elements` supplies them, `display` merges per slot
 * child-first, and `ambientocclusion` and `gui_light` come from the nearest
 * model that sets them. The walk stops at `builtin/*` and flat-sprite item
 * parents (kept as `parent`), at a parent file that cannot be found or read,
 * and at a cycle; those stops keep the id as `parent` and add a warning when
 * something could not be resolved. A chain that ends at a model without a
 * parent yields a model without `parent`, unless no model in the chain has
 * elements: then the child's `parent` is kept, with a warning, so the export
 * still names it. Every other field is the child's.
 */
export function resolveJavaModelParents(child: JavaModel, options: ResolveParentsOptions): NormalizeResult {
  const warnings: string[] = [];
  const chain: JavaModel[] = [child];
  const visited = new Set<string>([options.modelPath.replace(/\\/g, '/')]);
  let stopParent: unknown = undefined;
  let current = child;

  while (current.parent !== undefined) {
    const parent = current.parent;
    if (typeof parent !== 'string' || isBuiltinParent(parent) || ITEM_PARENTS.has(parent)) {
      stopParent = parent;
      break;
    }
    let found: { path: string; content: string } | null = null;
    for (const root of options.assetRoots) {
      const path = parentModelPath(root, parent);
      const content = options.read(path);
      if (content !== null) {
        found = { path, content };
        break;
      }
    }
    if (found === null) {
      warnings.push(
        `Parent "${parent}" was not found under the ${options.assetRoots.length} asset root(s) resolve_parents searched; the chain stops there.`,
      );
      stopParent = parent;
      break;
    }
    if (visited.has(found.path)) {
      warnings.push(`Parent "${parent}" forms a cycle in the parent chain; the chain stops there.`);
      stopParent = parent;
      break;
    }
    visited.add(found.path);
    let parsed: unknown;
    try {
      parsed = JSON.parse(found.content);
    } catch {
      parsed = undefined;
    }
    if (!isPlainObject(parsed)) {
      warnings.push(`Parent "${parent}" at ${found.path} is not a JSON model; the chain stops there.`);
      stopParent = parent;
      break;
    }
    chain.push(parsed);
    current = parsed;
  }

  const merged: JavaModel = { ...child };
  delete merged.parent;
  if (stopParent !== undefined) merged.parent = stopParent;

  const ancestorsFirst = [...chain].reverse();
  if (chain.some((model) => isPlainObject(model.textures))) {
    const textures: Record<string, unknown> = {};
    for (const model of ancestorsFirst) {
      if (isPlainObject(model.textures)) Object.assign(textures, model.textures);
    }
    merged.textures = textures;
  }
  if (chain.some((model) => isPlainObject(model.display))) {
    const display: Record<string, unknown> = {};
    for (const model of ancestorsFirst) {
      if (isPlainObject(model.display)) Object.assign(display, model.display);
    }
    merged.display = display;
  }
  for (const key of ['ambientocclusion', 'gui_light']) {
    const source = chain.find((model) => model[key] !== undefined);
    if (source !== undefined) merged[key] = source[key];
  }
  const withElements = chain.find((model) => Array.isArray(model.elements) && model.elements.length > 0);
  if (withElements !== undefined) {
    merged.elements = withElements.elements;
  } else if (stopParent === undefined && child.parent !== undefined) {
    merged.parent = child.parent;
    warnings.push(
      `No model in the parent chain of "${String(child.parent)}" has elements, so the parent was kept.`,
    );
  }

  return { model: merged, warnings };
}
