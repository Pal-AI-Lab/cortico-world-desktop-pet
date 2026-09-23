/** Package entry: the default export is the `WorldDefinition`. */
import { DESKTOP_PET } from './definition.ts';

export default DESKTOP_PET;

export { DESKTOP_PET };
export { DESKTOP_PET_DEFAULTS, DESKTOP_PET_CONFIG_GROUP, DESKTOP_PET_ASR_CONFIG_GROUP } from './config.ts';
export type { DesktopPetConfigSection, PetSkin } from './config.ts';
export { DesktopPetWorld } from './world.ts';
export { HOST_ENV, HOST_MAIN } from './window-host.ts';
