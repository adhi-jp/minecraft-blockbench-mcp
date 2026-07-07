// Shared adapter-plugin protocol contract.
// This module must stay free of Node builtins: it compiles under both the
// adapter (Node) and plugin (browser/Blockbench) TypeScript configurations.
import { z } from 'zod';

export const PROTOCOL_VERSION = 1;

export const DEFAULT_WS_PORT = 39731;

// Operational defaults shared by both sides. All of them are configurable on
// the adapter; the hello_ack tells the plugin the effective heartbeat settings.
export const DEFAULTS = {
  requestTimeoutMs: 30_000,
  // propose_scoped_directory waits for a human decision inside Blockbench.
  scopeProposalTimeoutMs: 120_000,
  heartbeatIntervalMs: 15_000,
  heartbeatMissLimit: 2,
  maxMessageBytes: 16 * 1024 * 1024,
  screenshotDefaultSize: 512,
  screenshotMaxSize: 1920,
  maxTextureDataUrlBytes: 8 * 1024 * 1024,
} as const;

export const ERROR_CODES = [
  'E_PLUGIN_NOT_CONNECTED',
  'E_SECRET_MISSING',
  'E_AUTH_FAILED',
  'E_SESSION_EXISTS',
  'E_PORT_IN_USE',
  'E_PROTOCOL_MISMATCH',
  'E_TIMEOUT',
  'E_INVALID_PARAMS',
  'E_UNSUPPORTED_COMMAND',
  'E_SCOPE_NOT_CONFIRMED',
  'E_SCOPE_EXPIRED',
  'E_SCOPE_REVOKED',
  'E_PATH_OUTSIDE_SCOPE',
  'E_FILE_EXISTS',
  'E_PREFLIGHT_FAILED',
  'E_NOT_FOUND',
  'E_FORMAT_UNSUPPORTED',
  'E_BLOCKBENCH_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const errorPayloadSchema = z.object({
  code: z.enum(ERROR_CODES),
  message: z.string(),
  details: z.unknown().optional(),
});

export type ErrorPayload = z.infer<typeof errorPayloadSchema>;

// ---------------------------------------------------------------------------
// Scope status (session-only scoped-directory state machine)
// ---------------------------------------------------------------------------

export const SCOPE_STATES = ['unconfirmed', 'proposed', 'confirmed', 'revoked', 'expired'] as const;

export const scopeStatusSchema = z.object({
  state: z.enum(SCOPE_STATES),
  normalized_path: z.string().optional(),
});

export type ScopeStatus = z.infer<typeof scopeStatusSchema>;

// ---------------------------------------------------------------------------
// Common result fragments
// ---------------------------------------------------------------------------

// Write results report the normalized destination path plus whether the file
// was created, updated without conflict, or explicitly overwritten. With the
// per-operation overwrite flag rules of this protocol, the current write
// commands report 'created' or 'overwritten'; 'updated' is reserved for
// future non-conflicting update semantics.
export const writeResultSchema = z.object({
  path: z.string(),
  status: z.enum(['created', 'updated', 'overwritten']),
  bytes: z.number().int().nonnegative(),
});

export type WriteResult = z.infer<typeof writeResultSchema>;

const vec3 = z.tuple([z.number(), z.number(), z.number()]);

const cubeFaceNames = ['north', 'south', 'east', 'west', 'up', 'down'] as const;

// ---------------------------------------------------------------------------
// Command registry
// ---------------------------------------------------------------------------

export interface CommandSpec {
  description: string;
  /** True when the command mutates Blockbench project state or files. */
  mutates: boolean;
  params: z.ZodTypeAny;
  result: z.ZodTypeAny;
  /** Adapter-side request timeout override in milliseconds. */
  timeoutMs?: number;
}

const getPluginStatusParams = z.object({}).strict();
const getPluginStatusResult = z.object({
  plugin_version: z.string(),
  blockbench_version: z.string(),
  protocol_version: z.number().int(),
  capabilities: z.array(z.string()),
  scope: scopeStatusSchema,
});

const getProjectStateParams = z
  .object({
    include_objects: z.boolean().optional().describe('Include per-object identifier lists (default true).'),
  })
  .strict();
const getProjectStateResult = z.object({
  open: z.boolean(),
  format: z.string().optional(),
  name: z.string().optional(),
  saved: z.boolean().optional(),
  counts: z
    .object({
      cubes: z.number().int().nonnegative(),
      groups: z.number().int().nonnegative(),
      textures: z.number().int().nonnegative(),
    })
    .optional(),
  cubes: z.array(z.object({ uuid: z.string(), name: z.string() })).optional(),
  groups: z.array(z.object({ uuid: z.string(), name: z.string() })).optional(),
  textures: z.array(z.object({ uuid: z.string(), name: z.string(), id: z.string().optional() })).optional(),
});

