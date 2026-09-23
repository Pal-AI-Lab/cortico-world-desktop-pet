import { runtimesRoot, modelsRoot } from 'cortico/paths.ts';
import type { WorldDefinition } from 'cortico/world.ts';
import { DESKTOP_PET_DEFAULTS, DESKTOP_PET_ID, type DesktopPetConfigSection } from './config.ts';
import { DesktopPetWorld, modelsDirFor } from './world.ts';

export const DESKTOP_PET: WorldDefinition<DesktopPetConfigSection> = {
  id: DESKTOP_PET_ID,
  label: '桌宠',
  defaults: () => structuredClone(DESKTOP_PET_DEFAULTS),
  // ctx.cfg is the live `worlds.desktop-pet` section: hot keys are read at use
  create: (ctx) => new DesktopPetWorld({
    cfg: ctx.cfg,
    timezone: ctx.timezone,
    persist: (patch) => ctx.persist(patch),
    runtimesRoot,
    modelsDir: () => modelsDirFor(modelsRoot()),
  }),
};
