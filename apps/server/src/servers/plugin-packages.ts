import fs from 'node:fs';
import path from 'node:path';
import { readZipText } from '../lib/zip.js';

/**
 * Which plugin or mod owns which Java package, read from the jars in plugins/ and mods/. The crash helper matches
 * stack traces against it, so it can say "Essentials caused it" instead of "unknown".
 */

const FOLDERS = ['plugins', 'mods'] as const;
const DESCRIPTORS = [
  'plugin.yml',
  'paper-plugin.yml',
  'bungee.yml',
  'velocity-plugin.json',
  'fabric.mod.json',
];
const MAX_DESCRIPTOR_BYTES = 256 * 1024;
const JAR = '.jar';

// plugin.yml: "main: com.earth2me.essentials.Essentials" → "com.earth2me.essentials.Essentials"; "name: Essentials" → "Essentials".
// https://regex101.com/?flavor=javascript&regex=%5E(main%7Cname)%3A%5Cs*%5B'%22%5D%3F(%5B%5E'%22%5Cs%23%5D%2B)&flags=gm&testString=name%3A%20Essentials%0Amain%3A%20com.earth2me.essentials.Essentials%0Aversion%3A%202.21
const YAML_FIELD = /^(main|name):\s*['"]?([^'"\s#]+)/gm;
// JSON (fabric.mod.json, velocity-plugin.json): "main": "a.b.C", "name": "X", or the first entrypoint "main": ["a.b.C"].
// https://regex101.com/?flavor=javascript&regex=%22(main%7Cname)%22%5Cs*%3A%5Cs*%5C%5B%3F%5Cs*%22(%5B%5E%22%5D%2B)%22&flags=g&testString=%7B%22name%22%3A%20%22Sodium%22%2C%20%22entrypoints%22%3A%20%7B%22main%22%3A%20%5B%22me.jellysquid.Sodium%22%5D%7D%7D
const JSON_FIELD = /"(main|name)"\s*:\s*\[?\s*"([^"]+)"/g;
// A class name's package: "com.earth2me.essentials.Essentials" → "com.earth2me.essentials".
// https://regex101.com/?flavor=javascript&regex=%5C.%5B%5E.%5D%2B%24&testString=com.earth2me.essentials.Essentials
const CLASS_PART = /\.[^.]+$/;

function fieldsOf(text: string): { main?: string; name?: string } {
  const pairs = [...text.matchAll(YAML_FIELD), ...text.matchAll(JSON_FIELD)].map(
    (m) => [m[1], m[2]] as const,
  );
  return {
    main: pairs.find(([key]) => key === 'main')?.[1],
    name: pairs.find(([key]) => key === 'name')?.[1],
  };
}

export interface PackageOwner {
  readonly name: string;
  /** The jar, relative to the server folder ("plugins/EssentialsX-2.21.0.jar"). */
  readonly file: string;
}

async function describe(serverDir: string, file: string): Promise<readonly [string, PackageOwner] | null> {
  try {
    const text = await readZipText(file, DESCRIPTORS, MAX_DESCRIPTOR_BYTES);
    if (!text) return null;
    const { main, name } = fieldsOf(text);
    if (!main?.includes('.')) return null;
    return [
      main.replace(CLASS_PART, ''),
      { name: name ?? path.basename(file, JAR), file: path.relative(serverDir, file) },
    ];
  } catch {
    return null;
  }
}

export async function pluginPackages(serverDir: string): Promise<Record<string, PackageOwner>> {
  const jars = FOLDERS.flatMap((folder) => {
    try {
      return fs
        .readdirSync(path.join(serverDir, folder))
        .filter((name) => name.endsWith(JAR))
        .map((name) => path.join(serverDir, folder, name));
    } catch {
      return [];
    }
  });
  const found = await Promise.all(jars.map((jar) => describe(serverDir, jar)));
  return Object.fromEntries(found.filter((pair): pair is readonly [string, PackageOwner] => pair !== null));
}
