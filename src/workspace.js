import fs from "node:fs";
import path from "node:path";
import { resolveInside } from "./paths.js";

export class Workspace {
  constructor() {
    this.root = path.resolve(process.env.WORKSPACE_ROOT ?? process.cwd());
  }

  readFile(relPath) {
    const full = resolveInside(this.root, relPath);
    return fs.readFileSync(full, "utf8");
  }

  writeFile(relPath, content, createDirs = true) {
    const full = resolveInside(this.root, relPath);
    if (createDirs) fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf8");
  }
}
