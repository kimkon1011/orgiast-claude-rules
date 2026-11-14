#!/usr/bin/env node
/**
 * illustrator-mcp.mjs — MCP server for Adobe Illustrator automation
 *
 * Provides a stdio-based MCP interface that Claude Code / Codex can use to
 * control Adobe Illustrator via ExtendScript (.jsx) generation and execution.
 *
 * Tools:
 *   - generate_extendscript: Convert natural language → ExtendScript code
 *   - execute_script:        Run a .jsx file on Illustrator (COM on Windows)
 *   - create_text_effect:    High-level: create a styled text effect
 *   - export_artboard:       Export current artboard as PDF/PNG
 *
 * Usage:
 *   node tools/illustrator-mcp.mjs          # MCP server mode (stdio)
 *   node tools/illustrator-mcp.mjs --info   # Print tool info and exit
 *
 * MCP config (add to ~/.claude/settings.json mcpServers):
 *   "illustrator-mcp": {
 *     "type": "stdio",
 *     "command": "node",
 *     "args": ["path/to/tools/illustrator-mcp.mjs"]
 *   }
 *
 * Dependencies: (built-in only; llm-ask used optionally for script generation)
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IS_WIN = process.platform === 'win32';

// ── Detection ──────────────────────────────────────────────────────────

/** Check if Adobe Illustrator is installed and find its executable path. */
function detectIllustrator() {
  if (!IS_WIN) return null;
  const candidates = [
    // AI 2025 / 2024 / 2023 / 2022
    'C:\\Program Files\\Adobe\\Adobe Illustrator 2025\\Support Files\\Contents\\Windows\\Illustrator.exe',
    'C:\\Program Files\\Adobe\\Adobe Illustrator 2024\\Support Files\\Contents\\Windows\\Illustrator.exe',
    'C:\\Program Files\\Adobe\\Adobe Illustrator 2023\\Support Files\\Contents\\Windows\\Illustrator.exe',
    'C:\\Program Files\\Adobe\\Adobe Illustrator 2022\\Support Files\\Contents\\Windows\\Illustrator.exe',
    'C:\\Program Files\\Adobe\\Adobe Illustrator CC\\Support Files\\Contents\\Windows\\Illustrator.exe',
    // Alternative install paths
    'C:\\Program Files (x86)\\Adobe\\Adobe Illustrator 2025\\Support Files\\Contents\\Windows\\Illustrator.exe',
    'C:\\Program Files (x86)\\Adobe\\Adobe Illustrator 2024\\Support Files\\Contents\\Windows\\Illustrator.exe',
  ];
  for (const p of candidates) {
    try { if (fs.statSync(p).isFile()) return { exe: p, version: extractVersion(p) }; } catch { /* next */ }
  }
  return null;
}

function extractVersion(p) {
  const m = p.match(/Illustrator\s+(20\d{2}|CC)/);
  return m ? m[1] : 'unknown';
}

/** Check if Illustrator COM is accessible (Windows only). */
function canUseCom() {
  if (!IS_WIN) return false;
  try {
    const r = spawnSync('cscript', ['//NoLogo', '//E:JScript', '-'], {
      input: 'try{new ActiveXObject("Illustrator.Application");WScript.Echo("ok")}catch(e){WScript.Echo("no")}',
      windowsHide: true,
      timeout: 5000,
      encoding: 'utf8',
    });
    return r.stdout?.trim() === 'ok';
  } catch {
    return false;
  }
}

// ── ExtendScript generation ────────────────────────────────────────────

/** Generate ExtendScript from a natural-language description using llm-ask.
 *  Falls back to template-based generation if llm-ask is unavailable. */
