/** 好感度养成（rapport）v1.2.0 · nuoxi4n */

import * as utils from './lib/utils.js';
import * as levels from './lib/levels.js';
import * as config from './lib/config.js';
import * as messages from './lib/messages.js';
import * as storage from './lib/storage.js';
import * as scoring from './lib/scoring.js';
import * as relationship from './lib/relationship.js';
import * as context from './lib/tools/context.js';
import * as tools from './lib/tools/index.js';
import * as check from './lib/tools/check.js';
import * as rank from './lib/tools/rank.js';
import * as tune from './lib/tools/tune.js';
import * as reset from './lib/tools/reset.js';
import * as adjust from './lib/tools/adjust.js';
import * as events from './lib/events.js';
import { createPlugin } from './lib/plugin.js';

const modules = {
  utils, levels, config, messages, storage, scoring, relationship,
  context, tools, check, rank, tune, reset, adjust, events
};

// 独立实例供宿主和测试使用；模块加载遵循标准 ESM 静态导入。
export function createRapportPlugin() {
  return createPlugin(modules, import.meta.url);
}
const plugin = createRapportPlugin();

export const {
  setup, activate, deactivate, dispose, available, hooks, promptSections, providers,
  applyDecay, ownerList, normalizeEntry, findMember,
  levelTable, levelOf, titleOf, progressText, relationshipText
} = plugin;