const createProjectParams = z
  .object({
    format: z.literal('java_block'),
    name: z.string().optional(),
    force: z
      .boolean()
      .optional()
      .describe('Required when an unsaved project is open; the new project opens in a separate tab.'),
  })
  .strict();
const createProjectResult = z.object({
  created: z.boolean(),
  format: z.string(),
  name: z.string().optional(),
});

const openModelParams = z
  .object({
    path: z.string().describe('Model JSON path inside the confirmed scoped directory (absolute or scope-relative).'),
    force: z
      .boolean()
      .optional()
      .describe('Required when an unsaved project is open; the model opens in a separate tab.'),
  })
  .strict();
const openModelResult = z.object({
  opened: z.boolean(),
  format: z.string(),
  name: z.string().optional(),
  counts: z.object({
    cubes: z.number().int().nonnegative(),
    groups: z.number().int().nonnegative(),
    textures: z.number().int().nonnegative(),
  }),
});

const cubeRotationSchema = z.object({
  axis: z.enum(['x', 'y', 'z']),
  angle: z.number(),
  origin: vec3.optional(),
});

const createCubesParams = z
  .object({
    cubes: z
      .array(
        z
          .object({
            name: z.string().optional(),
            from: vec3,
            to: vec3,
            origin: vec3.optional(),
            rotation: cubeRotationSchema.optional(),
            group_uuid: z.string().optional(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
const createCubesResult = z.object({
  cubes: z.array(z.object({ uuid: z.string(), name: z.string() })),
});

const updateCubeParams = z
  .object({
    uuid: z.string(),
    set: z
      .object({
        name: z.string().optional(),
        from: vec3.optional(),
        to: vec3.optional(),
        origin: vec3.optional(),
        rotation: cubeRotationSchema.nullable().optional(),
        visibility: z.boolean().optional(),
      })
      .strict(),
  })
  .strict();
const updateCubeResult = z.object({ uuid: z.string(), updated: z.literal(true) });

const deleteCubesParams = z.object({ uuids: z.array(z.string()).min(1) }).strict();
const deleteCubesResult = z.object({ deleted: z.number().int().nonnegative() });

const createGroupParams = z
  .object({
    name: z.string(),
    parent_uuid: z.string().optional(),
    origin: vec3.optional(),
  })
  .strict();
const createGroupResult = z.object({ uuid: z.string(), name: z.string() });

const updateGroupParams = z
  .object({
    uuid: z.string(),
    set: z
      .object({
        name: z.string().optional(),
        origin: vec3.optional(),
        parent_uuid: z.string().optional(),
      })
      .strict(),
  })
  .strict();
const updateGroupResult = z.object({ uuid: z.string(), updated: z.literal(true) });

const deleteGroupParams = z
  .object({
    uuid: z.string(),
    keep_children: z.boolean().optional().describe('Move children to the parent instead of deleting them (default false).'),
  })
  .strict();
const deleteGroupResult = z.object({ deleted: z.literal(true) });

const assignTextureParams = z
  .object({
    source: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('path'), path: z.string() }).strict(),
      z.object({ kind: z.literal('data_url'), data_url: z.string() }).strict(),
    ]),
    name: z.string().optional(),
    apply_to: z.union([
      z.literal('all'),
      z
        .object({
          cube_uuids: z.array(z.string()).min(1),
          faces: z.array(z.enum(cubeFaceNames)).optional(),
        })
        .strict(),
    ]),
  })
  .strict();
const assignTextureResult = z.object({
  texture_uuid: z.string(),
  name: z.string(),
  applied_to: z.union([z.literal('all'), z.array(z.string())]),
});

export const JAVA_DISPLAY_SLOTS = [
  'thirdperson_righthand',
  'thirdperson_lefthand',
  'firstperson_righthand',
  'firstperson_lefthand',
  'ground',
  'gui',
  'head',
  'fixed',
] as const;

const setDisplayTransformParams = z
  .object({
    slot: z.enum(JAVA_DISPLAY_SLOTS),
    translation: vec3.optional(),
    rotation: vec3.optional(),
    scale: vec3.optional(),
  })
  .strict();
const setDisplayTransformResult = z.object({ slot: z.enum(JAVA_DISPLAY_SLOTS), updated: z.literal(true) });

const exportModelParams = z
  .object({
    path: z.string(),
    overwrite: z
      .boolean()
      .optional()
      .describe('Required to replace an existing file at the destination; applies to this write only.'),
  })
  .strict();

const readFileParams = z
  .object({
    path: z.string(),
    encoding: z.enum(['utf8', 'base64']).optional(),
    // Bounded so a response can never exceed the transport's frame limit.
    max_bytes: z.number().int().positive().max(DEFAULTS.maxTextureDataUrlBytes).optional(),
  })
  .strict();
const readFileResult = z.object({
  path: z.string(),
  content: z.string(),
  encoding: z.enum(['utf8', 'base64']),
  bytes: z.number().int().nonnegative(),
});

const writeFilesParams = z
  .object({
    files: z
      .array(
        z
          .object({
            path: z.string(),
            content: z.string(),
            encoding: z.enum(['utf8', 'base64']).optional(),
            overwrite: z
              .boolean()
              .optional()
              .describe('Required to replace an existing file at this destination; applies to this file only.'),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
const writeFilesResult = z.object({ results: z.array(writeResultSchema) });

const captureScreenshotParams = z
  .object({
    width: z.number().int().positive().max(DEFAULTS.screenshotMaxSize).optional(),
    height: z.number().int().positive().max(DEFAULTS.screenshotMaxSize).optional(),
  })
  .strict();
const captureScreenshotResult = z.object({
  data_url: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

const validateProjectParams = z.object({}).strict();
const validateProjectResult = z.object({
  diagnostics: z.array(
    z.object({
      severity: z.enum(['error', 'warning']),
      message: z.string(),
      check_id: z.string().optional(),
    }),
  ),
});

const proposeScopedDirectoryParams = z
  .object({
    path: z.string().describe('Absolute directory path proposed for session-scoped AI file access.'),
    reason: z.string().optional().describe('Shown to the Blockbench user in the confirmation dialog.'),
  })
  .strict();
const proposeScopedDirectoryResult = z.object({
  state: z.enum(['confirmed']),
  normalized_path: z.string(),
});

// Format-neutral operations work in any Blockbench project format and are the
// reuse surface for later format adapters.
export const FORMAT_NEUTRAL_COMMAND_SPECS = {
  get_plugin_status: {
    description: 'Report plugin/Blockbench versions, capabilities, and scoped-directory status. Read-only.',
    mutates: false,
    params: getPluginStatusParams,
    result: getPluginStatusResult,
  },
  get_project_state: {
    description:
      'Inspect the currently open project: format, name, object counts, and object identifiers. Read-only.',
    mutates: false,
    params: getProjectStateParams,
    result: getProjectStateResult,
  },
  create_cubes: {
    description: 'Create new cube elements. Always creates new objects and returns their UUIDs.',
    mutates: true,
    params: createCubesParams,
    result: createCubesResult,
  },
  update_cube: {
    description: 'Update one existing cube addressed by UUID. Fails with E_NOT_FOUND for unknown UUIDs.',
    mutates: true,
    params: updateCubeParams,
    result: updateCubeResult,
  },
  delete_cubes: {
    description: 'Delete existing cubes addressed by UUID.',
    mutates: true,
    params: deleteCubesParams,
    result: deleteCubesResult,
  },
  create_group: {
    description: 'Create a new group/bone. Always creates a new object and returns its UUID.',
    mutates: true,
    params: createGroupParams,
    result: createGroupResult,
  },
  update_group: {
    description: 'Update one existing group addressed by UUID. Fails with E_NOT_FOUND for unknown UUIDs.',
    mutates: true,
    params: updateGroupParams,
    result: updateGroupResult,
  },
  delete_group: {
    description: 'Delete an existing group addressed by UUID; children move to the parent when keep_children is true.',
    mutates: true,
    params: deleteGroupParams,
    result: deleteGroupResult,
  },
  assign_texture: {
    description:
      'Add a texture from a scoped file path or data URL and apply it to all cubes or to selected cubes/faces. Creates a new texture object.',
    mutates: true,
    params: assignTextureParams,
    result: assignTextureResult,
  },
  read_file: {
    description: 'Read a file inside the confirmed scoped directory. Read-only.',
    mutates: false,
    params: readFileParams,
    result: readFileResult,
  },
  write_files: {
    description:
      'Write one or more files inside the confirmed scoped directory. Preflights all destinations and writes nothing when any blocker exists; each overwrite must be explicitly flagged per file.',
    mutates: true,
    params: writeFilesParams,
    result: writeFilesResult,
  },
  capture_screenshot: {
    description: 'Capture a bounded screenshot of the model preview as a data URL. Read-only.',
    mutates: false,
    params: captureScreenshotParams,
    result: captureScreenshotResult,
  },
  validate_project: {
    description: 'Run Blockbench validation checks and return structured diagnostics. Read-only.',
    mutates: false,
    params: validateProjectParams,
    result: validateProjectResult,
  },
  propose_scoped_directory: {
    description:
      'Propose a directory for session-scoped AI file access. The Blockbench user must confirm inside Blockbench; rejection returns E_SCOPE_NOT_CONFIRMED.',
    mutates: true,
    params: proposeScopedDirectoryParams,
    result: proposeScopedDirectoryResult,
    timeoutMs: DEFAULTS.scopeProposalTimeoutMs,
  },
} as const satisfies Record<string, CommandSpec>;

// Format-specific commands for the Minecraft Java block/item adapter
// (Blockbench format id `java_block`). Later format adapters add their own
// group without touching the format-neutral surface.
export const JAVA_FORMAT_COMMAND_SPECS = {
  create_project: {
    description:
      'Create a new Minecraft Java block/item project (Blockbench format java_block) in a new project tab. When an unsaved project is open, force:true is required.',
    mutates: true,
    params: createProjectParams,
    result: createProjectResult,
  },
  open_model: {
    description:
      'Open a Java block/item model JSON file from the confirmed scoped directory via the java_block codec, in a new project tab. When an unsaved project is open, force:true is required.',
    mutates: true,
    params: openModelParams,
    result: openModelResult,
  },
  set_display_transform: {
    description: 'Set the Java display transform (translation/rotation/scale) for one display slot. Updates in place.',
    mutates: true,
    params: setDisplayTransformParams,
    result: setDisplayTransformResult,
  },
  export_model: {
    description:
      'Export the current project through the java_block codec to a file inside the confirmed scoped directory. Overwrite must be explicitly flagged.',
    mutates: true,
    params: exportModelParams,
    result: writeResultSchema,
  },
} as const satisfies Record<string, CommandSpec>;

export const COMMAND_SPECS = {
  ...FORMAT_NEUTRAL_COMMAND_SPECS,
  ...JAVA_FORMAT_COMMAND_SPECS,
} as const;

export type CommandName = keyof typeof COMMAND_SPECS;

export const COMMAND_NAMES = Object.keys(COMMAND_SPECS) as CommandName[];

export function isCommandName(value: string): value is CommandName {
  return Object.prototype.hasOwnProperty.call(COMMAND_SPECS, value);
}

// ---------------------------------------------------------------------------
// Message envelopes
// ---------------------------------------------------------------------------

export const helloMessageSchema = z
  .object({
    type: z.literal('hello'),
    protocol_version: z.number().int(),
    secret: z.string().min(1),
    plugin_version: z.string(),
    blockbench_version: z.string(),
    capabilities: z.array(z.string()),
  })
  .strict();

export type HelloMessage = z.infer<typeof helloMessageSchema>;

export const helloAckMessageSchema = z
  .object({
    type: z.literal('hello_ack'),
    protocol_version: z.number().int(),
    heartbeat_interval_ms: z.number().int().positive(),
    // Adapter-side capability flags: the extension surface for later format
    // adapters, mirroring the plugin's capabilities in hello.
    capabilities: z.array(z.string()),
  })
  .strict();

export type HelloAckMessage = z.infer<typeof helloAckMessageSchema>;

export const requestMessageSchema = z
  .object({
    type: z.literal('request'),
    id: z.string().min(1),
    command: z.string(),
    params: z.unknown(),
  })
  .strict();

export type RequestMessage = z.infer<typeof requestMessageSchema>;

export const responseMessageSchema = z
  .object({
    type: z.literal('response'),
    id: z.string().min(1),
    ok: z.boolean(),
    result: z.unknown().optional(),
    error: errorPayloadSchema.optional(),
  })
  .strict()
  .superRefine((message, ctx) => {
    if (message.ok && message.error !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'A successful response must not carry an error payload.' });
    }
    if (!message.ok && message.error === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'A failed response must carry an error payload.' });
    }
  });

export type ResponseMessage = z.infer<typeof responseMessageSchema>;

export const eventMessageSchema = z
  .object({
    type: z.literal('event'),
    event: z.string(),
    data: z.unknown().optional(),
  })
  .strict();

export type EventMessage = z.infer<typeof eventMessageSchema>;

/** Messages the plugin may send to the adapter. (A plain union because the
 * refined response schema cannot join a discriminated union in zod v3.) */
export const pluginToAdapterMessageSchema = z.union([
  helloMessageSchema,
  responseMessageSchema,
  eventMessageSchema,
]);

export type PluginToAdapterMessage = z.infer<typeof pluginToAdapterMessageSchema>;

/** Messages the adapter may send to the plugin. */
export const adapterToPluginMessageSchema = z.discriminatedUnion('type', [
  helloAckMessageSchema,
  requestMessageSchema,
]);

export type AdapterToPluginMessage = z.infer<typeof adapterToPluginMessageSchema>;

export function makeError(code: ErrorCode, message: string, details?: unknown): ErrorPayload {
  return details === undefined ? { code, message } : { code, message, details };
}