function generateExtendScript(description, { scriptPath } = {}) {
  const prompt = `You are an Adobe Illustrator ExtendScript (JavaScript) expert.
Generate ONLY raw ExtendScript code (no markdown fences, no explanations).
The script must work with Illustrator's ExtendScript API (ES3/ES5 compatible).

Requirements:
- Use "app.activeDocument" as the current document
- Use Illustrator-specific objects: TextFrame, CharacterAttributes, etc.
- Include comments in Japanese explaining each step
- The script must be self-contained (no external dependencies)
- Use "redraw()" at the end if document was modified
- Do NOT use modern JS (ES6+): ExtendScript uses ES3

Task: ${description}

Output the complete .jsx script code only, without \`\`\` fences or extra text.`;

  // Try llm-ask first
  const llmAskPath = path.join(__dirname, 'llm-ask.mjs');
  let code = null;
  if (fs.existsSync(llmAskPath)) {
    try {
      const r = spawnSync(process.execPath, [
        llmAskPath, '--provider', 'gemini', '--model', 'gemini-3.6-flash',
        '--system', 'You are an Adobe Illustrator ExtendScript expert. Output only raw ExtendScript code.',
        '--max', '4096',
        prompt,
      ], { windowsHide: true, timeout: 30000, encoding: 'utf8' });
      if (r.status === 0 && r.stdout?.trim()) {
        // Strip potential markdown fences
        code = r.stdout.trim().replace(/^```(?:jsx|javascript|js)?\n?/im, '').replace(/\n?```\s*$/im, '');
      }
    } catch {
      // Fall through to template
    }
  }

  // Fallback template if llm-ask unavailable
  if (!code) {
    code = generateFallbackScript(description);
  }

  // Write to file if path specified
  if (scriptPath && code) {
    fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
    fs.writeFileSync(scriptPath, code, 'utf8');
  }

  return code;
}

