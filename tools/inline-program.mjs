// Shared by the delegation hook and usage aggregation. Keep detection here so
// the two callers cannot drift apart.
const EXCLUDED = /(?:llm-ask(?:\.mjs)?|codex-do(?:\.mjs)?|batch-enqueue(?:\.mjs)?|usage-stats(?:\.mjs)?|glm-code(?:\.mjs)?|deepseek-ask(?:\.mjs)?|grok-ask(?:\.mjs)?|ollama-ask(?:\.mjs)?|manus-research(?:\.mjs)?|scratchpad)/i;

export function isExcludedInlineProgramCommand(command) {
  return EXCLUDED.test(String(command || ''));
}

function lineCount(text) {
  return text.length ? text.split(/\r?\n/).length : 0;
}

export function extractInlineProgram(command) {
  command = String(command || '');
  if (!command || isExcludedInlineProgramCommand(command)) return null;

  // Interpreter heredocs: count only the authored body, not the shell wrapper
  // or delimiter. Quoted and indented (<<-) delimiters are both accepted.
  const heredoc = /\b(?:node|python3?|ruby|perl)\b[^\r\n;&|]*<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[^\r\n]*\r?\n/i.exec(command);
  if (heredoc) {
    const start = heredoc.index + heredoc[0].length;
    const delimiter = heredoc[2].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const endMatch = new RegExp(`^\\s*${delimiter}\\s*(?:$|[;&|])`, 'm').exec(command.slice(start));
    const program = command.slice(start, endMatch ? start + endMatch.index : command.length).replace(/\r?\n$/, '');
    return { program, size: program.length, lines: lineCount(program) };
  }

  const marker = /\b(?:node\s+(?:-e|--eval|-p|--print)|python3?\s+-c|ruby\s+-e|perl\s+-e)\b\s*/i.exec(command);
  if (marker) {
    const program = command.slice(marker.index + marker[0].length);
    return { program, size: program.length, lines: lineCount(program) };
  }

  const powershell = /(?:^|\s)-(?:Command|c)\b\s*/i.exec(command);
  if (powershell) {
    const program = command.slice(powershell.index + powershell[0].length);
    if (/\r?\n/.test(program)) return { program, size: program.length, lines: lineCount(program) };
  }
  return null;
}
