// Synthetic 2x2 RGB PNG with valid chunk CRCs and zlib-compressed scanlines.
// No real person's image, network, model, or process environment is used.
import { writeFileSync } from "node:fs";
import path from "node:path";

export const AVATAR_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGNwaDgARAwQCgAoDgYBQzpj2gAAAABJRU5ErkJggg==", "base64");

export function writeAvatar(home, filename = "synthetic-avatar.png") {
  const file = path.resolve(home, filename);
  writeFileSync(file, AVATAR_PNG, { mode: 0o600 });
  return file;
}
