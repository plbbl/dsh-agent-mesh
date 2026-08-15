import React, { useEffect, useId, useMemo, useRef, useState } from 'react';

import { checkNativeModelRoute } from '../model-readiness.js';

const h = React.createElement;
const LOCALE_NS = 'agent-mesh';

const ZH = {
  selectHarness: '选择 harness',
  selectModel: '选择模型',
  loading: '读取本机配置…',
  retry: '重试',
  empty: '没有可用的本机模型',
  failed: '读取失败：{message}',
  currentHarness: '当前 harness：{name}',
  currentModel: '当前模型：{name}',
  menu: '模型选择菜单',
  reasoning: '推理等级',
  credentialMissing: '未配置凭据：{ref}',
};

const EN = {
  selectHarness: 'Choose harness',
  selectModel: 'Choose model',
  loading: 'Reading local configuration…',
  retry: 'Retry',
  empty: 'No local model available',
  failed: 'Load failed: {message}',
  currentHarness: 'Current harness: {name}',
  currentModel: 'Current model: {name}',
  menu: 'Model selection menu',
  reasoning: 'Effort',
  credentialMissing: 'Credential missing: {ref}',
};

const STYLES = `
.agent-mesh-model-seat {
  --agent-mesh-accent: var(--dsw-alias-state-business-primary, #4778ea);
  --agent-mesh-surface: var(--dsw-specific-menu, var(--dsw-alias-bg-module-platform, #fff));
  --agent-mesh-raised: var(--dsw-alias-interactive-bg-hover, rgba(80, 98, 140, .08));
  --agent-mesh-text: var(--dsw-alias-label-primary, #1b1e25);
  --agent-mesh-muted: var(--dsw-alias-label-secondary, #6f7785);
  --agent-mesh-faint: var(--dsw-alias-label-tertiary, #9ba2ad);
  --agent-mesh-line: var(--dsw-alias-border-l2, rgba(27, 30, 37, .12));
  position: relative;
  display: flex;
  align-items: center;
  min-width: 0;
  gap: 2px;
  color: var(--agent-mesh-text);
  font: inherit;
  line-height: 20px;
}
.agent-mesh-model-trigger {
  display: flex;
  align-items: center;
  min-width: 0;
  height: 28px;
  gap: 4px;
  padding: 0 5px 0 8px;
  border: 0;
  border-radius: 24px;
  color: var(--agent-mesh-muted);
  background: transparent;
  font: inherit;
  font-size: 13px;
  font-weight: 500;
  line-height: 20px;
  cursor: pointer;
}
.agent-mesh-model-trigger:hover:not(:disabled),
.agent-mesh-model-trigger[data-open='true'] { background: var(--agent-mesh-raised); }
.agent-mesh-model-trigger:disabled { color: var(--agent-mesh-faint); cursor: default; }
.agent-mesh-model-trigger[data-kind='harness'] { max-width: 118px; }
.agent-mesh-model-trigger[data-kind='model'] { max-width: 220px; }
.agent-mesh-model-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.agent-mesh-model-effort { flex: none; color: var(--agent-mesh-faint); font-size: 12px; font-weight: 400; }
.agent-mesh-model-separator { color: var(--agent-mesh-faint); user-select: none; }
.agent-mesh-model-chevron {
  flex: none;
  width: 0;
  height: 0;
  border-top: 4px solid currentColor;
  border-right: 4px solid transparent;
  border-left: 4px solid transparent;
  opacity: .72;
  transition: transform 120ms ease;
}
.agent-mesh-model-trigger[data-open='true'] .agent-mesh-model-chevron { transform: rotate(180deg); }
.agent-mesh-model-menu {
  position: absolute;
  right: 0;
  bottom: calc(100% + 8px);
  z-index: 30;
  display: flex;
  flex-direction: column;
  width: min(292px, calc(100vw - 32px));
  max-height: min(360px, calc(100vh - 96px));
  overflow: hidden;
  padding: 4px;
  border: 1px solid var(--dsw-alias-border-inverted, var(--agent-mesh-line));
  border-radius: 12px;
  color: var(--agent-mesh-text);
  background: var(--agent-mesh-surface);
  box-shadow: var(--dsw-shadow-lv3, 0 14px 36px rgba(30, 35, 48, .18));
}
.agent-mesh-model-menu-list { min-height: 0; overflow: auto; }
.agent-mesh-model-menu-status { padding: 10px; color: var(--agent-mesh-muted); font-size: 12px; line-height: 18px; }
.agent-mesh-model-menu-error { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; margin: 0 0 4px; padding: 7px 8px; border-radius: 8px; color: var(--dsw-alias-state-error-primary, #c23c43); background: var(--dsw-alias-interactive-bg-hover-danger, rgba(194, 60, 67, .08)); font-size: 12px; line-height: 17px; }
.agent-mesh-model-menu-retry { flex: none; padding: 0; border: 0; color: inherit; background: transparent; font: inherit; font-weight: 600; cursor: pointer; }
.agent-mesh-model-group-title { padding: 5px 8px 3px; color: var(--agent-mesh-faint); font-size: 12px; line-height: 18px; }
.agent-mesh-model-option { display: flex; align-items: center; width: 100%; min-height: 36px; gap: 8px; padding: 6px 8px; border: 0; border-radius: 9px; color: inherit; background: transparent; font: inherit; text-align: left; cursor: pointer; }
.agent-mesh-model-option:hover { background: var(--agent-mesh-raised); }
.agent-mesh-model-option:disabled { opacity: .5; cursor: default; }
.agent-mesh-model-option[data-selected='true'] { color: var(--agent-mesh-accent); background: color-mix(in srgb, var(--agent-mesh-accent) 9%, transparent); }
.agent-mesh-model-option-copy { min-width: 0; flex: 1; }
.agent-mesh-model-option-name { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.agent-mesh-model-option-description { display: block; overflow: hidden; margin-top: 1px; color: var(--agent-mesh-faint); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.agent-mesh-model-check { flex: none; width: 16px; color: var(--agent-mesh-accent); font-size: 14px; }
.agent-mesh-model-seat button:focus-visible { outline: 2px solid var(--dsw-alias-border-l3, var(--agent-mesh-accent)); outline-offset: 1px; }
@media (max-width: 720px) {
  .agent-mesh-model-trigger[data-kind='harness'] { max-width: 86px; }
  .agent-mesh-model-trigger[data-kind='model'] { max-width: 150px; }
}
@media (prefers-reduced-motion: reduce) {
  .agent-mesh-model-chevron { transition: none; }
}
`;

