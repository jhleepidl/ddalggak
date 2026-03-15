import path from "node:path";
import { loadPresetSpecs } from "./preset_spec_loader.js";
import { compilePresetSpecList } from "./preset_compiler.js";

export class PresetRegistry {
  constructor({
    presetsDir = path.resolve(process.cwd(), "presets"),
  } = {}) {
    this.presetsDir = presetsDir;
    this.presets = [];
    this.byId = new Map();
  }

  load({ refresh = false } = {}) {
    if (!refresh && this.presets.length > 0) {
      return {
        presets: [...this.presets],
        presets_dir: this.presetsDir,
      };
    }
    const specs = loadPresetSpecs(this.presetsDir);
    const compiled = compilePresetSpecList(specs);
    this.presets = compiled;
    this.byId = new Map(compiled.map((preset) => [preset.preset_id, preset]));
    return {
      presets: [...this.presets],
      presets_dir: this.presetsDir,
    };
  }

  ensureLoaded() {
    if (this.presets.length === 0) this.load();
    return this;
  }

  list({
    roleId = "",
  } = {}) {
    this.ensureLoaded();
    const key = String(roleId || "").trim().toLowerCase();
    if (!key) return [...this.presets];
    return this.presets.filter((preset) => String(preset.role_id || "").trim().toLowerCase() === key);
  }

  resolve(presetId = "") {
    this.ensureLoaded();
    const key = String(presetId || "").trim().toLowerCase();
    if (!key) return null;
    return this.byId.get(key) || null;
  }
}
