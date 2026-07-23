#!/usr/bin/env node

import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import {
  canonicalJson,
  type ActiveMemberPrincipalV1,
  type WorldManifestV1,
} from '@worldgraph/contracts';

import {
  compileWorld,
  createCompilerInputBundle,
  verifyCompiledArtifact,
  type ExactPrimitiveSource,
} from './index.js';

export interface WorldgraphCliIo {
  error(message: string): void;
  output(message: string): void;
}

const defaultIo: WorldgraphCliIo = {
  error: (message) => console.error(message),
  output: (message) => console.log(message),
};

function argumentsByName(args: readonly string[]): Map<string, string> {
  const parsed = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith('--') || value === undefined || value.startsWith('--')) {
      throw new TypeError(`Expected --name value argument near ${flag ?? '<end>'}.`);
    }
    if (parsed.has(flag)) throw new TypeError(`Duplicate argument ${flag}.`);
    parsed.set(flag, value);
  }
  return parsed;
}

function required(args: ReadonlyMap<string, string>, name: string): string {
  const value = args.get(name);
  if (!value) throw new TypeError(`Missing required argument ${name}.`);
  return value;
}

async function readJson(path: string): Promise<unknown> {
  const bytes = await readFile(path, 'utf8');
  if (Buffer.byteLength(bytes, 'utf8') > 8 * 1024 * 1024) {
    throw new TypeError(`Input file exceeds 8 MiB: ${path}`);
  }
  return JSON.parse(bytes) as unknown;
}

function manifestFrom(value: unknown): WorldManifestV1 {
  if (value !== null && typeof value === 'object' && 'manifest' in value) {
    return value.manifest as WorldManifestV1;
  }
  return value as WorldManifestV1;
}

async function compileCommand(args: readonly string[], io: WorldgraphCliIo): Promise<number> {
  const flags = argumentsByName(args);
  const manifestPath = required(flags, '--manifest');
  const catalogPath = required(flags, '--catalog');
  const seed = required(flags, '--seed');
  const outputDirectory = required(flags, '--output');
  const manifest = manifestFrom(await readJson(manifestPath));
  const catalog = await readJson(catalogPath);
  if (catalog === null || typeof catalog !== 'object' || !('primitives' in catalog)) {
    throw new TypeError('Catalog snapshot must be an object containing exact primitives.');
  }
  const activeMembers = flags.has('--members')
    ? ((await readJson(required(flags, '--members'))) as ActiveMemberPrincipalV1[])
    : [];
  const bundle = createCompilerInputBundle({
    activeMembers,
    manifest,
    primitives: catalog.primitives as ExactPrimitiveSource[],
    seed,
  });
  const result = compileWorld(bundle);
  if (!result.artifact) {
    io.error(canonicalJson({ diagnostics: result.diagnostics, inputHash: result.inputHash }));
    return 2;
  }
  await mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    writeFile(`${outputDirectory}/compiler-input.json`, canonicalJson(bundle), 'utf8'),
    writeFile(`${outputDirectory}/compiled-artifact.json`, canonicalJson(result.artifact), 'utf8'),
    writeFile(`${outputDirectory}/compiled-world.json`, result.artifact.canonicalBytes, 'utf8'),
  ]);
  io.output(
    canonicalJson({
      artifactHash: result.artifact.contentHash,
      controllers: result.artifact.world.counts.controllers,
      entities: result.artifact.world.counts.entities,
      inputHash: result.inputHash,
      relationships: result.artifact.world.counts.relationships,
    }),
  );
  return 0;
}

async function verifyCommand(args: readonly string[], io: WorldgraphCliIo): Promise<number> {
  const flags = argumentsByName(args);
  const value = await readJson(required(flags, '--artifact'));
  const verification = verifyCompiledArtifact(value);
  if (!verification.valid) {
    io.error(canonicalJson(verification));
    return 2;
  }
  io.output(canonicalJson({ artifactHash: verification.computedHash, valid: true }));
  return 0;
}

export async function runWorldgraphCli(
  argv: readonly string[],
  io: WorldgraphCliIo = defaultIo,
): Promise<number> {
  try {
    const [command, ...args] = argv;
    switch (command) {
      case 'compile':
        return await compileCommand(args, io);
      case 'verify-artifact':
        return await verifyCommand(args, io);
      default:
        io.error(
          'Usage: worldgraph compile --manifest FILE --catalog FILE --seed SEED --output DIR [--members FILE]\n' +
            '   or: worldgraph verify-artifact --artifact FILE',
        );
        return 1;
    }
  } catch (error) {
    io.error(error instanceof Error ? error.message : 'Unknown CLI failure.');
    return 2;
  }
}

const executedPath = process.argv[1];
if (executedPath && import.meta.url === pathToFileURL(await realpath(executedPath)).href) {
  process.exitCode = await runWorldgraphCli(process.argv.slice(2));
}