/** Template-based ExtendScript generation for common booth-signage effects. */
function generateFallbackScript(description) {
  const lower = description.toLowerCase();

  // 版ずれ風 (misregistration) text effect
  if (lower.includes('版ずれ') || lower.includes('misregistration') ||
      (lower.includes('ずら') && lower.includes('文字'))) {
    return `// 版ずれ風テキストエフェクト — ブースサイン向け
// Generated by illustrator-mcp.mjs

if (app.documents.length === 0) {
  app.documents.add();
}
var doc = app.activeDocument;
var artboard = doc.artboards[0];

// 1. アートボードをA4横に設定
artboard.artboardRect = [0, 0, 1190, 842]; // A4 landscape at 72dpi

// 2. 文字ツールで中央揃えテキストを作成
var textLayer = doc.layers.add();
textLayer.name = "版ずれテキスト";
var textFrame = textLayer.textFrames.add();
textFrame.contents = "ブースタイトル";
textFrame.position = [595, 421]; // 中央
textFrame.textRange.characterAttributes.size = 120;
textFrame.textRange.characterAttributes.textFont = app.textFonts.getByName("Arial-BoldMT");

// 3. 中央揃え
textFrame.textRange.paragraphAttributes.justification = Justification.CENTER;

// 4. 各文字を個別にウェイト変更（1文字ずつ）
var chars = textFrame.textRange.characters;
for (var i = 0; i < chars.length; i++) {
  var w = 80 + (i * 10); // 段階的にウェイト増
  if (w > 100) w = 100;
  chars[i].characterAttributes.tracking = i * 20;
}

// 5. 塗り M20+Y20%、線 K100% 1pt
var textColor = doc.swatches.add();
textColor.color = new CMYKColor();
textColor.color.cyan = 0;
textColor.color.magenta = 20;
textColor.color.yellow = 20;
textColor.color.black = 0;
textFrame.textRange.fillColor = textColor.color;

var strokeColor = doc.swatches.add();
strokeColor.color = new CMYKColor();
strokeColor.color.cyan = 0;
strokeColor.color.magenta = 0;
strokeColor.color.yellow = 0;
strokeColor.color.black = 100;
textFrame.textRange.strokeColor = strokeColor.color;
textFrame.textRange.strokeWidth = 1;

// 6. 線に変形 -2mm（≒-5.67pt @72dpi）
var offset = textFrame.duplicate();
offset.textRange.strokeColor = textFrame.textRange.strokeColor;
offset.textRange.fillColor = new NoColor();
offset.position = [textFrame.position[0] - 5.67, textFrame.position[1] - 5.67];

// 7. ラフ効果
var rough = textFrame.effects.add();
rough.type = EffectTypes.ROUGHEN;
rough.roughness.size = 2;
rough.roughness.detail = 10;
rough.roughness.smooth = false;

// 8. 下方向に複製（ドロップシャドウ風）
var shadow = textFrame.duplicate();
shadow.position = [textFrame.position[0], textFrame.position[1] - 10];
shadow.textRange.fillColor = new GrayColor();
shadow.textRange.fillColor.gray = 60;
shadow.move(textLayer, ElementPlacement.PLACEATEND);

// 9. アピアランス分割 & アウトライン
var outlined = textFrame.duplicate();
outlined.createOutline();

// 10. アートボード調整
artboard.artboardRect = [
  textFrame.position[0] - 50,
  textFrame.position[1] + 50,
  textFrame.position[0] + textFrame.width + 50,
  textFrame.position[1] - textFrame.height - 50
];

redraw();
alert("版ずれ風テキストエフェクトの作成が完了しました。");
`;
  }

  // ブースサイン / booth sign
  if (lower.includes('ブースサイン') || lower.includes('booth sign') || lower.includes('パネル')) {
    return `// ブースサイン作成 — パネル文字
// Generated by illustrator-mcp.mjs

if (app.documents.length === 0) {
  app.documents.add(DocumentColorSpace.CMYK, 2100, 2970); // A3 @300dpi
}
var doc = app.activeDocument;
var layer = doc.layers.add();
layer.name = "サイン";

// メインタイトル
var title = layer.textFrames.add();
title.contents = "ようこそ";
title.position = [1050, 800];
title.textRange.characterAttributes.size = 200;
title.textRange.characterAttributes.textFont = app.textFonts.getByName("ArialMT");
title.textRange.paragraphAttributes.justification = Justification.CENTER;

// サブタイトル
var subtitle = layer.textFrames.add();
subtitle.contents = "Welcome to Our Booth";
subtitle.position = [1050, 1050];
subtitle.textRange.characterAttributes.size = 72;
subtitle.textRange.characterAttributes.textFont = app.textFonts.getByName("Arial-ItalicMT");
subtitle.textRange.paragraphAttributes.justification = Justification.CENTER;

// 塗り: 白
var whiteColor = new CMYKColor();
whiteColor.cyan = 0; whiteColor.magenta = 0;
whiteColor.yellow = 0; whiteColor.black = 0;
title.textRange.fillColor = whiteColor;
subtitle.textRange.fillColor = whiteColor;

redraw();
alert("ブースサインを作成しました。");
`;
  }

  // 汎用フォールバック
  return `// Illustrator ExtendScript — Generated from: ${description}
// NOTE: This is a template. Customize before running.

if (app.documents.length === 0) {
  app.documents.add();
}
var doc = app.activeDocument;
var layer = doc.layers.add();
layer.name = "Generated";

var tf = layer.textFrames.add();
tf.contents = "サンプルテキスト";
tf.position = [doc.width / 2, doc.height / 2];
tf.textRange.characterAttributes.size = 48;
tf.textRange.paragraphAttributes.justification = Justification.CENTER;

redraw();
alert("スクリプト実行完了（テンプレート）");
`;
}

// ── Script execution ───────────────────────────────────────────────────

/** Execute a .jsx file on Illustrator.
 *  Returns { ok, stdout, stderr, method } */
