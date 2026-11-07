import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const electronStub = new URL('./electron-test-stub.mjs', import.meta.url).href;

export function resolve(specifier, context, nextResolve) {
  if (specifier === 'electron') {
    return { url: electronStub, shortCircuit: true };
  }
  if (specifier.endsWith('.js') && context.parentURL?.startsWith('file:')) {
    const requested = fileURLToPath(new URL(specifier, context.parentURL));
    const typescript = requested.slice(0, -3) + '.ts';
    if (!existsSync(requested) && existsSync(typescript)) {
      return nextResolve(pathToFileURL(typescript).href, context);
    }
  }
  return nextResolve(specifier, context);
}
