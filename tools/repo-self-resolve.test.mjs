import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const toolsDir = path.dirname(fileURLToPath(import.meta.url));

const cases = [
  {
    file: 'nightly-batch.ps1',
    homeMarkers: [
      "Join-Path $HOME 'orgiast-claude-rules'",
      "Join-Path $HOME 'Downloads\\orgiast-claude-rules'",
    ],
  },
  {
    file: 'fleet-poller.ps1',
    homeMarkers: [
      '$H\\orgiast-claude-rules',
      '$H\\Downloads\\orgiast-claude-rules',
    ],
  },
  {
    file: 'cost-loop.ps1',
    homeMarkers: [
      "Join-Path $H 'orgiast-claude-rules\\tools\\cost-work-loop.mjs'",
      "Join-Path $H 'Downloads\\orgiast-claude-rules\\tools\\cost-work-loop.mjs'",
    ],
  },
];

for (const { file, homeMarkers } of cases) {
  test(`${file} resolves its own repository before HOME fallbacks`, async () => {
    const source = await readFile(path.join(toolsDir, file), 'utf8');
    const selfMarker = 'Split-Path -Parent $PSScriptRoot';
    const selfIndex = source.indexOf(selfMarker);

    assert.notEqual(selfIndex, -1, `${file} must derive the repository root from $PSScriptRoot`);
    for (const marker of homeMarkers) {
      const fallbackIndex = source.indexOf(marker);
      assert.notEqual(fallbackIndex, -1, `${file} must retain fallback: ${marker}`);
      assert.ok(selfIndex < fallbackIndex, `${file} must prefer its own repository over ${marker}`);
    }
  });
}
