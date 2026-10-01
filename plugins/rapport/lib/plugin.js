// 组装实例和生命周期；模块之间通过显式服务对象协作，不共享全局状态。
import { createReplyGuard } from './reply-guard.js';
export function createPlugin(modules, pluginUrl) {
  let api = null;
  let flushTimer = null;
  let activationError = '';
  const lifecycle = { running: false, epoch: 0 };
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
    storage, lifecycle, log, warn, assertRunning,
    readIntegrationPermissions: () => api?.config?.()?.integrationPermissions ?? '{}'
  };
  const scoring = modules.scoring.createScoring(services);
  Object.assign(services, scoring);
  const events = modules.events.createEvents(services);
  const replyGuard = createReplyGuard({ isExternalTool: events.ownsTool });
  Object.assign(services, { eventClaimed: events.claimed });
  const relationship = modules.relationship.createRelationship(services);
  Object.assign(services, { getRun: relationship.getRun });
  Object.assign(services, modules.context.createToolContext(services));

  function assertRunning(epoch) {
    if (!lifecycle.running || epoch !== lifecycle.epoch || api?.isSkillActive?.('rapport') === false) {
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

  // 初始化只有同步 IO；同步抛错才能被宿主的生命周期 try/catch 接住。
  function activate() {
    if (lifecycle.running) return;
    lifecycle.epoch += 1;
    lifecycle.running = true;
    try {
      storage.ensureLoaded();
      scoring.syncMode();
      scoring.syncOwners();
      storage.markDirty();
      storage.flush();
      activationError = '';
      if (flushTimer) clearInterval(flushTimer);
      flushTimer = setInterval(() => { try { storage.flush(); } catch {} }, 30000);
      flushTimer.unref?.();
      log('好感度养成已启用');
    } catch (error) {
      lifecycle.running = false;
      activationError = error.message;
      storage.reset();
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
    try { storage.flush(); } finally { storage.reset(); }
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
    setup, activate, deactivate, dispose,
    available: () => activationError ? { ok: false, reason: activationError } : storage.available() !== true ? storage.available() : events.available(), hooks,
    providers: { 'rapport.v1': args => api?.isSkillActive?.('rapport') === false ? undefined : events.provider(args) },
    promptSections: relationship.promptSections, relationshipText: relationship.relationshipText,
    normalizeEntry: messages.normalizeEntry, findMember: services.findMember,
    applyDecay: levels.applyDecay, ownerList: levels.ownerList,
    levelTable: levels.levelTable, levelOf: levels.levelOf,
    titleOf: levels.titleOf, progressText: levels.progressText
  };
}
