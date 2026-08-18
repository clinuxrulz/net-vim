/**
 * Bundled Lua plugins shipped with Net-Vim (resolved by the Lua module loader
 * before the OPFS `.config/net-vim/lua` directory, so user files win).
 *
 * which-key.nvim is vendored from https://github.com/folke/which-key.nvim
 * (tag v3.17.0, MIT — see src/lua-plugins/which-key/LICENSE).
 */
import bufRaw from './which-key/buf.lua?raw';
import colorsRaw from './which-key/colors.lua?raw';
import configRaw from './which-key/config.lua?raw';
import iconsRaw from './which-key/icons.lua?raw';
import initRaw from './which-key/init.lua?raw';
import layoutRaw from './which-key/layout.lua?raw';
import mappingsRaw from './which-key/mappings.lua?raw';
import nodeRaw from './which-key/node.lua?raw';
import pluginsInitRaw from './which-key/plugins/init.lua?raw';
import pluginsMarksRaw from './which-key/plugins/marks.lua?raw';
import pluginsPresetsRaw from './which-key/plugins/presets.lua?raw';
import pluginsRegistersRaw from './which-key/plugins/registers.lua?raw';
import pluginsSpellingRaw from './which-key/plugins/spelling.lua?raw';
import presetsRaw from './which-key/presets.lua?raw';
import stateRaw from './which-key/state.lua?raw';
import textRaw from './which-key/text.lua?raw';
import treeRaw from './which-key/tree.lua?raw';
import triggersRaw from './which-key/triggers.lua?raw';
import typesRaw from './which-key/types.lua?raw';
import utilRaw from './which-key/util.lua?raw';
import viewRaw from './which-key/view.lua?raw';
import winRaw from './which-key/win.lua?raw';

/**
 * Map of relative path (under `.config/net-vim/lua`) -> Lua source.
 */
export const LUA_PLUGIN_FILES: Record<string, string> = {
  'which-key/init.lua': initRaw,
  'which-key/buf.lua': bufRaw,
  'which-key/colors.lua': colorsRaw,
  'which-key/config.lua': configRaw,
  'which-key/icons.lua': iconsRaw,
  'which-key/layout.lua': layoutRaw,
  'which-key/mappings.lua': mappingsRaw,
  'which-key/node.lua': nodeRaw,
  'which-key/presets.lua': presetsRaw,
  'which-key/state.lua': stateRaw,
  'which-key/text.lua': textRaw,
  'which-key/tree.lua': treeRaw,
  'which-key/triggers.lua': triggersRaw,
  'which-key/types.lua': typesRaw,
  'which-key/util.lua': utilRaw,
  'which-key/view.lua': viewRaw,
  'which-key/win.lua': winRaw,
  'which-key/plugins/init.lua': pluginsInitRaw,
  'which-key/plugins/marks.lua': pluginsMarksRaw,
  'which-key/plugins/presets.lua': pluginsPresetsRaw,
  'which-key/plugins/registers.lua': pluginsRegistersRaw,
  'which-key/plugins/spelling.lua': pluginsSpellingRaw,
};
