import z from '@deepseek-ai/schemastery';
import { symbols } from '@deepseek-ai/cordis';
import { installLock } from './core.mjs';

export const name = 'default-model-lock';
export const inject = ['agentDefaultModel'];
export const Config = z.object({
  enabled: z.boolean().default(false).description('锁定全局默认模型；不改变已有会话的显式模型').volatile(),
  provider: z.string().default('').description('精确 provider ID；启用时不能为空').volatile(),
  model: z.string().default('').description('精确 model ID；不会自动选择替代模型').volatile(),
  reasoningEffort: z.string().default('').description('推理档位；留空则省略，使用模型默认').volatile(),
});

export function apply(ctx, config) {
  installLock(ctx, config, symbols.original);
  // 自定义设置页已承载这四个字段；settings 可选注入，拿到时才隐藏 Loader 自动生成的通用表单，
  // 不把它写进 inject，避免 settings 缺席时整个插件挂起、锁定也不生效。
  ctx.inject(['settings'], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber));
  });
}
