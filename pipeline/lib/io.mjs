// io.mjs — tiny JSON read/write helpers that resolve paths under public/data.
//
// The repo IS the database: every step reads and writes plain JSON files here.
// Paths passed to these helpers are relative to public/data unless absolute.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// pipeline/lib -> repo root is two levels up.
const REPO_ROOT = resolve(__dirname, "..", "..");
export const DATA_DIR = resolve(REPO_ROOT, "public", "data");

// Resolve a path relative to public/data (absolute paths pass through).
export function dataPath(p) {
  return isAbsolute(p) ? p : resolve(DATA_DIR, p);
}

// Read + parse a JSON file. Returns `fallback` if the file is missing or
// unparseable, so a step never crashes on a fresh/empty repo.
export async function readJson(path, fallback = null) {
  try {
    const raw = await readFile(dataPath(path), "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") return fallback;
    console.warn(`[io] readJson(${path}) failed: ${err.message} — using fallback`);
    return fallback;
  }
}

// Pretty-write an object as JSON (creating parent dirs as needed).
// Returns the absolute path written.
export async function writeJson(path, obj) {
  const full = dataPath(path);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, JSON.stringify(obj, null, 2) + "\n", "utf8");
  return full;
}