function executeScript(scriptPath) {
  const ai = detectIllustrator();
  if (!ai) {
    return { ok: false, reason: 'illustrator_not_found', method: 'none',
      message: 'Adobe Illustrator が見つかりません。スクリプトファイルを生成しました: ' + scriptPath };
  }

  // Method 1: Launch Illustrator with --runScriptPath
  try {
    const r = spawnSync(`"${ai.exe}"`, [`--runScriptPath="${scriptPath}"`], {
      windowsHide: true,
      timeout: 60000,
      encoding: 'utf8',
      shell: true,
    });
    if (r.status === 0 || r.status === null) {
      return { ok: true, method: 'cli', stdout: r.stdout, stderr: r.stderr };
    }
  } catch { /* fall through */ }

  // Method 2: COM via cscript (if available)
  if (canUseCom()) {
    try {
      const comScript = `
var ai = new ActiveXObject("Illustrator.Application");
var jsxFile = "${scriptPath.replace(/\\/g, '\\\\')}";
var script = new ActiveXObject("Scripting.FileSystemObject").OpenTextFile(jsxFile, 1).ReadAll();
ai.DoJavaScript(script);
WScript.Echo("Script executed via COM");
`;
      const r = spawnSync('cscript', ['//NoLogo', '//E:JScript', '-'], {
        input: comScript,
        windowsHide: true,
        timeout: 60000,
        encoding: 'utf8',
      });
      if (r.status === 0) {
        return { ok: true, method: 'com', stdout: r.stdout, stderr: r.stderr };
      }
    } catch { /* fall through */ }
  }

  return { ok: false, reason: 'execution_failed', method: 'all_tried',
    message: 'Illustrator スクリプトの実行に失敗しました。手動で開いてください: ' + scriptPath };
}

// ── MCP Protocol ───────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'generate_extendscript',
    description: '自然言語の指示からIllustrator用ExtendScript(.jsx)を生成する',
    inputSchema: {
      type: 'object',
      properties: {
        description: {
          type: 'string',
          description: 'Illustratorで行いたい作業の説明（例：「版ずれ風の見出しテキストを作成」）',
        },
        output_path: {
          type: 'string',
          description: '生成した.jsxファイルの保存先パス（省略時はカレントディレクトリ）',
        },
      },
      required: ['description'],
    },
  },
  {
    name: 'execute_script',
    description: 'ExtendScript(.jsx)ファイルをIllustratorで実行する',
    inputSchema: {
      type: 'object',
      properties: {
        script_path: {
          type: 'string',
          description: '実行する.jsxファイルの絶対パス',
        },
      },
      required: ['script_path'],
    },
  },
  {
    name: 'create_text_effect',
    description: 'テキストエフェクトを生成する（版ずれ風/ドロップシャドウ/グラデーション等）',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '表示するテキスト' },
        effect: {
          type: 'string',
          enum: ['misregistration', 'drop_shadow', 'gradient', 'outline', 'rough'],
          description: 'エフェクト種類',
        },
        font_size: { type: 'number', description: 'フォントサイズ（pt）', default: 120 },
        font_name: { type: 'string', description: 'フォント名', default: 'Arial-BoldMT' },
        output_path: { type: 'string', description: '生成した.jsxの保存先' },
      },
      required: ['text', 'effect'],
    },
  },
  {
    name: 'export_artboard',
    description: 'IllustratorのカレントアートボードをPDF/PNGに書き出す',
    inputSchema: {
      type: 'object',
      properties: {
        format: { type: 'string', enum: ['pdf', 'png'], description: '出力形式' },
        output_path: { type: 'string', description: '出力先ファイルパス' },
      },
      required: ['format', 'output_path'],
    },
  },
];

function mcpResponse(id, result) {
  return JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n';
}

function mcpError(id, code, message) {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n';
}

function mcpNotification(method, params) {
  return JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n';
}

