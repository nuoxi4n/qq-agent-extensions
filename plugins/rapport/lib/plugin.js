// 组装实例和生命周期；模块之间通过显式服务对象协作，不共享全局状态。
import { createReplyGuard } from './reply-guard.js';
export function createPlugin(modules, pluginUrl) {
  let api = null;
  let flushTimer = null;
  const lifecycle = { running: false, epoch: 0 };
  const replyGuard = createReplyGuard();
  const log = (...args) => api?.log?.(...args);
  const warn = (...args) => api?.warn?.(...args);
  const utils = modules.utils;
  const levels = modules.levels.createLevels(utils);
  const storage = modules.storage.createStorage({ ...utils, pluginUrl, warn });
  const configuration = modules.config.createConfiguration({
    ...utils, ...levels,
    readConfig: () => api?.config?.() || {},
    readOverrides: () => storage.db?.meta?.overrides
  });
  const messages = modules.messages.createMessages(utils);
  const services = {
    ...utils, ...levels, ...configuration, ...messages,
    ensureLoaded: storage.ensureLoaded, getChat: storage.getChat,
    newRecord: storage.newRecord, markDirty: storage.markDirty, flush: storage.flush,
    storage, lifecycle, log, warn, assertRunning
  };
  const scoring = modules.scoring.createScoring(services);
  Object.assign(services, scoring);
  const relationship = modules.relationship.createRelationship(services);
  Object.assign(services, { getRun: relationship.getRun });
  Object.assign(services, modules.context.createToolContext(services));

  function assertRunning(epoch) {
    if (!lifecycle.running || epoch !== lifecycle.epoch) {
      const error = new Error('插件已停用或重新加载，本次操作已取消。');
      error.code = 'rapport-cancelled';
      throw error;
    }
  }

  function setup(hostApi) {
    api = hostApi;
    modules.tools.registerTools(api, services, [
      modules.check.createTool, modules.rank.createTool,
      modules.tune.createTool, modules.reset.createTool, modules.adjust.createTool
    ]);
    log('好感度养成已加载');
  }

  async function activate() {
    lifecycle.epoch += 1;
    lifecycle.running = true;
    try {
      storage.ensureLoaded();
      scoring.syncMode();
      scoring.syncOwners();
      storage.markDirty();
      storage.flush();
      if (flushTimer) clearInterval(flushTimer);
      flushTimer = setInterval(() => { try { storage.flush(); } catch {} }, 30000);
      flushTimer.unref?.();
      log('好感度养成已启用');
    } catch (error) {
      lifecycle.running = false;
      throw error;
    }
  }

  function deactivate() {
    lifecycle.running = false;
    lifecycle.epoch += 1;
    if (flushTimer) clearInterval(flushTimer);
    flushTimer = null;
    relationship.clear();
    replyGuard.clear();
    storage.flush();
  }

  function dispose() {
    try { deactivate(); } finally { storage.reset(); }
  }

  const hooks = {
    'before-tool': (payload = {}) => {
      if (lifecycle.running) return replyGuard.beforeTool(payload);
    },
    'before-context': async (payload = {}) => {
      const epoch = lifecycle.epoch;
      try {
        assertRunning(epoch);
        const result = await scoring.accumulate(payload);
        assertRunning(epoch);
        relationship.captureRelationshipRun(payload);
        if (result.counted > 0) log(`好感度记账：${result.chatKey} 新增 ${result.counted} 条发言`);
      } catch (error) {
        relationship.clearRun(payload);
        if (error.code === 'rapport-cancelled') return;
        throw error;
      }
    }
  };

  return {
    setup, activate, deactivate, dispose, available: storage.available, hooks,
    promptSections: relationship.promptSections, relationshipText: relationship.relationshipText,
    normalizeEntry: messages.normalizeEntry, findMember: services.findMember,
    applyDecay: levels.applyDecay, ownerList: levels.ownerList,
    levelTable: levels.levelTable, levelOf: levels.levelOf,
    titleOf: levels.titleOf, progressText: levels.progressText
  };
}
