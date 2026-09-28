import { DEFAULTS, type SCREENSHOT_ANGLE_PRESETS } from '../../shared/protocol.js';
import { CommandError } from '../session.js';
import type { ScopeManager } from '../scope-manager.js';
import { writeFilesCommand } from '../file-commands.js';
import { projectCounts } from './helpers.js';

export type ScreenshotAnglePreset = (typeof SCREENSHOT_ANGLE_PRESETS)[number];

export interface ScreenshotParams {
  width?: number;
  height?: number;
  angle_preset?: ScreenshotAnglePreset;
  output_path?: string;
  overwrite?: boolean;
}

interface ScreenshotMetadata {
  width: number;
  height: number;
  angle_preset?: ScreenshotAnglePreset;
  project: { uuid: string; name: string };
  counts: ReturnType<typeof projectCounts>;
}

export type ScreenshotResult = ScreenshotMetadata & ({ data_url: string } | { path: string; bytes: number });

// Screenshot and animation-pose captures share global Blockbench preview state:
// the offscreen NoAAPreview singleton, recorder state, and GeckoLib timeline
// pose globals. Keep one queue instance for the whole critical section.
let screenshotChain: Promise<void> = Promise.resolve();

export function enqueueScreenshot<T>(task: () => Promise<T>): Promise<T> {
  const result = screenshotChain.then(task);
  screenshotChain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export async function captureScreenshotFromPreview(
  params: ScreenshotParams,
  scope: ScopeManager,
): Promise<ScreenshotResult> {
  const project = { uuid: Project.uuid, name: Project.name };
  const counts = projectCounts();
  const width = params.width ?? DEFAULTS.screenshotDefaultSize;
  const height = params.height ?? DEFAULTS.screenshotDefaultSize;
  let preview: Preview;
  if (params.angle_preset !== undefined) {
    // Blockbench's GIF/APNG recorder renders through the same offscreen
    // preview; repointing its camera mid-recording would corrupt the
    // remaining frames.
    const screencamState = Screencam as unknown as { processing_gif?: unknown };
    const recordingFrame = typeof document !== 'undefined' ? document.getElementById('gif_recording_frame') : null;
    if (recordingFrame !== null || screencamState.processing_gif !== undefined) {
      throw new CommandError(
        'E_BLOCKBENCH_ERROR',
        'A Blockbench screen recording is in progress and shares the offscreen preview; retry after it finishes.',
      );
    }
    // Blockbench's own preset screenshots render through the offscreen
    // NoAAPreview; the visible viewport camera stays untouched. The ambient
    // AnglePreset type lacks the id field, hence the cast.
    const preset = (DefaultCameraPresets as Array<AnglePreset & { id?: string }>).find(
      (candidate) => candidate.id === params.angle_preset,
    );
    if (preset === undefined) {
      throw new CommandError('E_BLOCKBENCH_ERROR', 'The camera preset is missing from DefaultCameraPresets.', {
        angle_preset: params.angle_preset,
      });
    }
    preview = Screencam.NoAAPreview;
    preview.loadAnglePreset(preset);
    // loadAnglePreset skips the preset zoom for locked-angle presets
    // (top/bottom and the compass directions), which would leave a
    // residual zoom from an earlier render on the shared preview.
    if (preview.isOrtho && typeof preset.zoom === 'number') {
      const camera = preview.camera as unknown as { zoom: number; updateProjectionMatrix(): void };
      camera.zoom = preset.zoom;
      camera.updateProjectionMatrix();
    }
    // resize is absent from the ambient Preview type.
    (preview as unknown as { resize(width: number, height: number): void }).resize(width, height);
  } else {
    preview = Preview.selected ?? Screencam.NoAAPreview;
  }
  const dataUrl = await new Promise<string>((resolve, reject) => {
    // Blockbench's withoutGizmos wrapper swallows render exceptions, so
    // a failed render would otherwise leave this promise pending forever
    // and wedge the serialization queue behind it.
    const deadline = setTimeout(() => {
      reject(new CommandError('E_BLOCKBENCH_ERROR', 'The screenshot render did not complete within 20 seconds.'));
    }, 20_000);
    try {
      Screencam.screenshotPreview(preview, { width, height, crop: false }, (result) => {
        clearTimeout(deadline);
        resolve(result);
      });
    } catch (error) {
      clearTimeout(deadline);
      reject(error);
    }
  });
  const metadata = {
    project,
    counts,
    width,
    height,
    ...(params.angle_preset !== undefined ? { angle_preset: params.angle_preset } : {}),
  };
  if (params.output_path !== undefined) {
    const { results } = writeFilesCommand(scope, [{
      path: params.output_path,
      content: dataUrl.slice('data:image/png;base64,'.length),
      encoding: 'base64',
      overwrite: params.overwrite,
    }]);
    return { ...metadata, path: results[0].path, bytes: results[0].bytes };
  }
  return { ...metadata, data_url: dataUrl };
}