async function handleRequest(request) {
  const { id, method, params } = request;

  switch (method) {
    case 'initialize':
      return mcpResponse(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'illustrator-mcp', version: '1.0.0' },
      });

    case 'notifications/initialized':
      return ''; // no response needed

    case 'tools/list':
      return mcpResponse(id, { tools: TOOLS });

    case 'tools/call': {
      const toolName = params?.name;
      const args = params?.arguments || {};

      try {
        let result;
        switch (toolName) {
          case 'generate_extendscript': {
            const desc = args.description;
            const outputPath = args.output_path || path.join(process.cwd(), 'generated-script.jsx');
            const absPath = path.resolve(outputPath);
            const code = generateExtendScript(desc, { scriptPath: absPath });
            result = {
              content: [{ type: 'text', text: code || '生成に失敗しました' }],
              script_path: absPath,
            };
            break;
          }

          case 'execute_script': {
            const scriptPath = path.resolve(args.script_path);
            if (!fs.existsSync(scriptPath)) {
              return mcpError(id, -32602, `スクリプトファイルが見つかりません: ${scriptPath}`);
            }
            const execResult = executeScript(scriptPath);
            result = { content: [{ type: 'text', text: JSON.stringify(execResult, null, 2) }] };
            break;
          }

          case 'create_text_effect': {
            const effectDescriptions = {
              misregistration: `${args.text} に版ずれ風エフェクトを適用。フォントサイズ${args.font_size || 120}pt、フォント${args.font_name || 'Arial-BoldMT'}。塗りM20+Y20%、線K100%1pt、線を-2mm変形、ラフ効果、下方向複製、アピアランス分割まで`,
              drop_shadow: `${args.text} にドロップシャドウ効果。フォントサイズ${args.font_size || 120}pt。下方向に10ptオフセットした半透明コピーを作成`,
              gradient: `${args.text} にグラデーション塗り。フォントサイズ${args.font_size || 120}pt。CMYKグラデーションを適用`,
              outline: `${args.text} をアウトライン化。フォントサイズ${args.font_size || 120}pt。線のみで塗りなし`,
              rough: `${args.text} にラフ効果。フォントサイズ${args.font_size || 120}pt。ラフネス2px、ディテール10/in`,
            };
            const desc = effectDescriptions[args.effect] ||
              `${args.text} にテキストエフェクト。フォントサイズ${args.font_size || 120}pt`;
            const outputPath = args.output_path ? path.resolve(args.output_path) :
              path.join(process.cwd(), `${args.effect}-effect.jsx`);
            const code = generateExtendScript(desc, { scriptPath: outputPath });
            result = {
              content: [{ type: 'text', text: code || '生成に失敗しました' }],
              script_path: outputPath,
            };
            break;
          }

          case 'export_artboard': {
            const ext = args.format === 'png' ? 'png' : 'pdf';
            const outputPath = path.resolve(args.output_path || `artboard.${ext}`);
            const code = generateExtendScript(
              `カレントアートボードを${args.format.toUpperCase()}形式で "${outputPath}" に書き出す`,
              { scriptPath: outputPath.replace(/\.\w+$/, '.jsx') }
            );
            result = {
              content: [{ type: 'text', text: code || '生成に失敗しました' }],
              export_path: outputPath,
              note: 'スクリプトを生成しました。Illustratorで実行してください。',
            };
            break;
          }

          default:
            return mcpError(id, -32601, `Unknown tool: ${toolName}`);
        }
        return mcpResponse(id, result);
      } catch (err) {
        return mcpError(id, -32603, err.message);
      }
    }

    default:
      return mcpError(id, -32601, `Method not found: ${method}`);
  }
}

// ── CLI entry ──────────────────────────────────────────────────────────

function printInfo() {
  const ai = detectIllustrator();
  const com = canUseCom();
  console.log(JSON.stringify({
    name: 'illustrator-mcp',
    version: '1.0.0',
    illustrator: ai ? { found: true, exe: ai.exe, version: ai.version } : { found: false },
    com_available: com,
    tools: TOOLS.map(t => t.name),
    sample_usage: 'Configure as MCP server in ~/.claude/settings.json',
  }, null, 2));
}

// MCP server mode: read JSON-RPC lines from stdin
async function serve() {
  const ai = detectIllustrator();
  const com = canUseCom();
  // Log detection results to stderr so they don't interfere with MCP protocol on stdout
  console.error(`[illustrator-mcp] Illustrator: ${ai ? ai.exe : 'NOT FOUND'}, COM: ${com ? 'OK' : 'N/A'}`);

  let buffer = '';
  for await (const chunk of process.stdin) {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const request = JSON.parse(trimmed);
        const response = await handleRequest(request);
        if (response) process.stdout.write(response);
      } catch (err) {
        // Ignore malformed JSON (might be partial line)
        console.error('[illustrator-mcp] parse error:', err.message);
      }
    }
  }
}

if (process.argv.includes('--info')) {
  printInfo();
} else {
  serve().catch(err => {
    console.error('[illustrator-mcp] fatal:', err);
    process.exit(1);
  });
}
