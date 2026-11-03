import {
  File,
  FileArchive,
  FileCode2,
  FileImage,
  FileJson2,
  FileText,
  Folder,
  Package,
  ScrollText,
  type LucideIcon,
} from 'lucide-react';
import type { FileEntry } from '@mornihosting/shared';

/** What the file manager knows about a file from its name: icon, and whether the editor can open it. */

const ICONS: Readonly<Record<string, LucideIcon>> = {
  jar: Package,
  disabled: Package,
  zip: FileArchive,
  gz: FileArchive,
  tar: FileArchive,
  json: FileJson2,
  json5: FileJson2,
  yml: FileCode2,
  yaml: FileCode2,
  toml: FileCode2,
  properties: FileCode2,
  conf: FileCode2,
  cfg: FileCode2,
  ini: FileCode2,
  sh: FileCode2,
  js: FileCode2,
  mcmeta: FileCode2,
  txt: FileText,
  md: FileText,
  log: ScrollText,
  png: FileImage,
  jpg: FileImage,
  jpeg: FileImage,
  gif: FileImage,
  webp: FileImage,
};

const BINARY = new Set([
  'jar',
  'disabled',
  'zip',
  'gz',
  'tar',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'dat',
  'mca',
  'db',
  'sqlite',
  'exe',
  'so',
  'dll',
  'nbt',
  'schem',
  'schematic',
  'litematic',
  'class',
  'lock',
]);

/** Files above this size open as download instead of in the editor (matches the server limit). */
const EDITOR_MAX_BYTES = 5 * 1024 * 1024; // eslint-disable-line ts-patterns/no-magic-numbers -- 5 MB

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

export function iconFor(entry: Pick<FileEntry, 'name' | 'type'>): LucideIcon {
  if (entry.type === 'dir') return Folder;
  return ICONS[extensionOf(entry.name)] ?? File;
}

export function isEditable(entry: Pick<FileEntry, 'name' | 'type' | 'size'>): boolean {
  return entry.type === 'file' && !BINARY.has(extensionOf(entry.name)) && entry.size <= EDITOR_MAX_BYTES;
}

export function isZip(entry: Pick<FileEntry, 'name' | 'type'>): boolean {
  return entry.type === 'file' && extensionOf(entry.name) === 'zip';
}

export function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

export function parentOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash > 0 ? path.slice(0, slash) : '';
}

export function downloadUrl(serverId: string, path: string): string {
  return `/api/servers/${serverId}/files/download?path=${encodeURIComponent(path)}`;
}