function installStyles() {
  if (document.querySelector('style[data-agent-mesh-model-styles]')) return () => undefined;
  const style = document.createElement('style');
  style.dataset.agentMeshModelStyles = '';
  style.textContent = STYLES;
  document.head.appendChild(style);
  return () => style.remove();
}

function translate(t, key, params) {
  const dictionary = typeof t === 'function' ? undefined : ZH;
  const value = typeof t === 'function' ? t(key, params) : dictionary[key] ?? key;
  return String(value).replace(/\{(\w+)\}/g, (match, name) => params && name in params ? String(params[name]) : match);
}

function CompositeModelSelect({ locked, available, directory, load, select, preflight, t }) {
  const state = React.useSyncExternalStore(
    (listener) => directory.subscribe(listener),
    () => directory.getSnapshot(),
    () => directory.getSnapshot(),
  );
  const [open, setOpen] = useState(undefined);
  const [actionError, setActionError] = useState(null);
  const rootRef = useRef(null);
  const menuId = useId();
  const busy = state.status === 'selecting';
  const groups = state.groups ?? [];
  const currentGroup = groups.find((group) => group.id === state.current?.provider);
  const fallbackGroup = groups[0];
  const activeGroup = currentGroup ?? fallbackGroup;
  const currentModel = activeGroup?.models?.find((model) => model.id === state.current?.model);
  const modelLabel = currentModel?.name ?? state.current?.model ?? translate(t, 'selectModel');
  const reasoning = currentModel?.reasoning;
  const effectiveEffort = state.current?.reasoningEffort ?? reasoning?.defaultEffort;
  const effortLabel = reasoning?.efforts?.find((effort) => effort.id === effectiveEffort)?.name ?? effectiveEffort;
  const harnessLabel = currentGroup?.name ?? translate(t, 'selectHarness');
  const modelChoices = useMemo(() => activeGroup?.models ?? [], [activeGroup]);

  useEffect(() => {
    if (available) load();
  }, [available, load]);

  useEffect(() => {
    if (!open) return undefined;
    const closeOutside = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(undefined);
    };
    const closeEscape = (event) => {
      if (event.key === 'Escape') setOpen(undefined);
    };
    document.addEventListener('mousedown', closeOutside);
    document.addEventListener('keydown', closeEscape);
    return () => {
      document.removeEventListener('mousedown', closeOutside);
      document.removeEventListener('keydown', closeEscape);
    };
  }, [open]);

  if (!available) return null;

  const showMenu = (kind) => {
    setActionError(null);
    setOpen((current) => current === kind ? undefined : kind);
    load();
  };

  const choose = (selection) => {
    if (!selection || busy) return;
    setActionError(null);
    const selectedGroup = groups.find((group) => group.id === selection.provider);
    const selectedModel = selectedGroup?.models?.find((model) => model.id === selection.model);
    if (selectedModel?.available === false) return;
    const selectedEffort = selection.reasoningEffort ?? selectedModel?.reasoning?.defaultEffort;
    if (state.current?.provider === selection.provider
      && state.current?.model === selection.model
      && effectiveEffort === selectedEffort) {
      setOpen(undefined);
      return;
    }
    Promise.resolve().then(() => preflight?.(selection)).then((result) => {
      if (result?.state === 'missing') throw new Error(translate(t, 'credentialMissing', { ref: result.ref }));
      return select(selection);
    }).then((accepted) => {
      if (accepted) setOpen(undefined);
    }).catch((error) => {
      setActionError(error?.message ?? String(error));
    });
  };

  const chooseHarness = (group) => {
    const model = group.models?.[0];
    if (!model) return;
    choose({
      provider: group.id,
      model: model.id,
      ...(model.reasoning?.defaultEffort ? { reasoningEffort: model.reasoning.defaultEffort } : {}),
    });
  };

  const menuError = actionError ?? (state.error ? translate(t, 'failed', { message: state.error }) : null);
  const loading = state.status === 'loading';

  return h('div', { className: 'agent-mesh-model-seat', ref: rootRef },
    h('button', {
      type: 'button',
      className: 'agent-mesh-model-trigger',
      'data-kind': 'harness',
      'data-open': open === 'harness' ? 'true' : 'false',
      'aria-label': translate(t, 'currentHarness', { name: harnessLabel }),
      'aria-haspopup': 'menu',
      'aria-expanded': open === 'harness',
      'aria-controls': open === 'harness' ? menuId : undefined,
      disabled: locked || busy,
      onClick: () => showMenu('harness'),
      title: harnessLabel,
    }, h('span', { className: 'agent-mesh-model-label' }, harnessLabel), h('span', { className: 'agent-mesh-model-chevron', 'aria-hidden': 'true' })),
    h('span', { className: 'agent-mesh-model-separator', 'aria-hidden': 'true' }, '·'),
    h('button', {
      type: 'button',
      className: 'agent-mesh-model-trigger',
      'data-kind': 'model',
      'data-open': open === 'model' ? 'true' : 'false',
      'aria-label': translate(t, 'currentModel', { name: modelLabel }),
      'aria-haspopup': 'menu',
      'aria-expanded': open === 'model',
      'aria-controls': open === 'model' ? menuId : undefined,
      disabled: locked || busy,
      onClick: () => showMenu('model'),
      title: modelLabel,
    }, h('span', { className: 'agent-mesh-model-label' }, modelLabel), effortLabel ? h('span', { className: 'agent-mesh-model-effort' }, effortLabel) : null, h('span', { className: 'agent-mesh-model-chevron', 'aria-hidden': 'true' })),
    open ? h('div', { id: menuId, className: 'agent-mesh-model-menu', role: 'menu', 'aria-label': translate(t, 'menu'), 'aria-busy': busy || loading },
      menuError ? h('div', { className: 'agent-mesh-model-menu-error' }, h('span', null, menuError), h('button', { type: 'button', className: 'agent-mesh-model-menu-retry', onClick: () => { setActionError(null); load(); } }, translate(t, 'retry'))) : null,
      loading && !groups.length ? h('div', { className: 'agent-mesh-model-menu-status' }, translate(t, 'loading')) : null,
      !loading && !groups.length && !menuError ? h('div', { className: 'agent-mesh-model-menu-status' }, translate(t, 'empty')) : null,
      open === 'harness' ? h('div', { className: 'agent-mesh-model-menu-list' }, groups.map((group) => h('button', {
        key: group.id,
        type: 'button',
        role: 'menuitemradio',
        'aria-checked': currentGroup?.id === group.id,
        className: 'agent-mesh-model-option',
        'data-selected': currentGroup?.id === group.id ? 'true' : 'false',
        disabled: busy || !group.models?.length || group.models.every((model) => model.available === false),
        onClick: () => chooseHarness(group),
      }, h('span', { className: 'agent-mesh-model-option-copy' }, h('span', { className: 'agent-mesh-model-option-name' }, group.name)), h('span', { className: 'agent-mesh-model-check' }, currentGroup?.id === group.id ? '✓' : '')))) : null,
      open === 'model' && activeGroup ? h('div', { className: 'agent-mesh-model-menu-list' },
        h('div', { className: 'agent-mesh-model-group-title' }, activeGroup.name),
        modelChoices.map((model) => h('button', {
          key: model.id,
          type: 'button',
          role: 'menuitemradio',
          'aria-checked': currentGroup?.id === activeGroup.id && state.current?.model === model.id,
          className: 'agent-mesh-model-option',
          'data-selected': currentGroup?.id === activeGroup.id && state.current?.model === model.id ? 'true' : 'false',
          disabled: busy || model.available === false,
          onClick: () => choose({
            provider: activeGroup.id,
            model: model.id,
            ...(model.reasoning?.defaultEffort ? { reasoningEffort: model.reasoning.defaultEffort } : {}),
          }),
        }, h('span', { className: 'agent-mesh-model-option-copy' }, h('span', { className: 'agent-mesh-model-option-name' }, model.name), model.description ? h('span', { className: 'agent-mesh-model-option-description' }, model.description) : null), h('span', { className: 'agent-mesh-model-check' }, currentGroup?.id === activeGroup.id && state.current?.model === model.id ? '✓' : ''))),
        reasoning?.efforts?.length ? h('div', { className: 'agent-mesh-model-group-title' }, translate(t, 'reasoning')) : null,
        reasoning?.efforts?.map((effort) => h('button', {
          key: `effort:${effort.id}`,
          type: 'button',
          role: 'menuitemradio',
          'aria-checked': effectiveEffort === effort.id,
          className: 'agent-mesh-model-option',
          'data-selected': effectiveEffort === effort.id ? 'true' : 'false',
          disabled: busy,
          onClick: () => choose({
            provider: state.current?.provider,
            model: state.current?.model,
            reasoningEffort: effort.id,
          }),
        }, h('span', { className: 'agent-mesh-model-option-copy' }, h('span', { className: 'agent-mesh-model-option-name' }, effort.name), effort.description ? h('span', { className: 'agent-mesh-model-option-description' }, effort.description) : null), h('span', { className: 'agent-mesh-model-check' }, effectiveEffort === effort.id ? '✓' : ''))),
      ) : null,
    ) : null,
  );
}

export const inject = [
  'slots',
  'locale',
  'sessions',
  'modelDirectories',
  'connection',
];

export function apply(ctx) {
  ctx.effect(() => installStyles(), 'agent-mesh: styles');
  ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh: ZH, en: EN }), 'agent-mesh: locale');
  ctx.inject(['slots', 'modelDirectories', 'connection'], (scope) => {
    const models = scope.modelDirectories;
    const sessions = scope.sessions;
    const api = scope.connection.api;
    scope.slots.inject('conversation.input.model', () => scope.slots.register({
      name: 'conversation.input.model',
      priority: -10,
      locale: LOCALE_NS,
      inject: (sessionId) => {
        const directory = models.directoryFor(sessionId);
        const available = sessions.subagentAddress(sessionId) === void 0;
        return {
          available,
          directory: directory.store,
          load: () => {
            if (available) directory.load().catch(() => {});
          },
          select: (selection) => available ? directory.select(selection).then(() => true, () => false) : Promise.resolve(false),
          preflight: (selection) => checkNativeModelRoute(api, selection),
        };
      },
    }, CompositeModelSelect));
  });
}
