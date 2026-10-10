// Incomplete JSON → the value written so far. Used to draw a Live UI view while the model is
// still streaming its ui__render arguments.

/** Closes the open strings, arrays and objects of a JSON prefix (dropping a half-written escape). */
function close(prefix: string): string {
  const closers: string[] = [];
  let inString = false;
  let dangling = -1; // where an unfinished escape (\ or \u12) starts
  for (let i = 0; i < prefix.length; i++) {
    const c = prefix[i];
    if (inString) {
      if (c === '\\') {
        const need = prefix[i + 1] === 'u' ? 6 : 2;
        if (i + need > prefix.length) { dangling = i; break; }
        i += need - 1;
      } else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') closers.push('}');
    else if (c === '[') closers.push(']');
    else if (c === '}' || c === ']') closers.pop();
  }
  const body = dangling >= 0 ? prefix.slice(0, dangling) : prefix;
  return body + (inString ? '"' : '') + closers.reverse().join('');
}

/**
 * The value an incomplete JSON document has so far, or undefined if there is none yet. Cuts back
 * past a half-written token (a key without its value, `tru`, a trailing comma) when closing alone
 * doesn't parse; strings that are still being written are kept, so text grows as it streams.
 */
export function parsePartialJson(text: string): unknown {
  const s = text.trim();
  if (!s) return undefined;
  try {
    return JSON.parse(s);
  } catch {
    /* incomplete: repair below */
  }
  // A half-written key, number or literal is at most a few dozen characters.
  for (let end = s.length, tries = 0; end > 0 && tries < 80; end--, tries++) {
    try {
      return JSON.parse(close(s.slice(0, end)));
    } catch {
      /* cut one more character */
    }
  }
  return undefined;
}
