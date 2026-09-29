import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { describe, expect, test } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');
const guides = ['USER_GUIDE.md', 'AI_DIY_GUIDE.md', 'AI_PROMPTS.md'];
describe('recipient documentation', () => {
  test('both packagers expose human, AI and prompt entry points', () => {
    for (const packager of ['scripts/package-release.ps1', 'scripts/package-release.sh']) {
      const text = readFileSync(resolve(root, packager), 'utf8');
      for (const guide of guides) expect(text).toContain(`docs/${guide}`);
    }
  });
  test('recipient guide links resolve without a complete source checkout', () => {
    const shipped = new Set([...guides, '../LICENSE', '../THIRD_PARTY_NOTICES.md', 'SELF_SERVICE_MODULES.md',
      'HOW_TO_ADD_MODULE.md', 'HOW_TO_ADD_PLATFORM.md', 'DIY_SEMANTIC_EXTENSIONS.md',
      '离线包使用说明.md']);
    for (const guide of guides) {
      const file = resolve(root, 'docs', guide);
      const content = readFileSync(file, 'utf8');
      for (const match of content.matchAll(/\]\(([^)]+)\)/g)) {
        const target = match[1].split('#')[0];
        if (!target || /^https?:/.test(target)) continue;
        expect(shipped.has(target), `${guide}: ${target} must be shipped`).toBe(true);
        expect(existsSync(resolve(dirname(file), target))).toBe(true);
      }
    }
  });
});
